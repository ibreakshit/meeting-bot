import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createClient } from 'redis';
import { TranscriptQueue, transcriptJobId } from './queue';
import { RedisLedger } from '../scheduler/queue';
import type { DispatchRecord, RecordingPayload } from '../scheduler/types';

const container = `transcription-test-${randomUUID()}`;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const config = { queueName: 'fixture:jobs', resultList: 'fixture:results', failureList: 'fixture:failures', workers: [],
  transcriptionEnabled: true, s3: { bucket: 'fixture' } };
const source = { botId: 'bot', recordingId: 'recording', bucket: 'fixture', key: 'audio.webm' };
let client: ReturnType<typeof createClient>;
let ledger: RedisLedger;
let queue: TranscriptQueue;
let created = false;
const payload: RecordingPayload = { recordingId: source.recordingId, status: 'completed', timestamp: '2020-01-01T00:00:00Z',
  metadata: { botId: source.botId, storage: { provider: 's3', bucket: source.bucket, key: source.key } } };
async function dispatch() {
  const botPayload = { botId: source.botId, provider: 'google' as const, url: 'https://meet.google.com/abc-defg-hij', name: 'Fixture', timezone: 'UTC', teamId: 'fixture', userId: 'fixture', bearerToken: 'fixture' };
  await ledger.enqueue({ botId: source.botId, payload: botPayload, serializedPayload: JSON.stringify(botPayload), memberInstanceKeys: ['fixture'], pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now() + 60000, state: 'queued' } as DispatchRecord);
}
before(async () => {
  docker('run', '-d', '--name', container, '-p', '127.0.0.1::6379', 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'always', '--aof-load-truncated', 'no');
  created = true;
  const port = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', container))['6379/tcp'][0].HostPort;
  client = createClient({ url: `redis://127.0.0.1:${port}`, socket: { reconnectStrategy: false } });
  await client.connect();
});
after(async () => { if (client?.isOpen) await client.close(); if (created) docker('rm', '-f', container); });
beforeEach(async () => {
  await client.flushDb(); ledger = new RedisLedger(client, config); await ledger.initialize();
  queue = new TranscriptQueue(client, config.queueName, 'fixture'); await dispatch();
});
for (const order of ['webhook-first', 'redis-first']) test(`${order} completion queues once and preserves meeting outcome`, async () => {
  if (order === 'webhook-first') await ledger.addRecording(payload);
  await client.rPush(config.resultList, JSON.stringify(payload)); await ledger.ingestResults();
  await ledger.addRecording(payload); await ledger.reconcileTranscriptions();
  const claim = await queue.claim('worker'); assert.equal(claim?.jobId, transcriptJobId(source));
  assert.equal(await queue.claim('other'), null);
  assert.equal((await ledger.listDispatches())[0].outcome?.status, 'completed');
});
test('reconciliation recovers a crash after result merge before enqueue', async () => {
  const disabled = new RedisLedger(client, { ...config, transcriptionEnabled: false });
  await client.rPush(config.resultList, JSON.stringify(payload)); await disabled.ingestResults();
  await ledger.reconcileTranscriptions(); assert.equal((await queue.claim('worker'))?.jobId, transcriptJobId(source));
});
test('conflicting locations block enqueue and publication by a previously valid owner', async () => {
  await ledger.addRecording(payload); const claim = await queue.claim('worker'); assert.ok(claim);
  await ledger.addRecording({ ...payload, metadata: { ...payload.metadata, storage: { provider: 's3', bucket: 'fixture', key: 'other.webm' } } });
  assert.equal(await queue.publish(claim.jobId, claim.token, { originalState: 'ready' }), false);
  await assert.rejects(queue.ensureJob(source), /conflict|eligible/i);
});
test('expired leases are reclaimed and stale owners cannot publish or fail', async () => {
  await ledger.addRecording(payload); const first = await queue.claim('one'); assert.ok(first);
  await client.zAdd(`${config.queueName}:transcripts:leases`, { score: 0, value: first.jobId });
  const second = await queue.claim('two'); assert.ok(second); assert.notEqual(first.token, second.token);
  assert.equal(await queue.publish(first.jobId, first.token, { originalState: 'ready' }), false);
  assert.equal(await queue.renew(first.jobId, first.token), false);
  assert.equal(await queue.publish(second.jobId, second.token, { originalState: 'running' }), true);
});
test('activation survives restart and excludes previously accepted recordings', async () => {
  await client.del(`${config.queueName}:transcripts:activation`);
  const disabled = new RedisLedger(client, { ...config, transcriptionEnabled: false });
  await disabled.addRecording(payload);
  await new Promise(resolve => setTimeout(resolve, 5));
  await ledger.checkPersistence(); const activation = await client.get(`${config.queueName}:transcripts:activation`);
  await ledger.reconcileTranscriptions(); assert.equal(await queue.claim('worker'), null);
  await ledger.checkPersistence(); assert.equal(await client.get(`${config.queueName}:transcripts:activation`), activation);
});
test('identity includes the full canonical tuple and is independent of property insertion order', () => {
  assert.equal(transcriptJobId(source), transcriptJobId({ key: source.key, bucket: source.bucket, recordingId: source.recordingId, botId: source.botId }));
  assert.notEqual(transcriptJobId(source), transcriptJobId({ ...source, key: 'other' }));
});
test('unknown dispatch, incomplete completion and wrong bucket never queue', async () => {
  await ledger.addRecording({ ...payload, status: 'processing' });
  assert.equal(await queue.claim('worker'), null);
  await assert.rejects(queue.ensureJob(source), /eligible/);
  await ledger.addRecording({ ...payload, metadata: { ...payload.metadata, botId: 'unknown' } });
  assert.equal(await queue.claim('worker'), null);
  await ledger.addRecording({ ...payload, metadata: { ...payload.metadata, storage: { provider: 's3', bucket: 'foreign', key: source.key } } });
  assert.equal(await queue.claim('worker'), null);
});
test('queue failure cannot roll back completed recording ingestion', async () => {
  await client.set(`${config.queueName}:transcripts:jobs`, 'wrong-type');
  await client.rPush(config.resultList, JSON.stringify(payload));
  await ledger.ingestResults();
  assert.equal((await ledger.listDispatches())[0].outcome?.status, 'completed');
  assert.equal(await client.lLen(config.resultList), 0);
});
test('host-wide serialization permits only one inference job across worker processes', async () => {
  await ledger.addRecording(payload);
  await client.hSet(`${config.queueName}:scheduler:dispatches`, 'bot2', JSON.stringify({ botId: 'bot2', recording: { ...(await ledger.listDispatches())[0].recording, botId: 'bot2' } }));
  await queue.ensureJob({ ...source, botId: 'bot2' });
  assert.ok(await queue.claim('one'));
  assert.equal(await queue.claim('two'), null);
});
test('repeated worker death cannot reset the persisted three-attempt limit', async () => {
  await ledger.addRecording(payload);
  for (let index = 0; index < 3; index++) {
    const claim = await queue.claim('dying-worker'); assert.ok(claim);
    await client.zAdd(`${config.queueName}:transcripts:leases`, { value: claim.jobId, score: 0 });
  }
  assert.equal(await queue.claim('fourth'), null);
  assert.equal((await queue.get(transcriptJobId(source)))?.originalState, 'failed');
});
