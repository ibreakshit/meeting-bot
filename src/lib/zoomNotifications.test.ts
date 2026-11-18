import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { installZoomNoticeDismissal } from './zoomNotifications';

for (const embedded of [false, true]) test(`Zoom dismisses known overlays before capture and throughout the call (iframe: ${embedded})`, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    if (embedded) { await page.setContent('<iframe id="webclient" style="width:1200px;height:680px"></iframe>'); }
    const frame = embedded ? page.frames()[1] : page.mainFrame();
    await frame.setContent(`<style>.notification-message-wrap,.onboarding-popover,[role=tooltip]{position:absolute;z-index:10;top:20px;background:black;color:white;padding:12px;max-width:650px}.onboarding-popover{top:170px}[role=tooltip]{top:280px}</style>
      <canvas id="presentation" width="1280" height="720"></canvas>
      <div id="hardware" class="notification-message-wrap">For a better meeting experience, enable the option 'Use graphics/hardware acceleration' under browser system settings.<a>Learn more</a></div>
      <div id="devices" class="notification-message-wrap" style="top:100px">Please enable access to your <a>microphone</a> and <a>camera</a> for the best experience.<button aria-label="Close" onclick="this.parentElement.remove()">×</button></div>
      <div id="notes" class="onboarding-popover"><h2>Introducing My Notes</h2><p>Edit your meeting notes with our new editor.</p><button onclick="this.parentElement.remove()">Got it</button></div>
      <div id="apps" role="tooltip">See apps that are accessing your meeting content</div>
      <div id="recording" role="alert">This meeting is being recorded<button>OK</button></div>
      <aside id="chat">Please enable access to your microphone and camera for the best experience.<button aria-label="close">Close chat</button></aside>
      <button id="unrelated" aria-label="close">Close presentation</button>`);
    const stop = await installZoomNoticeDismissal(frame);
    for (const id of ['hardware', 'devices', 'notes', 'apps']) assert.equal(await frame.locator('#' + id).isVisible(), false, id);
    for (const id of ['presentation', 'recording', 'chat', 'unrelated']) assert.equal(await frame.locator('#' + id).isVisible(), true, id);
    assert.equal(await frame.locator('#devices, #notes').count(), 0, 'Dismiss controls were clicked');
    await frame.locator('#hardware').evaluate(element => { element.textContent = 'This meeting is being recorded'; });
    await frame.locator('#hardware').waitFor({ state: 'visible' });
    await frame.evaluate(() => {
      setTimeout(() => {
        const notice = document.createElement('div'); notice.id = 'late'; notice.className = 'notification-message-wrap';
        notice.innerHTML = 'Cannot detect your microphone<button aria-label="close" onclick="this.parentElement.remove()">×</button>';
        document.body.append(notice);
        document.body.dataset.lateNoticeAdded = 'true';
      }, 7000);
    });
    await frame.waitForFunction(() => document.body.dataset.lateNoticeAdded === 'true');
    await frame.locator('#late').waitFor({ state: 'hidden' });
    await stop();
    await frame.evaluate(() => {
      const notice = document.createElement('div'); notice.id = 'after-stop'; notice.className = 'notification-message-wrap';
      notice.textContent = 'Cannot detect your camera'; document.body.append(notice);
    });
    await page.waitForTimeout(200);
    assert.equal(await frame.locator('#after-stop').isVisible(), true);
  } finally { await browser.close(); }
});
