import type { SchedulerConfig, WorkerRegistration } from './types';

const split = (value = '') => value.split(',').map(item => item.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing required configuration: ${name}`);
    return value;
  };
  const integer = (name: string, fallback: number, minimum = 1): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const secretValue = required('SCHEDULER_SECRET');
  const secret = Buffer.from(secretValue, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== secretValue) {
    throw new Error('SCHEDULER_SECRET must be 32 random bytes encoded as base64');
  }
  const allowedEmails = split(required('DASHBOARD_ALLOWED_EMAILS')).map(email => email.toLowerCase());
  if (!allowedEmails.length || allowedEmails.some(email => !email.includes('@'))) throw new Error('Invalid dashboard allowed emails');
  const baseUrls = split(required('DASHBOARD_BASE_URLS')).map(value => {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Dashboard origins require HTTPS (except localhost) and no path or credentials');
    }
    return url.origin;
  });
  if (!baseUrls.length) throw new Error('At least one dashboard origin is required');
  const basePath = env.SCHEDULER_BASE_PATH === '/' ? '' : env.SCHEDULER_BASE_PATH || '';
  if (basePath && (!/^\/[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)*$/.test(basePath) ||
    basePath.split('/').some(segment => segment === '.' || segment === '..'))) {
    throw new Error('SCHEDULER_BASE_PATH must be an absolute URL path without trailing slash, empty or dot segments, or encoded characters');
  }
  const queueName = env.REDIS_QUEUE_NAME || 'jobs:meetbot:list';
  const resultList = env.NOTIFY_REDIS_LIST || 'jobs:meetbot:recordings';
  const failureList = env.NOTIFY_REDIS_FAILURE_LIST || 'jobs:meetbot:failures';
  const defaults: WorkerRegistration[] = [1, 2].map(id => ({
    id: String(id), baseUrl: `http://meeting-bot-${id}:3000`, processingQueue: `jobs:meetbot:processing:${id}`,
  }));
  const workers: WorkerRegistration[] = env.SCHEDULER_WORKERS ? JSON.parse(env.SCHEDULER_WORKERS) : defaults;
  if (!Array.isArray(workers) || !workers.length) throw new Error('SCHEDULER_WORKERS must be a non-empty array');
  for (const worker of workers) {
    if (!worker || typeof worker.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(worker.id) ||
      typeof worker.baseUrl !== 'string' || typeof worker.processingQueue !== 'string' || !worker.processingQueue) {
      throw new Error('Invalid worker registration');
    }
    const url = new URL(worker.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Worker baseUrl must be an HTTP origin without credentials');
    }
    worker.baseUrl = url.origin;
  }
  for (const field of ['id', 'baseUrl', 'processingQueue'] as const) {
    if (new Set(workers.map(worker => worker[field])).size !== workers.length) throw new Error(`Worker ${field} values must be unique`);
  }
  const lists = [queueName, resultList, failureList, ...workers.map(worker => worker.processingQueue)];
  if (new Set(lists).size !== lists.length) throw new Error('Pending, result and processing list names must be unique');
  const redis = new URL(`redis://${env.REDIS_HOST || 'redis'}:${integer('REDIS_PORT', 6379)}`);
  if (env.REDIS_USERNAME) redis.username = env.REDIS_USERNAME;
  if (env.REDIS_PASSWORD) redis.password = env.REDIS_PASSWORD;
  if (env.NOTIFY_REDIS_URI) {
    const notification = new URL(env.NOTIFY_REDIS_URI);
    if (notification.protocol !== redis.protocol || notification.host !== redis.host || notification.username !== redis.username ||
      notification.password !== redis.password || !['', '/', '/0'].includes(notification.pathname)) {
      throw new Error('Notifications must use the same Redis instance and database as the queue');
    }
  }
  if (env.NOTIFY_REDIS_DB !== undefined && env.NOTIFY_REDIS_DB !== '' && Number(env.NOTIFY_REDIS_DB) !== 0) {
    throw new Error('NOTIFY_REDIS_DB must be 0 to match the shared queue');
  }
  const endpoint = env.S3_ENDPOINT || undefined;
  if (endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid S3 endpoint');
  }
  return {
    transcriptionEnabled: env.TRANSCRIPTION_ENABLED === 'true',
    port: integer('SCHEDULER_PORT', 3001), googleClientId: required('GOOGLE_OAUTH_CLIENT_ID'),
    googleClientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET'), secret, allowedEmails, baseUrls, basePath,
    ownerAliases: split(env.SCHEDULER_OWNER_EMAIL_ALIASES).map(email => email.toLowerCase()),
    botName: required('SCHEDULER_BOT_NAME'), teamId: required('SCHEDULER_TEAM_ID'), userId: required('SCHEDULER_USER_ID'),
    bearerToken: required('SCHEDULER_BEARER_TOKEN'), webhookSecret: required('NOTIFY_WEBHOOK_SECRET'),
    joinLeadSeconds: integer('SCHEDULER_JOIN_LEAD_SECONDS', 60, 0),
    maxSnapshotAgeSeconds: integer('SCHEDULER_MAX_SNAPSHOT_AGE_SECONDS', 300),
    statePath: env.SCHEDULER_STATE_PATH || '/data/scheduler-state.json', redisUrl: redis.toString(),
    queueName, resultList, failureList, workers,
    s3: { bucket: required('S3_BUCKET_NAME'), region: required('S3_REGION'), endpoint,
      accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: env.S3_USE_MINIO_COMPATIBILITY === 'true' },
  };
}
