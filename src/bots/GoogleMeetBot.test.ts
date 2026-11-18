import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { createLogger } from 'winston';
import config from '../config';
import { GoogleMeetBot } from './GoogleMeetBot';
import { JoinParams } from './AbstractMeetBot';
import { BotStatus } from '../types';

for (const scenario of [
  { name: 'signed-in guests join without a name field', anonymous: false, devicePrompt: false, admissionPrompt: false },
  { name: 'anonymous guests fill their name despite a hidden search field', anonymous: true, devicePrompt: false, admissionPrompt: false },
  { name: 'anonymous guests can submit with the pre-join sign-in tip visible', anonymous: true, devicePrompt: false, admissionPrompt: false, signInTip: true },
  { name: 'signed-in guests dismiss the microphone permission prompt', anonymous: false, devicePrompt: true, admissionPrompt: false },
  { name: 'admitted guests complete the Gemini join confirmation before recording', anonymous: false, devicePrompt: false, admissionPrompt: true },
  { name: 'anonymous guests click the German join button', anonymous: true, devicePrompt: false, admissionPrompt: false, joinText: 'Teilnahme erbitten' },
]) test(scenario.name, { timeout: 20_000 }, async t => {
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const address = portServer.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', `--remote-debugging-port=${address.port}`] });
  t.after(() => browser.close());
  const connection = await chromium.connectOverCDP(`http://127.0.0.1:${address.port}`);
  const context = connection.contexts()[0];
  await context.route('https://meet.google.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><body>
      <div>signed-in-guest@example.com</div><h1>Ready to join?</h1>
      <input type="text" hidden aria-label="Search">
      ${scenario.anonymous ? '<label>Your name <input type="text" id="guest-name"></label>' : ''}
      ${scenario.devicePrompt ? '<div id="device-prompt" role="dialog"><button onclick="this.parentElement.remove()">Continue without microphone</button></div>' : ''}
      <button hidden>Ask to join</button>
      <button id="other" onclick="document.body.dataset.unexpectedActivation = 'true'">Other ways to join</button>
      <button id="join">${scenario.joinText ?? 'Ask to join anyway'}</button>
      ${scenario.signInTip ? '<aside id="tip"><p>Sign in with your Google account</p><button onclick="this.parentElement.remove()">Got it</button></aside>' : ''}
      <script>
      let mouseMoves = 0;
      document.addEventListener('mousemove', () => mouseMoves++, true);
      document.addEventListener('click', event => {
        if (['join', 'confirm'].includes(event.target.id)) {
          document.body.dataset[event.target.id + 'Activation'] = JSON.stringify({
            trusted: event.isTrusted, detail: event.detail, mouseMoves,
          });
        }
      }, true);
      const enterCall = () => {
        document.body.dataset.admitted = 'true';
        document.body.innerHTML = '<button aria-label="People - 2 joined">People</button><button aria-label="Leave call">Leave call</button>';
      };
      document.querySelector('#join').onclick = () => {
        if (document.querySelector('#device-prompt, #tip')) return;
        document.body.dataset.guestName = document.querySelector('#guest-name')?.value || '';
        if (${scenario.admissionPrompt}) {
          document.body.innerHTML = '<p>Please wait until a meeting host brings you into the call</p><button aria-label="Leave call">Leave call</button><div role="dialog">Gemini is taking notes<button id="confirm">Join now</button></div>';
          document.querySelector('#confirm').onclick = enterCall;
        } else enterCall();
      };</script>
    </body>`,
  }));
  const previousUrl = config.chromeCdpUrl;
  const previousJoinWait = config.joinWaitTime;
  config.chromeCdpUrl = `http://127.0.0.1:${address.port}`;
  config.joinWaitTime = 0.1;
  t.after(() => { config.chromeCdpUrl = previousUrl; config.joinWaitTime = previousJoinWait; });
  const bot = new GoogleMeetBot(createLogger({ silent: true }), 'signed-in-join-regression') as unknown as {
    joinMeeting(params: JoinParams & { pushState(status: BotStatus): void }): Promise<void>;
    recordMeetingPage(): Promise<void>;
    dismissPostJoinPrompts(): Promise<void>;
  };
  // Exercise the actual join flow; recording and cloud uploads are outside this fixture.
  bot.recordMeetingPage = async () => {
    const page = context.pages().find(candidate => candidate.url().endsWith('/join-fixture'));
    assert.ok(page);
    assert.equal(await page.locator('body').getAttribute('data-admitted'), 'true');
    assert.equal(await page.locator('body').getAttribute('data-unexpected-activation'), null);
    for (const button of scenario.admissionPrompt ? ['join', 'confirm'] : ['join']) {
      const activation = JSON.parse(await page.locator('body').getAttribute(`data-${button}-activation`) ?? '{}');
      assert.equal(activation.trusted, true, `${button} must receive a trusted activation`);
      assert.equal(activation.detail, 1, `${button} must be activated with a mouse click`);
      assert.ok(activation.mouseMoves > 5, `${button} must be reached along a cursor path`);
    }
  };
  bot.dismissPostJoinPrompts = () => Promise.resolve();
  const states: BotStatus[] = [];
  await bot.joinMeeting({
    url: 'https://meet.google.com/join-fixture', name: 'Meeting assistant',
    bearerToken: 'fixture-token', teamId: 'fixture-team', userId: 'fixture-user', timezone: 'UTC',
    uploader: {} as JoinParams['uploader'], pushState: status => states.push(status),
  });
  assert.deepEqual(states, ['joined', 'finished']);
  const page = context.pages().find(candidate => candidate.url().endsWith('/join-fixture'));
  assert.ok(page);
  assert.equal(await page.locator('body').getAttribute('data-guest-name'), scenario.anonymous ? 'Meeting assistant' : '');
  await page.close();
  await connection.close();
});
