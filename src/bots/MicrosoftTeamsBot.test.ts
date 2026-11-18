import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createLogger } from 'winston';
import config from '../config';
import * as chromiumLib from '../lib/chromium';
import { MicrosoftTeamsBot } from './MicrosoftTeamsBot';
import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';

const fixture = `<!doctype html><body>
  <button id="launcher" aria-label="Join meeting from this browser" style="position:absolute;left:600px;top:300px"
    onclick="this.remove(); document.querySelector('#prejoin').hidden = false">Continue on this browser</button>
  <div id="prejoin" hidden>
    <input id="name" data-tid="prejoin-display-name-input" style="position:absolute;left:100px;top:120px;width:240px">
    <input id="camera" type="checkbox" role="switch" data-tid="toggle-video" checked aria-label="Turn camera off" style="position:absolute;left:150px;top:500px">
    <input id="mic" type="checkbox" role="switch" data-tid="toggle-mute" aria-label="Mute microphone" style="position:absolute;left:250px;top:500px">
    <button id="join" style="position:absolute;left:900px;top:450px" onclick="
      document.body.dataset.guestName = document.querySelector('#name').value;
      document.body.dataset.camera = document.querySelector('#camera').checked;
      document.body.dataset.mic = document.querySelector('#mic').checked;
      document.querySelector('#prejoin').remove();
      document.body.insertAdjacentHTML('beforeend', '<button id=leave>Leave</button><button id=close aria-label=Close style=position:absolute;left:1000px;top:80px onclick=this.remove()>x</button>');">Join now</button>
  </div>
  <script>
    window.clicks = [];
    let moves = 0;
    addEventListener('mousemove', () => moves++, true);
    addEventListener('click', e => { clicks.push({ id: e.target.id, trusted: e.isTrusted, detail: e.detail, moves }); moves = 0; }, true);
  </script></body>`;

test('teams guests open prejoin, set devices, name themselves and join with human cursor clicks', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  // Teams launches a local Chrome for X11 capture; swap in a headless page with the fixture routed.
  const createBrowserContext = chromiumLib.default;
  Object.assign(chromiumLib, { default: async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('https://teams.microsoft.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    return page;
  } });
  t.after(() => Object.assign(chromiumLib, { default: createBrowserContext }));

  const previous = { wait: config.joinWaitTime, stabilize: config.teamsAudioStabilizationMs, prewarm: config.teamsPrewarmEnabled };
  Object.assign(config, { joinWaitTime: 0.2, teamsAudioStabilizationMs: 0, teamsPrewarmEnabled: false });
  t.after(() => Object.assign(config, previous));

  const bot = new MicrosoftTeamsBot(createLogger({ silent: true }), 'teams-cursor-fixture') as unknown as {
    page: import('playwright').Page;
    joinMeeting(params: JoinParams & { pushState(status: BotStatus): void }): Promise<void>;
    recordMeetingPageWithFFmpeg(): Promise<void>;
  };
  type Click = { id: string; trusted: boolean; detail: number; moves: number };
  let clicks: Click[] = [];
  let dataset: Record<string, string | undefined> = {};
  // ffmpeg recording and uploads are outside this fixture; capture what the join left behind instead.
  bot.recordMeetingPageWithFFmpeg = async () => {
    clicks = await bot.page.evaluate(() => (window as unknown as { clicks: Click[] }).clicks);
    dataset = await bot.page.evaluate(() => ({ ...document.body.dataset }));
  };
  const states: BotStatus[] = [];
  await bot.joinMeeting({
    url: 'https://teams.microsoft.com/meet/123', name: 'Meeting assistant',
    bearerToken: 'fixture-token', teamId: 'fixture-team', userId: 'fixture-user', timezone: 'UTC',
    uploader: {} as JoinParams['uploader'], pushState: status => states.push(status),
  });

  assert.deepEqual(states, ['joined', 'finished']);
  assert.deepEqual([dataset.guestName, dataset.camera, dataset.mic], ['Meeting assistant', 'false', 'true']);
  assert.deepEqual(clicks.map(click => click.id), ['launcher', 'name', 'camera', 'mic', 'join', 'close']);
  for (const click of clicks) {
    assert.equal(click.trusted, true, `${click.id} must receive a trusted click`);
    assert.equal(click.detail, 1, `${click.id} must be a real mouse click`);
    assert.ok(click.moves > 5, `${click.id} must be reached along a cursor path`);
  }
});
