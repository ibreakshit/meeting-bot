import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { renderHistory } from './views';
import type { DispatchRecord } from './types';

function failedMeeting(id: string, type: string, message: string): DispatchRecord {
  const start = new Date();
  start.setUTCHours(1, 30, 0, 0);
  const payload = { botId: id, eventId: `event-${id}`, provider: 'google' as const, url: 'https://meet.google.com/example',
    name: 'Meeting bot', timezone: 'Asia/Seoul', teamId: 'team', userId: 'user', bearerToken: 'private' };
  return { botId: id, payload, serializedPayload: JSON.stringify(payload), memberInstanceKeys: [id],
    pushedAt: Date.now(), scheduledStart: start.getTime(), scheduledEnd: start.getTime() + 1800000,
    state: 'failed', outcome: { status: 'failed', timestamp: new Date().toISOString(), error: { type, message } } };
}

test('History explains failures, keeps traces expandable and shows recovered recordings without erasing the failure', async () => {
  const recovered = failedMeeting('recovered', 'RecordingUploadFailedError', 'Google Meet recording completed but upload failed');
  recovered.meetingTitle = 'Fanz <> Jiho monthly';
  recovered.recording = { botId: recovered.botId, recordingId: 'recording', timestamp: new Date().toISOString(),
    duration: 651, storage: { provider: 's3', bucket: 'recordings', key: 'meeting.webm' } };
  const browserFailure = failedMeeting('browser', 'Error', 'browserType.connectOverCDP: getaddrinfo EAI_AGAIN chrome-cdp-2\nCall log:\n  - retrieving websocket URL from http://chrome-cdp-2:9223\n  - <script>window.injected = true</script>');
  const lobby = failedMeeting('lobby', 'WaitingAtLobbyRetryError', 'Google Meet bot could not enter the meeting...');
  const records = [recovered, browserFailure, lobby];
  const now = Date.now();
  records.forEach((record, index) => { record.pushedAt = now - index * 1000; });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Seoul', locale: 'en-US' });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent(renderHistory(records));
    const rows = page.locator('.history-entry');
    assert.equal(await rows.nth(0).getByRole('heading').innerText(), 'Fanz <> Jiho monthly');
    assert.equal(await rows.nth(1).getByRole('heading').innerText(), 'Google Meet');
    assert.match(await rows.nth(0).innerText(), /Recording recovered/);
    assert.match(await rows.nth(0).innerText(), /10 min 51 sec/);
    assert.match(await rows.nth(0).innerText(), /10:30/);
    assert.doesNotMatch(await rows.nth(0).innerText(), /Permanent failure/);
    assert.match(await rows.nth(1).innerText(), /Browser unavailable/);
    assert.match(await rows.nth(2).innerText(), /Could not join/);
    assert.equal(await rows.nth(1).locator('pre').isVisible(), false);
    await rows.nth(1).getByText('Technical details', { exact: true }).click();
    assert.equal(await rows.nth(1).locator('pre').isVisible(), true);
    assert.match(await rows.nth(1).locator('pre').textContent() || '', /EAI_AGAIN chrome-cdp-2\nCall log:/);
    assert.equal(await page.evaluate(() => 'injected' in window), false);
    assert.doesNotMatch(await page.content(), /http:\/\/chrome-cdp-2/);
    assert.equal(recovered.outcome?.status, 'failed');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('History does not describe conflicted or unavailable recordings as recovered', () => {
  const record = failedMeeting('conflict', 'RecordingUploadFailedError', 'Recording upload failed');
  record.recording = { botId: record.botId, recordingId: 'recording', timestamp: new Date().toISOString(),
    storage: { provider: 's3', bucket: 'recordings', key: 'file.webm' }, locationConflict: true };
  assert.doesNotMatch(renderHistory([record]), /Recording recovered/);
  record.recording.locationConflict = false;
  assert.ok(record.outcome);
  record.outcome.conflict = true;
  assert.doesNotMatch(renderHistory([record]), /Recording recovered/);
  assert.match(renderHistory([record]), /Conflicting results/);
});
