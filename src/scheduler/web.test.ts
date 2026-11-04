import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
// Node fetch rewrites Host. Raw HTTP keeps the reverse-proxy Host under test.
function fetch(url: string, options: RequestInit = {}): Promise<Response> {
    return new Promise((resolve, reject) => { const req = request(url, { method: options.method, headers: options.headers as Record<string, string> }, res => { const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { const headers = new Headers(); for (const [key, value] of Object.entries(res.headers))
        if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(', ') : value); resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: res.statusCode, headers })); }); }); req.on('error', reject); req.end(options.body as string | undefined); });
}
import type { AddressInfo } from 'node:net';
import { createSchedulerApp, SchedulerWebDependencies } from './web';
import type { DispatchRecord, MeetingGroup, OAuthIdentity, SchedulerConfig } from './types';
import { emptyState } from './types';
import { InvalidBotThumbnailError } from './thumbnails';

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  assert.ok(value, `Expected ${name} response header`);
  return value;
}
function requiredState(destination: string): string {
  const state = new URL(destination).searchParams.get('state');
  assert.ok(state, 'OAuth URL must contain state');
  return state;
}
function meetingGroup(patch: Partial<MeetingGroup> = {}): MeetingGroup {
  return {
    id: 'g', memberKeys: ['k'], start: Date.now(), end: Date.now() + 1000,
    join: true, reason: 'accepted',
    members: [{ key: 'k', calendarKey: 'c', accountId: 'a', calendarId: 'c',
      calendarSummary: 'Work', timeZone: 'UTC', event: { id: 'e', summary: 'Meeting' },
      start: Date.now(), end: Date.now() + 1000, eligible: true,
      sourceStatus: 'current', decision: { join: true, reason: 'accepted' } }],
    ...patch,
  };
}
function dispatchRecord(patch: Partial<DispatchRecord> = {}): DispatchRecord {
  const payload = { botId: 'b', eventId: 'e', provider: 'google' as const,
    url: 'https://meet.google.com/abc-defg-hij', name: 'Test bot', timezone: 'UTC',
    teamId: 'team', userId: 'user', bearerToken: 'test-bearer' };
  return { botId: 'b', payload, serializedPayload: JSON.stringify(payload),
    memberInstanceKeys: ['k'], pushedAt: Date.now(), scheduledStart: Date.now(),
    scheduledEnd: Date.now() + 1000, state: 'unknown', ...patch };
}

function fixture() {
    const state = emptyState();
    const reports: unknown[] = [];
    let fail = false;
    const config: SchedulerConfig = { port: 3001, googleClientId: 'client', googleClientSecret: 'client-secret', secret: Buffer.alloc(32), ownerAliases: [], botName: 'Test bot', teamId: 'team', userId: 'user', joinLeadSeconds: 60, statePath: '/unused', redisUrl: 'redis://localhost:6379', queueName: 'pending', resultList: 'results', failureList: 'failures', baseUrls: ['http://localhost:3001', 'https://owner.tail.ts.net'], allowedEmails: ['owner@example.com'], bearerToken: 'test-bearer', webhookSecret: 'hook-secret', maxSnapshotAgeSeconds: 300, workers: [{ id: '1', baseUrl: 'http://worker:3000', processingQueue: 'processing:1' }], s3: { bucket: 'private', region: 'local', accessKeyId: 'secret', secretAccessKey: 'secret', forcePathStyle: true } };
    const crypto = { encrypt: (v: string) => `encrypted:${v}`, decrypt: (v: string) => v.slice(10), signCookie: (p: unknown) => Buffer.from(JSON.stringify(p)).toString('base64url'), verifyCookie: <T>(v: string): T | null => { try {
            return JSON.parse(Buffer.from(v, 'base64url').toString());
        }
        catch {
            return null;
        } } };
    let identity: OAuthIdentity = { id: 'owner', email: 'owner@example.com', refreshToken: 'refresh', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] };
    const deps: SchedulerWebDependencies = { config, crypto, store: { read: () => structuredClone(state), update: async (fn) => { if (fail)
                throw Error('disk'); await fn(state); } }, ledger: { listDispatches: async () => [], history: async () => [], addAttempt: async (v) => { if (fail)
                throw Error('redis'); reports.push(v); }, addLog: async (v) => reports.push(v), addRecording: async (v) => reports.push(v) }, google: { authorizationUrl: (_f: string, _r: string, s: string) => `https://accounts.google.com/?state=${s}`, completeOAuth: async () => identity, listCalendars: async () => [{ id: 'c', summary: 'Work', timeZone: 'UTC' }], revokeAccount: async () => undefined }, runtime: { view: () => ({ ready: true, groups: [], workers: [], queueDepth: 0, ingestionPending: false }), tick: async () => undefined, invite: async () => { throw Error('Manual invitation unavailable in this fixture'); } } };
    return { deps, state, reports, crypto, setIdentity: (v: OAuthIdentity) => { identity = v; }, setFail: () => { fail = true; } };
}
async function server(f: ReturnType<typeof fixture>, run: (url: string) => Promise<void>) {
    const app = createSchedulerApp(f.deps);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    }
}
const host = { Host: 'localhost:3001' };
const cookie = (f: ReturnType<typeof fixture>, email = 'owner@example.com') => {
  const suffix = f.deps.config.basePath ? `_${Buffer.from(f.deps.config.basePath).toString('base64url')}` : '';
  return `scheduler_session${suffix}=${f.crypto.signCookie({ email })}`;
};

test('Schedule orders meetings and distinguishes stale, busy and missing worker observations', async () => {
  const f = fixture();
  const now = Date.now();
  f.deps.config.workers.push(
    { id: '2', baseUrl: 'http://worker2:3000', processingQueue: 'processing:2' },
    { id: '3', baseUrl: 'http://worker3:3000', processingQueue: 'processing:3' },
  );
  f.deps.runtime.view = () => ({ ready: true, queueDepth: 4, ingestionPending: false,
    workers: [
      { id: '1', reachable: true, busy: false, observedAt: now - 60_000 },
      { id: '2', reachable: true, busy: true, observedAt: now },
    ],
    groups: [
      meetingGroup({ id: 'later', start: now + 7200000, end: now + 9000000 }),
      meetingGroup({ id: 'earlier', start: now + 3600000, end: now + 5400000 }),
    ],
  });
  await server(f, async url => {
    const response = await fetch(url + '/', { headers: { ...host, Cookie: cookie(f) } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /aria-label="Bot availability"/);
    assert.match(html, /Worker 1[\s\S]*?Stale observation/);
    assert.match(html, /Worker 2[\s\S]*?Busy/);
    assert.match(html, /Worker 3[\s\S]*?Not observed/);
    assert.doesNotMatch(html, />Idle</);
    assert.ok(html.indexOf('/groups/earlier/override') < html.indexOf('/groups/later/override'));
    assert.match(html, /<time datetime="[^\"]+" data-format="time">/);
    assert.match(html, /<strong>4<\/strong><span>meetings queued<\/span>/);
    assert.match(html, /href="#main"/);
  });
});

test('manual invitation endpoint requires an owner and same-origin submission', async () => {
  const f = fixture();
  f.deps.config.basePath = '/meeting-bot';
  const submitted: unknown[] = [];
  f.deps.runtime.invite = async request => { submitted.push(request); return dispatchRecord({ state: 'queued', source: 'manual' }); };
  await server(f, async url => {
    const path = url + '/meeting-bot/invitations';
    const body = JSON.stringify({ url: 'https://meet.google.com/abc-defg-hij', requestId: '9df2b010-93ce-4b29-9191-53f21b15c110', timezone: 'Asia/Seoul' });
    const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Cookie: '' }, body })).status, 401);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Origin: 'https://wrong.example' }, body })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'X-Scheduler-Request': '' }, body })).status, 403);
    assert.equal((await fetch(path, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.deepEqual(submitted, []);
    const invited = await fetch(path, { method: 'POST', headers, body });
    assert.equal(invited.status, 200);
    assert.equal((await invited.json() as { botId: string }).botId, 'b');
    assert.equal(submitted.length, 1);
  });
});

test('Accounts identifies each account default calendar without enabling watching', async () => {
  const f = fixture();
  f.state.accounts.push(
    { id: 'personal', email: 'owner@example.com', refreshToken: 'encrypted:r', connectedAt: 'now', needsReconnect: false },
    { id: 'work', email: 'work@example.com', refreshToken: 'encrypted:r', connectedAt: 'now', needsReconnect: false },
  );
  f.state.calendars.push(
    { accountId: 'personal', id: 'renamed-id', summary: 'Personal', primary: true, timeZone: 'UTC', watched: false, events: [] },
    { accountId: 'personal', id: 'work@example.com', summary: 'Work shared copy', primary: false, timeZone: 'UTC', watched: false, events: [] },
    { accountId: 'work', id: 'work@example.com', summary: 'Renamed work calendar', timeZone: 'UTC', watched: false, events: [] },
    { accountId: 'work', id: 'secondary', summary: 'Personal', primary: false, timeZone: 'UTC', watched: false, events: [] },
  );
  await server(f, async url => {
    const response = await fetch(url + '/accounts', { headers: { ...host, Cookie: cookie(f) } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.equal((html.match(/>Default calendar<\/span>/g) || []).length, 2);
    assert.match(html, /Personal <span class="badge">Default calendar<\/span>/);
    assert.match(html, /Renamed work calendar <span class="badge">Default calendar<\/span>/);
    assert.doesNotMatch(html, /Work shared copy <span class="badge">Default calendar<\/span>/);
    assert.doesNotMatch(html, /data-calendar="[^"]+" checked/);
    assert.equal(f.state.calendars.filter(calendar => calendar.watched).length, 0);
  });
});

test('mounted dashboard ignores legacy root sessions before login and after logout', async () => {
  const f = fixture();
  f.deps.config.basePath = '/meeting-bot';
  await server(f, async url => {
    const legacySession = `scheduler_session=${f.crypto.signCookie({ email: 'owner@example.com' })}`;
    assert.equal((await fetch(url + '/meeting-bot/', { headers: { ...host, Cookie: legacySession } })).status, 401);
    const start = await fetch(url + '/meeting-bot/auth/login', { headers: host });
    const oauthCookie = requiredHeader(start, 'set-cookie').split(';')[0];
    const callback = await fetch(url + '/meeting-bot/auth/callback?code=x&state=' + requiredState(requiredHeader(start, 'location')), { headers: { ...host, Cookie: oauthCookie } });
    assert.equal(callback.status, 302);
    const sessionCookie = requiredHeader(callback, 'set-cookie').split(', ').find(value => value.startsWith('scheduler_session_L21lZXRpbmctYm90='))?.split(';')[0];
    assert.ok(sessionCookie, 'Login must issue a mount-specific session cookie');
    const staleRootSession = `scheduler_session=${f.crypto.signCookie({ email: 'stranger@example.com' })}`;
    const otherMountSession = `scheduler_session_L290aGVy=${f.crypto.signCookie({ email: 'owner@example.com' })}`;
    assert.equal((await fetch(url + '/meeting-bot/', { headers: { ...host, Cookie: otherMountSession } })).status, 401);
    for (const value of [`${sessionCookie}; ${staleRootSession}`, `${staleRootSession}; ${sessionCookie}`]) {
      assert.equal((await fetch(url + '/meeting-bot/', { headers: { ...host, Cookie: value } })).status, 200);
    }
    const logout = await fetch(url + '/meeting-bot/auth/logout', { method: 'POST', headers: { ...host, Cookie: `${sessionCookie}; ${legacySession}`, Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1' } });
    assert.equal(logout.status, 200);
    assert.match(requiredHeader(logout, 'set-cookie'), /^scheduler_session_L21lZXRpbmctYm90=; Path=\/meeting-bot;/);
    assert.equal((await fetch(url + '/meeting-bot/', { headers: { ...host, Cookie: legacySession } })).status, 401);
  });
});

test('mounted OAuth ignores root flow cookies regardless of their request ordering', async () => {
  const f = fixture();
  f.deps.config.basePath = '/meeting-bot';
  await server(f, async url => {
    const legacyOAuth = `scheduler_oauth=${f.crypto.signCookie({ nonce: 'legacy', flow: 'login', origin: 'http://localhost:3001' })}`;
    assert.equal((await fetch(url + '/meeting-bot/auth/callback?code=x&state=legacy', { headers: { ...host, Cookie: legacyOAuth } })).status, 400);
    for (const rootCookieFirst of [true, false]) {
      const start = await fetch(url + '/meeting-bot/auth/login', { headers: host });
      const oauthCookie = requiredHeader(start, 'set-cookie').split(';')[0];
      assert.match(oauthCookie, /^scheduler_oauth_L21lZXRpbmctYm90=/);
      const value = rootCookieFirst ? `${legacyOAuth}; ${oauthCookie}` : `${oauthCookie}; ${legacyOAuth}`;
      const callback = await fetch(url + '/meeting-bot/auth/callback?code=x&state=' + requiredState(requiredHeader(start, 'location')), { headers: { ...host, Cookie: value } });
      assert.equal(callback.status, 302);
    }
  });
});

test('dashboard subpath keeps navigation, controls and recording downloads inside its mount', async () => {
  const f = fixture();
  Object.assign(f.deps.config, { basePath: '/meeting-bot' });
  f.state.accounts.push({ id: 'a', email: 'connected@example.com', refreshToken: 'encrypted:r', connectedAt: 'now', needsReconnect: true });
  f.state.calendars.push({ accountId: 'a', id: 'c', summary: 'Work', timeZone: 'UTC', watched: true, events: [] });
  f.deps.runtime.view = () => ({ ready: true, groups: [meetingGroup()], workers: [], queueDepth: 0, ingestionPending: false });
  f.deps.ledger.listDispatches = async () => [dispatchRecord({ recording: { botId: 'b', recordingId: 'r', timestamp: new Date().toISOString(), storage: { provider: 's3', bucket: 'private', key: 'b.mp4' } } })];
  f.deps.ledger.history = f.deps.ledger.listDispatches;
  await server(f, async url => {
    const signedOut = await fetch(url + '/meeting-bot', { headers: host });
    assert.equal(signedOut.status, 401);
    assert.ok((await signedOut.text()).includes('href="/meeting-bot/auth/login"'));
    const headers = { ...host, Cookie: cookie(f) };
    for (const path of ['/meeting-bot', '/meeting-bot/', '/meeting-bot/history', '/meeting-bot/accounts']) {
      const response = await fetch(url + path, { headers });
      assert.equal(response.status, 200);
      const html = await response.text();
      const localUrls = [...html.matchAll(/(?:href|data-url)="(\/[^\"]*)"/g)].map(match => match[1]);
      assert.ok(localUrls.length >= 5);
      assert.ok(localUrls.every(value => value.startsWith('/meeting-bot/')), JSON.stringify(localUrls));
      assert.ok(html.includes('fetch("/meeting-bot/calendars/watch"'));
      assert.ok(html.includes('location.assign("/meeting-bot/")'));
      if (path.endsWith('/history')) assert.ok(html.includes('data-meeting-bot="b"') && html.includes('View meeting'));
      if (path === '/meeting-bot/') assert.ok(html.includes('data-url="/meeting-bot/groups/g/override"'));
      if (path.endsWith('/accounts')) assert.ok(html.includes('data-url="/meeting-bot/accounts/a/disconnect"'));
    }
    assert.equal((await fetch(url + '/meeting-bot/recordings/missing/download', { headers })).status, 404);
    assert.equal((await fetch(url + '/meeting-bot/recordings/b/download', { headers: host })).status, 401);
    for (const path of ['/', '/auth/login', '/accounts', '/history', '/recordings/b/download', '/meeting-bot-other']) {
      assert.equal((await fetch(url + path, { headers })).status, 404);
    }
  });
});

test('subpath OAuth callback URLs, redirects and cookies retain the trusted origin and mount', async () => {
  const f = fixture();
  Object.assign(f.deps.config, { basePath: '/meeting-bot' });
  const callbackUris: string[] = [];
  f.deps.google.authorizationUrl = (_flow, redirectUri, state) => {
    callbackUris.push(redirectUri);
    return `https://accounts.google.com/?state=${state}`;
  };
  f.deps.google.completeOAuth = async (_code, redirectUri) => {
    callbackUris.push(redirectUri);
    return { id: 'owner', email: 'owner@example.com', refreshToken: 'refresh', scopes: ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] };
  };
  await server(f, async url => {
    const headers = { Host: 'owner.tail.ts.net', Cookie: cookie(f), Origin: 'https://owner.tail.ts.net', 'X-Scheduler-Request': '1' };
    for (const flow of ['login', 'connect']) {
      const start = await fetch(url + '/meeting-bot/auth/' + flow, { method: flow === 'connect' ? 'POST' : 'GET', headers: { ...headers, 'X-Forwarded-Host': 'evil.example' } });
      assert.equal(start.status, flow === 'connect' ? 200 : 302);
      const destination = flow === 'connect' ? (await start.json() as { url: string }).url : requiredHeader(start, 'location');
      assert.match(requiredHeader(start, 'set-cookie'), /Path=\/meeting-bot;/);
      assert.match(requiredHeader(start, 'set-cookie'), /Secure/);
      const oauthCookie = requiredHeader(start, 'set-cookie').split(';')[0];
      const callback = await fetch(url + '/meeting-bot/auth/callback?code=x&state=' + requiredState(destination), { headers: { ...headers, Cookie: `${oauthCookie}; ${cookie(f)}` } });
      assert.equal(callback.status, 302);
      assert.equal(requiredHeader(callback, 'location'), flow === 'login' ? '/meeting-bot/' : '/meeting-bot/accounts');
      assert.match(requiredHeader(callback, 'set-cookie'), /scheduler_oauth_L21lZXRpbmctYm90=; Path=\/meeting-bot;/);
      if (flow === 'login') assert.match(requiredHeader(callback, 'set-cookie'), /scheduler_session_L21lZXRpbmctYm90=[^;]+;[^,]*Path=\/meeting-bot;/);
    }
    assert.deepEqual(callbackUris, Array(4).fill('https://owner.tail.ts.net/meeting-bot/auth/callback'));
    assert.equal((await fetch(url + '/meeting-bot/auth/login', { headers: { Host: 'evil.example' } })).status, 400);
    assert.equal((await fetch(url + '/meeting-bot/auth/logout', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
    const logout = await fetch(url + '/meeting-bot/auth/logout', { method: 'POST', headers });
    assert.equal(logout.status, 200);
    assert.match(requiredHeader(logout, 'set-cookie'), /scheduler_session_L21lZXRpbmctYm90=; Path=\/meeting-bot;/);
  });
});

test('subpath dashboard controls persist while health and authenticated worker callbacks stay at root', async () => {
  const f = fixture();
  Object.assign(f.deps.config, { basePath: '/meeting-bot' });
  f.state.calendars.push({ accountId: 'a', id: 'c', summary: 'Work', timeZone: 'UTC', watched: false, events: [] });
  f.deps.runtime.view = () => ({ ready: true, groups: [meetingGroup()], workers: [], queueDepth: 0, ingestionPending: false });
  await server(f, async url => {
    const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/meeting-bot/calendars/watch', { method: 'POST', headers, body: JSON.stringify({ accountId: 'a', calendarId: 'c', watched: true }) })).status, 200);
    assert.equal(f.state.calendars[0].watched, true);
    assert.equal((await fetch(url + '/meeting-bot/groups/g/override', { method: 'POST', headers, body: JSON.stringify({ mode: 'skip' }) })).status, 200);
    assert.equal(f.state.overrides.k.mode, 'skip');
    assert.equal((await fetch(url + '/health')).status, 200);
    const body = JSON.stringify({ botId: 'b', provider: 'google', status: ['joined'] });
    assert.equal((await fetch(url + '/v2/meeting/app/bot/status', { method: 'PATCH', headers: { Authorization: 'Bearer test-bearer', 'Content-Type': 'application/json' }, body })).status, 200);
    const raw = JSON.stringify({ recordingId: 'r', status: 'completed', timestamp: new Date().toISOString(), metadata: { botId: 'b' } });
    assert.equal((await fetch(url + '/hooks/recording-completed', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': createHmac('sha256', 'hook-secret').update(raw).digest('hex') }, body: raw })).status, 200);
    for (const path of ['/meeting-bot/health', '/meeting-bot/v2/meeting/app/bot/status', '/meeting-bot/hooks/recording-completed']) assert.equal((await fetch(url + path)).status, 404);
    assert.equal(f.reports.length, 2);
  });
});

test('dashboard and downloads require an allowlisted session; hostile Host rejected', async () => {
    const f = fixture();
    let storageCalls = 0;
    f.deps.s3 = { send: async () => { storageCalls++; throw Error('Unexpected storage access'); } };
    await server(f, async (u) => {
        assert.equal((await fetch(u + '/', { headers: host, redirect: 'manual' })).status, 401);
        assert.equal((await fetch(u + '/recordings/b/download', { headers: host })).status, 401);
        assert.equal((await fetch(u + '/recordings/b/download', { method: 'HEAD', headers: host })).status, 401);
        assert.equal((await fetch(u + '/recordings/b/download', { method: 'HEAD', headers: { ...host, Cookie: cookie(f, 'stranger@example.com') } })).status, 403);
        assert.equal((await fetch(u + '/recordings/b/video', { headers: host })).status, 401);
        assert.equal((await fetch(u + '/recordings/b/video', { method: 'HEAD', headers: host })).status, 401);
        assert.equal((await fetch(u + '/recordings/b/video', { headers: { ...host, Cookie: cookie(f, 'stranger@example.com') } })).status, 403);
        assert.equal(storageCalls, 0);
        assert.equal((await fetch(u + '/', { headers: { ...host, Cookie: cookie(f, 'stranger@example.com') } })).status, 403);
        assert.equal((await fetch(u + '/auth/login', { headers: { Host: 'evil.example' }, redirect: 'manual' })).status, 400);
        assert.equal((await fetch(u + '/', { headers: { ...host, Cookie: cookie(f) } })).status, 200);
    });
});
test('OAuth binds random state to flow, origin and initiating owner', async () => {
    const f = fixture();
    await server(f, async (u) => {
        const start = await fetch(u + '/auth/login', { headers: host, redirect: 'manual' });
        assert.equal(start.status, 302);
        const state = requiredState(requiredHeader(start, 'location'));
        const oauthCookie = requiredHeader(start, 'set-cookie').split(';')[0];
        assert.equal((await fetch(u + '/auth/callback?code=x&state=wrong', { headers: { ...host, Cookie: oauthCookie } })).status, 400);
        assert.equal((await fetch(u + '/auth/callback?code=x&state=' + state, { headers: { Host: 'owner.tail.ts.net', Cookie: oauthCookie }, redirect: 'manual' })).status, 400);
        const done = await fetch(u + '/auth/callback?code=x&state=' + state, { headers: { ...host, Cookie: oauthCookie }, redirect: 'manual' });
        assert.equal(done.status, 302);
        assert.match(requiredHeader(done, 'set-cookie'), /HttpOnly/);
        assert.match(requiredHeader(done, 'set-cookie'), /SameSite=Lax/);
        const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1' };
        const connect = await fetch(u + '/auth/connect', { method: 'POST', headers, redirect: 'manual' });
        assert.equal(connect.status, 200);
        const data: unknown = await connect.json();
        assert.ok(data && typeof data === 'object' && 'url' in data && typeof data.url === 'string');
        const connectState = new URL(data.url).searchParams.get('state');
        const cc = requiredHeader(connect, 'set-cookie').split(';')[0];
        assert.equal((await fetch(u + `/auth/callback?code=x&state=${connectState}`, { headers: { ...host, Cookie: cc }, redirect: 'manual' })).status, 401);
        f.setIdentity({ id: 'other', email: 'other@example.com', refreshToken: 'refresh', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] });
        assert.equal((await fetch(u + `/auth/callback?code=x&state=${connectState}`, { headers: { ...host, Cookie: cc + '; ' + cookie(f) }, redirect: 'manual' })).status, 302);
        assert.equal(f.state.accounts[0].refreshToken, 'encrypted:refresh');
        assert.equal(f.state.calendars[0].watched, false);
    assert.equal(f.state.calendars[0].selectionRevision, 1);
        assert.equal((await fetch(u + '/', { headers: { ...host, Cookie: cookie(f, 'other@example.com') } })).status, 403);
    });
});
test('POST controls require custom header and exact same allowed Origin, persist before success', async () => {
    const f = fixture();
    await server(f, async (u) => {
        for (const headers of [{ ...host, Cookie: cookie(f) }, { ...host, Cookie: cookie(f), Origin: 'https://evil.example', 'X-Scheduler-Request': '1' }])
            assert.equal((await fetch(u + '/auth/logout', { method: 'POST', headers })).status, 403);
        f.setFail();
        assert.equal((await fetch(u + '/calendars/watch', { method: 'POST', headers: { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: 'a', calendarId: 'b', watched: true }) })).status, 503);
    });
});
test('callback routes strictly authenticate and validate raw signed bodies before durable acknowledgement', async () => {
    const f = fixture();
    await server(f, async (u) => {
        const body = { botId: 'b', provider: 'google', status: ['processing', 'failed'] };
        for (const authorization of ['', 'Bearer wrong', 'bearer test-bearer', 'Bearer test-bearer extra'])
            assert.equal((await fetch(u + '/v2/meeting/app/bot/status', { method: 'PATCH', headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
        const headers = { Authorization: 'Bearer test-bearer', 'Content-Type': 'application/json' };
        assert.equal((await fetch(u + '/v2/meeting/app/bot/status', { method: 'PATCH', headers, body: JSON.stringify({ ...body, status: ['bogus'] }) })).status, 400);
        assert.equal((await fetch(u + '/v2/meeting/app/bot/status', { method: 'PATCH', headers, body: JSON.stringify(body) })).status, 200);
        const raw = JSON.stringify({ recordingId: 'r', status: 'completed', timestamp: new Date().toISOString(), metadata: { botId: 'b', storage: { provider: 's3', bucket: 'private', key: 'b.mp4' } }, blobUrl: 'https://do-not-expose.example/secret' });
        const signature = createHmac('sha256', 'hook-secret').update(raw).digest('hex');
        assert.equal((await fetch(u + '/hooks/recording-completed', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature }, body: raw + ' ' })).status, 401);
        assert.equal((await fetch(u + '/hooks/recording-completed', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature }, body: raw })).status, 200);
        assert.equal(f.reports.length, 2);
        f.setFail();
        assert.equal((await fetch(u + '/v2/meeting/app/bot/status', { method: 'PATCH', headers, body: JSON.stringify(body) })).status, 503);
    });
});
test('server-rendered views escape calendar text and never expose dispatch secrets', async () => {
    const f = fixture();
    const hostile = '<img src=x onerror=alert(1)>';
    f.deps.runtime.view = () => ({ ready: true, workers: [], queueDepth: 3, ingestionPending: true, groups: [meetingGroup({ members: [{ ...meetingGroup().members[0], calendarSummary: hostile, event: { id: 'e', summary: hostile } }] })] });
    await server(f, async (u) => {
        const page = await (await fetch(u + '/', { headers: { ...host, Cookie: cookie(f) } })).text();
        assert.ok(page.includes('&lt;img'));
        assert.ok(!page.includes('<img'));
        assert.ok(!page.includes('test-bearer'));
        assert.ok(page.includes('Queue'));
        assert.ok(page.includes('color-scheme'));
        for (const path of ['/history', '/accounts'])
            assert.equal((await fetch(u + path, { headers: { ...host, Cookie: cookie(f) } })).status, 200);
    });
});

test('connect rejects missing scopes or unusable tokens, and login denies non-owner identities', async () => {
  const f = fixture();
  await server(f, async url => {
    const begin = async (flow: 'login' | 'connect') => {
      const start = await fetch(url + `/auth/${flow}`, {
        method: flow === 'connect' ? 'POST' : 'GET',
        headers: { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1' },
      });
      const destination = flow === 'login' ? requiredHeader(start, 'location') : (await start.json() as { url: string }).url;
      const state = new URL(destination).searchParams.get('state');
      return fetch(url + `/auth/callback?code=x&state=${state}`, { headers: { ...host, Cookie: `${requiredHeader(start, 'set-cookie').split(';')[0]}; ${cookie(f)}` } });
    };
    f.setIdentity({ id: 'other', email: 'other@example.com', scopes: [] });
    assert.equal((await begin('login')).status, 403);
    assert.equal((await begin('connect')).status, 400);
    f.setIdentity({ id: 'other', email: 'other@example.com', scopes: ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'] });
    assert.equal((await begin('connect')).status, 400);
    assert.equal(f.state.accounts.length, 0);
  });
});

test('overrides store every member key at one revision, and watch/disconnect invalidate sources', async () => {
  const f = fixture();
  f.state.accounts.push({ id: 'a', email: 'connected@example.com', refreshToken: 'encrypted:r', connectedAt: 'now', needsReconnect: false });
  f.state.calendars.push({ accountId: 'a', id: 'c', summary: 'Calendar', timeZone: 'UTC', watched: true, events: [], verified: true });
  f.deps.runtime.view = () => ({ ready: true, groups: [meetingGroup({ memberKeys: ['one', 'two'] })], workers: [], queueDepth: 0, ingestionPending: false });
  await server(f, async url => {
    const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
    for (const mode of ['skip', 'automatic']) {
      assert.equal((await fetch(url + '/groups/g/override', { method: 'POST', headers, body: JSON.stringify({ mode }) })).status, 200);
      assert.deepEqual(f.state.overrides.one, f.state.overrides.two);
      assert.equal(f.state.overrides.one.mode, mode);
    }
    assert.equal(f.state.overrideRevision, 2);
    assert.equal((await fetch(url + '/calendars/watch', { method: 'POST', headers, body: JSON.stringify({ accountId: 'a', calendarId: 'c', watched: false }) })).status, 200);
    assert.equal(f.state.calendars[0].watched, false);
    assert.equal(f.state.calendars[0].selectionRevision, 1);
    assert.equal(f.state.calendars[0].verified, false);
    assert.equal((await fetch(url + '/accounts/a/disconnect', { method: 'POST', headers })).status, 200);
    assert.equal(f.state.accounts.length, 0);
    assert.equal(f.state.calendars.length, 0);
  });
});

test('history diagnostics redact storage URLs and configured credentials', async () => {
  const f = fixture();
  f.deps.ledger.listDispatches = async () => [dispatchRecord({ logs: [{ botId: 'b', provider: 'google', category: 'storage', subCategory: 'read', receivedAt: Date.now(), level: 'error', message: 'Read https://storage.example/private/object?signature=secret failed with secret and test-bearer' }] })];
  f.deps.ledger.history = f.deps.ledger.listDispatches;
  f.deps.ledger.diagnostics = async () => [{ kind: 'malformed result', raw: 'https://storage.example/secret' }, { kind: 'https://storage.example/secret' }];
  await server(f, async url => {
    const response = await fetch(url + '/history', { headers: { ...host, Cookie: cookie(f) } });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!html.includes('storage.example'));
    assert.ok(!html.includes('test-bearer'));
    assert.ok(!html.includes('signature=secret'));
    assert.ok(html.includes('[URL redacted]'));
    assert.ok(html.includes('Malformed results: 1'));
    assert.ok(html.includes('Other diagnostics: 1'));
  });
});

test('late first pickup observation warns without claiming an exact pickup time', async () => {
  const f = fixture();
  f.deps.ledger.history = async () => [dispatchRecord({ state: 'picked_up', scheduledEnd: Date.now() - 1000, firstObservedAt: Date.now() })];
  await server(f, async url => {
    const response = await fetch(url + '/history', { headers: { ...host, Cookie: cookie(f) } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('Possible late pickup'));
    assert.ok(html.includes('Exact pickup time is unknown'));
    assert.ok(html.includes('Picked up'));
  });
});

test('mounted Bot Settings requires owner session and saves validated names and private images', async () => {
  const f = fixture();
  f.deps.config.basePath = '/meeting-bot';
  const saved: string[] = [];
  const id = 'b'.repeat(64);
  Object.assign(f.deps, { thumbnails: { save: async (value: string) => { saved.push(value); return id; }, read: async (value: string) => value === id ? Buffer.from('private png') : null } });
  await server(f, async url => {
    const path = '/meeting-bot/bot-settings';
    const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + path, { headers: host })).status, 401);
    const page = await fetch(url + path, { headers });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Bot Settings/);
    assert.match(html, /value="Test bot"/);
    assert.match(html, /participant|participants/);
    assert.match(html, /pending|Pending/);
    assert.match(html, /active|Active/);
    assert.match(html, /accept="image\/png,image\/jpeg,image\/webp"/);
    assert.equal((await fetch(url + path, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: JSON.stringify({ name: 'Changed' }) })).status, 403);
    for (const body of [{ name: '' }, { name: ' '.repeat(10) }, { name: 'a'.repeat(101) }, { name: 'a\nb' }, { name: 3 }, { name: 'Bot', removeThumbnail: 'yes' }, { name: 'Bot', thumbnailDataUrl: 'x', removeThumbnail: true }]) {
      assert.equal((await fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(f.state.botSettings, undefined);
    assert.equal((await fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ name: '  New bot  ', thumbnailDataUrl: 'data:image/png;base64,fixture' }) })).status, 200);
    assert.deepEqual(f.state.botSettings, { name: 'New bot', thumbnailId: id });
    assert.equal(saved.length, 1);
    assert.equal((await fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ name: 'Rename' }) })).status, 200);
    assert.deepEqual(f.state.botSettings, { name: 'Rename', thumbnailId: id });
    const image = await fetch(url + path + '/thumbnail/' + id, { headers });
    assert.equal(image.status, 200);
    assert.match(requiredHeader(image, 'content-type'), /^image\/png/);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from('private png'));
    assert.equal((await fetch(url + path + '/thumbnail/' + id, { headers: host })).status, 401);
    assert.equal((await fetch(url + path + '/thumbnail/bad', { headers })).status, 404);
    assert.equal((await fetch(url + '/v2/meeting/app/bot/thumbnail/' + id)).status, 401);
    assert.equal((await fetch(url + '/v2/meeting/app/bot/thumbnail/' + id, { headers: { Authorization: 'Bearer test-bearer' } })).status, 200);
    assert.equal((await fetch(url + '/meeting-bot/v2/meeting/app/bot/thumbnail/' + id, { headers })).status, 404);
    assert.equal((await fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ name: 'No camera', removeThumbnail: true }) })).status, 200);
    assert.deepEqual(f.state.botSettings, { name: 'No camera' });
  });
});

test('Bot Settings preserves saved settings when image processing or durable persistence fails', async () => {
  const f = fixture();
  f.state.botSettings = { name: 'Original', thumbnailId: 'a'.repeat(64) };
  Object.assign(f.deps, { thumbnails: { save: async () => { throw new InvalidBotThumbnailError('Image cannot be decoded'); }, read: async () => null } });
  await server(f, async url => {
    const headers = { ...host, Cookie: cookie(f), Origin: 'http://localhost:3001', 'X-Scheduler-Request': '1', 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/bot-settings', { method: 'POST', headers, body: JSON.stringify({ name: 'Replacement', thumbnailDataUrl: 'bad' }) })).status, 400);
    assert.equal(f.state.botSettings?.name, 'Original');
    f.setFail();
    assert.equal((await fetch(url + '/bot-settings', { method: 'POST', headers, body: JSON.stringify({ name: 'Replacement' }) })).status, 503);
    assert.equal(f.state.botSettings?.name, 'Original');
  });
});

test('mounted transcript routes use existing owner authentication before reading private artifacts', async () => {
  const f = fixture(); f.deps.config.basePath = '/scheduler'; let reads = 0;
  f.deps.transcriptQueue = { get: async () => { reads++; return null; } };
  f.deps.transcriptStorage = { readArtifact: async () => { throw new Error('must not read'); } };
  await server(f, async url => {
    const unauthenticated = await fetch(url + '/scheduler/recordings/b/transcript', { headers: host });
    assert.equal(unauthenticated.status, 401); assert.equal(reads, 0);
    const authorizedCookie = `scheduler_session_${Buffer.from('/scheduler').toString('base64url')}=${f.deps.crypto.signCookie({ email: 'owner@example.com' }, 3600)}`;
    assert.equal((await fetch(url + '/scheduler/recordings/b/transcript?version=bad', { headers: { ...host, Cookie: authorizedCookie } })).status, 400);
    assert.equal((await fetch(url + '/scheduler/recordings/b/transcript/download?format=html', { headers: { ...host, Cookie: authorizedCookie } })).status, 400);
  });
});

test('meeting drawer plays and seeks authenticated video without resetting for transcript changes', { timeout: 30000 }, async () => {
  const { chromium } = await import('playwright');
  const { Readable } = await import('node:stream');
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { mkdtemp, readFile, writeFile, unlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeWebmDurationMetadata } = await import('../lib/webmDuration');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const directory = await mkdtemp(join(tmpdir(), 'meeting-drawer-qa-'));
  const fixturePath = join(directory, 'recording.webm');
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const chunks = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d'); if (!context) throw Error('Canvas unavailable');
      let frame = 0;
      const draw = () => {
        context.fillStyle = '#18344a'; context.fillRect(0, 0, 1280, 720);
        context.fillStyle = '#e8f2ed'; context.font = '36px sans-serif'; context.fillText('Weekly product review', 80, 180);
        context.font = '24px sans-serif'; context.fillText('Meeting playback fixture', 80, 235);
        context.fillStyle = '#8bbdaa'; context.fillRect(80 + frame++ * 8, 330, 160, 120);
      };
      draw(); const timer = setInterval(draw, 100);
      const stream = canvas.captureStream(10);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
      recorder.start(); await new Promise(resolve => setTimeout(resolve, 4000)); recorder.stop(); await stopped;
      clearInterval(timer); stream.getTracks().forEach(track => track.stop());
      return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    await writeFile(fixturePath, Buffer.from(chunks)); await writeWebmDurationMetadata(fixturePath, 4);
    const videoBytes = await readFile(fixturePath);
    const f = fixture(); f.deps.config.basePath = '/meeting-bot';
    const dispatch = dispatchRecord({ recording: { botId: 'b', recordingId: 'r', timestamp: 'now', contentType: 'video/webm', storage: { provider: 's3', bucket: 'private', key: 'recording.webm' } } });
    dispatch.payload.eventId = 'Weekly product review';
    Object.assign(dispatch, { meetingTitle: 'Weekly product review' });
    f.deps.ledger.listDispatches = async () => [dispatch]; f.deps.ledger.history = f.deps.ledger.listDispatches;
    let videoReads = 0; let transcriptAvailable = true;
    f.deps.s3 = { send: async command => {
      if (!(command instanceof GetObjectCommand)) return { ContentLength: videoBytes.length, ContentType: 'video/webm', ETag: '"media"' };
      videoReads++;
      const range = command.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
      const body = range ? videoBytes.subarray(Number(range[1]), Number(range[2]) + 1) : videoBytes;
      return { ContentLength: body.length, ETag: '"media"', Body: Readable.from([body]) };
    } };
    f.deps.transcriptQueue = { get: async () => transcriptAvailable ? {
      originalState: 'ready', correctionState: 'ready', original: { revisionId: 'original' }, latestCorrection: { revisionId: 'corrected' }, warnings: []
    } as never : null };
    f.deps.transcriptStorage = { readArtifact: async artifact => Buffer.from(JSON.stringify({
      segments: Array.from({ length: 6 }, (_, index) => ({ id: 's' + index, start: index * 15, speaker: 'SPEAKER_00', words: [], text: index === 0 ? (artifact.revisionId === 'original' ? 'gloomit' : 'Google Meet') + ' connects the team for our weekly review.' : 'We reviewed the release, discussed customer feedback, and agreed on the next steps.' })),
      corrections: artifact.revisionId === 'original' ? [] : [{ original: 'gloomit', replacement: 'Google Meet', correctedRange: { segmentId: 's0', start: 0, end: 11 } }]
    })) };
    const errors: string[] = []; const consoleErrors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await server(f, async origin => {
      f.deps.config.baseUrls = [origin];
      const [name, value] = cookie(f).split('=');
      await page.context().addCookies([{ name, value, url: origin + '/meeting-bot/', httpOnly: true, sameSite: 'Lax' }]);
      await page.goto(origin + '/meeting-bot/history');
      assert.equal(await page.title(), 'History - Meeting scheduler'); assert.equal(videoReads, 0);
      const open = page.getByRole('button', { name: 'View meeting' }); await open.click();
      const player = page.locator('#meeting-video');
      await player.evaluate((video: HTMLVideoElement) => video.play());
      await page.waitForFunction(() => (document.getElementById('meeting-video') as HTMLVideoElement).currentTime > 0.1);
      assert.deepEqual(await player.evaluate((video: HTMLVideoElement) => [video.videoWidth, video.videoHeight]), [1280, 720]);
      await player.evaluate((video: HTMLVideoElement) => { video.pause(); video.currentTime = 1.2; });
      await page.waitForFunction(() => {
        const video = document.getElementById('meeting-video') as HTMLVideoElement;
        return !video.seeking && video.readyState >= 2 && Math.abs(video.currentTime - 1.2) < 0.1;
      });
      await player.evaluate((video: HTMLVideoElement) => video.play());
      const url = await player.getAttribute('src');
      await page.getByRole('button', { name: 'Original', exact: true }).click();
      await page.getByText('gloomit connects the team for our weekly review.', { exact: true }).waitFor();
      assert.equal(await player.getAttribute('src'), url);
      assert.ok(await player.evaluate((video: HTMLVideoElement) => video.currentTime >= 1.1));
      assert.equal(await player.evaluate((video: HTMLVideoElement) => video.paused), false);
      await page.getByRole('button', { name: 'Corrected', exact: true }).click(); await page.locator('.transcript-change').waitFor();
      await player.evaluate((video: HTMLVideoElement) => video.pause());
      const partial = await page.request.get(origin + url, { headers: { Range: 'bytes=10-20' } });
      assert.equal(partial.status(), 206); assert.equal((await partial.body()).length, 11);
      const dialog = page.getByRole('dialog', { name: 'Weekly product review' });
      const bounds = await dialog.boundingBox(); assert.ok(bounds); assert.equal(Math.round(bounds.width), 864);
      const videoBounds = await player.boundingBox(); const transcriptBounds = await page.getByRole('heading', { name: 'Transcript', exact: true }).boundingBox();
      assert.ok(videoBounds && transcriptBounds && videoBounds.y + videoBounds.height <= transcriptBounds.y);
      await page.locator('.meeting-body').evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: join(directory, 'desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileBounds = await dialog.boundingBox(); assert.ok(mobileBounds); assert.equal(Math.round(mobileBounds.width), 390);
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
      await page.screenshot({ path: join(directory, 'mobile.png') });
      assert.deepEqual(consoleErrors, []);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => !document.getElementById('meeting-video')?.getAttribute('src'));
      assert.equal(await player.getAttribute('src'), null); assert.equal(await player.evaluate((video: HTMLVideoElement) => video.paused), true);
      assert.equal(await open.evaluate(element => element === document.activeElement), true);
      transcriptAvailable = false; await open.click(); await page.getByText('Transcript unavailable', { exact: true }).waitFor();
      await player.evaluate((video: HTMLVideoElement) => video.play());
      assert.equal(await player.evaluate((video: HTMLVideoElement) => video.paused), false);
      await page.getByRole('button', { name: 'Close meeting' }).click();
      assert.deepEqual(errors, []);
      console.log('Meeting drawer screenshots: ' + directory);
    });
  } finally { await browser.close(); await unlink(fixturePath).catch(() => undefined); }
});
