import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTranscriptionConfig } from './config';
import { localTokenCounter, prepareCorrectionChunks, proposeCorrections } from './correction';
import { validateAndApplyCorrections } from './patches';
import { SourceConflictError } from './storage';
import { realignTranscript, runWhisperX } from './whisperx';
import type { TranscriptQueue } from './queue';
import type { TranscriptStorage } from './storage';
import type { ClaimedTranscriptJob, OriginalTranscript } from './types';

export interface WorkerDependencies {
  queue: TranscriptQueue; storage: TranscriptStorage; signal?: AbortSignal; now?: () => number;
  whisperx?: typeof runWhisperX; realign?: typeof realignTranscript; correction?: typeof proposeCorrections;
  countTokens?: import('./types').CorrectionBudget['countTokens'];
  config?: ReturnType<typeof loadTranscriptionConfig>;
}
export async function processTranscriptJob(claim: ClaimedTranscriptJob, deps: WorkerDependencies): Promise<void> {
  const { queue, storage } = deps;
  if (!await queue.renew(claim.jobId, claim.token)) return;
  const config = deps.config || loadTranscriptionConfig();
  const cancellation = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, cancellation.signal]) : cancellation.signal;
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void queue.renew(claim.jobId, claim.token).then(owned => { if (!owned) cancellation.abort(); }, () => cancellation.abort()).finally(() => { renewing = false; });
  }, 30000);
  const directory = await mkdtemp(join(tmpdir(), 'meeting-transcript-'));
  let stage: 'original' | 'correction' = 'original';
  const publish = async (update: Parameters<TranscriptQueue['publish']>[2]) => {
    signal.throwIfAborted();
    if (!await queue.publish(claim.jobId, claim.token, update)) throw new Error('Transcript ownership lost');
  };
  try {
    let manifest = await queue.get(claim.jobId);
    if (!manifest) return;
    if (manifest.latestCorrection && manifest.correctionState === 'ready') {
      await queue.finish(claim.jobId, claim.token); return;
    }
    const audioPath = join(directory, 'recording');
    const fingerprint = await storage.downloadRecording(claim.source, audioPath, signal);
    if (manifest.fingerprint && manifest.fingerprint.sha256 !== fingerprint.sha256) throw new SourceConflictError('Recording content changed');
    let original;
    if (manifest.original) original = await storage.restoreArtifacts(manifest.original, join(directory, 'original'));
    else {
      await publish({ originalState: 'running' });
      original = await (deps.whisperx || runWhisperX)({ audioPath, outputDirectory: join(directory, 'original'), signal }, config);
      const pointer = await storage.uploadArtifacts(claim.jobId, randomUUID(), original);
      await publish({ original: pointer, fingerprint, originalState: 'ready', warnings: original.warnings });
    }
    stage = 'correction';
    if (!config.correctionEnabled) {
      await queue.finish(claim.jobId, claim.token, { correctionState: 'skipped', warnings: [...original.warnings, 'Automatic correction awaits model quality validation.'] }); return;
    }
    await publish({ correctionState: 'running' });
    manifest = await queue.get(claim.jobId);
    if (!manifest?.original) throw new Error('Published original unavailable');
    const display = JSON.parse(await readFile(original.display, 'utf8')) as Omit<OriginalTranscript, 'sourceHash'>;
    const source: OriginalTranscript = { ...display, sourceHash: manifest.original.sourceHash };
    const chunks = await prepareCorrectionChunks(source, { contextTokens: 8192, completionTokens: 2048, safetyTokens: 512, countTokens: deps.countTokens || localTokenCounter(config.gemmaUrl, signal) });
    const proposals = [];
    for (const chunk of chunks) proposals.push(await (deps.correction || proposeCorrections)(chunk, signal, { baseUrl: config.gemmaUrl }));
    const corrected = validateAndApplyCorrections(source, proposals);
    const segmentsPath = join(directory, 'corrected-segments.json');
    await writeFile(segmentsPath, JSON.stringify({ language: source.language, segments: corrected.segments, corrections: corrected.applied }), { mode: 0o600 });
    const auditPath = join(directory, 'audit.json');
    await writeFile(auditPath, JSON.stringify({ proposals, applied: corrected.applied, rejected: corrected.rejected, unresolved: corrected.unresolved,
      settings: { model: 'gemma-4-e4b-it-q6', temperature: 0, reasoning: true, reasoningBudget: 512, completionTokens: 2048, promptVersion: 1 } }), { mode: 0o600 });
    let artifacts = original;
    if (corrected.applied.length) artifacts = await (deps.realign || realignTranscript)({ audioPath, correctedSegmentsPath: segmentsPath, diarizationPath: original.diarization, outputDirectory: join(directory, 'corrected'), signal }, config);
    else artifacts = { ...original, display: segmentsPath };
    const revision = await storage.uploadArtifacts(claim.jobId, randomUUID(), artifacts, 'corrected', source.sourceHash, auditPath);
    await publish({ latestCorrection: revision, correctionState: 'ready', warnings: artifacts.warnings });
    await queue.finish(claim.jobId, claim.token);
  } catch (error) {
    if (signal.aborted) return;
    const transient = !(error instanceof SourceConflictError) && /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|service unavailable|SlowDown|503|502/.test(error instanceof Error ? error.message : '');
    if (transient && claim.attempt < 3) {
      await queue.finish(claim.jobId, claim.token, { [stage === 'original' ? 'originalState' : 'correctionState']: stage === 'original' ? 'queued' : 'pending', nextAttemptAt: (deps.now || Date.now)() + (claim.attempt === 1 ? 5000 : 30000) });
    } else await queue.fail(claim.jobId, claim.token, stage, error instanceof SourceConflictError ? 'Recording source changed; transcript unavailable.' : stage === 'original' ? 'Transcription failed.' : 'Correction failed; original remains available.');
  } finally {
    clearInterval(renewal); cancellation.abort();
    await rm(directory, { recursive: true, force: true });
  }
}
