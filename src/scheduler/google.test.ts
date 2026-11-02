import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleCalendar, GooglePollError } from './google';
import { TokenCrypto } from './crypto';
import type { Account, CalendarState, SchedulerConfig } from './types';

const config = { googleClientId: 'client', googleClientSecret: 'secret' } as SchedulerConfig;
const crypto = new TokenCrypto(Buffer.alloc(32));
const account: Account = { id: 'owner', email: 'owner@example.test', refreshToken: crypto.encrypt('refresh'), connectedAt: '2026-11-01', needsReconnect: false };
const calendar: CalendarState = { id: 'work@example.test', accountId: 'owner', summary: 'Work', timeZone: 'Asia/Seoul', watched: true, events: [] };

test('Google polling follows empty pages with fixed bounds and required field selection', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const google = new GoogleCalendar(config, crypto, async (_account, path, params) => {
    assert.match(path, /work%40example\.test\/events$/);
    requests.push(params);
    return params.pageToken ? { items: [{ id: 'event', summary: 'Meeting' }] } : { items: [], nextPageToken: 'second' };
  });
  const events = await google.pollCalendar(account, calendar, 1_800_000_000_000);
  assert.equal(events.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].timeMin, requests[1].timeMin);
  assert.equal(requests[0].timeMax, requests[1].timeMax);
  assert.equal(requests[0].singleEvents, true);
  assert.match(String(requests[0].fields), /nextPageToken/);
  assert.match(String(requests[0].fields), /originalStartTime/);
});

test('a later page failure never yields a partial successful calendar snapshot', async () => {
  const google = new GoogleCalendar(config, crypto, async (_account, _path, params) => {
    if (params.pageToken) throw { response: { status: 503, data: { error: { message: 'unavailable' } } } };
    return { items: [{ id: 'partial' }], nextPageToken: 'second' };
  });
  await assert.rejects(() => google.pollCalendar(account, calendar, Date.now()), (error: unknown) => error instanceof GooglePollError && error.kind === 'transient');
});

test('access loss and invalid grants are distinct from rate limiting', async () => {
  for (const [response, kind] of [
    [{ status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } }, 'access'],
    [{ status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } }, 'transient'],
    [{ status: 403, data: { error: { errors: [{ domain: 'usageLimits', reason: 'dailyLimitExceeded' }] } } }, 'transient'],
    [{ status: 400, data: { error: 'invalid_grant' } }, 'invalid_grant'],
  ] as const) {
    const google = new GoogleCalendar(config, crypto, async () => { throw { response }; });
    await assert.rejects(() => google.pollCalendar(account, calendar, Date.now()), (error: unknown) => error instanceof GooglePollError && error.kind === kind);
  }
});

test('calendar enumeration is paginated and defaults new calendars to explicit selection elsewhere', async () => {
  let requests = 0;
  const google = new GoogleCalendar(config, crypto, async (_account, _path, params) => {
    requests++;
    return params.pageToken ? { items: [{ id: 'second', summary: 'Team', timeZone: 'UTC' }] } : { items: [{ id: 'first', summary: 'Own', timeZone: 'Asia/Seoul' }], nextPageToken: 'more' };
  });
  const calendars = await google.listCalendars(account);
  assert.equal(requests, 2);
  assert.deepEqual(calendars.map(item => item.id), ['first', 'second']);
});

test('calendar enumeration preserves Google primary metadata rather than inferring from names', async () => {
  let fields: unknown;
  const google = new GoogleCalendar(config, crypto, async (_account, _path, params) => {
    fields = params.fields;
    return { items: [
      { id: 'renamed-calendar', summary: 'Personal', primary: true },
      { id: 'shared-calendar', summary: 'Personal' },
    ] };
  });
  const calendars = await google.listCalendars(account);
  assert.match(String(fields), /primary/);
  assert.deepEqual(calendars.map(calendar => calendar.primary), [true, false]);
});

test('OAuth links request offline calendar consent only for owner account connection', () => {
  const google = new GoogleCalendar(config, crypto);
  const login = new URL(google.authorizationUrl('login', 'http://localhost:3001/auth/callback', 'login-state'));
  assert.equal(login.searchParams.get('state'), 'login-state');
  assert.equal(login.searchParams.get('scope'), 'openid email');
  const connect = new URL(google.authorizationUrl('connect', 'http://localhost:3001/auth/callback', 'connect-state'));
  assert.equal(connect.searchParams.get('access_type'), 'offline');
  assert.equal(connect.searchParams.get('prompt'), 'consent');
  assert.match(connect.searchParams.get('scope') || '', /calendar\.events\.readonly/);
});
