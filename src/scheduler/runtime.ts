import { randomUUID } from 'node:crypto';
import { buildGroups } from './group';
import { plan } from './planner';
import { GooglePollError } from './google';
import { calendarKey } from './types';
import { getBotSettings } from './settings';
import { parseJoinLink } from './links';
import type { GoogleCalendar } from './google';
import type { RedisLedger } from './queue';
import type { SchedulerStore } from './store';
import type { DispatchRecord, MeetingGroup, RuntimeView, SchedulerConfig, WorkerObservation, WorkerRegistration } from './types';

type RuntimeLedger = Pick<RedisLedger, 'checkPersistence' | 'ingestResults' | 'listDispatches' | 'pendingPayloads' |
  'processingPayloads' | 'enqueue' | 'remove' | 'observe' | 'attachMembers'> & Partial<Pick<RedisLedger, 'reconcileTranscriptions'>>;
type RuntimeOptions = {
  now?: () => number;
  random?: () => number;
  probe?: (worker: WorkerRegistration) => Promise<WorkerObservation>;
};
type RuntimeConfig = Pick<SchedulerConfig, 'maxSnapshotAgeSeconds' | 'joinLeadSeconds' | 'ownerAliases' |
  'botName' | 'teamId' | 'userId' | 'bearerToken' | 'workers'>;

export class InvalidManualInviteError extends Error {}
export interface ManualInvitation { url: string; requestId: string; timezone: string }

async function probeWorker(worker: WorkerRegistration): Promise<WorkerObservation> {
  const signal = AbortSignal.timeout(3000);
  try {
    const [healthResponse, busyResponse] = await Promise.all([
      fetch(`${worker.baseUrl}/health`, { signal, redirect: 'error' }),
      fetch(`${worker.baseUrl}/isbusy`, { signal, redirect: 'error' }),
    ]);
    if (!healthResponse.ok || !busyResponse.ok) throw new Error('Worker health request failed');
    const health = await healthResponse.json() as { uptime?: number; timestamp?: string };
    const busy = await busyResponse.json() as { success?: boolean; data?: number };
    if (typeof health.uptime !== 'number' || !Number.isFinite(health.uptime) || health.uptime < 0 || !health.timestamp ||
      !Number.isFinite(Date.parse(health.timestamp)) || busy.success !== true || (busy.data !== 0 && busy.data !== 1)) {
      throw new Error('Invalid worker observation');
    }
    return { id: worker.id, reachable: true, busy: busy.data === 1, observedAt: Date.now(), lastSuccess: Date.now(),
      uptime: health.uptime, startedAt: Date.parse(health.timestamp) - health.uptime * 1000 };
  } catch {
    return { id: worker.id, reachable: false, observedAt: Date.now(), error: 'Worker unreachable' };
  }
}

export class SchedulerRuntime {
  private ready = false;
  private stopped = false;
  private ticking?: Promise<void>;
  private timers: NodeJS.Timeout[] = [];
  private polling = new Map<string, Promise<void>>();
  private schedules = new Map<string, { next: number; failures: number; selection: string }>();
  private observations: WorkerObservation[] = [];
  private queueDepth = 0;
  private ingestionPending = false;
  private lastError?: string;
  private now: () => number;
  private random: () => number;
  private probe: (worker: WorkerRegistration) => Promise<WorkerObservation>;

  constructor(private config: RuntimeConfig, private store: SchedulerStore, private ledger: RuntimeLedger,
    private google: Pick<GoogleCalendar, 'pollCalendar'>, options: RuntimeOptions = {}) {
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.probe = options.probe || probeWorker;
  }

  view(): RuntimeView {
    return { ready: this.ready, workers: structuredClone(this.observations),
      groups: buildGroups(this.store.read(), this.now(), this.config.maxSnapshotAgeSeconds, this.config.ownerAliases),
      queueDepth: this.queueDepth, ingestionPending: this.ingestionPending,
      lastError: this.store.isDirty ? 'Controls could not be saved; new dispatches are paused' : this.lastError };
  }

  async invite(request: ManualInvitation): Promise<DispatchRecord> {
    const link = typeof request.url === 'string' && request.url.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(request.url) ? parseJoinLink(request.url) : undefined;
    if (!link || new URL(link.url).port || typeof request.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId)) {
      throw new InvalidManualInviteError('Enter a supported HTTPS meeting URL and start a new invitation if needed.');
    }
    try {
      if (typeof request.timezone !== 'string' || request.timezone.length > 100) throw new Error();
      new Intl.DateTimeFormat('en-US', { timeZone: request.timezone });
    } catch { throw new InvalidManualInviteError('Your timezone could not be determined. Refresh and try again.'); }
    if (!this.ready || this.stopped || this.store.isDirty) throw new Error('Manual invitations are temporarily unavailable');
    await this.tick();
    if (this.lastError || this.stopped || this.store.isDirty) throw new Error('Manual invitations are temporarily unavailable');
    const memberKey = `manual:${request.requestId.toLowerCase()}`;
    const records = await this.ledger.listDispatches();
    const replays = records.filter(record => record.memberInstanceKeys.includes(memberKey));
    const replay = replays.find(record => !(record.state === 'removed' && record.removedBeforePickup)) || replays[replays.length - 1];
    if (replay) {
      if (parseJoinLink(replay.payload.url)?.roomId !== link.roomId) throw new InvalidManualInviteError('This request was already submitted. Start a new invitation for a different meeting.');
      return replay;
    }
    // Old ledger records predate roomId. Reuse active executions by parsing their existing URL.
    const active = records.find(record => (!record.outcome || record.outcome.status === 'unknown') && ['queued', 'picked_up', 'unknown'].includes(record.state) && parseJoinLink(record.payload.url)?.roomId === link.roomId);
    const botId = `manual-${request.requestId.toLowerCase()}`;
    const appearance = getBotSettings(this.store.read(), this.config.botName);
    const payload = { provider: link.provider, url: link.url, name: appearance.name,
      ...(appearance.thumbnailId ? { thumbnailId: appearance.thumbnailId } : {}),
      timezone: request.timezone, eventId: `manual:${link.provider}`, botId, teamId: this.config.teamId,
      userId: this.config.userId, bearerToken: this.config.bearerToken };
    const now = this.now();
    const candidate: DispatchRecord = { botId, source: 'manual', roomId: link.roomId, payload, serializedPayload: JSON.stringify(payload),
      memberInstanceKeys: [memberKey], pushedAt: now, scheduledStart: now, scheduledEnd: now + 3 * 3600000, state: 'queued' };
    if (active && !active.roomId && await this.ledger.attachMembers(active.botId, [memberKey])) {
      const currentRecords = await this.ledger.listDispatches();
      const current = currentRecords.find(record => record.memberInstanceKeys.includes(memberKey) && !(record.state === 'removed' && record.removedBeforePickup))
        || currentRecords.find(record => record.botId === active.botId);
      if (current) return current;
    }
    if (this.store.isDirty || this.stopped) throw new Error('Manual invitations are temporarily unavailable');
    const invited = await this.ledger.enqueue(candidate);
    if (!invited) throw new Error('Manual invitation could not be queued');
    this.queueDepth = (await this.ledger.pendingPayloads()).size;
    return invited;
  }

  async start(options: { timers?: boolean } = {}): Promise<void> {
    this.stopped = false;
    await this.ledger.checkPersistence();
    await this.tick();
    if (this.lastError) throw new Error(this.lastError);
    this.ready = true;
    if (options.timers !== false) {
      this.timers.push(setInterval(() => { void this.tick(); }, 10_000));
      this.timers.push(setInterval(() => { void this.pollCalendars(); }, 1000));
      void this.pollCalendars();
    }
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().catch(() => { this.lastError = 'Redis or scheduler state unavailable; dispatch paused'; })
      .finally(() => { this.ticking = undefined; });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    await this.store.flush();
    await this.ledger.checkPersistence();
    this.ingestionPending = (await this.ledger.ingestResults()).pending;
    // Transcript recovery is independent of recording readiness and dispatch health.
    await this.ledger.reconcileTranscriptions?.().catch(() => undefined);
    const previous = this.observations;
    this.observations = await Promise.all(this.config.workers.map(async worker => {
      try {
        const observed = await this.probe(worker);
        const old = previous.find(item => item.id === worker.id);
        return observed.reachable ? observed : { ...observed, lastSuccess: old?.lastSuccess, startedAt: old?.startedAt, uptime: old?.uptime };
      } catch { return { id: worker.id, reachable: false, observedAt: this.now(), error: 'Worker observation failed' }; }
    }));
    const pending = await this.ledger.pendingPayloads();
    const processing = await this.ledger.processingPayloads();
    const records = await this.ledger.listDispatches();
    this.queueDepth = pending.size;
    for (const record of records) {
      if (record.outcome || record.state === 'removed') continue;
      const owners = this.config.workers.filter(worker => processing[worker.id]?.includes(record.serializedPayload));
      if (owners.length === 1) {
        const worker = this.observations.find(item => item.id === owners[0].id);
        const old = previous.find(item => item.id === owners[0].id);
        const restarted = worker?.startedAt !== undefined && old?.startedAt !== undefined && Math.abs(worker.startedAt - old.startedAt) > 5000;
        const unknown = record.state === 'unknown' || !worker?.reachable || restarted || (!worker.busy && !this.ingestionPending);
        await this.ledger.observe(record.botId, { state: unknown ? 'unknown' : 'picked_up', workerId: owners[0].id,
          firstObservedAt: record.firstObservedAt || this.now(), ...(unknown ? { reason: 'Worker execution cannot be established from current observations' } : {}) });
      } else if (owners.length > 1 || (!pending.has(record.serializedPayload) && !this.ingestionPending)) {
        await this.ledger.observe(record.botId, { state: 'unknown', reason: owners.length > 1 ? 'Job appears in multiple processing lists' : 'No queue entry or authoritative result' });
      }
    }
    const dispatches = await this.ledger.listDispatches();
    const groups = buildGroups(this.store.read(), this.now(), this.config.maxSnapshotAgeSeconds, this.config.ownerAliases);
    for (const action of plan(groups, dispatches, pending, this.now(), this.config.joinLeadSeconds,
      getBotSettings(this.store.read(), this.config.botName))) {
      if (this.store.isDirty) break;
      if (action.type === 'remove') {
        await this.ledger.remove(action.dispatch.botId, action.reason);
      } else if (action.type === 'replace-manual') {
        const botId = `manual-${randomUUID()}`;
        const appearance = getBotSettings(this.store.read(), this.config.botName);
        const payload = { ...action.dispatch.payload, botId, name: appearance.name, thumbnailId: appearance.thumbnailId };
        await this.ledger.enqueue({ ...action.dispatch, botId, payload, serializedPayload: JSON.stringify(payload), pushedAt: this.now() }, action.dispatch.botId);
      } else if (action.type === 'annotate') {
        if (action.group) await this.ledger.attachMembers(action.dispatch.botId, action.group.memberKeys);
        if (action.changedFields.length) await this.ledger.observe(action.dispatch.botId, {
          calendarChangedAt: action.dispatch.calendarChangedAt || this.now(),
          changedFields: [...new Set([...(action.dispatch.changedFields || []), ...action.changedFields])],
        });
      } else {
        // Calendar/account controls may have changed while Redis or worker probes were in flight.
        const current = buildGroups(this.store.read(), this.now(), this.config.maxSnapshotAgeSeconds, this.config.ownerAliases)
          .find(group => group.id === action.group.id);
        if (!current?.join || !current.primary?.link || this.now() < current.start - this.config.joinLeadSeconds * 1000 || this.now() >= current.end) continue;
        await this.ledger.enqueue(this.dispatch(current), action.type === 'replace' ? action.dispatch.botId : undefined);
      }
    }
    this.queueDepth = (await this.ledger.pendingPayloads()).size;
    this.lastError = undefined;
  }

  private dispatch(group: MeetingGroup): DispatchRecord {
    const member = group.primary;
    if (!member?.link) throw new Error('Cannot dispatch a meeting without a supported link');
    const botId = randomUUID();
    const appearance = getBotSettings(this.store.read(), this.config.botName);
    const payload = { provider: member.link.provider, url: member.link.url, name: appearance.name,
      ...(appearance.thumbnailId ? { thumbnailId: appearance.thumbnailId } : {}),
      timezone: member.timeZone, eventId: member.event.id, botId, teamId: this.config.teamId,
      userId: this.config.userId, bearerToken: this.config.bearerToken };
    return { botId, payload, serializedPayload: JSON.stringify(payload), memberInstanceKeys: group.memberKeys,
      pushedAt: this.now(), scheduledStart: group.start, scheduledEnd: group.end, state: 'queued' };
  }

  async pollCalendars(): Promise<void> {
    if (this.stopped) return;
    const snapshot = this.store.read();
    const jobs: Promise<void>[] = [];
    for (const calendar of snapshot.calendars) {
      const account = snapshot.accounts.find(item => item.id === calendar.accountId);
      if (!calendar.watched || !account || account.needsReconnect) continue;
      const key = calendarKey(calendar);
      if (this.polling.has(key)) continue;
      const selection = `${account.refreshToken}:${calendar.selectionRevision || 0}`;
      const schedule = this.schedules.get(key);
      if (schedule?.selection === selection && schedule.next > this.now()) continue;
      const started = this.now();
      const task = (async () => {
        try {
          const events = await this.google.pollCalendar(account, calendar, started);
          await this.store.update(state => {
            const currentAccount = state.accounts.find(item => item.id === account.id);
            const current = state.calendars.find(item => calendarKey(item) === key);
            if (!current?.watched || currentAccount?.needsReconnect || currentAccount?.refreshToken !== account.refreshToken ||
              (current.selectionRevision || 0) !== (calendar.selectionRevision || 0)) return;
            Object.assign(current, { events, verified: true, unauthorized: false, lastSuccess: this.now(),
              lastAttempt: started, lastAttemptSucceeded: true, lastError: undefined });
          });
          this.schedules.set(key, { next: this.now() + 60_000 + this.random() * 5000, failures: 0, selection });
        } catch (error) {
          const kind = error instanceof GooglePollError ? error.kind : 'transient';
          try {
            await this.store.update(state => {
              const currentAccount = state.accounts.find(item => item.id === account.id);
              const current = state.calendars.find(item => calendarKey(item) === key);
              if (!current || !currentAccount || currentAccount.refreshToken !== account.refreshToken ||
                (current.selectionRevision || 0) !== (calendar.selectionRevision || 0)) return;
              Object.assign(current, { lastAttempt: started, lastAttemptSucceeded: false,
                lastError: kind === 'invalid_grant' ? 'Account needs reconnecting' : kind === 'access' ? 'Calendar access unavailable' : 'Temporary calendar polling failure' });
              if (kind === 'access') { current.unauthorized = true; current.verified = false; }
              if (kind === 'invalid_grant') {
                currentAccount.needsReconnect = true;
                for (const item of state.calendars.filter(item => item.accountId === account.id)) { item.verified = false; item.unauthorized = true; }
              }
            });
          } catch { this.lastError = 'Calendar state could not be saved; dispatch paused'; }
          const failures = (schedule?.failures || 0) + 1;
          this.schedules.set(key, { next: this.now() + Math.min(900_000, 60_000 * 2 ** Math.min(failures - 1, 4)) + this.random() * 5000, failures, selection });
        } finally { this.polling.delete(key); }
      })();
      this.polling.set(key, task);
      jobs.push(task);
    }
    await Promise.allSettled(jobs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await Promise.allSettled([...this.polling.values(), ...(this.ticking ? [this.ticking] : [])]);
  }
}
