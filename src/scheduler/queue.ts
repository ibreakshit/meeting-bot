import { TranscriptQueue } from '../transcription/queue';
import { createHash } from 'node:crypto';
import { isValidThumbnailId } from './settings';
import { parseJoinLink } from './links';
import type { createClient } from 'redis';
import type {
  BotLogReport, DispatchObservation, DispatchRecord, RecordingPayload,
  SchedulerConfig, StatusReport, StoredRecording
} from './types';

type LedgerConfig = Pick<SchedulerConfig, 'queueName' | 'resultList' | 'failureList' | 'workers'> & { transcriptionEnabled?: boolean; s3?: { bucket: string } };
type RedisClient = ReturnType<typeof createClient>;

export interface LedgerDiagnostic {
  kind: string;
  source?: string;
  error?: string;
  receivedAt?: number;
}

// Every script validates every key it may write before its first mutation. Redis
// scripts prevent interleaving, but a runtime error does not roll back writes.
const SCRIPT_COMMON = `
local expectedTypes = {'string', 'hash', 'hash', 'zset', 'set', 'hash', 'list', 'list', 'list'}
for i, key in ipairs(KEYS) do
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expectedTypes[i] then
    return redis.error_reply('Unexpected Redis key type: ' .. key)
  end
end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return redis.error_reply('Scheduler dataset marker missing or incompatible; explicit initialization required')
end
local function loadRecord(botId)
  local raw = redis.call('HGET', KEYS[2], botId)
  if not raw then return nil end
  local record = cjson.decode(raw)
  if type(record) ~= 'table' or record.botId ~= botId or type(record.memberInstanceKeys) ~= 'table' then
    error('Invalid stored dispatch record')
  end
  return record
end
local function nonblocking(record)
  return record.state == 'removed' and record.removedBeforePickup == true
end
local function saveRecord(record)
  redis.call('HSET', KEYS[2], record.botId, cjson.encode(record))
end
local function visibleHistory(botId, timestamp)
  redis.call('ZADD', KEYS[4], timestamp, botId)
  redis.call('ZREMRANGEBYRANK', KEYS[4], 0, -201)
end
local function mergeRecording(record, incoming)
  if not incoming or incoming == cjson.null then return end
  local existing = record.recording
  if not existing then record.recording = incoming; return end
  if existing.recordingId ~= incoming.recordingId then
    existing.locationConflict = true
    return
  end
  if existing.storage and incoming.storage then
    if existing.storage.provider ~= incoming.storage.provider or existing.storage.bucket ~= incoming.storage.bucket or existing.storage.key ~= incoming.storage.key then
      existing.locationConflict = true
    end
  elseif incoming.storage then existing.storage = incoming.storage end
  if not existing.duration then existing.duration = incoming.duration end
  if not existing.contentType then existing.contentType = incoming.contentType end
end
`;

const ENQUEUE_SCRIPT = SCRIPT_COMMON + `
local candidate = cjson.decode(ARGV[2])
local replaces = ARGV[3]
local existing = loadRecord(candidate.botId)
if existing then
  if candidate.source == 'manual' and existing.payload.url ~= candidate.payload.url then
    return redis.error_reply('Invitation request was already submitted for another target')
  end
  return cjson.encode(existing)
end
local previous = nil
if replaces ~= '' then
  previous = loadRecord(replaces)
  if not previous or previous.state ~= 'queued' or previous.outcome then return false end
  for _, member in ipairs(previous.memberInstanceKeys) do
    if redis.call('HGET', KEYS[3], member) ~= replaces then return false end
  end
end
local blocker = nil
-- A manual invitation must share any queued or unconfirmed execution in the same room.
-- The same check also prevents a later calendar tick from starting a second bot.
if candidate.roomId then
  for _, raw in ipairs(redis.call('HVALS', KEYS[2])) do
    local owner = cjson.decode(raw)
    if owner.botId ~= replaces and owner.roomId == candidate.roomId and (not owner.outcome or owner.outcome.status == 'unknown')
      and (owner.state == 'queued' or owner.state == 'picked_up' or owner.state == 'unknown')
      and (candidate.source == 'manual' or owner.source == 'manual') then
      blocker = owner
      break
    end
  end
end
local owners = {}
for _, member in ipairs(candidate.memberInstanceKeys) do
  local ownerId = redis.call('HGET', KEYS[3], member)
  if ownerId then
    local owner = loadRecord(ownerId)
    if not owner then return redis.error_reply('Instance index has no dispatch record') end
    if candidate.source == 'manual' and owner.roomId and owner.roomId ~= candidate.roomId then
      return redis.error_reply('Invitation request identity belongs to another room')
    end
    owners[member] = owner
    if not nonblocking(owner) and ownerId ~= replaces and not blocker then blocker = owner end
  end
end
if blocker then
  if previous then return false end
  -- A newly observed group member becomes protected by the existing execution.
  -- Never steal a member already owned by another blocking execution.
  local membership = {}
  for _, member in ipairs(blocker.memberInstanceKeys) do membership[member] = true end
  for _, member in ipairs(candidate.memberInstanceKeys) do
    local owner = owners[member]
    if not membership[member] and (not owner or nonblocking(owner)) then
      table.insert(blocker.memberInstanceKeys, member)
      membership[member] = true
    end
  end
  local encoded = cjson.encode(blocker)
  for _, member in ipairs(blocker.memberInstanceKeys) do
    redis.call('HSET', KEYS[3], member, blocker.botId)
  end
  redis.call('HSET', KEYS[2], blocker.botId, encoded)
  return encoded
end
if previous then
  -- A calendar replacement must retain manual request IDs already bound to that execution.
  local membership = {}
  for _, member in ipairs(candidate.memberInstanceKeys) do membership[member] = true end
  for _, member in ipairs(previous.memberInstanceKeys) do
    if string.sub(member, 1, 7) == 'manual:' and not membership[member] then
      table.insert(candidate.memberInstanceKeys, member)
      membership[member] = true
    end
  end
end
local encoded = cjson.encode(candidate)
local oldEncoded = nil
if previous then
  previous.state = 'removed'
  previous.removedBeforePickup = true
  previous.reason = 'replaced before pickup'
  oldEncoded = cjson.encode(previous)
end
if previous and redis.call('LREM', KEYS[8], 1, previous.serializedPayload) ~= 1 then return false end
if previous then
  redis.call('HSET', KEYS[2], previous.botId, oldEncoded)
  visibleHistory(previous.botId, ARGV[4])
end
redis.call('HSET', KEYS[2], candidate.botId, encoded)
for _, member in ipairs(candidate.memberInstanceKeys) do redis.call('HSET', KEYS[3], member, candidate.botId) end
redis.call('RPUSH', KEYS[8], candidate.serializedPayload)
return encoded
`;

const REMOVE_SCRIPT = SCRIPT_COMMON + `
local record = loadRecord(ARGV[2])
if not record then return false end
if nonblocking(record) then return cjson.encode(record) end
if record.state ~= 'queued' or record.outcome then return false end
for _, member in ipairs(record.memberInstanceKeys) do
  if redis.call('HGET', KEYS[3], member) ~= record.botId then return false end
end
record.state = 'removed'
record.removedBeforePickup = true
record.reason = ARGV[3]
local encoded = cjson.encode(record)
if redis.call('LREM', KEYS[8], 1, record.serializedPayload) ~= 1 then return false end
redis.call('HSET', KEYS[2], record.botId, encoded)
visibleHistory(record.botId, ARGV[4])
return encoded
`;

const ATTACH_SCRIPT = SCRIPT_COMMON + `
local record = loadRecord(ARGV[2])
if not record or nonblocking(record) then return false end
local members = cjson.decode(ARGV[3])
local membership = {}
local additions = {}
for _, member in ipairs(record.memberInstanceKeys) do membership[member] = true end
for _, member in ipairs(members) do
  if not membership[member] then
    local ownerId = redis.call('HGET', KEYS[3], member)
    local owner = ownerId and loadRecord(ownerId) or nil
    if ownerId and not owner then return redis.error_reply('Instance index has no dispatch record') end
    if not owner or ownerId == record.botId or nonblocking(owner) then
      table.insert(record.memberInstanceKeys, member)
      table.insert(additions, member)
      membership[member] = true
    end
  end
end
local encoded = cjson.encode(record)
redis.call('HSET', KEYS[2], record.botId, encoded)
for _, member in ipairs(additions) do redis.call('HSET', KEYS[3], member, record.botId) end
return true
`;

const OBSERVE_SCRIPT = SCRIPT_COMMON + `
local record = loadRecord(ARGV[2])
if not record then return false end
local patch = cjson.decode(ARGV[3])
local terminal = record.outcome ~= nil or nonblocking(record)
for field, value in pairs(patch) do
  if field ~= 'state' or not terminal then record[field] = value end
end
saveRecord(record)
if record.state == 'unknown' then visibleHistory(record.botId, ARGV[4]) end
return true
`;

const REPORT_SCRIPT = SCRIPT_COMMON + `
local report = cjson.decode(ARGV[3])
local record = loadRecord(ARGV[2])
if not record then
  local archive = cjson.encode({kind = ARGV[4], report = report})
  redis.call('RPUSH', KEYS[7], archive)
  redis.call('LTRIM', KEYS[7], -200, -1)
  return true
end
local kind = ARGV[4]
if kind == 'recording' then
  mergeRecording(record, cjson.decode(ARGV[5]))
else
  if not record[kind] then record[kind] = {} end
  table.insert(record[kind], report)
end
local encoded = cjson.encode(record)
-- Raw recording delivery is diagnostic evidence, separate from serialized UI records.
if kind == 'recording' then redis.call('HSET', KEYS[6], ARGV[6], ARGV[3]) end
redis.call('HSET', KEYS[2], record.botId, encoded)
return true
`;

const INGEST_SCRIPT = SCRIPT_COMMON + `
if redis.call('LINDEX', KEYS[9], 0) ~= ARGV[2] then return false end
local digest = ARGV[3]
if redis.call('SISMEMBER', KEYS[5], digest) == 1 then
  redis.call('LPOP', KEYS[9])
  return true
end
local update = cjson.decode(ARGV[4])
local record = nil
if update.botId then record = loadRecord(update.botId) end
local encoded = nil
local archive = nil
if update.valid and record then
  local outcome = record.outcome
  if not outcome or not outcome.conflict then
    if outcome and outcome.status ~= 'unknown' and outcome.status ~= update.status then
      record.outcome = {status = 'unknown', timestamp = update.timestamp, conflict = true}
      record.state = 'unknown'
    else
      record.outcome = {status = update.status, timestamp = update.timestamp, error = update.error}
      record.state = update.status
    end
  end
  mergeRecording(record, update.recording)
  encoded = cjson.encode(record)
else
  archive = cjson.encode({kind = update.valid and 'unscheduled result' or 'malformed result', source = KEYS[9], raw = ARGV[2], error = update.error, receivedAt = tonumber(ARGV[5])})
end
-- Persist evidence and the merged terminal summary before acknowledging the list.
redis.call('HSET', KEYS[6], digest, ARGV[2])
if encoded then
  redis.call('HSET', KEYS[2], record.botId, encoded)
  visibleHistory(record.botId, ARGV[5])
else
  redis.call('RPUSH', KEYS[7], archive)
  redis.call('LTRIM', KEYS[7], -200, -1)
end
redis.call('SADD', KEYS[5], digest)
redis.call('LPOP', KEYS[9])
return true
`;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function digest(source: string, raw: string): string { return createHash('sha256').update(source).update('\0').update(raw).digest('hex'); }

function recordingMetadata(payload: RecordingPayload): StoredRecording | undefined {
  const metadata = payload.metadata;
  if (!metadata || !nonempty(metadata.botId)) return undefined;
  const recording: StoredRecording = { botId: metadata.botId, recordingId: payload.recordingId, timestamp: payload.timestamp, acceptedAt: Date.now() };
  if (typeof metadata.duration === 'number' && Number.isFinite(metadata.duration) && metadata.duration >= 0) recording.duration = metadata.duration;
  if (nonempty(metadata.contentType)) recording.contentType = metadata.contentType;
  const storage = metadata.storage;
  if (isObject(storage) && nonempty(storage.provider)) {
    recording.storage = { provider: storage.provider };
    if (nonempty(storage.bucket)) recording.storage.bucket = storage.bucket;
    if (nonempty(storage.key)) recording.storage.key = storage.key;
  }
  return recording;
}

function validateRecording(value: unknown): asserts value is RecordingPayload {
  if (!isObject(value) || !nonempty(value.recordingId) || !nonempty(value.status) || !nonempty(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) || (value.metadata !== undefined && !isObject(value.metadata))) {
    throw new Error('Invalid recording result payload');
  }
}

export class RedisLedger {
  private readonly keys: string[];
  private readonly marker: string;
  private readonly transcripts?: TranscriptQueue;

  constructor(private readonly client: RedisClient, private readonly config: LedgerConfig) {
    const queueNames = [config.queueName, config.resultList, config.failureList, ...config.workers.map(worker => worker.processingQueue)];
    if (queueNames.some(name => !nonempty(name)) || new Set(queueNames).size !== queueNames.length || new Set(config.workers.map(worker => worker.id)).size !== config.workers.length) throw new Error('Redis list and worker identities must be unique');
    const prefix = `${config.queueName}:scheduler:`;
    this.keys = ['dataset', 'dispatches', 'instances', 'history', 'seen', 'evidence', 'archives'].map(name => prefix + name).concat(config.queueName);
    if (queueNames.some(name => this.keys.slice(0, 7).includes(name))) throw new Error('Redis list collides with scheduler ledger');
    if (config.transcriptionEnabled && config.s3?.bucket) this.transcripts = new TranscriptQueue(client, config.queueName, config.s3.bucket);
    this.marker = JSON.stringify({ version: 1, queueName: config.queueName, resultList: config.resultList, failureList: config.failureList });
  }

  private async run(script: string, args: string[], source?: string): Promise<unknown> {
    return this.client.eval(script, { keys: source ? [...this.keys, source] : this.keys, arguments: [this.marker, ...args] });
  }

  private async persistenceConfiguration(): Promise<void> {
    const settings = await this.client.configGet(['appendonly', 'appendfsync', 'no-appendfsync-on-rewrite', 'aof-load-truncated', 'maxmemory-policy']);
    const expected = { appendonly: 'yes', appendfsync: 'always', 'no-appendfsync-on-rewrite': 'no', 'aof-load-truncated': 'no', 'maxmemory-policy': 'noeviction' };
    for (const [name, value] of Object.entries(expected)) if (settings[name] !== value) throw new Error(`Unsafe Redis persistence configuration: ${name}`);
    const info = await this.client.info('persistence');
    const status = Object.fromEntries(info.split(/\r?\n/).filter(line => line.includes(':')).map(line => line.split(':', 2)));
    if (status.aof_enabled !== '1' || status.aof_last_write_status !== 'ok' || status.aof_last_bgrewrite_status !== 'ok' || status.loading !== '0') throw new Error('Redis AOF persistence is unavailable or failed');
  }

  async initialize(): Promise<void> {
    await this.persistenceConfiguration();
    // Only the explicit initialization CLI invokes this method. Normal startup
    // calls checkPersistence and never reconstructs a missing execution dataset.
    await this.client.set(this.keys[0], this.marker, { NX: true });
    await this.checkPersistence();
  }

  async checkPersistence(): Promise<void> {
    await this.persistenceConfiguration();
    if (await this.client.get(this.keys[0]) !== this.marker) throw new Error('Scheduler dataset marker missing or incompatible; explicit initialization required');
    await this.transcripts?.activate();
  }

  async reconcileTranscriptions(): Promise<void> {
    if (!this.transcripts) return;
    await this.transcripts.activate();
    for (const record of await this.listDispatches()) {
      const r = record.recording;
      if (!r || r.locationConflict || r.storage?.provider !== 's3' || !r.storage.bucket || r.storage.bucket !== this.config.s3?.bucket || !r.storage.key) continue;
      try { await this.transcripts.ensureJob({ botId: record.botId, recordingId: r.recordingId, bucket: r.storage.bucket, key: r.storage.key }); }
      catch (error) { if (!(error instanceof Error) || !/not eligible/.test(error.message)) throw error; }
    }
  }

  async listDispatches(): Promise<DispatchRecord[]> {
    return Object.values(await this.client.hGetAll(this.keys[1])).map(raw => JSON.parse(raw) as DispatchRecord);
  }

  async pendingPayloads(): Promise<Set<string>> { return new Set(await this.client.lRange(this.config.queueName, 0, -1)); }

  async processingPayloads(): Promise<Record<string, string[]>> {
    return Object.fromEntries(await Promise.all(this.config.workers.map(async worker => [worker.id, await this.client.lRange(worker.processingQueue, 0, -1)])));
  }

  async enqueue(record: DispatchRecord, replacesBotId?: string): Promise<DispatchRecord | null> {
    this.validateDispatch(record);
    if (replacesBotId === record.botId) throw new Error('Replacement requires a new botId');
    await this.checkPersistence();
    const link = parseJoinLink(record.payload.url);
    const candidate: DispatchRecord = {
      botId: record.botId, payload: record.payload, serializedPayload: record.serializedPayload,
      memberInstanceKeys: [...new Set(record.memberInstanceKeys)], pushedAt: record.pushedAt,
      scheduledStart: record.scheduledStart, scheduledEnd: record.scheduledEnd, state: 'queued',
      ...(record.source ? { source: record.source } : {}),
      ...(link ? { roomId: link.roomId } : {}),
      ...(replacesBotId ? { replacesBotId } : {})
    };
    const raw = await this.run(ENQUEUE_SCRIPT, [JSON.stringify(candidate), replacesBotId ?? '', String(Date.now())]);
    return typeof raw === 'string' ? JSON.parse(raw) as DispatchRecord : null;
  }

  async remove(botId: string, reason: string): Promise<DispatchRecord | null> {
    const raw = await this.run(REMOVE_SCRIPT, [botId, reason, String(Date.now())]);
    return typeof raw === 'string' ? JSON.parse(raw) as DispatchRecord : null;
  }

  async attachMembers(botId: string, memberKeys: string[]): Promise<boolean> {
    if (!memberKeys.every(nonempty)) throw new Error('Invalid member identity');
    return Boolean(await this.run(ATTACH_SCRIPT, [botId, JSON.stringify([...new Set(memberKeys)])]));
  }

  async observe(botId: string, patch: DispatchObservation): Promise<void> {
    const allowed = ['state', 'reason', 'workerId', 'firstObservedAt', 'calendarChangedAt', 'changedFields'];
    if (Object.keys(patch).some(field => !allowed.includes(field)) || (patch.state !== undefined && !['picked_up', 'unknown'].includes(patch.state))) throw new Error('Invalid dispatch observation');
    await this.run(OBSERVE_SCRIPT, [botId, JSON.stringify(patch), String(Date.now())]);
  }

  async addAttempt(report: StatusReport): Promise<void> {
    await this.run(REPORT_SCRIPT, [report.botId, JSON.stringify({ ...report, receivedAt: Date.now() }), 'attempts', '', '']);
  }

  async addLog(report: BotLogReport): Promise<void> {
    await this.run(REPORT_SCRIPT, [report.botId, JSON.stringify({ ...report, receivedAt: Date.now() }), 'logs', '', '']);
  }

  async addRecording(payload: RecordingPayload): Promise<void> {
    validateRecording(payload);
    const raw = JSON.stringify(payload);
    const recording = payload.status === 'completed' ? recordingMetadata(payload) : undefined;
    await this.run(REPORT_SCRIPT, [recording?.botId ?? '', raw, 'recording', JSON.stringify(recording ?? null), digest('webhook', raw)]);
    await this.reconcileTranscriptions().catch(() => undefined);
  }

  async ingestResults(limit = 100): Promise<{ pending: boolean }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Result ingestion limit must be between 1 and 1000');
    for (const source of [this.config.resultList, this.config.failureList]) {
      for (let count = 0; count < limit; count++) {
        const raw = await this.client.lIndex(source, 0);
        if (raw === null) break;
        let update: Record<string, unknown>;
        try {
          const value: unknown = JSON.parse(raw);
          validateRecording(value);
          const status = source === this.config.resultList ? 'completed' : 'failed';
          if (value.status !== status) throw new Error('Result status does not match its source list');
          const object = value as RecordingPayload & { error?: unknown };
          if (status === 'failed' && (!isObject(object.error) || !nonempty(object.error.message) || (object.error.type !== undefined && !nonempty(object.error.type)))) throw new Error('Invalid permanent failure error');
          update = { valid: true, botId: nonempty(value.metadata?.botId) ? value.metadata.botId : undefined, status, timestamp: value.timestamp };
          if (status === 'completed') update.recording = recordingMetadata(value);
          if (status === 'failed' && isObject(object.error)) update.error = { type: object.error.type, message: object.error.message };
        } catch (error) {
          update = { valid: false, error: error instanceof SyntaxError ? 'Invalid result JSON' : error instanceof Error ? error.message : 'Malformed result' };
        }
        const committed = await this.run(INGEST_SCRIPT, [raw, digest(source, raw), JSON.stringify(update), String(Date.now())], source);
        if (!committed) break;
      }
    }
    const lengths = await Promise.all([this.client.lLen(this.config.resultList), this.client.lLen(this.config.failureList)]);
    await this.reconcileTranscriptions().catch(() => undefined);
    return { pending: lengths.some(length => length > 0) };
  }

  async history(): Promise<DispatchRecord[]> {
    const ids = await this.client.zRange(this.keys[3], 0, 199, { REV: true });
    if (ids.length === 0) return [];
    return (await this.client.hmGet(this.keys[1], ids)).filter((raw): raw is string => raw !== null).map(raw => JSON.parse(raw) as DispatchRecord);
  }

  async diagnostics(): Promise<LedgerDiagnostic[]> {
    return (await this.client.lRange(this.keys[6], -200, -1)).map(raw => {
      const archive: Record<string, unknown> = JSON.parse(raw);
      const diagnostic: LedgerDiagnostic = { kind: String(archive.kind) };
      if (typeof archive.source === 'string') diagnostic.source = archive.source;
      if (typeof archive.error === 'string') diagnostic.error = archive.error;
      if (typeof archive.receivedAt === 'number') diagnostic.receivedAt = archive.receivedAt;
      return diagnostic;
    });
  }

  private validateDispatch(record: DispatchRecord): void {
    if (record.source !== undefined && record.source !== 'manual') throw new Error('Invalid dispatch source');
    if (!nonempty(record.botId) || !Array.isArray(record.memberInstanceKeys) || !record.memberInstanceKeys.length || !record.memberInstanceKeys.every(nonempty) || ![record.pushedAt, record.scheduledStart, record.scheduledEnd].every(Number.isFinite) || record.scheduledEnd <= record.scheduledStart) throw new Error('Invalid dispatch identity or schedule');
    let parsed: unknown;
    try { parsed = JSON.parse(record.serializedPayload); } catch { throw new Error('Invalid serialized job payload'); }
    if (!isObject(parsed) || JSON.stringify(parsed) !== JSON.stringify(record.payload) || parsed.botId !== record.botId || !['google', 'zoom', 'microsoft'].includes(String(parsed.provider)) || !['url', 'name', 'timezone', 'teamId', 'userId', 'bearerToken'].every(field => nonempty(parsed[field]))) throw new Error('Invalid job payload or serialization mismatch');
    if (parsed.thumbnailId !== undefined && !isValidThumbnailId(parsed.thumbnailId)) throw new Error('Invalid job thumbnail ID');
    try { if (new URL(String(parsed.url)).protocol !== 'https:') throw new Error(); } catch { throw new Error('Invalid job payload URL'); }
    if (record.source === 'manual' && !parseJoinLink(String(parsed.url))) throw new Error('Invalid manual invitation URL');
  }
}
