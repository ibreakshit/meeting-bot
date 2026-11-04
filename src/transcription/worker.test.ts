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
