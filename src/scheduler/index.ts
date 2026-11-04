import { S3Client } from '@aws-sdk/client-s3';
import { TranscriptQueue } from '../transcription/queue';
import { TranscriptStorage } from '../transcription/storage';
import 'dotenv/config';
import { createClient } from 'redis';
import { loadConfig } from './config';
import { TokenCrypto } from './crypto';
import { SchedulerStore } from './store';
import { GoogleCalendar } from './google';
import { RedisLedger } from './queue';
import { SchedulerRuntime } from './runtime';
import { createSchedulerApp } from './web';

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  if (args.some(argument => argument !== '--init')) throw new Error('Usage: scheduler [--init]');
  const config = loadConfig();
  const client = createClient({ url: config.redisUrl, disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: retries => Math.min(500 * (retries + 1), 5000) } })
    .withCommandOptions({ timeout: 5000 });
  client.on('error', () => console.error('Scheduler Redis connection unavailable'));
  await client.connect();
  try {
    const ledger = new RedisLedger(client, config);
    if (args.includes('--init')) {
      try { await ledger.initialize(); console.log('Scheduler Redis dataset initialized; existing execution state retained'); }
      finally { await client.quit(); }
      return;
    }
    const crypto = new TokenCrypto(config.secret);
    const store = new SchedulerStore(config.statePath);
    await store.load();
    const google = new GoogleCalendar(config, crypto, undefined, async (accountId, encrypted) => {
      await store.update(state => {
        const account = state.accounts.find(item => item.id === accountId);
        if (account) account.refreshToken = encrypted;
      });
    });
    const runtime = new SchedulerRuntime(config, store, ledger, google);
    const transcriptQueue = new TranscriptQueue(client, config.queueName, config.s3.bucket);
    const transcriptStorage = new TranscriptStorage(new S3Client({ region: config.s3.region, endpoint: config.s3.endpoint,
      forcePathStyle: config.s3.forcePathStyle, credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey } }), config.s3.bucket);
    const app = createSchedulerApp({ config, crypto, store, google, ledger, runtime, transcriptQueue, transcriptStorage });
    const server = app.listen(config.port, '0.0.0.0');
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const cutoff = setTimeout(() => server.closeAllConnections(), 10_000);
      cutoff.unref();
      await runtime.stop();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
      clearTimeout(cutoff);
      if (client.isOpen) await client.quit();
    };
    const handleShutdown = () => {
      void shutdown().catch(() => {
        if (client.isOpen) client.destroy();
        console.error('Scheduler shutdown failed');
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', handleShutdown);
    process.once('SIGTERM', handleShutdown);
    try {
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      await runtime.start();
      console.log(`Calendar scheduler ready on port ${config.port} with ${config.workers.length} configured workers`);
    } catch (error) { await shutdown(); throw error; }
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Scheduler startup failed');
    process.exitCode = 1;
  });
}
