import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { S3Client } from '@aws-sdk/client-s3';
import { TranscriptQueue } from './queue';
import { TranscriptStorage } from './storage';
import { processTranscriptJob } from './worker';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const url = required('TRANSCRIPTION_REDIS_URL');
  const bucket = required('S3_BUCKET_NAME');
  const client = createClient({ url, disableOfflineQueue: true, socket: { reconnectStrategy: false, connectTimeout: 5000 } }).withCommandOptions({ timeout: 5000 });
  client.on('error', () => console.error('Transcription Redis unavailable'));
  await client.connect();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const queue = new TranscriptQueue(client, process.env.REDIS_QUEUE_NAME || 'jobs:meetbot:list', bucket);
  try {
    if (args.length) {
      if (args[0] === 'status' && args[1] === '--job-id' && /^[a-f0-9]{64}$/.test(args[2] || '') && args.length === 3) {
        const manifest = await queue.get(args[2]);
        console.log(JSON.stringify(manifest ? { jobId: manifest.jobId, originalState: manifest.originalState, correctionState: manifest.correctionState, attempt: manifest.attempt, warnings: manifest.warnings, error: manifest.error } : null)); return;
      }
      if (args.join(' ').match(/^retry --job-id [a-f0-9]{64} --stage correction$/)) {
        if (!await queue.retryCorrection(args[2])) throw new Error('Correction retry unavailable: missing original, source conflict or active worker');
        console.log('Correction retry queued'); return;
      }
      throw new Error('Usage: transcription [status --job-id ID | retry --job-id ID --stage correction]');
    }
    const s3 = new S3Client({ region: required('S3_REGION'), endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_USE_MINIO_COMPATIBILITY === 'true', credentials: { accessKeyId: required('S3_ACCESS_KEY_ID'), secretAccessKey: required('S3_SECRET_ACCESS_KEY') } });
    const storage = new TranscriptStorage(s3, bucket);
    const ownerId = randomUUID();
    while (!abort.signal.aborted) {
      const claim = await queue.claim(ownerId);
      if (claim) await processTranscriptJob(claim, { queue, storage, signal: abort.signal });
      else await delay(1000, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (client.isOpen) await client.quit();
  }
}
if (require.main === module) void main().catch(() => { console.error('Transcription worker failed; check private host diagnostics.'); process.exitCode = 1; });
