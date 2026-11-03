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
