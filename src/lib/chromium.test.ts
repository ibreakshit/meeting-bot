import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn, execFile, ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, Server } from 'node:http';
import { Browser, chromium } from 'playwright';
import { createLogger } from 'winston';
import config from '../config';
import createBrowserContext, { closeBotBrowser, isExternalBrowserContext } from './chromium';
import { FFmpegRecorder } from './ffmpegRecorder';

let directory: string;
let chrome: ChildProcess;
let externalBrowser: Browser;
let server: Server;
let origin: string;

function zoomPrejoinFixture(prompt: string): string {
  return `<!doctype html><html><body>
    <label>Your Name <input type="text"></label>
    <button onclick="document.body.dataset.joined='yes';document.body.innerHTML='<div id=wc-footer>2 Participants</div>'">Join</button>
    <script>
      let promptCount = 0;
      function showPrompt() {
        promptCount++;
        const modal = document.createElement('div'); modal.id = 'device-modal';
        const question = promptCount === 1 ? 'Do you want people to see you in the meeting?' : 'Do you want people to hear you in the meeting?';
        modal.innerHTML = '<div class="ReactModal__Overlay" style="position:fixed;inset:0;background:#8888;z-index:9999"><div role="dialog" style="background:white;padding:30px"><p>' + question + '</p><a href="#">Continue without microphone and camera</a></div></div>';
        let dismissing = false;
        modal.querySelector('a').onclick = event => {
          event.preventDefault();
          document.body.dataset.devicePromptClicks = String(Number(document.body.dataset.devicePromptClicks || 0) + 1);
          if (dismissing) return;
          dismissing = true;
          setTimeout(() => {
            document.body.dataset.devicePromptDismissed = 'yes'; modal.remove();
            if (${JSON.stringify(prompt)} === 'sequential' && promptCount === 1) showPrompt();
          }, 700);
        };
        document.body.append(modal);
      }
      if (['present', 'sequential'].includes(${JSON.stringify(prompt)})) showPrompt();
      if (${JSON.stringify(prompt)} === 'late') document.querySelector('input').addEventListener('input', () => setTimeout(showPrompt, 0), { once: true });
    </script>
  </body></html>`;
}

function teamsPrejoinFixture(mode: string): string {
  return `<!doctype html><html><body><script>
    function showPrejoin() {
      document.body.innerHTML = '<label>Your name<input data-tid="prejoin-display-name-input"></label><button id="prejoin-join-button" disabled>Join now</button>';
      const name = document.querySelector('input'); const join = document.querySelector('button');
      name.oninput = () => { join.disabled = !name.value.trim(); };
      join.onclick = () => { document.body.dataset.joinedName = name.value; document.body.innerHTML = '<button>Leave</button>'; };
    }
    if (${JSON.stringify(mode)} === 'direct') showPrejoin();
    else {
      document.body.innerHTML = '<button aria-label="Join meeting from this browser">Continue on this browser</button>';
      const launcher = document.querySelector('button'); launcher.onclick = showPrejoin;
      if (${JSON.stringify(mode)} === 'auto') {
        // Teams can navigate away from its launcher without the browser button being clicked.
        setTimeout(() => location.replace('/teams-prejoin?mode=direct'), 0);
      }
    }
  </script></body></html>`;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meeting-browser-test-'));
  server = createServer((request, response) => {
    if (request.method === 'PATCH') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"success":true}');
      return;
    }
    const url = new URL(request.url || '/', 'http://fixture.local');
    const prompt = url.searchParams.get('prompt') || 'absent';
    response.writeHead(200, { 'Content-Type': 'text/html' });
    if (url.pathname === '/teams-prejoin') {
      response.end(teamsPrejoinFixture(url.searchParams.get('mode') || 'direct')); return;
    }
    if (url.pathname === '/iframe/fixture') {
      response.end(`<a href="/zoom-client?prompt=${prompt}">Join from your browser</a>`); return;
    }
    if (url.pathname === '/zoom-client') {
      response.end(`<iframe id="webclient" src="/zoom-prejoin?prompt=${prompt}"></iframe>`); return;
    }
    if (url.pathname === '/zoom-prejoin' || url.pathname === '/wc/join/fixture' || url.pathname === '/j/fixture') {
      response.end(zoomPrejoinFixture(prompt)); return;
    }
    response.end('<!doctype html><html><body>Local browser fixture</body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  const debuggerSocket = createServer();
  await new Promise<void>(resolve => debuggerSocket.listen(0, '127.0.0.1', resolve));
  const debuggerAddress = debuggerSocket.address();
  assert.ok(debuggerAddress && typeof debuggerAddress !== 'string');
  const cdpUrl = `http://127.0.0.1:${debuggerAddress.port}`;
  await new Promise<void>(resolve => debuggerSocket.close(() => resolve()));
  const profile = join(directory, 'external');
  chrome = spawn(config.chromeExecutablePath, [
    '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${debuggerAddress.port}`, `--user-data-dir=${profile}`,
    '--auto-accept-this-tab-capture', '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ], { stdio: 'ignore' });
  let ready = false;
  const deadline = Date.now() + 20_000;
  while (!ready && Date.now() < deadline) {
    ready = await fetch(`${cdpUrl}/json/version`).then(response => response.ok).catch(() => false);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'Fixture Chrome did not start');
  externalBrowser = await chromium.connectOverCDP(cdpUrl);
  Object.assign(config, {
    chromeCdpUrl: cdpUrl,
    chromeUserDataDir: join(directory, 'profiles'),
    googleChromeCdpUrl: cdpUrl,
    googleChromeUserDataDir: undefined,
    googleChromeStorageStatePath: undefined,
    authBaseUrlV2: origin,
    miscStorageBucket: undefined,
  });
});

after(async () => {
  await externalBrowser?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise<void>(resolve => chrome.once('exit', () => resolve()));
    chrome.kill('SIGTERM');
    await exited;
  }
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const provider of ['google', 'zoom', 'microsoft'] as const) {
  test(`${provider} preserves browser identity between jobs without the automation launch flag`, { timeout: 30_000 }, async () => {
    const page = await createBrowserContext(origin, 'browser-regression', provider);
    try {
      assert.equal(isExternalBrowserContext(page.context()), provider !== 'microsoft');
      await page.goto(origin);
      await page.evaluate(value => { document.cookie = `${value}=remembered; Max-Age=3600; SameSite=Lax`; }, provider);
      assert.notEqual(await page.evaluate(() => navigator.webdriver), true);
      const session = await page.context().newCDPSession(page);
      await assert.rejects(session.send('Browser.getBrowserCommandLine'), /enable-automation/);
      await session.detach();
    } finally { await closeBotBrowser(page); }

    const next = await createBrowserContext(origin, 'browser-regression-next', provider);
    try {
      await next.goto(origin);
      assert.ok((await next.evaluate(() => document.cookie)).includes(`${provider}=remembered`));
      if (provider === 'microsoft') {
        const tracks = await next.evaluate(async () => {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
          const kinds = stream.getTracks().map(track => track.kind).sort();
          stream.getTracks().forEach(track => track.stop());
          return kinds;
        });
        assert.deepEqual(tracks, ['audio', 'video']);
        // Exercise the actual local display/audio recorder with the persistent browser open.
        const path = join(directory, 'teams-capture.webm');
        const recorder = new FFmpegRecorder(path, createLogger({ silent: true }));
        try {
          await recorder.start();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } finally { await recorder.stop(); }
        const probe = await promisify(execFile)('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', path]);
        const streams = JSON.parse(probe.stdout).streams as Array<{ codec_type: string }>;
        assert.deepEqual(streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
      } else {
        const capture = await next.evaluate(async () => {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, preferCurrentTab: true } as DisplayMediaStreamOptions);
          const kinds = stream.getTracks().map(track => track.kind).sort();
          const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
          let bytes = 0;
          recorder.ondataavailable = event => { bytes += event.data.size; };
          const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
          recorder.start(100);
          await new Promise(resolve => setTimeout(resolve, 400));
          recorder.stop();
          await stopped;
          stream.getTracks().forEach(track => track.stop());
          return { kinds, bytes };
        });
        assert.deepEqual(capture.kinds, ['audio', 'video']);
        assert.ok(capture.bytes > 0, 'Tab capture must produce WebM data');
      }
    } finally { await closeBotBrowser(next); }
  });
}

test('Zoom failure closes its meeting tab while keeping persistent Chrome available', { timeout: 30_000 }, async () => {
  const { ZoomBot } = await import('../bots/ZoomBot');
  const page = await createBrowserContext(origin, 'zoom-cleanup-regression', 'zoom');
  const sentinel = await externalBrowser.contexts()[0].newPage();
  try {
    const bot = new ZoomBot(createLogger({ silent: true }), 'zoom-cleanup-regression');
    // Replace admission with a local failure so the real outer cleanup runs without joining a meeting.
    Object.assign(bot, { page, joinMeeting: async () => { throw new Error('fixture admission failed'); } });
    await assert.rejects(bot.join({ url: origin, name: 'Fixture', bearerToken: 'fixture', uploader: {} } as Parameters<typeof bot.join>[0]), /fixture admission failed/);
    assert.equal(page.isClosed(), true, 'A failed meeting must not leave an open tab');
    assert.equal(sentinel.isClosed(), false, 'Cleanup must preserve unrelated persistent tabs');
    assert.equal(externalBrowser.isConnected(), true);
  } finally {
    await closeBotBrowser(page);
    await sentinel.close();
  }
});

for (const [layout, prompt] of [['iframe', 'present'], ['iframe', 'late'], ['iframe', 'sequential'], ['j', 'sequential'], ['j', 'absent']]) {
  test(`Zoom dismisses device prompt and reaches recording: ${layout}, ${prompt}`, { timeout: 60_000 }, async () => {
    const { ZoomBot } = await import('../bots/ZoomBot');
    const bot = new ZoomBot(createLogger({ silent: true }), 'zoom-device-prompt');
    let reachedRecording = false;
    // Keep the actual join flow and browser; replace recording after local fixture admission.
    Object.assign(bot, { recordMeetingPage: async () => {
      const page = (bot as unknown as { page: import('playwright').Page }).page;
      const frame = layout === 'iframe' ? page.frames().find(candidate => candidate !== page.mainFrame()) : page;
      assert.ok(frame);
      const state = await frame.evaluate(() => ({ joined: document.body.dataset.joined, dismissed: document.body.dataset.devicePromptDismissed, clicks: document.body.dataset.devicePromptClicks }));
      assert.equal(state.joined, 'yes');
      if (prompt !== 'absent') assert.equal(state.dismissed, 'yes');
      if (prompt !== 'absent') assert.equal(state.clicks, prompt === 'sequential' ? '2' : '1', 'Each device prompt must be clicked only once while it closes');
      reachedRecording = true;
    } });
    await bot.join({
      url: `${origin}/${layout}/fixture?prompt=${prompt}`, name: 'Fixture Assistant', bearerToken: 'fixture',
      uploader: { uploadRecordingToRemoteStorage: async () => true },
    } as Parameters<typeof bot.join>[0]);
    assert.equal(reachedRecording, true);
  });
}

for (const mode of ['direct', 'auto', 'click']) {
  test(`Teams enters prejoin, fills its name and reaches recording: ${mode}`, { timeout: 15_000 }, async () => {
    const { MicrosoftTeamsBot } = await import('../bots/MicrosoftTeamsBot');
    const bot = new MicrosoftTeamsBot(createLogger({ silent: true }), 'teams-launcher-transition');
    let reachedRecording = false;
    // Preserve the real browser/admission flow and stop at the recording boundary of this local meeting.
    Object.assign(bot, { recordMeetingPageWithFFmpeg: async () => {
      const page = (bot as unknown as { page: import('playwright').Page }).page;
      assert.equal(await page.evaluate(() => document.body.dataset.joinedName), 'Fixture Assistant');
      reachedRecording = true;
    } });
    const joining = bot.join({
      url: `${origin}/teams-prejoin?mode=${mode}`, name: 'Fixture Assistant', bearerToken: 'fixture',
      uploader: { uploadRecordingToRemoteStorage: async () => true },
    } as Parameters<typeof bot.join>[0]);
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([joining, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Teams did not advance past its launcher within six seconds')), 6000);
      })]);
      assert.equal(reachedRecording, true);
    } finally {
      clearTimeout(timeout);
      await closeBotBrowser((bot as unknown as { page?: import('playwright').Page }).page);
      await joining.catch(() => undefined);
    }
  });
}
