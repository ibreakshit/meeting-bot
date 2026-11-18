import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';

const image = process.env.CHROME_SIDECAR_TEST_IMAGE || 'meeting-bot-chrome:local';

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function logs(container: string): string {
  const result = spawnSync('docker', ['logs', container], { encoding: 'utf8', timeout: 5000 });
  return result.stdout + result.stderr;
}

async function waitForChrome(container: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', container));
    if (!state.Running) assert.fail(`Chrome sidecar exited: ${logs(container)}`);
    try {
      const version = JSON.parse(docker('exec', container, 'curl', '-fsS', '--max-time', '1', 'http://127.0.0.1:9223/json/version'));
      assert.match(version.Browser, /^Chrome\//);
      assert.match(version.webSocketDebuggerUrl, /^ws:/);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  assert.fail(`Chrome did not become ready: ${logs(container)}`);
}

test('Chrome sidecar recovers after graceful restarts and abrupt host shutdowns', { timeout: 90_000 }, async t => {
  const container = `meeting-bot-chrome-restart-test-${randomUUID()}`;
  const volume = `${container}-profile`;
  docker('volume', 'create', volume);
  t.after(() => { docker('rm', '--force', container); docker('volume', 'rm', volume); });
  function startContainer(): void {
    docker('run', '--detach', '--name', container, '--shm-size', '1g',
      '--mount', `type=volume,source=${volume},target=/tmp/chrome-profile`,
      '--mount', `type=bind,source=${resolve('scripts/start-chrome-cdp.sh')},target=/usr/local/bin/start-chrome-cdp,readonly`, image);
  }
  startContainer();
  await waitForChrome(container);

  // Preserve a profile value so recovery cannot pass by discarding browser state.
  docker('exec', container, 'bash', '-c', 'echo preserved > /tmp/chrome-profile/restart-test');
  docker('stop', '--time', '10', container);
  docker('start', container);
  await waitForChrome(container);

  // SIGKILL leaves the writable container filesystem intact, as an abrupt reboot does.
  for (let restart = 0; restart < 3; restart++) {
    // A previous X server's PID can now belong to PID 1 in the restarted container.
    docker('exec', container, 'bash', '-c', 'echo 1 > /tmp/.X99-lock');
    docker('kill', '--signal', 'KILL', container);
    docker('start', container);
    await waitForChrome(container);
  }
  assert.equal(docker('exec', container, 'cat', '/tmp/chrome-profile/restart-test'), 'preserved');

  // A failed display must terminate the sidecar so Docker's restart policy can recover it.
  docker('exec', container, 'pkill', '-x', 'Xvfb');
  docker('wait', container);
  docker('start', container);
  await waitForChrome(container);

  // Recreating a container changes its hostname but must preserve its private profile.
  docker('kill', '--signal', 'KILL', container);
  docker('rm', container);
  startContainer();
  await waitForChrome(container);
  assert.equal(docker('exec', container, 'cat', '/tmp/chrome-profile/restart-test'), 'preserved');
  assert.doesNotMatch(logs(container), /wait: .*no such job/);
});
