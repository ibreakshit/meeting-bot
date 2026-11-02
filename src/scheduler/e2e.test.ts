import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createClient } from 'redis';
import { loadConfig } from './config';
import { TokenCrypto } from './crypto';
import { GoogleCalendar } from './google';
import { RedisLedger } from './queue';
import { SchedulerRuntime } from './runtime';
import { SchedulerStore } from './store';
import { createSchedulerApp } from './web';
import type { CalendarEvent } from './types';

const docker = (...args: string[]): string => execFileSync('docker', args, {
  timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('scheduler HTTP, private recordings and two Redis workers preserve dispatch identity end to end', { timeout: 60_000 }, async t => {
  const containerName = `meeting-bot-e2e-${randomUUID()}`;
  const volumeName = `${containerName}-data`;
  const directory = await mkdtemp(join(tmpdir(), 'meeting-bot-e2e-'));
  const servers: Server[] = [];
  let volumeCreated = false;
  let containerCreated = false;
  const connections: Array<ReturnType<typeof createClient>> = [];
  let runtime: SchedulerRuntime | undefined;
  t.after(async () => {
    await runtime?.stop();
    for (const server of servers.reverse()) await close(server);
    for (const connection of connections) if (connection.isOpen) await connection.close();
    if (containerCreated) docker('rm', '-f', containerName);
    if (volumeCreated) docker('volume', 'rm', volumeName);
    await rm(directory, { recursive: true, force: true });
  });

  const workers = await Promise.all(['1', '2'].map(async id => {
    const state = { id, busy: false, paths: [] as string[] };
    const server = createServer((req, res) => {
      state.paths.push(req.url || '');
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/health') res.end(JSON.stringify({ timestamp: new Date().toISOString(), uptime: 1 }));
      else if (req.url === '/isbusy') res.end(JSON.stringify({ success: true, data: state.busy ? 1 : 0 }));
      else { res.statusCode = 404; res.end('{}'); }
    });
    servers.push(server);
    return { ...state, state, baseUrl: await listen(server), processingQueue: `fixture:processing:${id}` };
  }));
  docker('volume', 'create', volumeName); volumeCreated = true;
  docker('run', '-d', '--name', containerName, '-p', '127.0.0.1::6379', '-v', `${volumeName}:/data`,
    'redis:7-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'always',
    '--no-appendfsync-on-rewrite', 'no', '--aof-load-truncated', 'no', '--maxmemory-policy', 'noeviction');
  containerCreated = true;
  const redisPort = JSON.parse(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', containerName))['6379/tcp'][0].HostPort;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  const client = createClient({ url: redisUrl, socket: { connectTimeout: 5_000, reconnectStrategy: retries => retries < 20 ? 50 : false } });
  connections.push(client);
  client.on('error', () => undefined);
  await client.connect();

  // Configuration is an explicit synthetic environment; the owner's environment is never read.
  const config = loadConfig({
    GOOGLE_OAUTH_CLIENT_ID: 'fixture-google-client', GOOGLE_OAUTH_CLIENT_SECRET: 'fixture-google-secret',
    SCHEDULER_SECRET: Buffer.alloc(32, 7).toString('base64'), DASHBOARD_ALLOWED_EMAILS: 'owner@example.test',
    DASHBOARD_BASE_URLS: 'http://127.0.0.1:3001', SCHEDULER_BOT_NAME: 'Fixture Recorder',
    SCHEDULER_TEAM_ID: 'fixture-team', SCHEDULER_USER_ID: 'fixture-user',
    SCHEDULER_BEARER_TOKEN: 'fixture-bearer-secret', NOTIFY_WEBHOOK_SECRET: 'fixture-webhook-secret',
    S3_BUCKET_NAME: 'fixture-private', S3_REGION: 'fixture-region', S3_ENDPOINT: 'http://127.0.0.1:9',
    S3_ACCESS_KEY_ID: 'fixture-storage-key', S3_SECRET_ACCESS_KEY: 'fixture-storage-secret',
    S3_USE_MINIO_COMPATIBILITY: 'true', SCHEDULER_STATE_PATH: join(directory, 'state.json'),
    REDIS_HOST: '127.0.0.1', REDIS_PORT: redisPort, REDIS_QUEUE_NAME: 'fixture:pending',
    NOTIFY_REDIS_LIST: 'fixture:recordings', NOTIFY_REDIS_FAILURE_LIST: 'fixture:failures',
    SCHEDULER_WORKERS: JSON.stringify(workers.map(({ id, baseUrl, processingQueue }) => ({ id, baseUrl, processingQueue }))),
  });
  const now = Date.now();
  const crypto = new TokenCrypto(config.secret, () => now);
  const rooms = ['abc-defg-hij', 'klm-nopq-rst', 'uvw-xyza-bcd'];
  const events: CalendarEvent[] = rooms.map((room, index) => ({
    id: `event-${index + 1}`, iCalUID: `fixture-invite-${index + 1}`, summary: `Fixture meeting ${index + 1}`,
    hangoutLink: `https://meet.google.com/${room}`,
    start: { dateTime: new Date(now - 10_000 + index * 1000).toISOString() },
    end: { dateTime: new Date(now + 600_000 + index * 1000).toISOString() },
    attendees: [{ email: 'owner@example.test', responseStatus: 'accepted' }, { email: 'guest@example.test', responseStatus: 'accepted' }],
  }));
  const seed = new SchedulerStore(config.statePath);
  await seed.update(state => {
    state.accounts.push({ id: 'fixture-account', email: 'owner@example.test', refreshToken: crypto.encrypt('fixture-refresh-secret'), connectedAt: new Date(now).toISOString(), needsReconnect: false });
    state.calendars.push({ id: 'fixture-calendar', accountId: 'fixture-account', summary: 'Fixture calendar', timeZone: 'UTC', watched: true, events, verified: true, lastSuccess: now, lastAttemptSucceeded: true });
  });
  const store = new SchedulerStore(config.statePath);
  await store.load();
  assert.equal(store.read().calendars[0].verified, false, 'persisted snapshots must require a complete startup refresh');
  const requests: Array<{ path: string; params: Record<string, unknown> }> = [];
  const google = new GoogleCalendar(config, crypto, async (account, path, params) => {
    assert.equal(account.id, 'fixture-account');
    assert.equal(path, '/calendars/fixture-calendar/events');
    requests.push({ path, params });
    return params.pageToken ? { items: events.slice(1) } : { items: events.slice(0, 1), nextPageToken: 'fixture-next-page' };
  });
  const ledger = new RedisLedger(client, config);
  await ledger.initialize();
  runtime = new SchedulerRuntime(config, store, ledger, google, { now: () => now, random: () => 0 });
  await runtime.start({ timers: false });
  assert.equal(runtime.view().ready, true);
  assert.equal((await ledger.pendingPayloads()).size, 0, 'cached startup events cannot dispatch');
  await runtime.pollCalendars();
  assert.equal(requests.length, 2, 'the real Google adapter must follow pagination');
  assert.equal(requests[0].params.timeMin, requests[1].params.timeMin);
  await runtime.tick();
  assert.equal(runtime.view().lastError, undefined);
  const jobs = (await ledger.listDispatches()).sort((a, b) => a.scheduledStart - b.scheduledStart);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map(job => job.payload.url), rooms.map(room => `https://meet.google.com/${room}`));
  assert.equal((await ledger.pendingPayloads()).size, 3);

  const claims = await Promise.all(workers.map(async worker => {
    const consumer = createClient({ url: redisUrl, socket: { reconnectStrategy: false } });
    await consumer.connect();
    try {
      const payload = await consumer.blMove(config.queueName, worker.processingQueue, 'LEFT', 'RIGHT', 2);
      assert.ok(payload);
      worker.state.busy = true;
      return { workerId: worker.id, payload };
    } finally { await consumer.close(); }
  }));
  assert.deepEqual(new Set(claims.map(claim => claim.payload)), new Set(jobs.slice(0, 2).map(job => job.serializedPayload)));
  assert.deepEqual([...await ledger.pendingPayloads()], [jobs[2].serializedPayload]);
  await runtime.tick();
  assert.equal(runtime.view().queueDepth, 1);
  assert.ok(runtime.view().workers.every(worker => worker.reachable && worker.busy));
  const pickedUp = await ledger.listDispatches();
  for (const claim of claims) {
    const execution = pickedUp.find(job => job.serializedPayload === claim.payload);
    assert.equal(execution?.workerId, claim.workerId);
    assert.equal(execution?.state, 'picked_up');
  }
  for (const worker of workers) assert.ok(worker.state.paths.includes('/health') && worker.state.paths.includes('/isbusy'));

  const recordingBytes = Buffer.from('fixture-private-recording-bytes');
  const storageCalls: Array<HeadObjectCommand | GetObjectCommand> = [];
  const s3 = {
    async send(command: HeadObjectCommand | GetObjectCommand) {
      storageCalls.push(command);
      assert.equal(command.input.Bucket, config.s3.bucket);
      assert.equal(command.input.Key, 'fixture-recording.webm');
      const metadata = { ContentLength: recordingBytes.length, ContentType: 'video/webm', ETag: '"fixture-version"', LastModified: new Date(now) };
      if (command instanceof HeadObjectCommand) return metadata;
      assert.equal(command.input.IfMatch, metadata.ETag);
      const range = command.input.Range ? /^bytes=(\d+)-(\d+)$/.exec(command.input.Range) : undefined;
      const bytes = range ? recordingBytes.subarray(Number(range[1]), Number(range[2]) + 1) : recordingBytes;
      return { ...metadata, ContentLength: bytes.length, Body: Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]) };
    },
  };
  const app = createSchedulerApp({ config, store, ledger, google, crypto, runtime, s3 });
  const dashboard = createServer(app); servers.push(dashboard);
  const baseUrl = await listen(dashboard); config.baseUrls = [baseUrl];
  const ownerCookie = `scheduler_session=${crypto.signCookie({ email: 'owner@example.test' }, 3600)}`;
  const http = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  const first = jobs[0];
  const callback = await http('/v2/meeting/app/bot/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.bearerToken}` }, body: JSON.stringify({ botId: first.botId, provider: first.payload.provider, eventId: first.payload.eventId, status: ['processing', 'joined', 'finished'] }) });
  assert.equal(callback.status, 200);
  assert.deepEqual(await callback.json(), { success: true });
  let storedFirst = (await ledger.listDispatches()).find(job => job.botId === first.botId);
  assert.equal(storedFirst?.attempts?.length, 1);
  assert.equal(storedFirst?.outcome, undefined, 'attempt finished is not an upload outcome');
  assert.equal(storedFirst?.state, 'picked_up');
  await client.rPush(config.resultList, JSON.stringify({
    recordingId: 'fixture-recording', status: 'completed', timestamp: new Date(now).toISOString(),
    blobUrl: 'http://127.0.0.1:9/private-recording-storage-url',
    metadata: { botId: first.botId, contentType: 'video/webm', duration: 42, storage: { provider: 's3', bucket: config.s3.bucket, key: 'fixture-recording.webm', endpoint: 'http://127.0.0.1:9/untrusted-notification-endpoint' } },
  }));
  await runtime.tick();
  storedFirst = (await ledger.listDispatches()).find(job => job.botId === first.botId);
  assert.equal(storedFirst?.outcome?.status, 'completed');
  assert.equal(storedFirst?.recording?.duration, 42);
  assert.equal(await client.lLen(config.resultList), 0);
  assert.ok(runtime.view().workers.every(worker => worker.busy), 'successful upload must not imply worker availability');

  assert.equal((await http('/')).status, 401);
  const schedule = await http('/', { headers: { Cookie: ownerCookie } });
  assert.equal(schedule.status, 200);
  const html = await schedule.text();
  assert.ok(html.includes('Fixture meeting 1') && html.includes(`/recordings/${first.botId}/download`));
  for (const secret of [config.bearerToken, config.webhookSecret, config.googleClientSecret, config.s3.accessKeyId, config.s3.secretAccessKey, 'fixture-refresh-secret', 'private-recording-storage-url', 'untrusted-notification-endpoint']) assert.equal(html.includes(secret), false, `schedule leaked ${secret}`);
  const downloadPath = `/recordings/${first.botId}/download`;
  const denied = await http(downloadPath);
  assert.equal(denied.status, 401);
  await denied.text();
  assert.equal(storageCalls.length, 0, 'unauthenticated download must stop before storage access');
  const full = await http(downloadPath, { headers: { Cookie: ownerCookie } });
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), recordingBytes);
  const partial = await http(downloadPath, { headers: { Cookie: ownerCookie, Range: 'bytes=3-10', 'If-Range': '"fixture-version"' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('Content-Range'), `bytes 3-10/${recordingBytes.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), recordingBytes.subarray(3, 11));
  assert.equal(storageCalls.length, 4);
  assert.ok([...partial.headers.values()].every(value => !value.includes('127.0.0.1:9')));

  const pending = jobs[2];
  const group = runtime.view().groups.find(item => item.memberKeys.some(key => pending.memberInstanceKeys.includes(key)));
  assert.ok(group);
  const overridePath = `/groups/${encodeURIComponent(group.id)}/override`;
  const setOverride = (mode: 'skip' | 'automatic') => http(overridePath, { method: 'POST', headers: { Cookie: ownerCookie, Origin: baseUrl, 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
  const skipped = await setOverride('skip');
  assert.equal(skipped.status, 200);
  assert.deepEqual(await skipped.json(), { success: true });
  assert.equal((await ledger.pendingPayloads()).size, 0);
  assert.equal((await ledger.listDispatches()).find(job => job.botId === pending.botId)?.removedBeforePickup, true);
  const reset = await setOverride('automatic');
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { success: true });
  const afterReset = await ledger.listDispatches();
  assert.equal(afterReset.length, 4);
  const replacement = afterReset.find(job => job.botId !== pending.botId && job.memberInstanceKeys.some(key => pending.memberInstanceKeys.includes(key)));
  assert.ok(replacement);
  assert.notEqual(replacement.botId, pending.botId);
  assert.deepEqual([...await ledger.pendingPayloads()], [replacement.serializedPayload]);
  assert.equal(afterReset.filter(job => job.memberInstanceKeys.some(key => first.memberInstanceKeys.includes(key))).length, 1, 'completed execution must never automatically rejoin');
  await runtime.tick();
  assert.equal((await ledger.listDispatches()).length, 4);

  // A fresh process loads display-only snapshots, withdraws only the unclaimed
  // entry, then a fresh poll can dispatch that confirmed removal once again.
  await runtime.stop();
  const reloadedStore = new SchedulerStore(config.statePath); await reloadedStore.load();
  runtime = new SchedulerRuntime(config, reloadedStore, ledger, google, { now: () => now, random: () => 0 });
  await runtime.start({ timers: false });
  assert.equal((await ledger.pendingPayloads()).size, 0);
  assert.equal((await ledger.listDispatches()).find(job => job.botId === replacement.botId)?.removedBeforePickup, true);
  await runtime.pollCalendars(); await runtime.tick();
  assert.equal((await ledger.pendingPayloads()).size, 1);
  const afterRestart = await ledger.listDispatches();
  assert.equal(afterRestart.length, 5);
  assert.equal(afterRestart.filter(job => job.memberInstanceKeys.some(key => first.memberInstanceKeys.includes(key))).length, 1);
  assert.equal((await ledger.processingPayloads())['1'].length, 1);
  assert.equal((await ledger.processingPayloads())['2'].length, 1);
});
