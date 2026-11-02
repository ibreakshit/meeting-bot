import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractJoinLink } from './links';
import { buildGroups, instanceKey } from './group';
import { plan } from './planner';
import type { CalendarEvent, CalendarState, DispatchRecord, MeetingGroup, SchedulerState } from './types';

const now = Date.parse('2026-11-01T01:00:00Z');
const iso = (offset: number) => new Date(now + offset * 1000).toISOString();
function event(id = 'a', start = 60, end = 3600, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id, iCalUID: id, start: { dateTime: iso(start) }, end: { dateTime: iso(end) },
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    attendees: [{ email: 'owner@example.test', responseStatus: 'accepted' }, { email: 'guest@example.test' }], ...extra };
}
function calendar(events: CalendarEvent[], extra: Partial<CalendarState> = {}): CalendarState {
  return { accountId: 'owner', id: 'calendar', summary: 'Test', timeZone: 'Asia/Seoul', watched: true,
    events, lastSuccess: now, lastAttemptSucceeded: true, verified: true, ...extra };
}
function state(events: CalendarEvent[] = [event()], calendars?: CalendarState[]): SchedulerState {
  return { version: 1, accounts: [{ id: 'owner', email: 'owner@example.test', refreshToken: 'fixture', connectedAt: iso(0), needsReconnect: false }],
    calendars: calendars || [calendar(events)], overrides: {}, overrideRevision: 0 };
}
const groups = (s = state(), instant = now) => buildGroups(s, instant, 300, ['alias@example.test']);
function dispatch(group: MeetingGroup, extra: Partial<DispatchRecord> = {}): DispatchRecord {
  const primary = group.primary;
  assert.ok(primary?.link);
  const payload = { provider: primary.link.provider, url: primary.link.url, timezone: primary.timeZone,
    name: 'Recorder', teamId: 'team', userId: 'user', bearerToken: 'fixture', botId: 'bot-a', eventId: primary.event.id };
  return { botId: 'bot-a', payload, serializedPayload: JSON.stringify(payload), memberInstanceKeys: group.memberKeys,
    pushedAt: now, scheduledStart: group.start, scheduledEnd: group.end, state: 'queued', ...extra };
}

test('link priority ignores unsupported entries and preserves full decoded URLs', () => {
  const link = extractJoinLink(event('a', 60, 3600, { conferenceData: { entryPoints: [
    { entryPointType: 'video', uri: 'https://unsupported.test/room' },
    { entryPointType: 'video', uri: 'https://vanity.zoom.us/j/85512345678?pwd=abc&amp;other=2' },
  ] } }));
  assert.deepEqual(link, { provider: 'zoom', roomId: 'zoom:85512345678', url: 'https://vanity.zoom.us/j/85512345678?pwd=abc&other=2' });
  for (const [url, roomId] of [
    ['https://teams.microsoft.com/meet/123?p=secret', 'teams:work:123'],
    ['https://teams.live.com/meet/123?p=secret', 'teams:personal:123'],
    ['https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=abc', 'teams:thread:19:meeting_x@thread.v2'],
  ]) assert.equal(extractJoinLink(event('a', 60, 3600, { hangoutLink: url }))?.roomId, roomId);
  assert.equal(extractJoinLink(event('a', 60, 3600, { hangoutLink: undefined,
    description: '<a href="https://vanity.zoom.us/j/123?pwd=a&amp;x=b">Join</a>' }))?.url, 'https://vanity.zoom.us/j/123?pwd=a&x=b');
  for (const url of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.test/abc-defg-hij', 'https://zoom.us/profile/123']) {
    assert.equal(extractJoinLink(event('a', 60, 3600, { hangoutLink: url })), undefined);
  }
});

test('one-off and recurring identities survive moves and normalize original UTC instants', () => {
  assert.equal(instanceKey(event()), instanceKey(event('a', 600)));
  const recurring = event('a', 60, 3600, { originalStartTime: { dateTime: '2026-11-01T10:00:00+09:00' } });
  assert.equal(instanceKey(recurring), instanceKey({ ...recurring, start: { dateTime: iso(600) }, originalStartTime: { dateTime: iso(0) } }));
  assert.notEqual(instanceKey(recurring), instanceKey(event()));
  assert.notEqual(instanceKey(recurring), instanceKey({ ...recurring, originalStartTime: { dateTime: iso(86400) } }));
});

test('owner RSVP combines same occurrence copies and ignores shared self flags', () => {
  const declined = event('a', 60, 3600, { attendees: [{ email: 'OWNER@example.test', responseStatus: 'declined' }, { email: 'guest@example.test' }] });
  const accepted = event('a', 60, 3600, { attendees: [{ email: 'alias@example.test', responseStatus: 'tentative' }, { email: 'guest@example.test' }] });
  assert.equal(groups(state([], [calendar([declined]), calendar([accepted], { id: 'other' })]))[0].join, true);
  assert.equal(groups(state([declined]))[0].reason, 'declined');
  const shared = event('shared', 60, 3600, { attendees: [{ email: 'other@example.test', self: true, responseStatus: 'declined' }] });
  assert.equal(groups(state([shared]))[0].join, true);
  assert.equal(groups(state([event('a', 60, 3600, { attendees: [{ email: 'owner@example.test' }, { email: 'alias@example.test' }, { email: 'room@example.test', resource: true }] })]))[0].reason, 'alone');
  assert.equal(groups(state([event('a', 60, 3600, { attendees: [], attendeesOmitted: true })]))[0].reason, 'attendees unavailable');
  assert.equal(groups(state([event('a', 60, 3600, { attendees: [], organizer: { email: 'guest@example.test' } })]))[0].join, true);
});

test('source freshness expires exactly at cutoff and known access loss bypasses grace', () => {
  const freshState = state();
  freshState.calendars[0].lastAttemptSucceeded = false;
  assert.equal(groups(freshState, now + 299999)[0].join, true);
  assert.equal(groups(freshState, now + 300000)[0].reason, 'calendar unavailable');
  for (const patch of [{ verified: false }, { watched: false }, { unauthorized: true }]) {
    assert.equal(groups(state([], [calendar([event()], patch)]))[0].join, false);
  }
  freshState.accounts[0].needsReconnect = true;
  assert.equal(groups(freshState)[0].join, false);
  freshState.accounts = [];
  assert.equal(groups(freshState)[0].join, false);
});

test('current occurrence supersedes grace link, schedule and responses', () => {
  const old = event('a', -60, 7200);
  const current = event('a', 120, 1800, { hangoutLink: 'https://zoom.us/j/123?pwd=new', attendees: [{ email: 'owner@example.test', responseStatus: 'declined' }, { email: 'guest@example.test' }] });
  const result = groups(state([], [calendar([old], { lastAttemptSucceeded: false }), calendar([current], { id: 'fresh' })]))[0];
  assert.equal(result.join, false);
  assert.equal(result.reason, 'declined');
  assert.equal(result.members.find(member => member.calendarId === 'calendar')?.eligible, false);
});

test('group overrides use latest revision, reset survives merges, Join cannot bypass hard rules', () => {
  const s = state([event('a'), event('b')]);
  s.overrides[instanceKey(event('a'))] = { mode: 'join', revision: 1 };
  s.overrides[instanceKey(event('b'))] = { mode: 'skip', revision: 2 };
  assert.equal(groups(s)[0].join, false);
  s.overrides[instanceKey(event('a'))] = { mode: 'automatic', revision: 3 };
  assert.equal(groups(s)[0].join, true);
  s.calendars[0].events = [event('a', 60, 3600, { attendees: [] })];
  s.overrides[instanceKey(event('a'))] = { mode: 'join', revision: 4 };
  assert.equal(groups(s)[0].join, true);
  for (const patch of [{ status: 'cancelled' }, { hangoutLink: 'https://unsupported.test/x' }, { start: { date: '2026-11-01' } }, { end: { dateTime: iso(0) } }]) {
    s.calendars[0].events = [event('a', 60, 3600, patch)];
    assert.equal(groups(s)[0].join, false);
    assert.equal(groups(s)[0].override?.mode, 'join');
  }
});

test('strict overlap groups rooms but back-to-back events and unavailable bridges remain separate', () => {
  assert.equal(groups(state([event('a', 0, 100), event('b', 100, 200)])).length, 2);
  assert.equal(groups(state([event('a', 0, 101), event('b', 100, 200)])).length, 1);
  assert.equal(groups(state([], [calendar([event('a', 0, 100), event('b', 200, 300)]), calendar([event('bridge', 0, 300)], { id: 'expired', lastSuccess: now - 300000 })])).length, 3);
  assert.equal(groups(state([event('a', 0, 100), event('bad', 0, 300, { status: 'cancelled' }), event('b', 200, 300)])).length, 3);
});

test('skipped members do not extend joining bounds or supply primary URL', () => {
  const skipped = event('skip', -100, 7200, { attendees: [] });
  const result = groups(state([event('join', 60, 3600), skipped]))[0];
  assert.equal(result.start, now + 60000);
  assert.equal(result.end, now + 3600000);
  assert.equal(result.primary?.event.id, 'join');
});

test('planner lead time, downtime, FIFO and ended boundaries', () => {
  const result = groups();
  assert.deepEqual(plan(result, [], new Set(), now - 1, 60), []);
  assert.equal(plan(result, [], new Set(), now, 60)[0]?.type, 'enqueue');
  assert.equal(plan(result, [], new Set(), now + 120000, 60)[0]?.type, 'enqueue');
  assert.deepEqual(plan(result, [], new Set(), result[0].end, 60), []);
  const separate = groups(state([event('late', 50, 1000, { hangoutLink: 'https://zoom.us/j/123' }), event('early', 10, 1000)]));
  assert.deepEqual(plan(separate, [], new Set(), now, 60).map(action => action.type === 'enqueue' && action.group.primary?.event.id), ['early', 'late']);
});

test('queued execution input edits replace only when still due; metadata alone never replaces', () => {
  const original = groups()[0];
  const record = dispatch(original);
  const pending = new Set([record.serializedPayload]);
  for (const patch of [{ hangoutLink: 'https://meet.google.com/abc-defg-hij?authuser=1' }, { hangoutLink: 'https://zoom.us/j/123?pwd=new' }, { start: { dateTime: iso(30) } }, { end: { dateTime: iso(4000) } }]) {
    assert.equal(plan(groups(state([event('a', 60, 3600, patch)])), [record], pending, now, 60)[0]?.type, 'replace');
  }
  assert.equal(plan(groups(state([], [calendar([event()], { timeZone: 'UTC' })])), [record], pending, now, 60)[0]?.type, 'replace');
  assert.equal(plan(groups(state([event('a', 600)])), [record], pending, now, 60)[0]?.type, 'remove');
  assert.deepEqual(plan(groups(state([event('a', 60, 3600, { id: 'new-primary', summary: 'renamed' })])), [record], pending, now, 60), []);
});

test('queued cancellation, Skip, expiry and unavailable sources remove safely', () => {
  const record = dispatch(groups()[0]);
  const pending = new Set([record.serializedPayload]);
  assert.equal(plan(groups(state([event('a', 60, 3600, { status: 'cancelled' })])), [record], pending, now, 60)[0]?.type, 'remove');
  assert.equal(plan(groups(state([], [calendar([event()], { verified: false })])), [record], pending, now, 60)[0]?.type, 'remove');
  const action = plan(groups(), [record], pending, record.scheduledEnd, 60)[0];
  assert.equal(action?.type, 'remove');
  if (action?.type === 'remove') assert.equal(action.reason, 'missed before pickup');
  const s = state(); s.overrides[instanceKey(event())] = { mode: 'skip', revision: 1 };
  assert.equal(plan(groups(s), [record], pending, now, 60)[0]?.type, 'remove');
});

test('only confirmed removal permits another execution; missing pending payload never authorizes replacement', () => {
  const record = dispatch(groups()[0]);
  for (const status of ['queued', 'picked_up', 'failed', 'completed', 'unknown', 'removed'] as const) {
    const actions = plan(groups(state([event('a', 30)])), [{ ...record, state: status }], new Set(), now, 60);
    assert.ok(actions.every(action => action.type === 'annotate'));
  }
  assert.equal(plan(groups(), [{ ...record, state: 'removed', removedBeforePickup: true }], new Set(), now, 60)[0]?.type, 'enqueue');
  assert.deepEqual(plan(groups(), [record], new Set([record.serializedPayload]), now, 60), []);
});

test('claimed edits annotate input and decision changes without another join', () => {
  const record = dispatch(groups()[0], { state: 'picked_up' });
  const result = plan(groups(state([event('a', 30, 3600, { status: 'cancelled' })])), [record], new Set(), now, 60);
  assert.equal(result[0]?.type, 'annotate');
  if (result[0]?.type === 'annotate') assert.ok(result[0].changedFields.includes('decision'));
  const missing = plan([], [record], new Set(), now, 60);
  assert.equal(missing[0]?.type, 'annotate');
});

test('split and merged groups retain all historical dispatch ownership', () => {
  const original = groups(state([event('a', 0, 100), event('b', 50, 200)]))[0];
  const record = dispatch(original, { state: 'unknown' });
  const split = groups(state([event('a', 0, 100), event('b', 100, 200)]));
  assert.ok(plan(split, [record], new Set(), now, 60).every(action => action.type === 'annotate'));
  const released = { ...record, state: 'removed' as const, removedBeforePickup: true };
  assert.equal(plan(split, [released], new Set(), now + 60000, 60).filter(action => action.type === 'enqueue').length, 2);
  const other = dispatch(groups(state([event('b', 50, 200)]))[0], { botId: 'bot-b', state: 'unknown' });
  assert.ok(plan([original], [other], new Set(), now, 60).every(action => action.type === 'annotate'));
});

test('owner identity normalization preserves aliases without inferring plus or dotted variants', () => {
  const s = state([event('a', 60, 3600, { attendees: [
    { email: ' OWNER@example.test ', responseStatus: 'declined' },
    { email: 'ALIAS@example.test', responseStatus: 'declined' },
    { email: 'owner+other@example.test', responseStatus: 'accepted' },
  ] })]);
  assert.equal(groups(s)[0].reason, 'declined');
  s.accounts[0].needsReconnect = true;
  s.calendars.push(calendar([event('a', 60, 3600, { attendees: [{ email: 'owner@example.test', responseStatus: 'declined' }, { email: 'guest@example.test' }] })], { accountId: 'second', id: 'healthy' }));
  s.accounts.push({ ...s.accounts[0], id: 'second', email: 'second@example.test', needsReconnect: false });
  assert.equal(groups(s)[0].reason, 'declined');
});

test('current copies supersede grace even when cancelled and new Join does not revive old data', () => {
  const s = state([], [calendar([event()], { lastAttemptSucceeded: false }), calendar([event('a', 60, 3600, { status: 'cancelled' })], { id: 'current' })]);
  s.overrides[instanceKey(event())] = { mode: 'join', revision: 1 };
  assert.equal(groups(s)[0].join, false);
  s.calendars[1].events = [event('a', 120, 1800, { hangoutLink: 'https://zoom.us/j/123' })];
  const result = groups(s)[0];
  assert.equal(result.primary?.calendarId, 'current');
  assert.equal(result.start, now + 120000);
  assert.equal(result.end, now + 1800000);
});

test('queued splits and merges remove safely before a later tick can redispatch', () => {
  const original = groups(state([event('a', 0, 100), event('b', 50, 200)]))[0];
  const queued = dispatch(original);
  const split = groups(state([event('a', 0, 100), event('b', 100, 200)]));
  assert.deepEqual(plan(split, [queued], new Set([queued.serializedPayload]), now, 60).map(action => action.type), ['remove']);
  const first = dispatch(groups(state([event('a', 0, 100)]))[0]);
  const second = dispatch(groups(state([event('b', 50, 200)]))[0], { botId: 'bot-b' });
  assert.deepEqual(plan([original], [first, second], new Set([first.serializedPayload, second.serializedPayload]), now, 60).map(action => action.type), ['remove', 'remove']);
});

test('blocked group merges attach new identities without dropping historical keys', () => {
  const original = groups(state([event('a', 0, 100)]))[0];
  const claimed = dispatch(original, { state: 'picked_up' });
  const merged = groups(state([event('a', 0, 100), event('b', 50, 200)]))[0];
  const action = plan([merged], [claimed], new Set(), now, 60)[0];
  assert.equal(action?.type, 'annotate');
  if (action?.type === 'annotate') assert.deepEqual(action.group?.memberKeys, merged.memberKeys);
  assert.deepEqual(claimed.memberInstanceKeys, original.memberKeys);
});

test('known resource organizer does not satisfy the person check', () => {
  const result = groups(state([event('a', 60, 3600, { organizer: { email: 'room@example.test' },
    attendees: [{ email: 'owner@example.test' }, { email: 'room@example.test', resource: true }] })]))[0];
  assert.equal(result.reason, 'alone');
});

test('primary and FIFO ties use exact lexicographic ordering', () => {
  const tied = groups(state([event('a'), event('B')]))[0];
  assert.equal(tied.primary?.event.id, 'B');
  const distinct = groups(state([event('a', 60, 3600), event('B', 60, 3600, { hangoutLink: 'https://zoom.us/j/123' })]));
  assert.deepEqual(plan(distinct, [], new Set(), now, 60).map(action => action.type === 'enqueue' && action.group.primary?.event.id), ['B', 'a']);
});

test('fallback event identity is scoped to source and cannot collide with an iCalUID', () => {
  const noUid = event('a', 60, 3600, { iCalUID: undefined });
  assert.notEqual(instanceKey(noUid, 'one'), instanceKey(noUid, 'two'));
  assert.notEqual(instanceKey(noUid, 'one'), instanceKey(event('b', 60, 3600, { iCalUID: JSON.stringify(['one', 'a']) })));
});

test('claimed cancellation retains every changed execution field as evidence', () => {
  const record = dispatch(groups()[0], { state: 'unknown' });
  const changed = groups(state([], [calendar([event('a', 30, 1800, { status: 'cancelled', hangoutLink: 'https://zoom.us/j/123?pwd=changed' })], { timeZone: 'UTC' })]));
  const action = plan(changed, [record], new Set(), now, 60)[0];
  assert.equal(action?.type, 'annotate');
  if (action?.type === 'annotate') assert.deepEqual(action.changedFields, ['provider', 'url', 'timezone', 'start', 'end', 'decision']);
});

test('group override actions survive split, reset and subsequent merge by revision', () => {
  const first = event('a', 0, 100), second = event('b', 50, 200);
  const s = state([first, second]);
  for (const key of groups(s)[0].memberKeys) s.overrides[key] = { mode: 'skip', revision: 1 };
  s.calendars[0].events[1] = event('b', 100, 200);
  assert.deepEqual(groups(s).map(group => group.join), [false, false]);
  s.overrides[instanceKey(second)] = { mode: 'automatic', revision: 2 };
  assert.deepEqual(groups(s).map(group => group.join), [false, true]);
  s.calendars[0].events[1] = second;
  assert.equal(groups(s)[0].join, true);
  assert.equal(groups(s)[0].override?.mode, 'automatic');
});

test('a healthy duplicate supports joining while unavailable copies remain display evidence', () => {
  const s = state([], [calendar([event('a', -600, 7200)], { id: 'expired', lastSuccess: now - 300000 }), calendar([event('a', 60, 3600)])]);
  const result = groups(s)[0];
  assert.equal(result.members.length, 2);
  assert.equal(result.join, true);
  assert.equal(result.start, now + 60000);
  assert.equal(result.end, now + 3600000);
  assert.equal(result.primary?.calendarId, 'calendar');
  assert.equal(plan([result], [], new Set(), now, 60)[0]?.type, 'enqueue');
});

test('new bot appearance replaces only a pending execution and keeps claimed appearances immutable', () => {
  const currentGroups = groups();
  const queued = dispatch(currentGroups[0]);
  const appearance = { name: 'Custom recorder', thumbnailId: 'a'.repeat(64) };
  assert.deepEqual(plan(currentGroups, [queued], new Set([queued.serializedPayload]), now, 60, appearance).map(action => action.type), ['replace']);
  for (const state of ['picked_up', 'unknown', 'completed', 'failed'] as const) {
    assert.deepEqual(plan(currentGroups, [{ ...queued, state }], new Set(), now, 60, appearance), []);
  }
  const matching = { ...queued, payload: { ...queued.payload, ...appearance } };
  assert.deepEqual(plan(currentGroups, [matching], new Set([matching.serializedPayload]), now, 60, appearance), []);
  assert.equal(plan(currentGroups, [matching], new Set([matching.serializedPayload]), now, 60, { name: appearance.name })[0]?.type, 'replace');
});
