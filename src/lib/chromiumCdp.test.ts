import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium as plainChromium } from 'playwright';
import { chromium } from 'playwright-extra';
import { PuppeteerExtraPlugin } from 'puppeteer-extra-plugin';
import type { Page as PuppeteerPage } from 'puppeteer';
import config from '../config';
import createBrowserContext, { closeBotBrowser } from './chromium';

test('Zoom CDP pages run page plugins before navigation and preserve profile cookies', { timeout: 30_000 }, async t => {
  const server = createServer((_req, res) => res.end('<!doctype html><title>Join fixture</title>'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const portServer = createServer();
  await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const portAddress = portServer.address(); assert.ok(portAddress && typeof portAddress !== 'string');
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const browser = await plainChromium.launch({ headless: true, args: ['--no-sandbox', `--remote-debugging-port=${portAddress.port}`] });
  t.after(() => browser.close());
  const cdpUrl = `http://127.0.0.1:${portAddress.port}`;
  const connection = await plainChromium.connectOverCDP(cdpUrl);
  const profile = connection.contexts()[0];
  await profile.addCookies([{ name: 'profile-session', value: 'preserved', url: origin }]);
  await connection.close();

  class PageLifecyclePlugin extends PuppeteerExtraPlugin {
    get name() { return 'cdp-page-lifecycle-test'; }
    async onPageCreated(page: PuppeteerPage) {
      await page.evaluateOnNewDocument(() => Object.defineProperty(window, 'pagePluginReady', { value: true }));
    }
  }
  chromium.use(new PageLifecyclePlugin());
  const previousUrl = config.chromeCdpUrl;
  config.chromeCdpUrl = cdpUrl;
  t.after(() => { config.chromeCdpUrl = previousUrl; });
  const page = await createBrowserContext(origin, 'cdp-regression', 'zoom');
  await page.goto(origin);
  assert.equal(await page.evaluate(() => (window as unknown as { pagePluginReady?: boolean }).pagePluginReady), true);
  assert.match(await page.evaluate(() => document.cookie), /profile-session=preserved/);
  await page.evaluate(() => { document.cookie = 'joined-session=renewed; Max-Age=3600'; });
  await closeBotBrowser(page);

  // Completing one job must preserve Chrome and cookies set during the meeting.
  const remaining = await plainChromium.connectOverCDP(cdpUrl);
  assert.equal(remaining.contexts().length, 1);
  assert.ok((await remaining.contexts()[0].cookies(origin)).some(cookie => cookie.name === 'joined-session' && cookie.value === 'renewed'));
  await remaining.close();
});
