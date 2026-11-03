import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { TranscriptStorage } from './storage';
import { S3Client } from '@aws-sdk/client-s3';

test('recording download pins ETag and hashes streamed content', async () => {
  const requests: unknown[] = [];
  const client = { send: async (command: { input: Record<string, unknown> }) => {
    requests.push(command.input);
    if (requests.length === 1) return { ETag: 'etag' };
    assert.equal(command.input.IfMatch, 'etag');
    return { Body: Readable.from(['audio']), ETag: 'etag' };
  } } as unknown as S3Client;
  const directory = await mkdtemp(join(tmpdir(), 'transcript-storage-'));
  try {
    const storage = new TranscriptStorage(client, 'private');
    const hash = await storage.downloadRecording({ botId: 'b', recordingId: 'r', bucket: 'private', key: 'recording' }, join(directory, 'audio'), new AbortController().signal);
    assert.equal(hash.sha256.length, 64); assert.equal(await readFile(join(directory, 'audio'), 'utf8'), 'audio');
    await assert.rejects(storage.downloadRecording({ botId: 'b', recordingId: 'r', bucket: 'foreign', key: 'x' }, join(directory, 'x'), new AbortController().signal), /bucket/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
