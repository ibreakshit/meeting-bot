import { createHash, randomUUID } from 'node:crypto';
import type { createClient } from 'redis';
import type { ArtifactManifest, ClaimedTranscriptJob, RecordingSource, TranscriptManifest } from './types';

type RedisClient = ReturnType<typeof createClient>;
export function transcriptJobId(source: RecordingSource): string {
  if (![source.botId, source.recordingId, source.bucket, source.key].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Invalid recording source');
  return createHash('sha256').update(JSON.stringify([source.botId, source.recordingId, source.bucket, source.key])).digest('hex');
}

// Each operation checks the current ledger location, including after a job was
// claimed. A later conflicting completion revokes publication authority.
const COMMON = `
local expected = {'hash', 'list', 'zset', 'hash', 'hash', 'string'}
for i, key in ipairs(KEYS) do
  local actual = redis.call('TYPE', key).ok
  if actual ~= 'none' and actual ~= expected[i] then return redis.error_reply('Invalid transcript Redis key type') end
end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function eligible(source)
  local raw = redis.call('HGET', KEYS[5], source.botId)
  if not raw then return false end
  local r = cjson.decode(raw).recording
  local activation = tonumber(redis.call('GET', KEYS[6]))
  return r and activation and r.acceptedAt and r.acceptedAt >= activation and not r.locationConflict
    and r.recordingId == source.recordingId and r.storage and r.storage.provider == 's3'
    and r.storage.bucket == source.bucket and r.storage.key == source.key and source.bucket == ARGV[1]
end
local function owned(id, token)
  return redis.call('HGET', KEYS[4], id) == token and tonumber(redis.call('ZSCORE', KEYS[3], id) or '0') > now
end
`;
const ENSURE = COMMON + `
local source = cjson.decode(ARGV[3])
if not eligible(source) then return redis.error_reply('Recording source conflict or not eligible') end
if redis.call('HEXISTS', KEYS[1], ARGV[2]) == 0 then
  local job = {schemaVersion=1, jobId=ARGV[2], source=source, attempt=0, requestedAt=now,
    originalState='queued', correctionState='pending', revisions=cjson.empty_array, warnings=cjson.empty_array}
  redis.call('HSET', KEYS[1], ARGV[2], cjson.encode(job))
  redis.call('RPUSH', KEYS[2], ARGV[2])
end
return ARGV[2]
`;
const CLAIM = COMMON + `
for _, id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now)) do
  redis.call('ZREM', KEYS[3], id)
  redis.call('HDEL', KEYS[4], id)
  redis.call('RPUSH', KEYS[2], id)
end
if redis.call('ZCARD', KEYS[3]) > 0 then return false end
local count = redis.call('LLEN', KEYS[2])
for i = 1, count do
  local id = redis.call('LPOP', KEYS[2])
  local raw = redis.call('HGET', KEYS[1], id)
  if raw and not redis.call('ZSCORE', KEYS[3], id) then
    local job = cjson.decode(raw)
    if eligible(job.source) then
      if job.attempt >= 3 then
        if job.original then job.correctionState = 'failed' else job.originalState = 'failed'; job.correctionState = 'skipped' end
        job.error = 'Transcription attempt limit reached after worker interruption'
        redis.call('HSET', KEYS[1], id, cjson.encode(job))
      elseif job.nextAttemptAt and job.nextAttemptAt > now then redis.call('RPUSH', KEYS[2], id)
      else
        job.attempt = job.attempt + 1
        redis.call('HSET', KEYS[1], id, cjson.encode(job))
        job.token = ARGV[2]; job.leaseExpiry = now + 120000
        redis.call('HSET', KEYS[4], id, job.token)
        redis.call('ZADD', KEYS[3], job.leaseExpiry, id)
        return cjson.encode(job)
      end
    end
  end
end
return false
`;
const UPDATE = COMMON + `
if not owned(ARGV[2], ARGV[3]) then return false end
local job = cjson.decode(redis.call('HGET', KEYS[1], ARGV[2]))
if not eligible(job.source) then return false end
if ARGV[4] == 'renew' then
  redis.call('ZADD', KEYS[3], now + 120000, ARGV[2]); return true
end
local patch = cjson.decode(ARGV[5])
if patch.original and job.original then return false end
if patch.latestCorrection then
  if not job.original or patch.latestCorrection.sourceHash ~= job.original.sourceHash then return false end
  if type(job.revisions) ~= 'table' then job.revisions = {} end
  table.insert(job.revisions, patch.latestCorrection)
end
for key, value in pairs(patch) do job[key] = value end
redis.call('HSET', KEYS[1], ARGV[2], cjson.encode(job))
if ARGV[4] == 'finish' then
  redis.call('ZREM', KEYS[3], ARGV[2]); redis.call('HDEL', KEYS[4], ARGV[2])
  if patch.nextAttemptAt then redis.call('RPUSH', KEYS[2], ARGV[2]) end
end
return true
`;
export type ManifestUpdate = Partial<Pick<TranscriptManifest, 'fingerprint' | 'originalState' | 'correctionState' | 'original' | 'latestCorrection' | 'warnings' | 'error' | 'nextAttemptAt'>>;
export class TranscriptQueue {
  private readonly keys: string[];
  constructor(private readonly client: RedisClient, queueName: string, private readonly bucket: string) {
    const prefix = `${queueName}:transcripts:`;
    this.keys = ['jobs', 'pending', 'leases', 'owners'].map(name => prefix + name)
      .concat(`${queueName}:scheduler:dispatches`, prefix + 'activation');
  }
  private run(script: string, args: string[]) { return this.client.eval(script, { keys: this.keys, arguments: [this.bucket, ...args] }); }
  async activate(): Promise<void> {
    await this.client.eval('local t=redis.call(\'TIME\'); return redis.call(\'SET\', KEYS[1], tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000), \'NX\')', { keys: [this.keys[5]], arguments: [] });
  }
  async ensureJob(source: RecordingSource): Promise<string> { return String(await this.run(ENSURE, [transcriptJobId(source), JSON.stringify(source)])); }
  async claim(ownerId: string): Promise<ClaimedTranscriptJob | null> {
    if (!ownerId) throw new Error('Worker identity required');
    const raw = await this.run(CLAIM, [randomUUID()]);
    return typeof raw === 'string' ? JSON.parse(raw) as ClaimedTranscriptJob : null;
  }
  async renew(jobId: string, token: string): Promise<boolean> { return Boolean(await this.run(UPDATE, [jobId, token, 'renew', '{}'])); }
  async publish(jobId: string, token: string, update: ManifestUpdate): Promise<boolean> {
    return Boolean(await this.run(UPDATE, [jobId, token, 'publish', JSON.stringify(update)]));
  }
  async finish(jobId: string, token: string, update: ManifestUpdate = {}): Promise<boolean> {
    return Boolean(await this.run(UPDATE, [jobId, token, 'finish', JSON.stringify(update)]));
  }
  async fail(jobId: string, token: string, stage: 'original' | 'correction', error: string): Promise<void> {
    // Browser-facing errors are deliberately supplied as safe stage summaries.
    await this.finish(jobId, token, { [stage === 'original' ? 'originalState' : 'correctionState']: 'failed', ...(stage === 'original' ? { correctionState: 'skipped' as const } : {}), error });
  }
  async retryCorrection(jobId: string): Promise<boolean> {
    return Boolean(await this.run(COMMON + `
local raw = redis.call('HGET', KEYS[1], ARGV[2])
if not raw then return false end
local job = cjson.decode(raw)
if not job.original or not eligible(job.source) then return false end
if tonumber(redis.call('ZSCORE', KEYS[3], ARGV[2]) or '0') > now then return false end
job.correctionState = 'pending'; job.attempt = 0; job.nextAttemptAt = nil; job.error = nil
redis.call('HSET', KEYS[1], ARGV[2], cjson.encode(job))
redis.call('LREM', KEYS[2], 0, ARGV[2])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('ZREM', KEYS[3], ARGV[2]); redis.call('HDEL', KEYS[4], ARGV[2])
return true
`, [jobId]));
  }
  async get(jobId: string): Promise<TranscriptManifest | null> {
    const raw = await this.client.hGet(this.keys[0], jobId);
    if (!raw) return null;
    const job = JSON.parse(raw) as TranscriptManifest;
    // Redis cjson encodes empty Lua tables as objects.
    if (!Array.isArray(job.revisions)) job.revisions = [] as ArtifactManifest[];
    if (!Array.isArray(job.warnings)) job.warnings = [];
    for (const artifact of [job.original, job.latestCorrection, ...job.revisions]) {
      if (artifact && !Array.isArray(artifact.warnings)) artifact.warnings = [];
    }
    return job;
  }
}
