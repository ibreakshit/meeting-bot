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
test('artifact reads pass cancellation to storage and abort stalled streams', async () => {
  const abort = new AbortController(); let passedSignal: AbortSignal | undefined;
  const body = new Readable({ read() { /* Fixture intentionally waits for cancellation. */ } });
  const client = { send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => { passedSignal = options?.abortSignal; return { Body: body }; } } as unknown as S3Client;
  const storage = new TranscriptStorage(client, 'private');
  const reading = storage.readArtifact({ keys: { json: 'meeting-bot/transcripts/fixture/json' }, hashes: { json: 'hash' } } as never, 'json', 1024, abort.signal);
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(reading, /cancel/); assert.equal(passedSignal, abort.signal); assert.equal(body.destroyed, true);
});
test('artifact uploads forward cancellation to a stalled storage request', { timeout: 2000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'transcript-upload-'));
  const abort = new AbortController();
  const client = { send: async (_command: unknown, options?: { abortSignal?: AbortSignal }) => {
    assert.equal(options?.abortSignal, abort.signal);
    abort.abort(); options?.abortSignal?.throwIfAborted();
  } } as unknown as S3Client;
  try {
    const path = join(directory, 'artifact'); const { writeFile } = await import('node:fs/promises'); await writeFile(path, '{}');
    const storage = new TranscriptStorage(client, 'private');
    await assert.rejects(storage.uploadArtifacts('a'.repeat(64), 'revision', { json: path, display: path, txt: path, srt: path, vtt: path, diarization: path, language: 'en', warnings: [] }, 'original', undefined, undefined, abort.signal), { name: 'AbortError' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
