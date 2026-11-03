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
      if (new URL(route.request().url()).pathname === '/history') return route.fulfill({ contentType: 'text/html', body: renderHistory([{ botId: 'b', payload: { eventId: 'Fixture meeting' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now()+60000, state: 'completed', recording: { botId: 'b', recordingId: 'r', timestamp: new Date().toISOString() } } as never]) });
      const original = new URL(route.request().url()).searchParams.get('version') === 'original';
      return route.fulfill({ json: { originalState: 'ready', correctionState: 'ready', selectedVersion: original ? 'original' : 'corrected', selectedRevision: 'r1', warnings: [], segments: [{ id: 's1', start: 12, text: original ? 'gloomit <img src=x onerror=alert(1)>' : 'Google Meet <img src=x onerror=alert(1)>', speaker: 'SPEAKER_00' }], corrections: original ? [] : [{ original: 'gloomit', replacement: 'Google Meet', correctedRange: { segmentId: 's1', start: 0, end: 11 } }] } });
    });
    await page.goto('http://fixture.test/history');
    assert.equal(await page.title(), 'History - Meeting scheduler');
    const open = page.getByRole('button', { name: 'View transcript' }); await open.click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor({ state: 'visible' });
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
    await page.getByRole('button', { name: 'Close transcript' }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
