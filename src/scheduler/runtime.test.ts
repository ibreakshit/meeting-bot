import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SchedulerRuntime } from './runtime';
import { SchedulerStore } from './store';
import { GooglePollError } from './google';
import type { Account, CalendarEvent, CalendarState, DispatchRecord, SchedulerState, WorkerObservation } from './types';

const epoch = Date.parse('2026-11-01T00:00:00Z');
const config = {
  maxSnapshotAgeSeconds: 300, joinLeadSeconds: 60, ownerAliases: [], botName: 'Recorder', teamId: 'team', userId: 'owner', bearerToken: 'fixture',
  workers: [{ id: '1', baseUrl: 'http://worker1:3000', processingQueue: 'processing1' }, { id: '2', baseUrl: 'http://worker2:3000', processingQueue: 'processing2' }],
};
const meeting: CalendarEvent = { id: 'event', iCalUID: 'invite', start: { dateTime: new Date(epoch + 30_000).toISOString() }, end: { dateTime: new Date(epoch + 3_600_000).toISOString() },
  hangoutLink: 'https://meet.google.com/abc-defg-hij', attendees: [{ email: 'owner@example.test', responseStatus: 'accepted' }, { email: 'guest@example.test' }] };

test('manual invitations use saved appearance without a calendar and survive reconciliation until pickup expiry', async () => {
  const f = await fixture();
  await f.store.update(state => { state.accounts = []; state.calendars = []; state.botSettings = { name: 'My assistant', thumbnailId: 'a'.repeat(64) }; });
  await f.runtime.start({ timers: false });
  const request = { requestId: randomUUID(), url: 'https://zoom.us/j/123456789?pwd=fixture', timezone: 'Asia/Seoul' };
  const job = await f.runtime.invite(request);
  assert.equal(job.source, 'manual');
  assert.equal(job.payload.name, 'My assistant');
  assert.equal(job.payload.thumbnailId, 'a'.repeat(64));
  assert.equal(job.payload.timezone, 'Asia/Seoul');
  assert.equal(job.payload.provider, 'zoom');
  assert.equal(job.payload.url, request.url);
  await f.runtime.tick();
  assert.equal(f.pending.size, 1);
  assert.equal((await f.runtime.invite(request)).botId, job.botId);
  assert.equal((await f.runtime.invite({ ...request, requestId: randomUUID() })).botId, job.botId);
  assert.equal(f.records.length, 1);
  await assert.rejects(f.runtime.invite({ ...request, url: 'https://meet.google.com/abc-defg-hij' }), /request|submitted/i);
  await f.store.update(state => { state.botSettings = { name: 'New assistant' }; });
  await f.runtime.tick();
  const pending = f.records.find(record => record.state === 'queued');
  assert.ok(pending);
  assert.equal(pending.payload.name, 'New assistant');
  assert.equal(pending.payload.thumbnailId, undefined);
  f.advance(3 * 3600000);
  await f.runtime.tick();
  assert.equal(f.pending.size, 0);
  assert.equal(f.records.find(record => record.botId === pending.botId)?.removedBeforePickup, true);
  await f.runtime.stop();
});

test('manual invitations reject unsupported destinations, malformed identity and unavailable runtime', async () => {
  const f = await fixture();
  const request = { requestId: randomUUID(), url: 'https://meet.google.com/abc-defg-hij', timezone: 'UTC' };
  await assert.rejects(f.runtime.invite(request), /unavailable|ready/i);
  await f.runtime.start({ timers: false });
  for (const url of ['http://meet.google.com/abc-defg-hij', 'https://meet.google.com.evil.test/abc-defg-hij', 'https://owner:password@meet.google.com/abc-defg-hij', 'https://meet.google.com:444/abc-defg-hij', 'https://example.test/room', 'https://meet.google.com/abc-defg-hij\n']) {
    await assert.rejects(f.runtime.invite({ ...request, url }));
  }
  await assert.rejects(f.runtime.invite({ ...request, requestId: 'invalid' }));
  await assert.rejects(f.runtime.invite({ ...request, timezone: 'invalid/zone' }));
  assert.equal(f.records.length, 0);
  await f.runtime.stop();
});

test('manual invite follows a replacement when the legacy active snapshot is removed before attachment', async () => {
  const f = await fixture(); await f.runtime.start({ timers: false }); await f.runtime.pollCalendars(); await f.runtime.tick();
  const previous = f.records[0];
  const replacementId = randomUUID();
  f.ledger.attachMembers = async () => {
    f.pending.delete(previous.serializedPayload);
    Object.assign(previous, { state: 'removed', removedBeforePickup: true });
    const payload = { ...previous.payload, botId: replacementId };
    const replacement: DispatchRecord = { ...previous, botId: replacementId, roomId: 'meet:abc-defg-hij',
      payload, serializedPayload: JSON.stringify(payload), state: 'queued', removedBeforePickup: undefined };
    f.records.push(replacement); f.pending.add(replacement.serializedPayload);
    return false;
  };
  const request = { requestId: randomUUID(), url: previous.payload.url, timezone: 'UTC' };
  const invited = await f.runtime.invite(request);
  assert.equal(invited.botId, replacementId);
  assert.ok(invited.memberInstanceKeys.includes(`manual:${request.requestId}`));
  assert.equal(f.pending.size, 1);
  assert.equal(f.records.length, 2);
  await f.runtime.stop();
});

async function fixture(poll: (account: Account, calendar: CalendarState, now: number) => Promise<CalendarEvent[]> = async () => [meeting]) {
  let now = epoch;
  const store = new SchedulerStore('/unused', async () => undefined);
  await store.update(state => {
    state.accounts.push({ id: 'owner', email: 'owner@example.test', refreshToken: 'encrypted', connectedAt: '2026-11-01', needsReconnect: false });
    state.calendars.push({ id: 'calendar', accountId: 'owner', summary: 'Calendar', watched: true, timeZone: 'UTC', events: [meeting], verified: false, selectionRevision: 0 });
  });
  const records: DispatchRecord[] = [];
  const pending = new Set<string>();
  const processing: Record<string, string[]> = { '1': [], '2': [] };
  const workers: WorkerObservation[] = config.workers.map(worker => ({ id: worker.id, reachable: true, busy: false, observedAt: epoch, lastSuccess: epoch, uptime: 60 }));
  const ledger = {
    async checkPersistence() { return undefined; }, async ingestResults() { return { pending: false }; },
    async listDispatches() { return structuredClone(records); }, async pendingPayloads() { return new Set(pending); },
    async processingPayloads() { return structuredClone(processing); }, async attachMembers(botId: string, members: string[]) {
      const record = records.find(item => item.botId === botId);
      if (!record || record.state === 'removed') return false;
      record.memberInstanceKeys = [...new Set([...record.memberInstanceKeys, ...members])];
      return true;
    },
    async enqueue(record: DispatchRecord, replacesBotId?: string) {
      const existing = records.find(item => item.botId === record.botId ||
        (!item.outcome && ['queued', 'picked_up', 'unknown'].includes(item.state) && item.roomId === record.roomId &&
          (item.source === 'manual' || record.source === 'manual')));
      if (existing && existing.botId !== replacesBotId) {
        existing.memberInstanceKeys = [...new Set([...existing.memberInstanceKeys, ...record.memberInstanceKeys])];
        return existing;
      }
      if (replacesBotId) {
        const previous = records.find(item => item.botId === replacesBotId);
        if (!previous || !pending.delete(previous.serializedPayload)) return null;
        Object.assign(previous, { state: 'removed', removedBeforePickup: true });
      }
      records.push(structuredClone(record)); pending.add(record.serializedPayload); return record;
    },
    async remove(botId: string, reason: string) {
      const record = records.find(record => record.botId === botId);
      if (!record || !pending.delete(record.serializedPayload)) return null;
      Object.assign(record, { state: 'removed', removedBeforePickup: true, reason }); return record;
    },
    async observe(botId: string, patch: Partial<DispatchRecord>) {
      const record = records.find(record => record.botId === botId);
      assert.ok(record);
      Object.assign(record, patch);
    },
  };
  const runtime = new SchedulerRuntime(config, store, ledger, { pollCalendar: poll }, {
    now: () => now, random: () => 0, probe: async worker => {
      const observation = workers.find(observation => observation.id === worker.id);
      assert.ok(observation);
      return structuredClone(observation);
    },
  });
  return { runtime, store, ledger, records, pending, processing, workers, advance: (ms: number) => { now += ms; } };
}

test('startup never joins persisted snapshots, then fresh polling enqueues due meetings', async () => {
  const f = await fixture();
  await f.runtime.start({ timers: false });
  assert.equal(f.runtime.view().ready, true);
  assert.equal(f.records.length, 0);
  await f.runtime.pollCalendars();
  await f.runtime.tick();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].payload.provider, 'google');
  assert.equal(f.store.read().calendars[0].verified, true);
  await f.runtime.stop();
});

test('poll failures retain the snapshot, but the five minute cutoff withdraws pending jobs', async () => {
  let fail = false;
  const f = await fixture(async () => { if (fail) throw new GooglePollError('transient', 'unavailable'); return [meeting]; });
  await f.runtime.start({ timers: false });
  await f.runtime.pollCalendars(); await f.runtime.tick();
  fail = true; f.advance(60_000);
  await f.runtime.pollCalendars(); await f.runtime.tick();
  assert.equal(f.records[0].state, 'queued');
  assert.equal(f.store.read().calendars[0].events.length, 1);
  f.advance(240_000); await f.runtime.tick();
  assert.equal(f.records[0].state, 'removed');
  assert.equal(f.pending.size, 0);
  await f.runtime.stop();
});

test('invalid grant immediately disables all account calendars and withdraws pending jobs', async () => {
  let fail = false;
  const f = await fixture(async () => { if (fail) throw new GooglePollError('invalid_grant', 'reconnect'); return [meeting]; });
  await f.runtime.start({ timers: false }); await f.runtime.pollCalendars(); await f.runtime.tick();
  fail = true; f.advance(60_000); await f.runtime.pollCalendars(); await f.runtime.tick();
  assert.equal(f.store.read().accounts[0].needsReconnect, true);
  assert.equal(f.pending.size, 0);
  await f.runtime.stop();
});

test('an old in-flight poll cannot undo unwatch/re-watch verification', async () => {
  let resolve!: (events: CalendarEvent[]) => void;
  const f = await fixture(() => new Promise<CalendarEvent[]>(done => { resolve = done; }));
  await f.runtime.start({ timers: false });
  const polling = f.runtime.pollCalendars();
  await new Promise(done => setImmediate(done));
  await f.store.update((state: SchedulerState) => { state.calendars[0].selectionRevision = 2; state.calendars[0].verified = false; });
  resolve([meeting]); await polling; await f.runtime.tick();
  assert.equal(f.store.read().calendars[0].verified, false);
  assert.equal(f.records.length, 0);
  await f.runtime.stop();
});

test('one unreachable worker does not corrupt another worker execution', async () => {
  const f = await fixture();
  await f.runtime.start({ timers: false }); await f.runtime.pollCalendars(); await f.runtime.tick();
  const record = f.records[0]; f.pending.clear(); f.processing['2'] = [record.serializedPayload];
  f.workers[0].reachable = false; f.workers[1].busy = true;
  await f.runtime.tick();
  assert.equal(record.state, 'picked_up'); assert.equal(record.workerId, '2');
  assert.equal(f.records.length, 1);
  await f.runtime.stop();
});

test('each calendar backs off independently while a healthy source keeps scheduling', async () => {
  const calls: Record<string, number> = {};
  const f = await fixture(async (_account, calendar) => {
    calls[calendar.id] = (calls[calendar.id] || 0) + 1;
    if (calendar.id === 'calendar') throw new GooglePollError('transient', 'unavailable');
    return [meeting];
  });
  await f.store.update(state => {
    state.calendars.push({ ...state.calendars[0], id: 'healthy', events: [] });
  });
  await f.runtime.start({ timers: false });
  await f.runtime.pollCalendars();
  f.advance(60_000); await f.runtime.pollCalendars();
  f.advance(60_000); await f.runtime.pollCalendars(); await f.runtime.tick();
  assert.deepEqual(calls, { calendar: 2, healthy: 3 });
  assert.equal(f.store.read().calendars[0].verified, false);
  assert.equal(f.store.read().calendars[1].verified, true);
  assert.equal(f.records.length, 1);
  await f.runtime.stop();
});

test('a worker restart keeps its claimed execution unknown without another join', async () => {
  const f = await fixture();
  f.workers[0].startedAt = epoch - 60_000;
  await f.runtime.start({ timers: false }); await f.runtime.pollCalendars(); await f.runtime.tick();
  const record = f.records[0];
  f.pending.clear(); f.processing['1'] = [record.serializedPayload]; f.workers[0].busy = true;
  await f.runtime.tick();
  assert.equal(record.state, 'picked_up');
  f.workers[0].startedAt = epoch;
  await f.runtime.tick(); await f.runtime.tick();
  assert.equal(record.state, 'unknown');
  assert.equal(record.workerId, '1');
  assert.equal(f.records.length, 1);
  assert.equal(f.pending.size, 0);
  await f.runtime.stop();
});

test('saved appearance updates pending jobs but never replaces a picked-up execution', async () => {
  const f = await fixture();
  await f.store.update(state => { state.botSettings = { name: 'Custom recorder', thumbnailId: 'a'.repeat(64) }; });
  await f.runtime.start({ timers: false }); await f.runtime.pollCalendars(); await f.runtime.tick();
  assert.equal(f.records[0].payload.name, 'Custom recorder');
  assert.equal(f.records[0].payload.thumbnailId, 'a'.repeat(64));
  await f.store.update(state => { state.botSettings = { name: 'Updated recorder' }; });
  await f.runtime.tick();
  assert.equal(f.records.length, 2);
  assert.equal(f.records[0].state, 'removed');
  assert.equal(f.records[1].payload.name, 'Updated recorder');
  assert.equal(f.records[1].payload.thumbnailId, undefined);
  f.pending.clear(); f.processing['1'] = [f.records[1].serializedPayload]; f.workers[0].busy = true;
  await f.store.update(state => { state.botSettings = { name: 'Next meeting recorder' }; });
  await f.runtime.tick();
  assert.equal(f.records.length, 2);
  assert.equal(f.records[1].payload.name, 'Updated recorder');
  assert.equal(f.records[1].state, 'picked_up');
  await f.runtime.stop();
});
