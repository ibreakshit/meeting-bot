import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config';
import { TokenCrypto } from './crypto';
import { SchedulerStore } from './store';
import { getBotSettings } from './settings';

const environment = {
  GOOGLE_OAUTH_CLIENT_ID: 'client', GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  SCHEDULER_SECRET: Buffer.alloc(32, 7).toString('base64'),
  DASHBOARD_ALLOWED_EMAILS: ' OWNER@example.test ', DASHBOARD_BASE_URLS: 'http://localhost:3001,https://host.example.ts.net',
  SCHEDULER_BOT_NAME: 'Recorder', SCHEDULER_TEAM_ID: 'team', SCHEDULER_USER_ID: 'user',
  SCHEDULER_BEARER_TOKEN: 'test-bearer', NOTIFY_WEBHOOK_SECRET: 'test-hook',
  S3_BUCKET_NAME: 'recordings', S3_REGION: 'local', S3_ACCESS_KEY_ID: 'test-access', S3_SECRET_ACCESS_KEY: 'test-secret',
};

test('bot settings use the environment default until configured and return an isolated snapshot', () => {
  const state = { version: 1 as const, accounts: [], calendars: [], overrides: {}, overrideRevision: 0 };
  assert.deepEqual(getBotSettings(state, 'Existing recorder'), { name: 'Existing recorder' });
  const configured = { ...state, botSettings: { name: 'Custom recorder', thumbnailId: 'a'.repeat(64) } };
  const settings = getBotSettings(configured, 'Existing recorder');
  assert.deepEqual(settings, configured.botSettings);
  settings.name = 'Changed locally';
  assert.equal(configured.botSettings.name, 'Custom recorder');
});

test('configuration validates trust boundaries and defaults to two distinct workers', () => {
  const config = loadConfig(environment);
  assert.equal(config.workers.length, 2);
  assert.equal(config.maxSnapshotAgeSeconds, 300);
  assert.equal(config.joinLeadSeconds, 60);
  assert.deepEqual(config.allowedEmails, ['owner@example.test']);
  assert.throws(() => loadConfig({}), /required|missing/i);
  assert.throws(() => loadConfig({ ...environment, SCHEDULER_SECRET: 'short' }), /secret/i);
  assert.throws(() => loadConfig({ ...environment, DASHBOARD_BASE_URLS: 'http://unsafe.example.test' }), /https|origin/i);
  assert.throws(() => loadConfig({ ...environment, SCHEDULER_MAX_SNAPSHOT_AGE_SECONDS: 'NaN' }), /snapshot|positive|integer/i);
  assert.throws(() => loadConfig({ ...environment, NOTIFY_REDIS_URI: 'redis://another-redis:6379' }), /same Redis/i);
  assert.throws(() => loadConfig({ ...environment, SCHEDULER_WORKERS: JSON.stringify([
    { id: '1', baseUrl: 'http://worker1:3000', processingQueue: 'same' },
    { id: '2', baseUrl: 'http://worker2:3000', processingQueue: 'same' },
  ]) }), /unique|duplicate|processing/i);
});

test('dashboard base paths default to root and reject ambiguous or unsafe URL paths', () => {
  assert.equal(Reflect.get(loadConfig(environment), 'basePath'), '');
  for (const [value, expected] of [['', ''], ['/', ''], ['/meeting-bot', '/meeting-bot'], ['/tools/meeting-bot', '/tools/meeting-bot']]) {
    assert.equal(Reflect.get(loadConfig({ ...environment, SCHEDULER_BASE_PATH: value }), 'basePath'), expected);
  }
  for (const value of ['meeting-bot', '//host', '/meeting-bot/', '/a//b', '/a/../b', '/a/./b', '/%2e%2e', '/a?b', '/a#b', '/a\\b', '/a b', '/a;Path=/']) {
    assert.throws(() => loadConfig({ ...environment, SCHEDULER_BASE_PATH: value }), /SCHEDULER_BASE_PATH/);
  }
  assert.throws(() => loadConfig({ ...environment, DASHBOARD_BASE_URLS: 'https://host.example.ts.net/meeting-bot' }), /origin|path/i);
});

test('refresh tokens are authenticated and cookies expire and reject tampering', () => {
  let now = 1_800_000_000_000;
  const crypto = new TokenCrypto(Buffer.alloc(32, 1), () => now);
  const first = crypto.encrypt('private-refresh');
  const second = crypto.encrypt('private-refresh');
  assert.notEqual(first, second);
  assert.equal(crypto.decrypt(first), 'private-refresh');
  assert.throws(() => crypto.decrypt(first.slice(0, -2) + 'xx'));
  const cookie = crypto.signCookie({ email: 'owner@example.test' }, 60);
  assert.equal(crypto.verifyCookie<{ email: string }>(cookie)?.email, 'owner@example.test');
  assert.equal(crypto.verifyCookie(cookie + 'x'), null);
  now += 60_000;
  assert.equal(crypto.verifyCookie(cookie), null);
});

test('JSON updates serialize, protect snapshots and reset verification at startup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-store-'));
  try {
    const path = join(directory, 'state.json');
    const store = new SchedulerStore(path);
    await store.load();
    await Promise.all(Array.from({ length: 12 }, () => store.update(state => { state.overrideRevision++; })));
    assert.equal(store.read().overrideRevision, 12);
    const snapshot = store.read();
    snapshot.overrideRevision = -1;
    assert.equal(store.read().overrideRevision, 12);
    await store.update(state => { state.calendars.push({
      id: 'calendar', accountId: 'account', summary: 'Work', timeZone: 'UTC', watched: true,
      events: [], verified: true, lastSuccess: Date.now(),
    }); });
    const restarted = new SchedulerStore(path);
    await restarted.load();
    assert.equal(restarted.read().calendars[0].verified, false);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).overrideRevision, 12);
    await writeFile(path, '{ broken');
    await assert.rejects(() => new SchedulerStore(path).load(), /JSON|state/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed save remains dirty and retries without another state change', async () => {
  let fail = true;
  let saved = '';
  const store = new SchedulerStore('/unused', async (_path, data) => {
    if (fail) throw new Error('disk unavailable');
    saved = data;
  });
  await assert.rejects(() => store.update(state => { state.overrideRevision = 2; }), /disk unavailable/);
  assert.equal(store.isDirty, true);
  assert.equal(store.read().overrideRevision, 0);
  fail = false;
  await store.flush();
  assert.equal(store.isDirty, false);
  assert.equal(JSON.parse(saved).overrideRevision, 2);
  assert.equal(store.read().overrideRevision, 2);
});

test('bot settings persist across restart and malformed saved settings fail closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-settings-'));
  const path = join(directory, 'state.json');
  try {
    const store = new SchedulerStore(path);
    await store.update(state => { state.botSettings = { name: 'Personal recorder', thumbnailId: 'a'.repeat(64) }; });
    const restarted = new SchedulerStore(path);
    await restarted.load();
    assert.deepEqual(restarted.read().botSettings, store.read().botSettings);
    for (const botSettings of [null, { name: '' }, { name: 'x'.repeat(101) }, { name: 'Bad\nname' }, { name: 'Bad\u0080name' }, { name: 'Recorder', thumbnailId: '../private' }]) {
      await writeFile(path, JSON.stringify({ ...store.read(), botSettings }));
      await assert.rejects(() => new SchedulerStore(path).load(), /bot settings/i);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
