import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TranscriptionConfig {
  python: string; whisperxRoot: string; runner: string; aiRoot: string; stageTimeoutMs: number;
  whisperUrl: string; gemmaUrl: string; correctionEnabled: boolean;
}
export function loadTranscriptionConfig(env: NodeJS.ProcessEnv = process.env): TranscriptionConfig {
  const whisperxRoot = env.TRANSCRIPTION_WHISPERX_ROOT || join(homedir(), 'Workspace/whisperx');
  const stageTimeoutMs = Number(env.TRANSCRIPTION_STAGE_TIMEOUT_SECONDS || 3600) * 1000;
  if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs <= 0) throw new Error('Invalid transcription timeout');
  return { python: env.TRANSCRIPTION_PYTHON || join(whisperxRoot, '.venv/bin/python'), whisperxRoot,
    runner: join(process.cwd(), 'scripts/transcription/whisperx_runner.py'),
    aiRoot: env.TRANSCRIPTION_AI_ROOT || join(homedir(), 'Workspace/ai'), stageTimeoutMs,
    whisperUrl: env.TRANSCRIPTION_WHISPER_URL || 'http://127.0.0.1:8090',
    gemmaUrl: env.TRANSCRIPTION_GEMMA_URL || 'http://127.0.0.1:8091/v1',
    // Enable only after the structured prompt passes real-model preservation evaluation.
    correctionEnabled: env.TRANSCRIPTION_CORRECTION_ENABLED === 'true' };
}
