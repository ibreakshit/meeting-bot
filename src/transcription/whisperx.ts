import { spawn } from 'node:child_process';
import { access, readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadTranscriptionConfig } from './config';
import type { TranscriptionConfig } from './config';

export interface RawTranscriptArtifacts {
  json: string; display: string; txt: string; srt: string; vtt: string; diarization: string;
  language: string; warnings: string[];
}
interface RunnerInput { audioPath: string; outputDirectory: string; signal: AbortSignal }
async function runnerEnvironment(config: TranscriptionConfig): Promise<NodeJS.ProcessEnv> {
  const venv = dirname(dirname(config.python));
  const libraries = [join(venv, 'lib/ffmpeg')];
  for (const name of await readdir(join(venv, 'lib')).catch(() => [])) {
    if (/^python\d/.test(name)) libraries.unshift(join(venv, 'lib', name, 'site-packages/av.libs'));
  }
  return { ...process.env,
    PATH: [join(venv, 'bin'), join(config.aiRoot, 'runtimes/nemo-speech-0.3.0-vulkan/bin'), process.env.PATH].filter(Boolean).join(':'),
    LD_LIBRARY_PATH: [...libraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    PYTHONPATH: [config.whisperxRoot, process.env.PYTHONPATH].filter(Boolean).join(':'),
    NEMO_SPEECH_MODEL_DIR: process.env.NEMO_SPEECH_MODEL_DIR || join(config.aiRoot, 'models/gguf/nemotron-diarization'),
    CRISPASR_CACHE_DIR: process.env.CRISPASR_CACHE_DIR || join(config.aiRoot, 'models/gguf/forced-alignment'),
    WHISPER_CPP_URL: config.whisperUrl };
}
async function run(input: RunnerInput, args: string[], config: TranscriptionConfig): Promise<RawTranscriptArtifacts> {
  input.signal.throwIfAborted();
  const env = await runnerEnvironment(config);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.python, [config.runner, ...args, '--audio', input.audioPath, '--output-dir', input.outputDirectory], {
      env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let diagnostics = '';
    let stopped: string | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const append = (data: Buffer) => { diagnostics = (diagnostics + data.toString()).slice(-65536); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason; kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 3000);
    };
    const cancel = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), config.stageTimeoutMs);
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
    child.once('error', error => { stopped = `failed: ${error.message}`; });
    child.once('close', code => {
      clearTimeout(timeout); if (escalation) clearTimeout(escalation);
      if (stopped) kill('SIGKILL');
      input.signal.removeEventListener('abort', cancel);
      if (stopped || code !== 0) reject(new Error(`WhisperX ${stopped || 'failed'} (exit ${code}): ${diagnostics}`));
      else resolve();
    });
  });
  const metadata = JSON.parse(await readFile(join(input.outputDirectory, 'result.json'), 'utf8')) as { language: string; warnings: string[] };
  if (typeof metadata.language !== 'string' || !Array.isArray(metadata.warnings) || metadata.warnings.some(item => typeof item !== 'string')) throw new Error('Invalid WhisperX completion metadata');
  const paths = { json: join(input.outputDirectory, 'transcript.json'), display: join(input.outputDirectory, 'display.json'),
    txt: join(input.outputDirectory, 'transcript.txt'), srt: join(input.outputDirectory, 'transcript.srt'), vtt: join(input.outputDirectory, 'transcript.vtt'),
    diarization: join(input.outputDirectory, 'diarization.json') };
  await Promise.all(Object.values(paths).map(path => access(path)));
  return { ...paths, language: metadata.language, warnings: metadata.warnings };
}
export function runWhisperX(input: RunnerInput, config = loadTranscriptionConfig()): Promise<RawTranscriptArtifacts> {
  return run(input, ['transcribe'], config);
}
export function realignTranscript(input: RunnerInput & { correctedSegmentsPath: string; diarizationPath: string }, config = loadTranscriptionConfig()): Promise<RawTranscriptArtifacts> {
  return run(input, ['realign', '--segments', input.correctedSegmentsPath, '--diarization', input.diarizationPath], config);
}
