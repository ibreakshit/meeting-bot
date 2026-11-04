import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { renderHistory } from './views';

test('drawer shows exact originals on focus, switches versions, restores focus and fits mobile', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture.test/**', route => {
      if (new URL(route.request().url()).pathname === '/history') return route.fulfill({ contentType: 'text/html', body: renderHistory([{ botId: 'b', payload: { eventId: 'Fixture meeting' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now()+60000, state: 'completed', recording: { botId: 'b', recordingId: 'r', timestamp: new Date().toISOString(), storage: { provider: 's3', bucket: 'private', key: 'fixture.mp4' } } } as never]) });
      if (new URL(route.request().url()).pathname.endsWith('/video')) return route.fulfill({ status: 404 });
      const original = new URL(route.request().url()).searchParams.get('version') === 'original';
      return route.fulfill({ json: { originalState: 'ready', correctionState: 'ready', selectedVersion: original ? 'original' : 'corrected', selectedRevision: 'r1', warnings: [], segments: [{ id: 's1', start: 12, text: original ? 'gloomit <img src=x onerror=alert(1)>' : 'Google Meet <img src=x onerror=alert(1)>', speaker: 'SPEAKER_00' }], corrections: original ? [] : [{ original: 'gloomit', replacement: 'Google Meet', correctedRange: { segmentId: 's1', start: 0, end: 11 } }] } });
    });
    await page.goto('http://fixture.test/history');
    assert.equal(await page.title(), 'History - Meeting scheduler');
    const open = page.getByRole('button', { name: 'View meeting' });
    assert.equal(await open.count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Download recording' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'View transcript' }).count(), 0);
    await open.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor({ state: 'visible' });
    const desktopBox = await dialog.boundingBox(); assert.ok(desktopBox);
    assert.equal(Math.round(desktopBox.width), 768);
    const highlight = page.locator('.transcript-change'); await highlight.waitFor(); await highlight.focus();
    assert.equal(await page.getByRole('tooltip').innerText(), 'Original: gloomit');
    assert.equal(await page.locator('.transcript-content img').count(), 0);
    await page.screenshot({ path: '/tmp/transcription-desktop.png' });
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    await page.getByText('gloomit <img src=x onerror=alert(1)>', { exact: true }).waitFor();
    await page.keyboard.press('Escape'); assert.equal(await open.evaluate(element => element === document.activeElement), true);
    await page.setViewportSize({ width: 390, height: 844 }); await open.click(); await highlight.waitFor();
    const box = await dialog.boundingBox(); assert.ok(box); assert.equal(Math.round(box.width), 390);
    await page.screenshot({ path: '/tmp/transcription-mobile.png' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: '/tmp/transcription-mobile-dark.png' });
    await page.getByRole('button', { name: 'Close meeting' }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('pending polling preserves explicit Original selection, safe Korean wrapping and keyboard containment', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); let requests = 0;
    const html = renderHistory([{ botId: 'b', payload: { eventId: '한국어 회의' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now()+60000, state: 'completed', recording: { botId: 'b', recordingId: 'r', timestamp: new Date().toISOString(), storage: { provider: 's3', bucket: 'private', key: 'fixture.mp4' } } } as never]);
    await page.route('http://fixture.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/history') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.pathname.endsWith('/video')) return route.fulfill({ status: 404 });
      requests++; const ready = requests >= 3;
      return route.fulfill({ json: { originalState: 'ready', correctionState: ready ? 'ready' : 'pending', correctedAvailable: ready,
        selectedVersion: ready && url.searchParams.get('version') !== 'original' ? 'corrected' : 'original', selectedRevision: 'original', warnings: [],
        segments: [{ id: 's', text: '한국어 English 😀 '.repeat(200), start: 0 }], corrections: [] } });
    });
    await page.goto('http://fixture.test/history'); await page.getByRole('button', { name: 'View meeting' }).click();
    await page.getByText('Correction pending', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    await page.getByText('No corrections made', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Corrected', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-transcript-version="corrected"]')?.disabled);
    assert.equal(await page.getByRole('button', { name: 'Original', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.transcript-content').evaluate(element => element.scrollWidth <= element.clientWidth), true);
    for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); assert.equal(await page.locator('#transcript-drawer').evaluate(element => element.contains(document.activeElement)), true); }
    await page.getByRole('button', { name: 'Close meeting' }).click(); const closedRequests = requests;
    assert.ok(closedRequests >= 3);
  } finally { await browser.close(); }
});

test('Original remains selectable when corrected transcript retrieval fails', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.route('http://fixture.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/history') return route.fulfill({ contentType: 'text/html', body: renderHistory([{ botId: 'b', payload: { eventId: 'Fixture meeting' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now() + 60000, state: 'completed', recording: { botId: 'b', recordingId: 'r', timestamp: 'now', storage: { provider: 's3', bucket: 'private', key: 'fixture.mp4' } } } as never]) });
      if (url.pathname.endsWith('/video')) return route.fulfill({ status: 404 });
      if (url.searchParams.get('version') === 'corrected') return route.fulfill({ status: 503, json: { error: 'Corrected artifact unavailable' } });
      return route.fulfill({ json: { originalState: 'ready', correctionState: 'ready', selectedVersion: 'original', selectedRevision: 'original', correctedAvailable: true,
        warnings: [], corrections: [], segments: [{ id: 's', text: 'The original remains available.', start: 0 }] } });
    });
    await page.goto('http://fixture.test/history'); await page.getByRole('button', { name: 'View meeting' }).click();
    await page.getByText('Transcript retrieval failed', { exact: true }).waitFor();
    const original = page.getByRole('button', { name: 'Original', exact: true });
    assert.equal(await original.isEnabled(), true);
    await original.click(); await page.getByText('The original remains available.', { exact: true }).waitFor();
  } finally { await browser.close(); }
});
