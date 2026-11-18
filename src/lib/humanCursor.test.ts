import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { humanClick, humanMoveTo, humanType } from './humanCursor';

type Recorded = { moves: [number, number][]; clicks: { id: string; trusted: boolean; detail: number; x: number; y: number }[]; keydowns: number };

test('human cursor clicks along a path, types like a person, and refuses disabled targets', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(`
    <input id="name" value="stale" style="position:absolute;left:100px;top:100px;width:200px">
    <button id="go" style="position:absolute;left:900px;top:500px;width:160px;height:48px">Ask to join</button>
    <button id="off" disabled style="position:absolute;left:500px;top:300px">Disabled</button>
    <script>
      window.moves = [];
      window.clicks = [];
      window.keydowns = 0;
      document.addEventListener('mousemove', e => moves.push([e.clientX, e.clientY]));
      document.addEventListener('keydown', () => keydowns++);
      document.addEventListener('click', e => clicks.push({ id: e.target.id, trusted: e.isTrusted, detail: e.detail, x: e.clientX, y: e.clientY }));
    </script>`);

  await humanClick(page.locator('#go'));
  const { moves, clicks } = await page.evaluate(() => ({ moves: (window as unknown as Recorded).moves, clicks: (window as unknown as Recorded).clicks }));
  assert.equal(clicks.length, 1);
  const [click] = clicks;
  assert.deepEqual([click.id, click.trusted, click.detail], ['go', true, 1]);
  assert.ok(click.x > 900 && click.x < 1060 && click.y > 500 && click.y < 548, 'click lands inside the button');
  assert.ok(moves.length > 10, `expected a multi-step path, got ${moves.length} moves`);
  const [lastX, lastY] = moves[moves.length - 1];
  assert.deepEqual([lastX, lastY], [click.x, click.y], 'no jump between the path end and the click');

  await humanType(page.locator('#name'), 'Meeting assistant');
  assert.equal(await page.locator('#name').inputValue(), 'Meeting assistant');
  assert.ok(await page.evaluate(() => (window as unknown as Recorded).keydowns) >= 'Meeting assistant'.length);

  await assert.rejects(humanClick(page.locator('#off'), { timeout: 1000 }));
  assert.equal(await page.evaluate(() => (window as unknown as Recorded).clicks.filter(c => c.id === 'off').length), 0);
});

test('human cursor clicks wrapped inline links on the text, not the empty corners of their box', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  // Mirrors a Zoom device prompt squeezed into a narrow iframe: the link wraps and its dialog sits behind it.
  await page.setContent(`
    <iframe srcdoc="<div role=dialog style='padding:30px'><p>Do you want people to see you?</p><a id=link href=#>Continue without microphone and camera</a></div>
      <script>window.hits = 0; document.querySelector('a').onclick = e => { e.preventDefault(); hits++; };</script>"></iframe>`);
  const link = page.frameLocator('iframe').locator('#link');
  await link.waitFor();
  assert.ok(await link.evaluate(element => element.getClientRects().length) > 1, 'fixture link must wrap');
  // Leave between clicks; a cursor already inside the target would reuse its point and hide the bug.
  for (let attempt = 0; attempt < 10; attempt++) {
    await humanMoveTo(page, { x: 700, y: 500 });
    await humanClick(link, { timeout: 2000 });
  }
  assert.equal(await page.frames()[1].evaluate(() => (window as unknown as { hits: number }).hits), 10);
});
