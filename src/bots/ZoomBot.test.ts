import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createLogger } from 'winston';
import config from '../config';
import { ZoomBot } from './ZoomBot';
import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';
import { UnsupportedMeetingError } from '../error';

// Logs every trusted/untrusted click with the pointer moves that led to it; sessionStorage survives navigation and is shared with the same-origin iframe.
const clickLog = `<script>
  let moves = 0;
  addEventListener('mousemove', () => moves++, true);
  addEventListener('click', e => {
    const log = JSON.parse(sessionStorage.clicks || '[]');
    log.push({ id: e.target.closest('[id]')?.id, trusted: e.isTrusted, detail: e.detail, moves });
    sessionStorage.clicks = JSON.stringify(log);
    moves = 0;
  }, true);
</script>`;

const pages: Record<string, string> = {
  '/j/123': `<!doctype html><body>${clickLog}
    <button id="cookies" style="position:fixed;left:40px;bottom:40px" onclick="this.remove()">Accept Cookies</button>
    <button id="browser" onclick="location.href = '/wc/123/join'" style="position:absolute;left:700px;top:300px">Join from browser</button></body>`,
  '/wc/123/join': `<!doctype html><body style="margin:0">${clickLog}<iframe id="webclient" src="/wc/frame" style="width:1200px;height:700px;border:0"></iframe></body>`,
  '/wc/frame': `<!doctype html><body>${clickLog}
    <div id="prompt" style="position:absolute;left:300px;top:400px"><p>Do you want people to see you in the meeting?</p>
      <button id="continue" onclick="document.querySelector('#prompt').remove()">Continue without microphone and camera</button></div>
    <input type="text" id="name" style="position:absolute;left:100px;top:100px;width:220px">
    <button id="join" style="position:absolute;left:800px;top:200px" onclick="
      if (document.querySelector('#prompt')) return;
      document.body.dataset.guestName = document.querySelector('#name').value;
      document.body.insertAdjacentHTML('beforeend', '<div id=wc-footer>2 participants</div>');">Join</button></body>`,
};

// Links without an embedded pwd: Zoom puts a passcode field above the name, after a hidden text input.
const passcodeFrame = `<!doctype html><body>${clickLog}
  <input type="text" class="hideme" hidden>
  <label style="position:absolute;left:100px;top:60px">Meeting Passcode <input type="text" id="input-for-pwd"></label>
  <label style="position:absolute;left:100px;top:160px">Your Name <input type="text" id="input-for-name"></label>
  <button id="join" style="position:absolute;left:800px;top:200px" onclick="
    if (document.querySelector('#input-for-pwd').value !== '910449') return;
    document.body.dataset.guestName = document.querySelector('#input-for-name').value;
    document.body.insertAdjacentHTML('beforeend', '<div id=wc-footer>2 participants</div>');">Join</button></body>`;

type Click = { id?: string; trusted: boolean; detail: number; moves: number };
type FixtureBot = { page: import('playwright').Page; joinMeeting(params: JoinParams & { pushState(status: BotStatus): void }): Promise<void>; recordMeetingPage(): Promise<void> };

async function zoomFixture(t: import('node:test').TestContext, frame: string) {

  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const address = portServer.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', `--remote-debugging-port=${address.port}`] });
  t.after(() => browser.close());
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`);
  t.after(() => connection.close());
  await connection.contexts()[0].route('https://zoom.us/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/wc/frame' ? frame : pages[path];
    return body ? route.fulfill({ contentType: 'text/html', body }) : route.fulfill({ status: 404, body: '' });
  });

  const previous = { cdp: config.chromeCdpUrl, wait: config.joinWaitTime };
  config.chromeCdpUrl = `http://127.0.0.1:${address.port}`;
  config.joinWaitTime = 0.2;
  t.after(() => { config.chromeCdpUrl = previous.cdp; config.joinWaitTime = previous.wait; });

  const bot = new ZoomBot(createLogger({ silent: true }), 'zoom-cursor-fixture') as unknown as FixtureBot;
  const result = { clicks: [] as Click[], guestName: undefined as string | undefined, states: [] as BotStatus[] };
  // Recording and uploads are outside this fixture; capture what the join left behind instead.
  bot.recordMeetingPage = async () => {
    result.clicks = JSON.parse(await bot.page.evaluate(() => sessionStorage.clicks || '[]'));
    result.guestName = await bot.page.frameLocator('iframe#webclient').locator('body').getAttribute('data-guest-name') ?? undefined;
  };
  const join = (passcode?: string) => bot.joinMeeting({
    url: 'https://zoom.us/j/123', name: 'Meeting assistant', passcode,
    bearerToken: 'fixture-token', teamId: 'fixture-team', userId: 'fixture-user', timezone: 'UTC',
    uploader: {} as JoinParams['uploader'], pushState: status => result.states.push(status),
  });
  return { bot, result, join };
}

test('zoom guests reach the web client with human cursor clicks and typing', { timeout: 60_000 }, async t => {
  const { bot, result, join } = await zoomFixture(t, pages['/wc/frame']);
  await join();

  assert.deepEqual(result.states, ['joined', 'finished']);
  assert.equal(result.guestName, 'Meeting assistant');
  const { clicks } = result;
  assert.deepEqual(clicks.map(click => click.id).filter(id => id !== 'join'), ['cookies', 'browser', 'continue', 'name']);
  assert.equal(clicks.filter(click => click.id === 'join').length, 1, 'join is clicked once');
  for (const click of clicks) {
    assert.equal(click.trusted, true, `${click.id} must receive a trusted click`);
    assert.equal(click.detail, 1, `${click.id} must be a real mouse click`);
  }
  for (const id of ['cookies', 'browser', 'join']) {
    assert.ok((clicks.find(click => click.id === id)?.moves ?? 0) > 5, `${id} must be reached along a cursor path`);
  }
  await bot.page.close();
});

test('zoom guests enter the passcode before their name when the link has none', { timeout: 60_000 }, async t => {
  const { bot, result, join } = await zoomFixture(t, passcodeFrame);
  await join('910449');

  assert.deepEqual(result.states, ['joined', 'finished']);
  assert.equal(result.guestName, 'Meeting assistant');
  assert.deepEqual(result.clicks.map(click => click.id), ['cookies', 'browser', 'input-for-pwd', 'input-for-name', 'join']);
  await bot.page.close();
});

test('zoom fails fast when a meeting asks for a passcode the job did not provide', { timeout: 60_000 }, async t => {
  const { bot, result, join } = await zoomFixture(t, passcodeFrame);
  await assert.rejects(join(), (error: Error) => error instanceof UnsupportedMeetingError && /requires a passcode/.test(error.message));
  assert.deepEqual(result.states, []);
  // The name must never be typed into the passcode field, which comes first in the form.
  assert.equal(await bot.page.frameLocator('iframe#webclient').locator('#input-for-pwd').inputValue(), '');
  await bot.page.close();
});
