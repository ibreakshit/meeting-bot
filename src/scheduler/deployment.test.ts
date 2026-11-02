import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

type Service = {
  command: string[];
  environment: Record<string, string>;
  restart?: string;
  healthcheck?: { test: string[] };
  ports?: Array<{ target: number; host_ip?: string }>;
  depends_on?: Record<string, { condition: string }>;
  volumes?: Array<{ type: string; source?: string; target: string }>;
};

test('expanded deployment preserves durable queue and isolates each recording worker', () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), 'meeting-bot-compose-'));
  try {
    const environmentPath = join(fixtureDirectory, 'fixture.env');
    writeFileSync(environmentPath, 'REDIS_PORT_HOST=16379\n');
    // --no-env-resolution prevents even reading service .env, including credentials on the owner host.
    const rendered = execFileSync('docker', ['compose', '--env-file', environmentPath, '-f', resolve('docker-compose.yml'),
      'config', '--no-env-resolution', '--format', 'json'], {
      encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const config = JSON.parse(rendered) as { services: Record<string, Service>; volumes: Record<string, unknown> };
    assert.deepEqual(Object.keys(config.services).sort(), ['calendar-scheduler', 'chrome-cdp-1', 'chrome-cdp-2', 'meeting-bot-1', 'meeting-bot-2', 'redis']);
    const redis = config.services.redis;
    assert.equal(redis.restart, 'unless-stopped');
    for (const [flag, value] of [['appendonly', 'yes'], ['appendfsync', 'always'], ['no-appendfsync-on-rewrite', 'no'],
      ['aof-load-truncated', 'no'], ['maxmemory-policy', 'noeviction']]) {
      assert.equal(redis.command[redis.command.indexOf(`--${flag}`) + 1], value, flag);
    }
    assert.equal(redis.volumes?.find(volume => volume.target === '/data')?.source, 'cache');
    assert.ok(config.volumes.cache);
    const scheduler = config.services['calendar-scheduler'];
    assert.deepEqual(scheduler.command, ['npx', 'ts-node', 'src/scheduler/index.ts']);
    assert.deepEqual(scheduler.ports?.map(port => [port.host_ip, port.target]), [['127.0.0.1', 3001]]);
    assert.ok(scheduler.healthcheck?.test.some(part => part.includes('/health')));
    assert.equal(scheduler.volumes?.find(volume => volume.target === '/data')?.source, 'scheduler-state');
    const privateSources = new Set<string>();
    for (const id of [1, 2]) {
      const worker = config.services[`meeting-bot-${id}`];
      const chrome = config.services[`chrome-cdp-${id}`];
      assert.equal(worker.restart, 'unless-stopped');
      assert.equal(chrome.restart, 'unless-stopped');
      assert.equal(worker.ports, undefined);
      assert.ok(!worker.volumes?.some(volume => volume.target === '/usr/src/app' || volume.target === '/usr/src/app/dist' || volume.target === '/usr/src/app/node_modules'), 'Workers must use image-built code and dependencies on a fresh checkout');
      assert.equal(chrome.ports, undefined);
      assert.equal(worker.environment.CHROME_CDP_URL, `http://chrome-cdp-${id}:9223`);
      assert.equal(worker.environment.CHROME_USER_DATA_DIR, '/usr/src/app/.chrome');
      assert.equal(worker.environment.REDIS_PROCESSING_QUEUE_NAME, `jobs:meetbot:processing:${id}`);
      assert.equal(worker.environment.REDIS_CONSUMER_ENABLED, 'true');
      assert.equal(worker.environment.AUTH_BASE_URL_V2, 'http://calendar-scheduler:3001/v2');
      assert.equal(worker.environment.NOTIFY_WEBHOOK_ENABLED, 'true');
      assert.equal(worker.environment.NOTIFY_WEBHOOK_URL, 'http://calendar-scheduler:3001/hooks/recording-completed');
      for (const service of [scheduler, worker]) {
        assert.equal(service.environment.REDIS_HOST, 'redis');
        assert.equal(service.environment.REDIS_PORT, '6379');
        assert.equal(service.environment.NOTIFY_REDIS_ENABLED, 'true');
        assert.equal(service.environment.NOTIFY_REDIS_URI, '');
        assert.equal(service.environment.NOTIFY_REDIS_DB, '0');
        assert.equal(service.environment.REDIS_QUEUE_NAME, 'jobs:meetbot:list');
        assert.equal(service.environment.NOTIFY_REDIS_LIST, 'jobs:meetbot:recordings');
        assert.equal(service.environment.NOTIFY_REDIS_FAILURE_LIST, 'jobs:meetbot:failures');
      }
      for (const dependency of ['redis', 'calendar-scheduler', `chrome-cdp-${id}`]) {
        assert.equal(worker.depends_on?.[dependency]?.condition, 'service_healthy');
      }
      for (const target of ['/usr/src/app/.chrome', '/usr/src/app/dist/_tempvideo', '/usr/src/app/debug-videos', '/usr/src/app/assets/screenshots']) {
        const mount = worker.volumes?.find(volume => volume.target === target);
        assert.equal(mount?.type, 'volume', target);
        assert.ok(mount?.source);
        assert.ok(!privateSources.has(mount.source), `${target} must be private`);
        privateSources.add(mount.source);
      }
      const chromeProfile = chrome.volumes?.find(volume => volume.target === '/tmp/chrome-profile');
      assert.ok(chromeProfile?.source);
      assert.ok(!privateSources.has(chromeProfile.source));
      privateSources.add(chromeProfile.source);
      for (const service of [worker, chrome]) {
        assert.ok(!service.volumes?.some(volume => /\.X11-unix|\/run\/user|pulse/.test(volume.target)));
      }
    }
  } finally { rmSync(fixtureDirectory, { recursive: true, force: true }); }
});
