import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runWhisperX } from './whisperx';
import { loadTranscriptionConfig } from './config';

test('runner returns artifact paths, preserves shell-like filenames and retains CPU warnings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transcription-runner-'));
  try {
    const runner = join(directory, 'fixture.py');
    await writeFile(runner, 'import json, pathlib, sys\np = pathlib.Path(sys.argv[sys.argv.index(\'--output-dir\')+1])\np.mkdir(exist_ok=True)\nassert sys.argv[sys.argv.index(\'--audio\')+1] == \'audio; $(false).wav\'\nfor name in [\'transcript.json\',\'display.json\',\'diarization.json\',\'transcript.txt\',\'transcript.srt\',\'transcript.vtt\']: (p/name).write_text(\'{}\')\n(p/\'result.json\').write_text(json.dumps({\'language\':\'en\',\'warnings\':[\'CPU fallback\']}))\n');
    const result = await runWhisperX({ audioPath: 'audio; $(false).wav', outputDirectory: directory, signal: new AbortController().signal }, { ...loadTranscriptionConfig(), python: 'python3', runner });
    assert.equal(result.language, 'en'); assert.match(result.warnings.join(), /CPU fallback/);
    assert.equal(result.json, join(directory, 'transcript.json'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('subprocess failure rejects and does not return partial artifacts', async () => {
  await assert.rejects(runWhisperX({ audioPath: 'fixture.wav', outputDirectory: '/tmp', signal: new AbortController().signal }, { ...loadTranscriptionConfig(), python: 'python3', runner: '/nonexistent' }), /failed/);
});
test('timeout terminates the process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transcription-timeout-'));
  try {
    const runner = join(directory, 'wait.py'); await writeFile(runner, 'import time\ntime.sleep(60)\n');
    await assert.rejects(runWhisperX({ audioPath: 'fixture.wav', outputDirectory: directory, signal: new AbortController().signal }, { ...loadTranscriptionConfig(), python: 'python3', runner, stageTimeoutMs: 40 }), /timeout/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
