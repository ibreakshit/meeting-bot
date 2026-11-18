import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processTranscriptJob } from './worker';

test('a stale owner never downloads audio or runs inference', async () => {
  let downloads = 0;
  await processTranscriptJob({ jobId: 'job', source: { botId: 'b', recordingId: 'r', bucket: 'b', key: 'k' }, attempt: 1, requestedAt: 0, token: 'stale', leaseExpiry: 0 }, {
    queue: { renew: async () => false }, storage: { downloadRecording: async () => { downloads++; } }
  } as never);
  assert.equal(downloads, 0);
});
test('reclaimed job with a published correction only acknowledges without inference', async () => {
  let downloads = 0, acknowledgements = 0;
  await processTranscriptJob({ jobId: 'job', source: { botId: 'b', recordingId: 'r', bucket: 'b', key: 'k' }, attempt: 2, requestedAt: 0, token: 'new', leaseExpiry: Date.now() + 120000 }, {
    queue: { renew: async () => true, get: async () => ({ original: {}, latestCorrection: {}, correctionState: 'ready' }), finish: async () => { acknowledgements++; return true; } },
    storage: { downloadRecording: async () => { downloads++; } }
  } as never);
  assert.equal(downloads, 0); assert.equal(acknowledgements, 1);
});
test('download failure during correction retry fails correction while preserving original stage', async () => {
  let failedStage;
  await processTranscriptJob({ jobId: 'job', source: { botId: 'b', recordingId: 'r', bucket: 'b', key: 'k' }, attempt: 3, requestedAt: 0, token: 'new', leaseExpiry: Date.now() + 120000 }, {
    queue: { renew: async () => true, get: async () => ({ original: {}, originalState: 'ready', correctionState: 'pending' }), fail: async (_id: string, _token: string, stage: string) => { failedStage = stage; } },
    storage: { downloadRecording: async () => { throw new Error('network failed'); } }
  } as never);
  assert.equal(failedStage, 'correction');
});
test('storage timeout terminates correction preparation and cleans the private job directory', { timeout: 2000 }, async () => {
  let failedStage, destination = '';
  const { dirname } = await import('node:path'); const { access } = await import('node:fs/promises');
  const config = (await import('./config')).loadTranscriptionConfig();
  await processTranscriptJob({ jobId: 'job', source: { botId: 'b', recordingId: 'r', bucket: 'b', key: 'k' }, attempt: 3, requestedAt: 0, token: 'new', leaseExpiry: Date.now() + 120000 }, {
    config: { ...config, stageTimeoutMs: 30 },
    queue: { renew: async () => true, get: async () => ({ original: {}, originalState: 'ready', correctionState: 'pending' }), fail: async (_id: string, _token: string, stage: string) => { failedStage = stage; } },
    storage: { downloadRecording: async (_source: unknown, path: string, signal: AbortSignal) => { destination = path; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('storage timeout')), { once: true })); } }
  } as never);
  assert.equal(failedStage, 'correction'); await assert.rejects(access(dirname(destination)), /ENOENT/);
});

for (const failure of ['length', 'timeout']) test(`long correction retries preserve context, turns and patch IDs after ${failure}`, async () => {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { loadTranscriptionConfig } = await import('./config');
  const { CorrectionResponseTooLongError } = await import('./correction');
  const segments = Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, text: 'gloomit ' + 'Project discussion. '.repeat(25), words: [] }));
  const summary = { summary: 'A meeting about Google Meet.', evidence: [{ segmentId: 's19', quote: 'Project discussion.' }] };
  const manifest = { originalState: 'ready', correctionState: 'pending', original: { sourceHash: 'hash', revisionId: 'original' } };
  let audit: { context: { summary: unknown }; applied: unknown[] } | undefined, finalSegments: typeof segments = [], corrections = 0, summaries = 0;
  let restored: { display: string; warnings: string[] } | undefined;
  let simulateTruncation = true;
  await processTranscriptJob({ jobId: 'job', source: { botId: 'b', recordingId: 'r', bucket: 'b', key: 'k' }, attempt: 1, requestedAt: 0, token: 'owner', leaseExpiry: Date.now() + 120000 }, {
    config: { ...loadTranscriptionConfig(), correctionEnabled: true, correctionInputTokens: 1536 },
    countTokens: async (text: string) => Math.ceil(text.length / 4),
    queue: { renew: async () => true, get: async () => manifest, publish: async (_id: string, _token: string, update: Record<string, unknown>) => { Object.assign(manifest, update); return true; }, finish: async () => true, fail: async () => assert.fail('Correction should succeed') },
    storage: {
      downloadRecording: async () => ({ sha256: 'hash' }),
      restoreArtifacts: async (_original: unknown, directory: string) => { await mkdir(directory, { recursive: true }); const display = join(directory, 'display.json'); await writeFile(display, JSON.stringify({ language: 'en', segments })); restored = { display, warnings: [] }; return restored; },
      uploadArtifacts: async (_id: string, _revision: string, _artifacts: unknown, _version: string, _sourceHash: string, auditPath: string) => { audit = JSON.parse(await readFile(auditPath, 'utf8')); return { revisionId: 'corrected' }; }
    },
    summarize: async (_source: unknown, chunks: import('./types').CorrectionChunk[]) => { summaries++; assert.ok(chunks.length > 1); return { summary, parts: [summary], reductions: [] }; },
    correction: async (chunk: import('./types').CorrectionChunk) => {
      assert.deepEqual(JSON.parse(chunk.messages[1].content).contextSummary, summary);
      if (simulateTruncation) { simulateTruncation = false; throw failure === 'length' ? new CorrectionResponseTooLongError() : new DOMException('Request timed out', 'TimeoutError'); }
      const first = chunk.owned.find(range => range.start === 0);
      if (!first) return { sourceHash: 'hash', patches: [], unresolved: [], owned: chunk.owned };
      corrections++;
      return { sourceHash: 'hash', patches: [{ id: 'p1', segmentId: first.segmentId, start: 0, end: 7, original: 'gloomit', replacement: 'Google Meet', evidence: [{ segmentId: first.segmentId, quote: 'gloomit' }] }], unresolved: [], owned: chunk.owned };
    },
    realign: async (input: { correctedSegmentsPath: string }) => { finalSegments = JSON.parse(await readFile(input.correctedSegmentsPath, 'utf8')).segments; return restored; }
  } as never);
  assert.equal(summaries, 1); assert.ok(corrections > 1);
  assert.equal(finalSegments.length, 20);
  assert.equal(finalSegments.filter(segment => segment.text.startsWith('Google Meet')).length, corrections);
  assert.deepEqual(audit?.context.summary, summary);
  assert.equal(audit?.applied.length, corrections);
  assert.equal(manifest.original.revisionId, 'original');
  assert.equal(manifest.correctionState, 'ready');
});
