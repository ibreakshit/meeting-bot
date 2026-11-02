import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, test } from 'node:test';
import { createClient } from 'redis';
import { RedisLedger } from './queue';
import type { DispatchRecord, RecordingPayload, SchedulerConfig } from './types';
import { loadConfig } from './config';
import { TokenCrypto } from './crypto';
import { SchedulerStore } from './store';
import { SchedulerRuntime } from './runtime';
import { createSchedulerApp } from './web';

const containerName = `meeting-bot-ledger-test-${randomUUID()}`;
const volumeName = `${containerName}-data`;
const config: Pick<SchedulerConfig, 'queueName' | 'resultList' | 'failureList' | 'workers'> = {
  queueName: 'test:pending', resultList: 'test:results', failureList: 'test:failures',
  workers: [1, 2].map(id => ({ id: String(id), baseUrl: `http://worker-${id}:3000`, processingQueue: `test:processing:${id}` }))
};
const key = (name: string) => `${config.queueName}:scheduler:${name}`;
let client: ReturnType<typeof createClient>;
let ledger: RedisLedger;
let redisUrl: string;
let containerCreated = false;
let volumeCreated = false;
const docker = (...args: string[]) => execFileSync('docker', args, { timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function record(botId = randomUUID(), members = [`instance:${botId}`]): DispatchRecord {
  const payload = { botId, provider: 'google' as const, url: 'https://meet.google.com/abc-defg-hij', name: 'Fixture bot', timezone: 'UTC', eventId: 'fixture', teamId: 'fixture', userId: 'fixture', bearerToken: 'fixture-only' };
  return { botId, payload, serializedPayload: JSON.stringify(payload), memberInstanceKeys: members, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now() + 60_000, state: 'queued' };
}
function completion(botId?: string, extra: Record<string, unknown> = {}): RecordingPayload {
  return { recordingId: 'recording-1', status: 'completed', timestamp: '2026-11-01T01:00:00Z', blobUrl: 'http://private-storage/fixture', metadata: { botId, duration: 42, storage: { provider: 's3', bucket: 'fixture', key: 'recording.webm', endpoint: 'http://private-storage' } }, ...extra };
}
async function pushResult(payload: unknown, failure = false): Promise<void> {
  await client.rPush(failure ? config.failureList : config.resultList, typeof payload === 'string' ? payload : JSON.stringify(payload));
}

function losingReplyLedger(): RedisLedger {
  let loseReply = true;
  const connection = new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (property === 'eval') return async (...args: Parameters<typeof client.eval>) => {
        const result = await target.eval(...args);
        if (loseReply) { loseReply = false; throw new Error('Simulated lost Redis reply after commit'); }
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  return new RedisLedger(connection, config);
}

before(async () => {
  docker('volume', 'create', volumeName);
  volumeCreated = true;
  docker('run', '-d', '--name', containerName, '-p', '127.0.0.1::6379', '-v', `${volumeName}:/data`, 'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'always', '--no-appendfsync-on-rewrite', 'no', '--aof-load-truncated', 'no', '--maxmemory-policy', 'noeviction');
  containerCreated = true;
  const port = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', containerName))['6379/tcp'][0].HostPort;
  redisUrl = `redis://127.0.0.1:${port}`;
  client = createClient({ url: redisUrl, socket: { connectTimeout: 5_000, reconnectStrategy: false } });
  client.on('error', () => undefined);
  await client.connect();
  ledger = new RedisLedger(client, config);
}, { timeout: 60_000 });
after(async () => {
  if (client?.isOpen) await client.close();
  if (containerCreated) docker('rm', '-f', containerName);
  if (volumeCreated) docker('volume', 'rm', volumeName);
});
beforeEach(async () => { await client.flushDb(); await ledger.initialize(); });

test('requires explicit initialization and strict AOF configuration', async () => {
  await ledger.checkPersistence();
  await client.del(key('dataset'));
  await assert.rejects(ledger.checkPersistence(), /initializ|dataset|marker/i);
  await assert.rejects(ledger.enqueue(record()), /initializ|dataset|marker/i);
  assert.deepEqual(await ledger.listDispatches(), []);
  await ledger.initialize();
  await client.configSet('appendfsync', 'everysec');
  try { await assert.rejects(ledger.checkPersistence(), /appendfsync|persistence/i); }
  finally { await client.configSet('appendfsync', 'always'); }
});

test('duplicate enqueue and lost reply replay stay idempotent after pickup and completion', async () => {
  const first = record();
  assert.equal((await ledger.enqueue(first))?.botId, first.botId);
  assert.equal((await ledger.enqueue(record(randomUUID(), first.memberInstanceKeys)))?.botId, first.botId);
  assert.deepEqual([...await ledger.pendingPayloads()], [first.serializedPayload]);
  await client.lMove(config.queueName, config.workers[0].processingQueue, 'LEFT', 'RIGHT');
  assert.equal((await ledger.enqueue(first))?.botId, first.botId);
  await pushResult(completion(first.botId));
  await ledger.ingestResults();
  assert.equal((await ledger.enqueue(first))?.outcome?.status, 'completed');
  assert.equal((await ledger.enqueue(record(randomUUID(), first.memberInstanceKeys)))?.botId, first.botId);
  assert.equal((await ledger.listDispatches()).length, 1);
  assert.equal((await ledger.pendingPayloads()).size, 0);

});

test('concurrent manual invitations deduplicate by room and release only after an authoritative outcome', async () => {
  const candidates = Array.from({ length: 12 }, () => ({ ...record(), source: 'manual' as const }));
  const invited = await Promise.all(candidates.map(candidate => ledger.enqueue(candidate)));
  assert.equal(new Set(invited.map(job => job?.botId)).size, 1);
  assert.equal((await ledger.pendingPayloads()).size, 1);
  const active = invited[0]; assert.ok(active);
  assert.equal(active.source, 'manual');
  assert.equal(active.roomId, 'meet:abc-defg-hij');
  await client.lMove(config.queueName, config.workers[0].processingQueue, 'LEFT', 'RIGHT');
  assert.equal((await ledger.enqueue({ ...record(), source: 'manual' }))?.botId, active.botId);
  await pushResult(completion(active.botId)); await ledger.ingestResults();
  assert.equal((await ledger.enqueue(candidates[0]))?.botId, active.botId, 'replaying a request cannot rejoin a completed meeting');
  const fresh = await ledger.enqueue({ ...record(), source: 'manual' });
  assert.ok(fresh && fresh.botId !== active.botId, 'a new explicit invitation may reuse a finished room');
});

test('manual and calendar requests share an active room without duplicating the bot', async () => {
  const scheduled = record(); await ledger.enqueue(scheduled);
  const manual = { ...record(), source: 'manual' as const };
  manual.payload.url += '?authuser=fixture'; manual.serializedPayload = JSON.stringify(manual.payload);
  assert.equal((await ledger.enqueue(manual))?.botId, scheduled.botId);
  assert.equal((await ledger.pendingPayloads()).size, 1);
  await ledger.remove(scheduled.botId, 'fixture removal');
  const active = { ...record(), source: 'manual' as const }; await ledger.enqueue(active);
  assert.equal((await ledger.enqueue(record()))?.botId, active.botId);
  assert.equal((await ledger.pendingPayloads()).size, 1);
});

test('calendar replacement retains manual request bindings on the new execution', async () => {
  const scheduled = record(); await ledger.enqueue(scheduled);
  const member = `manual:${randomUUID()}`;
  await ledger.enqueue({ ...record(randomUUID(), [member]), source: 'manual' });
  const replacement = record(randomUUID(), scheduled.memberInstanceKeys);
  await ledger.enqueue(replacement, scheduled.botId);
  assert.equal(await client.hGet(key('instances'), member), replacement.botId);
  assert.ok((await ledger.listDispatches()).find(job => job.botId === replacement.botId)?.memberInstanceKeys.includes(member));
});

test('reusing a manual request identity for another room cannot silently invite the wrong target', async () => {
  const first = { ...record(), source: 'manual' as const }; await ledger.enqueue(first);
  const changed = { ...first, payload: { ...first.payload, url: 'https://meet.google.com/klm-nopq-rst' } };
  changed.serializedPayload = JSON.stringify(changed.payload);
  await assert.rejects(ledger.enqueue(changed), /request|identity|submitted/i);
  const another = { ...changed, botId: randomUUID() };
  another.payload = { ...another.payload, botId: another.botId };
  another.serializedPayload = JSON.stringify(another.payload);
  await assert.rejects(ledger.enqueue(another), /request|identity|room/i);
  assert.equal((await ledger.pendingPayloads()).size, 1);
});

test('manual URL form endpoint persists queued work across restart, settings changes and worker pickup', async t => {
  const directory = await mkdtemp('/tmp/manual-invite-e2e-');
  const settings = loadConfig({ GOOGLE_OAUTH_CLIENT_ID: 'fixture', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture', SCHEDULER_SECRET: Buffer.alloc(32, 9).toString('base64'), DASHBOARD_ALLOWED_EMAILS: 'owner@example.test', DASHBOARD_BASE_URLS: 'http://localhost:3001', SCHEDULER_BASE_PATH: '/meeting-bot', SCHEDULER_BOT_NAME: 'Fixture Recorder', SCHEDULER_TEAM_ID: 'fixture', SCHEDULER_USER_ID: 'fixture', SCHEDULER_BEARER_TOKEN: 'fixture-bearer', NOTIFY_WEBHOOK_SECRET: 'fixture-hook', S3_BUCKET_NAME: 'fixture', S3_REGION: 'fixture', S3_ACCESS_KEY_ID: 'fixture', S3_SECRET_ACCESS_KEY: 'fixture', SCHEDULER_STATE_PATH: join(directory, 'state.json') });
  Object.assign(settings, config);
  const crypto = new TokenCrypto(settings.secret);
  const store = new SchedulerStore(settings.statePath);
  await store.update(state => { state.botSettings = { name: 'Saved assistant', thumbnailId: 'a'.repeat(64) }; });
  let now = Date.now();
  const google = { authorizationUrl: () => '', completeOAuth: async () => { throw Error('unused fixture'); }, listCalendars: async () => [], revokeAccount: async () => undefined, pollCalendar: async () => [] };
  const makeRuntime = (state: SchedulerStore) => new SchedulerRuntime(settings, state, ledger, google, { now: () => now, probe: async worker => ({ id: worker.id, reachable: true, busy: true, observedAt: now }) });
  let runtime = makeRuntime(store); await runtime.start({ timers: false });
  const app = createSchedulerApp({ config: settings, store, ledger, google, crypto, runtime: { view: () => runtime.view(), tick: () => runtime.tick(), invite: request => runtime.invite(request) } });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { await runtime.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; settings.baseUrls = [origin];
  const headers = { Cookie: `scheduler_session_L21lZXRpbmctYm90=${crypto.signCookie({ email: 'owner@example.test' }, 3600)}`, Origin: origin, 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
  const request = { url: 'https://meet.google.com/abc-defg-hij', requestId: randomUUID(), timezone: 'Asia/Seoul' };
  const post = (path: string, body: unknown) => fetch(`${origin}/meeting-bot${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  for (const url of ['https://example.test/room', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com:444/abc-defg-hij']) assert.equal((await post('/invitations', { ...request, url })).status, 400);
  const invited = await post('/invitations', request); assert.equal(invited.status, 200);
  const response = await invited.json() as { botId: string; state: string };
  assert.equal(response.state, 'queued');
  let queued = (await ledger.listDispatches()).find(job => job.botId === response.botId); assert.ok(queued);
  assert.equal(queued.payload.name, 'Saved assistant'); assert.equal(queued.payload.thumbnailId, 'a'.repeat(64));
  assert.equal(queued.source, 'manual'); assert.equal((await ledger.pendingPayloads()).size, 1);
  const appearance = await post('/bot-settings', { name: 'Updated assistant', removeThumbnail: true }); assert.equal(appearance.status, 200);
  queued = (await ledger.listDispatches()).find(job => job.state === 'queued'); assert.ok(queued);
  assert.equal(queued.payload.name, 'Updated assistant'); assert.equal(queued.payload.thumbnailId, undefined);
  assert.notEqual(queued.botId, response.botId);
  const replay = await post('/invitations', request); assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { botId: string }).botId, queued.botId, 'retry follows the replacement rather than its removed predecessor');
  await runtime.stop();
  const reloaded = new SchedulerStore(settings.statePath); await reloaded.load(); runtime = makeRuntime(reloaded); await runtime.start({ timers: false });
  assert.deepEqual([...await ledger.pendingPayloads()], [queued.serializedPayload]);
  const schedule = await fetch(`${origin}/meeting-bot/`, { headers, signal: AbortSignal.timeout(5000) });
  const html = await schedule.text(); assert.match(html, /Manual invitations/); assert.match(html, /Manual Google Meet invitation/); assert.equal(html.includes('fixture-bearer'), false);
  await client.lMove(config.queueName, config.workers[0].processingQueue, 'LEFT', 'RIGHT'); await runtime.tick();
  assert.equal((await ledger.listDispatches()).find(job => job.botId === queued?.botId)?.state, 'picked_up');
  now += 3 * 3600000; await runtime.tick();
  assert.equal((await ledger.listDispatches()).find(job => job.botId === queued?.botId)?.state, 'picked_up', 'a pickup deadline cannot replace a claimed job');
  assert.equal((await ledger.pendingPayloads()).size, 0);
  await pushResult(completion(queued.botId)); await runtime.tick();
  await pushResult({ recordingId: 'conflict-fixture', status: 'failed', timestamp: new Date().toISOString(), metadata: { botId: queued.botId }, error: { message: 'Conflicting fixture result' } }, true);
  await runtime.tick();
  const uncertain = await post('/invitations', { ...request, requestId: randomUUID() });
  assert.equal(uncertain.status, 200);
  assert.equal((await uncertain.json() as { state: string }).state, 'unknown', 'uncertain execution must not create a second bot');
  assert.equal((await ledger.pendingPayloads()).size, 0);
});

test('removal and replacement only release identity after exact pending removal', async () => {
  const old = record();
  await ledger.enqueue(old);
  const replacement = record(randomUUID(), old.memberInstanceKeys);
  assert.equal((await ledger.enqueue(replacement, old.botId))?.botId, replacement.botId);
  const removed = (await ledger.listDispatches()).find(item => item.botId === old.botId);
  assert.equal(removed?.removedBeforePickup, true);
  assert.deepEqual([...await ledger.pendingPayloads()], [replacement.serializedPayload]);
  await client.lMove(config.queueName, config.workers[1].processingQueue, 'LEFT', 'RIGHT');
  assert.equal((await ledger.enqueue(replacement, old.botId))?.botId, replacement.botId);
  assert.equal(await ledger.remove(replacement.botId, 'cancelled'), null);
  assert.equal(await ledger.enqueue(record(randomUUID(), old.memberInstanceKeys), replacement.botId), null);
  assert.equal((await ledger.listDispatches()).length, 2);
  assert.deepEqual((await ledger.processingPayloads())['2'], [replacement.serializedPayload]);
});

test('confirmed removal replay and split groups can advance independently', async () => {
  const old = record(randomUUID(), ['a', 'b']);
  await ledger.enqueue(old);
  assert.equal((await ledger.remove(old.botId, 'calendar unavailable'))?.removedBeforePickup, true);
  assert.equal((await ledger.remove(old.botId, 'calendar unavailable'))?.state, 'removed');
  await ledger.enqueue(record(randomUUID(), ['a']));
  await ledger.enqueue(record(randomUUID(), ['b']));
  assert.equal((await ledger.pendingPayloads()).size, 2);
  assert.equal(await ledger.enqueue(record(randomUUID(), ['a']), old.botId), null);
});

test('wrong key types fail before mutation and invalid payloads cannot enqueue', async () => {
  const job = record();
  await client.set(config.queueName, 'wrong-type');
  await assert.rejects(ledger.enqueue(job), /type/i);
  assert.deepEqual(await ledger.listDispatches(), []);
  await client.del(config.queueName);
  await assert.rejects(ledger.enqueue({ ...job, serializedPayload: '{}' }), /payload/i);
  const invalidAppearance = { ...job.payload, thumbnailId: '../private.png' };
  await assert.rejects(ledger.enqueue({ ...job, payload: invalidAppearance, serializedPayload: JSON.stringify(invalidAppearance) }), /thumbnail/i);
  assert.equal((await ledger.pendingPayloads()).size, 0);
});

test('membership attachment is atomic and preserves terminal outcomes and other owners', async () => {
  const first = record(randomUUID(), ['first']);
  const second = record(randomUUID(), ['second']);
  await ledger.enqueue(first); await ledger.enqueue(second);
  await pushResult(completion(first.botId)); await ledger.ingestResults();
  await ledger.attachMembers(first.botId, ['first', 'new', 'second']);
  const stored = (await ledger.listDispatches()).find(item => item.botId === first.botId);
  assert.ok(stored);
  assert.deepEqual(stored.memberInstanceKeys.sort(), ['first', 'new']);
  assert.equal(stored.outcome?.status, 'completed');
  assert.equal((await ledger.enqueue(record(randomUUID(), ['new'])))?.botId, first.botId);
  assert.equal((await ledger.enqueue(record(randomUUID(), ['second'])))?.botId, second.botId);
});

test('callbacks preserve attempts and metadata without manufacturing or downgrading outcomes', async () => {
  const job = record(); await ledger.enqueue(job);
  const status = { botId: job.botId, provider: 'google' as const, status: ['processing', 'failed'] as Array<'processing' | 'failed'> };
  await ledger.addAttempt(status); await ledger.addAttempt(status);
  await ledger.addRecording(completion(job.botId));
  let stored = (await ledger.listDispatches())[0];
  assert.equal(stored.outcome, undefined);
  assert.equal(stored.attempts?.length, 2);
  assert.equal(stored.recording?.duration, 42);
  assert.equal(JSON.stringify(stored).includes('private-storage'), false);
  await pushResult(completion(job.botId)); await ledger.ingestResults();
  await ledger.addAttempt(status);
  await ledger.observe(job.botId, { state: 'unknown', reason: 'worker unavailable' });
  stored = (await ledger.listDispatches())[0];
  assert.equal(stored.state, 'completed');
  assert.equal(stored.outcome?.status, 'completed');
  assert.equal(stored.attempts?.length, 3);
});

test('permanent failure, late completion conflict and metadata conflicts retain all evidence', async () => {
  const job = record(); await ledger.enqueue(job);
  const failure = { ...completion(job.botId), status: 'failed', error: { type: 'LobbyTimeoutError', message: 'not admitted before timeout', retryable: false } };
  await pushResult(failure, true); await ledger.ingestResults();
  assert.equal((await ledger.listDispatches())[0].outcome?.status, 'failed');
  await pushResult(completion(job.botId)); await ledger.ingestResults();
  await pushResult(completion(job.botId)); await ledger.ingestResults();
  const stored = (await ledger.listDispatches())[0];
  assert.equal(stored.outcome?.status, 'unknown');
  assert.equal(stored.outcome?.conflict, true);
  assert.equal(stored.recording?.recordingId, 'recording-1');
  await ledger.addRecording(completion(job.botId, { metadata: { botId: job.botId, storage: { provider: 's3', bucket: 'fixture', key: 'different.webm' } } }));
  assert.equal((await ledger.listDispatches())[0].recording?.locationConflict, true);
  assert.equal((await ledger.history()).length, 1);
});

test('ingestion archives malformed and unscheduled entries before popping and signals backlog', async () => {
  await pushResult('{invalid'); await pushResult(completion()); await pushResult(completion('not-scheduled'));
  assert.equal((await ledger.ingestResults(1)).pending, true);
  assert.equal(await client.lLen(config.resultList), 2);
  assert.equal((await ledger.ingestResults()).pending, false);
  assert.equal(await client.lLen(key('archives')), 3);
  const diagnostics = await ledger.diagnostics();
  assert.equal(diagnostics.length, 3);
  assert.equal(diagnostics[0].kind, 'malformed result');
  assert.equal(JSON.stringify(diagnostics).includes('private-storage'), false);
  assert.deepEqual(await ledger.listDispatches(), []);
});

test('an outcome-write precondition failure retains source entry for safe replay', async () => {
  const job = record(); await ledger.enqueue(job); await pushResult(completion(job.botId));
  await client.set(key('history'), 'wrong-type');
  await assert.rejects(ledger.ingestResults(), /type/i);
  assert.equal(await client.lLen(config.resultList), 1);
  assert.equal((await ledger.listDispatches())[0].outcome, undefined);
  await client.del(key('history')); await ledger.ingestResults();
  assert.equal((await ledger.listDispatches())[0].outcome?.status, 'completed');
});

test('two workers claim distinct FIFO jobs while excess jobs remain pending', async () => {
  const jobs = [record(), record(), record()];
  for (const job of jobs) await ledger.enqueue(job);
  const consumers = await Promise.all(config.workers.map(async worker => {
    const consumer = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    await consumer.connect();
    try { return await consumer.blMove(config.queueName, worker.processingQueue, 'LEFT', 'RIGHT', 2); }
    finally { await consumer.close(); }
  }));
  assert.deepEqual(new Set(consumers), new Set(jobs.slice(0, 2).map(job => job.serializedPayload)));
  assert.deepEqual([...await ledger.pendingPayloads()], [jobs[2].serializedPayload]);
});

test('forced Redis restart preserves pending, processing, indexes and unconsumed results', { timeout: 90_000 }, async () => {
  const first = record(), second = record();
  await ledger.enqueue(first); await ledger.enqueue(second);
  await client.lMove(config.queueName, config.workers[0].processingQueue, 'LEFT', 'RIGHT');
  await pushResult(completion(first.botId));
  await client.close();
  docker('kill', '--signal', 'KILL', containerName);
  docker('start', containerName);
  const restartedPort = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', containerName))['6379/tcp'][0].HostPort;
  redisUrl = `redis://127.0.0.1:${restartedPort}`;
  client = createClient({ url: redisUrl, socket: { connectTimeout: 5_000, reconnectStrategy: retries => retries < 20 ? 50 : false } });
  client.on('error', () => undefined);
  await client.connect(); ledger = new RedisLedger(client, config);
  await ledger.checkPersistence();
  assert.equal((await ledger.listDispatches()).length, 2);
  assert.deepEqual([...await ledger.pendingPayloads()], [second.serializedPayload]);
  assert.deepEqual((await ledger.processingPayloads())['1'], [first.serializedPayload]);
  assert.equal(await client.lLen(config.resultList), 1);
  await ledger.ingestResults();
  assert.equal((await ledger.enqueue(first))?.outcome?.status, 'completed');
  assert.equal((await ledger.listDispatches()).length, 2);
});


test('lost command replies after enqueue, replacement, removal and ingestion never duplicate work', async () => {
  const first = record();
  await assert.rejects(losingReplyLedger().enqueue(first), /lost Redis reply/);
  await client.lMove(config.queueName, config.workers[0].processingQueue, 'LEFT', 'RIGHT');
  assert.equal((await ledger.enqueue(first))?.botId, first.botId);
  assert.equal((await ledger.pendingPayloads()).size, 0);
  const old = record(); await ledger.enqueue(old);
  const replacement = record(randomUUID(), old.memberInstanceKeys);
  await assert.rejects(losingReplyLedger().enqueue(replacement, old.botId), /lost Redis reply/);
  assert.equal((await ledger.enqueue(replacement, old.botId))?.botId, replacement.botId);
  assert.equal((await ledger.pendingPayloads()).size, 1);
  await assert.rejects(losingReplyLedger().remove(replacement.botId, 'cancelled'), /lost Redis reply/);
  assert.equal((await ledger.remove(replacement.botId, 'cancelled'))?.removedBeforePickup, true);
  await pushResult(completion(first.botId));
  await assert.rejects(losingReplyLedger().ingestResults(), /lost Redis reply/);
  assert.equal(await client.lLen(config.resultList), 0);
  await ledger.ingestResults();
  assert.equal((await ledger.listDispatches()).find(item => item.botId === first.botId)?.outcome?.status, 'completed');
});

test('late results resolve observation unknown without overwriting attached members or callbacks', async () => {
  const job = record(); await ledger.enqueue(job);
  await ledger.observe(job.botId, { state: 'unknown', workerId: '1', firstObservedAt: 123 });
  await ledger.attachMembers(job.botId, ['newly-grouped-instance']);
  await ledger.addLog({ botId: job.botId, provider: 'google', level: 'error', message: 'fixture attempt error', category: 'fixture', subCategory: 'fixture' });
  await pushResult(completion(job.botId)); await ledger.ingestResults();
  const stored = (await ledger.enqueue(job));
  assert.equal(stored?.outcome?.status, 'completed');
  assert.equal(stored?.workerId, '1');
  assert.equal(stored?.firstObservedAt, 123);
  assert.equal(stored?.logs?.length, 1);
  assert.ok(stored?.memberInstanceKeys.includes('newly-grouped-instance'));
  assert.equal((await ledger.enqueue(record(randomUUID(), ['newly-grouped-instance'])))?.botId, job.botId);
});

test('bounded visible history never expires dispatch identities or result deduplication', async () => {
  const jobs = Array.from({ length: 202 }, () => record());
  for (const job of jobs) {
    await ledger.enqueue(job);
    await pushResult(completion(job.botId));
  }
  while ((await ledger.ingestResults()).pending) { /* Drain the bounded batches before asserting outcomes. */ }
  assert.equal((await ledger.history()).length, 200);
  assert.equal((await ledger.listDispatches()).length, 202);
  assert.equal((await ledger.enqueue(record(randomUUID(), jobs[0].memberInstanceKeys)))?.botId, jobs[0].botId);
  await pushResult(completion(jobs[0].botId)); await ledger.ingestResults();
  assert.equal((await ledger.history()).length, 200);
  assert.equal(await client.sCard(key('seen')), 202);
});


test('scheduler process exit after Redis commit retains the dispatch for replay', async () => {
  const job = record();
  const script = `
    const { createClient } = require('redis');
    const { RedisLedger } = require('./src/scheduler/queue');
    (async () => {
      const connection = createClient({url: process.argv[1], socket: {reconnectStrategy: false}});
      await connection.connect();
      const originalEval = connection.eval.bind(connection);
      connection.eval = async (...args) => { await originalEval(...args); process.exit(0); };
      await new RedisLedger(connection, JSON.parse(process.argv[2])).enqueue(JSON.parse(process.argv[3]));
      process.exit(2);
    })().catch(() => process.exit(3));
  `;
  execFileSync(process.execPath, ['-r', 'ts-node/register', '-e', script, redisUrl, JSON.stringify(config), JSON.stringify(job)], { timeout: 10_000, stdio: 'pipe' });
  assert.equal((await ledger.enqueue(job))?.botId, job.botId);
  assert.deepEqual([...await ledger.pendingPayloads()], [job.serializedPayload]);
  assert.equal((await ledger.listDispatches()).length, 1);
});
