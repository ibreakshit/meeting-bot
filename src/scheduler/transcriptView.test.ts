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
      if (new URL(route.request().url()).pathname.endsWith('/processing')) return route.fulfill({ json: { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'ready' } });
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
      if (url.pathname.endsWith('/processing')) return route.fulfill({ json: { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'ready' } });
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
      if (url.pathname.endsWith('/processing')) return route.fulfill({ json: { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'ready' } });
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

test('processing drawer follows encoding, transcription and correction without requesting video early', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let stage = 0;
    let videoRequests = 0;
    const states = [
      { videoState: 'encoding', recordingReady: false, originalState: 'waiting', correctionState: 'waiting' },
      { videoState: 'ready', recordingReady: true, originalState: 'running', correctionState: 'pending' },
      { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'running' },
      { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'ready' },
      { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'failed' },
    ];
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('http://fixture.test/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/history') return route.fulfill({ contentType: 'text/html', body: renderHistory([{ botId: 'encoding', meetingTitle: 'Processing meeting', payload: { provider: 'google' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now(), state: 'picked_up' } as never]) });
      if (path.endsWith('/processing')) return route.fulfill({ json: states[stage] });
      if (path.endsWith('/video')) { videoRequests++; return route.fulfill({ status: 404 }); }
      return route.fulfill({ json: { ...states[stage], selectedVersion: stage === 3 ? 'corrected' : 'original', selectedRevision: stage >= 2 ? 'r1' : undefined, correctedAvailable: stage === 3, segments: stage >= 2 ? [{ id: 's', text: 'Original available during correction', start: 0 }] : [], corrections: [], warnings: [] } });
    });
    await page.goto('http://fixture.test/history');
    await page.getByRole('button', { name: 'View meeting' }).click({ timeout: 2000 });
    const progress = page.getByRole('region', { name: 'Meeting processing' });
    await progress.getByText('Encoding to MP4', { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(videoRequests, 0);
    assert.equal(await page.locator('#meeting-recording-download').getAttribute('href'), null);
    assert.equal(await page.locator('#meeting-video-error').isVisible(), false);
    await page.screenshot({ path: '/tmp/meeting-processing-encoding-mobile.png' });
    stage = 1;
    await progress.getByText('Transcription running', { exact: true }).waitFor();
    stage = 2;
    await progress.getByText('Correction running', { exact: true }).waitFor();
    await page.getByText('Original available during correction', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Original', exact: true }).isEnabled(), true);
    stage = 3;
    await progress.getByText('Correction complete', { exact: true }).waitFor();
    stage = 4;
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    await progress.getByText('Correction failed', { exact: true }).waitFor();
    await page.getByText('Correction failed. The original transcript is still available.', { exact: false }).waitFor();
    await page.getByText('Original available during correction', { exact: true }).waitFor();
    await page.screenshot({ path: '/tmp/meeting-processing-correction-failed-mobile.png' });
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await page.screenshot({ path: '/tmp/meeting-processing-correction-failed-dark.png' });
    assert.equal(videoRequests, 1);
    assert.equal(await progress.locator('[data-state="running"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole('button', { name: 'Close meeting' }).click();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('consecutive speaker segments form readable turns while preserving corrections and speaker changes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('http://fixture.test/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/history') return route.fulfill({ contentType: 'text/html', body: renderHistory([{ botId: 'b', meetingTitle: 'Readable turns', payload: { provider: 'google' }, pushedAt: Date.now(), scheduledStart: Date.now(), scheduledEnd: Date.now(), state: 'completed', recording: { botId: 'b', recordingId: 'r', timestamp: 'now', storage: { provider: 's3', bucket: 'private', key: 'video.webm' } } } as never]) });
      if (url.pathname.endsWith('/processing')) return route.fulfill({ json: { videoState: 'ready', recordingReady: true, originalState: 'ready', correctionState: 'ready' } });
      if (url.pathname.endsWith('/video')) return route.fulfill({ status: 404 });
      const original = url.searchParams.get('version') === 'original';
      return route.fulfill({ json: { originalState: 'ready', correctionState: 'ready', selectedVersion: original ? 'original' : 'corrected', selectedRevision: 'r', correctedAvailable: true, warnings: [],
        segments: [
          { id: 's1', speaker: 'SPEAKER_00', start: 12, text: 'We use' },
          { id: 's2', speaker: 'SPEAKER_00', start: 15, text: original ? 'gloomit' : 'Google Meet' },
          { id: 's3', speaker: 'SPEAKER_00', start: 20, text: '. It works.' },
          { id: 's4', speaker: 'SPEAKER_01', start: 30, text: 'I see.' },
          { id: 's5', speaker: 'SPEAKER_00', start: 43, text: 'Yes.' },
          { id: 's6', start: 50, text: 'Unidentified speaker.' },
          { id: 's7', start: 55, text: 'Another unidentified speaker.' },
        ], corrections: original ? [] : [{ original: 'gloomit', replacement: 'Google Meet', correctedRange: { segmentId: 's2', start: 0, end: 11 } }] } });
    });
    await page.goto('http://fixture.test/history'); await page.getByRole('button', { name: 'View meeting' }).click();
    const turns = page.locator('.transcript-turn'); await turns.first().waitFor();
    assert.equal(await turns.count(), 5);
    assert.equal(await turns.first().locator('h3').innerText(), 'SPEAKER_00 · 00:12');
    assert.equal(await turns.first().locator('p').innerText(), 'We use Google Meet. It works.');
    assert.equal(await turns.nth(2).locator('h3').innerText(), 'SPEAKER_00 · 00:43');
    const correctedWord = turns.first().locator('.transcript-change');
    assert.equal(await correctedWord.innerText(), 'Google Meet');
    await correctedWord.focus();
    assert.equal(await page.getByRole('tooltip').innerText(), 'Original: gloomit');
    await page.getByRole('button', { name: 'Original', exact: true }).click();
    await page.getByText('We use gloomit. It works.', { exact: true }).waitFor();
    assert.equal(await turns.count(), 5);
    assert.equal(await page.locator('.transcript-change').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  } finally { await browser.close(); }
});
