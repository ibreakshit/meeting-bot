import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { createClient } from 'redis';
import { RedisLedger } from '../scheduler/queue';
import { TranscriptQueue } from './queue';
import { TranscriptStorage } from './storage';
import { processTranscriptJob } from './worker';
import { loadTranscriptionConfig } from './config';
import type { RawTranscriptArtifacts } from './whisperx';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
test('duplicate completion, correction failure and retry preserve the published original and earlier revisions', { timeout: 30000 }, async () => {
  const container = `transcript-integration-${randomUUID()}`;
  let created = false;
  const objects = new Map<string, Buffer>([['/private/recording.webm', Buffer.from('fixture audio')]]);
  const server = createServer(async (req, res) => {
    const key = new URL(req.url || '/', 'http://fixture').pathname;
    if (req.method === 'PUT') {
      if (req.headers['if-none-match'] === '*' && objects.has(key)) { res.writeHead(412).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks)); res.writeHead(200, { ETag: '"fixture"' }).end(); return;
    }
    const body = objects.get(key); if (!body) { res.writeHead(404).end(); return; }
    const etag = '"' + createHash('sha256').update(body).digest('hex') + '"';
    if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412).end(); return; }
    res.writeHead(200, { 'Content-Length': body.length, ETag: etag }); res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const client = createClient({ socket: { reconnectStrategy: false } });
  try {
    docker('run', '-d', '--name', container, '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'always', '--aof-load-truncated', 'no'); created = true;
    const port = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container))['6379/tcp'][0].HostPort;
    const connection = createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } });
    await connection.connect();
    try {
      const config = { queueName: 'fixture', resultList: 'results', failureList: 'failures', workers: [], transcriptionEnabled: true, s3: { bucket: 'private' } };
      const ledger = new RedisLedger(connection, config); await ledger.initialize();
      const payload = { botId: 'b', provider: 'google' as const, url: 'https://meet.google.com/abc-defg-hij', name: 'Fixture', timezone: 'UTC', teamId: 't', userId: 'u', bearerToken: 'fixture' };
      await ledger.enqueue({ botId: 'b', payload, serializedPayload: JSON.stringify(payload), memberInstanceKeys: ['fixture'], pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now() + 60000, state: 'queued' });
      const completion = { recordingId: 'r', status: 'completed', timestamp: new Date().toISOString(), metadata: { botId: 'b', storage: { provider: 's3', bucket: 'private', key: 'recording.webm' } } };
      await connection.rPush('results', [JSON.stringify(completion), JSON.stringify(completion)]); await ledger.ingestResults(); await ledger.addRecording(completion);
      const queue = new TranscriptQueue(connection, 'fixture', 'private'); const claim = await queue.claim('worker'); assert.ok(claim);
      const s3 = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'test', forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } });
      const storage = new TranscriptStorage(s3, 'private'); let rawRuns = 0, alignRuns = 0;
      async function artifacts(directory: string, text: string, corrections: unknown[] = []): Promise<RawTranscriptArtifacts> {
        await mkdir(directory, { recursive: true });
        const segment = { id: 's1', text, start: 0, end: 1, speaker: 'SPEAKER_00', words: text.split(' ').map((word, index) => ({ word, start: index / 2, end: (index + 1) / 2 })) };
        const paths = { json: join(directory, 'native.json'), display: join(directory, 'display.json'), diarization: join(directory, 'diarization.json'), txt: join(directory, 'out.txt'), srt: join(directory, 'out.srt'), vtt: join(directory, 'out.vtt') };
        for (const [name, path] of Object.entries(paths)) await writeFile(path, name === 'display' ? JSON.stringify({ language: 'en', segments: [segment], corrections }) : name === 'json' ? JSON.stringify({ language: 'en', segments: [segment], word_segments: segment.words }) : name === 'diarization' ? '[{"start":0,"end":1,"speaker":"SPEAKER_00"}]' : text);
        return { ...paths, language: 'en', warnings: [] };
      }
      const dependencies = { queue, storage, config: { ...loadTranscriptionConfig(), correctionEnabled: true }, countTokens: async () => 100,
        whisperx: async (input: { outputDirectory: string }) => { rawRuns++; return artifacts(input.outputDirectory, 'gloomit'); },
        realign: async (input: { outputDirectory: string; correctedSegmentsPath: string }) => { alignRuns++; const display = JSON.parse(await readFile(input.correctedSegmentsPath, 'utf8')); return artifacts(input.outputDirectory, display.segments[0].text, display.corrections); },
        correction: async () => { const published = await queue.get(claim.jobId); assert.equal(published?.originalState, 'ready'); throw new Error('Gemma disabled for fixture'); }
      };
      await processTranscriptJob(claim, dependencies);
      const first = await queue.get(claim.jobId); assert.ok(first?.original); assert.equal(first.correctionState, 'failed');
      const originalBytes = await storage.readArtifact(first.original, 'json');
      assert.equal(await queue.claim('duplicate'), null);
      await queue.retryCorrection(claim.jobId); const retry = await queue.claim('retry'); assert.ok(retry);
      await processTranscriptJob(retry, { ...dependencies, correction: async chunk => ({ sourceHash: chunk.sourceHash, patches: [{ id: 'p', segmentId: 's1', start: 0, end: 7, original: 'gloomit', replacement: 'Google Meet', evidence: [{ segmentId: 's1', quote: 'gloomit' }] }], unresolved: [], owned: chunk.owned }) });
      const success = await queue.get(claim.jobId); assert.ok(success?.latestCorrection); assert.equal(success.correctionState, 'ready');
      assert.equal(rawRuns, 1); assert.equal(alignRuns, 1); assert.equal(success.revisions.length, 1);
      assert.deepEqual(await storage.readArtifact(first.original, 'json'), originalBytes);
      const corrected = JSON.parse((await storage.readArtifact(success.latestCorrection, 'display')).toString()); assert.equal(corrected.segments[0].text, 'Google Meet');
      await queue.retryCorrection(claim.jobId); const failedRetry = await queue.claim('failed-retry'); assert.ok(failedRetry);
      await processTranscriptJob(failedRetry, dependencies);
      const final = await queue.get(claim.jobId); assert.equal(final?.latestCorrection?.revisionId, success.latestCorrection.revisionId); assert.equal(final?.correctionState, 'failed');
      assert.equal((await ledger.listDispatches())[0].outcome?.status, 'completed');
    } finally { await connection.quit(); }
  } finally {
    if (client.isOpen) await client.quit();
    if (created) docker('rm', '-f', container);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
