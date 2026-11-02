import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { configureBotCameraControls, fetchBotThumbnail, installBotCamera } from './botCamera';

function png(red: number, green: number, blue: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1280); header.writeUInt32BE(720, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc(720 * (1280 * 3 + 1));
  for (let y = 0; y < 720; y++) for (let x = 0; x < 1280; x++) {
    const offset = y * 3841 + 1 + x * 3; raw[offset] = red; raw[offset + 1] = green; raw[offset + 2] = blue;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const redImage = png(230, 15, 20);
const blueImage = png(15, 20, 230);
const id = (image: Buffer) => createHash('sha256').update(image).digest('hex');
let server: Server;
let origin: string;
let browser: Browser;
let sharedContext: BrowserContext;
let assetResponse = redImage;
let assetStatus = 200;
let assetHeaders: Record<string, string> = {};
let assetRequests = 0;
let stallAssetResponse = false;
const warnings: string[] = [];
const logger = { warn: (message: string) => warnings.push(message) };

before(async () => {
  server = createServer((req, res) => {
    if (req.url?.includes('/thumbnail/')) {
      assetRequests++;
      if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
      res.writeHead(assetStatus, { 'Content-Type': 'image/png', ...assetHeaders });
      if (stallAssetResponse) { res.flushHeaders(); return; }
      res.end(assetResponse); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  sharedContext = await browser.newContext();
});
after(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve())); });

async function cameraPage(image = redImage): Promise<Page> {
  assetResponse = image;
  const page = await sharedContext.newPage();
  await page.addInitScript(() => {
    (window as unknown as { hardwareCalls: number }).hardwareCalls = 0;
    const intervals = new Set<number>();
    const setInterval = window.setInterval.bind(window); const clearInterval = window.clearInterval.bind(window);
    window.setInterval = ((handler: TimerHandler, timeout?: number) => {
      const timer = setInterval(handler, timeout); intervals.add(timer); return timer;
    }) as typeof window.setInterval;
    window.clearInterval = timer => { intervals.delete(timer as number); clearInterval(timer); };
    Object.defineProperty(window, 'cameraTimerCount', { get: () => intervals.size });
    navigator.mediaDevices.enumerateDevices = async () => [{
      kind: 'audiooutput', deviceId: 'fixture-speaker', groupId: 'fixture-output', label: 'Fixture speaker',
      toJSON: () => ({ kind: 'audiooutput', deviceId: 'fixture-speaker', groupId: 'fixture-output', label: 'Fixture speaker' }),
    }];
    navigator.mediaDevices.getUserMedia = async () => {
      (window as unknown as { hardwareCalls: number }).hardwareCalls++;
      throw new Error('Hardware capture is forbidden in the fixture');
    };
  });
  await installBotCamera(page, { thumbnailId: id(image), bearerToken: 'fixture-token', authBaseUrlV2: origin });
  await page.goto(origin);
  return page;
}

test('fetch authenticates canonical immutable assets and rejects malformed identifiers, auth, hash, PNG, size and redirects', async () => {
  const options = { thumbnailId: id(redImage), bearerToken: 'fixture-token', authBaseUrlV2: origin };
  assert.deepEqual(await fetchBotThumbnail(options), redImage);
  const beforeRequests = assetRequests;
  await assert.rejects(fetchBotThumbnail({ ...options, thumbnailId: '../anything' }));
  await assert.rejects(fetchBotThumbnail({ ...options, thumbnailId: id(redImage).toUpperCase() }));
  assert.equal(assetRequests, beforeRequests);
  await assert.rejects(fetchBotThumbnail({ ...options, bearerToken: 'incorrect' }));
  assetResponse = blueImage; await assert.rejects(fetchBotThumbnail(options), /hash/i);
  assetResponse = Buffer.from('not png'); await assert.rejects(fetchBotThumbnail({ ...options, thumbnailId: id(assetResponse) }), /PNG/i);
  assetResponse = Buffer.alloc(8 * 1024 * 1024 + 1); await assert.rejects(fetchBotThumbnail({ ...options, thumbnailId: id(assetResponse) }), /large/i);
  assetResponse = redImage; assetStatus = 302; assetHeaders = { Location: `${origin}/leak` };
  await assert.rejects(fetchBotThumbnail(options));
  assetStatus = 200; assetHeaders = {};
});

test('camera and silent audio transmit to actual local WebRTC peers without hardware capture', { timeout: 20_000 }, async () => {
  const page = await cameraPage();
  try {
    const result = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const sender = new RTCPeerConnection(); const receiver = new RTCPeerConnection();
      sender.onicecandidate = event => { if (event.candidate) void receiver.addIceCandidate(event.candidate); };
      receiver.onicecandidate = event => { if (event.candidate) void sender.addIceCandidate(event.candidate); };
      const remote = new MediaStream(); receiver.ontrack = event => remote.addTrack(event.track);
      for (const track of stream.getTracks()) sender.addTrack(track, stream);
      await sender.setLocalDescription(await sender.createOffer()); await receiver.setRemoteDescription(sender.localDescription as RTCSessionDescription);
      await receiver.setLocalDescription(await receiver.createAnswer()); await sender.setRemoteDescription(receiver.localDescription as RTCSessionDescription);
      const video = document.createElement('video'); video.muted = true; video.srcObject = remote; document.body.append(video); await video.play();
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('No decoded remote video')), 10000);
        const check = () => { if (video.videoWidth) { clearTimeout(deadline); resolve(); } else setTimeout(check, 50); }; check();
      });
      await new Promise<void>(resolve => video.requestVideoFrameCallback(() => resolve()));
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      canvas.getContext('2d')?.drawImage(video, 0, 0, 1280, 720); const pixel = Array.from((canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(640, 360, 1, 1).data);
      const audio = new AudioContext(); await audio.resume(); const analyser = audio.createAnalyser();
      audio.createMediaStreamSource(remote).connect(analyser); await new Promise(resolve => setTimeout(resolve, 150));
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
      const maxAudio = Math.max(...Array.from(samples, Math.abs));
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hardwareCalls = (window as unknown as { hardwareCalls: number }).hardwareCalls;
      const kinds = remote.getTracks().map(track => track.kind).sort();
      stream.getTracks().forEach(track => track.stop()); sender.close(); receiver.close(); await audio.close();
      return { pixel, videoState: { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, time: video.currentTime }, maxAudio, hardwareCalls, kinds, devices: devices.map(device => ({ kind: device.kind, label: device.label })) };
    });
    assert.ok(result.pixel[0] > 180 && result.pixel[1] < 50 && result.pixel[2] < 50, JSON.stringify(result));
    assert.ok(result.maxAudio < 0.001, `Remote Opus silence amplitude: ${result.maxAudio}`); assert.equal(result.hardwareCalls, 0); assert.deepEqual(result.kinds, ['audio', 'video']);
    assert.ok(result.devices.some(device => device.kind === 'videoinput' && device.label === 'Meeting bot image'));
    assert.ok(result.devices.some(device => device.kind === 'audiooutput' && device.label === 'Fixture speaker'));
  } finally { await page.close(); }
});

test('repeated streams and cloned tracks survive independent stops, navigation, iframes and isolated pages', async () => {
  const page = await cameraPage(); const second = await cameraPage(blueImage);
  try {
    const pixels = async (target: Page) => target.evaluate(async () => {
      const first = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const secondStream = await navigator.mediaDevices.getUserMedia({ video: true });
      if ((window as unknown as { cameraTimerCount: number }).cameraTimerCount !== 1) throw new Error('Camera allocated multiple source timers');
      const nativeStreamClone = secondStream.clone(); const clone = nativeStreamClone.getVideoTracks()[0]; secondStream.getTracks().forEach(track => track.stop()); first.getTracks().forEach(track => track.stop());
      const video = document.createElement('video'); video.muted = true; video.srcObject = new MediaStream([clone]); await video.play();
      await new Promise(resolve => setTimeout(resolve, 220));
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1; canvas.getContext('2d')?.drawImage(video, 0, 0, 1, 1);
      const pixel = Array.from((canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, 1, 1).data); clone.stop();
      const restarted = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const state = restarted.getTracks().map(track => track.readyState); restarted.getTracks().forEach(track => track.stop()); await Promise.resolve();
      if ((window as unknown as { cameraTimerCount: number }).cameraTimerCount !== 1) throw new Error('Repeated capture created extra page sources');
      return { pixel, state };
    });
    assert.ok((await pixels(page)).pixel[0] > 200); assert.ok((await pixels(second)).pixel[2] > 200);
    await page.reload(); assert.deepEqual((await pixels(page)).state, ['live', 'live']);
    await page.evaluate(url => { const frame = document.createElement('iframe'); frame.src = url; document.body.append(frame); }, origin);
    await page.waitForSelector('iframe'); const frame = page.frames().find(candidate => candidate !== page.mainFrame()); assert.ok(frame);
    await frame.waitForLoadState();
    assert.equal(await frame.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ video: true }); const label = stream.getVideoTracks()[0].label; stream.getTracks().forEach(track => track.stop()); return label; }), 'Meeting bot image');
    assert.equal(await page.evaluate(async () => { dispatchEvent(new PageTransitionEvent('pagehide')); await Promise.resolve(); return (window as unknown as { cameraTimerCount: number }).cameraTimerCount; }), 0);
  } finally { await page.close(); await second.close(); }
});

test('absent image leaves native media methods untouched and makes no request', async () => {
  const page = await browser.newPage(); const beforeRequests = assetRequests;
  await installBotCamera(page, { bearerToken: 'fixture-token', authBaseUrlV2: origin });
  await page.goto(origin);
  assert.equal(await page.evaluate(() => navigator.mediaDevices.enumerateDevices.toString().includes('[native code]')), true);
  assert.equal(assetRequests, beforeRequests); await page.close();
});

for (const provider of ['google', 'microsoft', 'zoom'] as const) {
  test(`${provider} controls enable only an off camera, mute active microphone and respect host-disabled video`, async () => {
    const page = await browser.newPage();
    const labels = provider === 'google' ? ['Turn on camera (ctrl + e)', 'Turn off microphone (ctrl + d)'] : provider === 'microsoft' ? ['Turn camera on', 'Mute microphone'] : ['Start Video', 'Mute'];
    await page.setContent(`<button aria-label="${labels[0]}" onclick="this.setAttribute('aria-label','${provider === 'zoom' ? 'Stop Video' : 'Turn camera off'}');window.cameraClicks=(window.cameraClicks||0)+1">camera</button><button aria-label="${labels[1]}" onclick="this.setAttribute('aria-label','Unmute microphone');window.micClicks=(window.micClicks||0)+1">mic</button>`);
    await configureBotCameraControls(page, provider, logger); await configureBotCameraControls(page, provider, logger);
    assert.deepEqual(await page.evaluate(() => [(window as unknown as { cameraClicks: number }).cameraClicks, (window as unknown as { micClicks: number }).micClicks]), [1, 1]);
    await page.setContent(`<button disabled aria-label="${labels[0]}">camera disabled by host</button>`); warnings.length = 0;
    await configureBotCameraControls(page, provider, logger); assert.ok(warnings.some(message => /camera/i.test(message))); await page.close();
  });
}


test('Teams checkbox controls preserve already configured state across prejoin and admission', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input type="checkbox" data-tid="toggle-video"><input type="checkbox" data-tid="toggle-mute">');
    await configureBotCameraControls(page, 'microsoft', logger); await configureBotCameraControls(page, 'microsoft', logger);
    assert.equal(await page.locator('[data-tid="toggle-video"]').isChecked(), true);
    assert.equal(await page.locator('[data-tid="toggle-mute"]').isChecked(), true);
    await page.locator('[data-tid="toggle-video"]').uncheck();
    await page.locator('[data-tid="toggle-video"]').evaluate(element => (element as HTMLInputElement).disabled = true);
    warnings.length = 0; await configureBotCameraControls(page, 'microsoft', logger);
    assert.equal(await page.locator('[data-tid="toggle-video"]').isChecked(), false); assert.equal(warnings.length, 1);
  } finally { await page.close(); }
});


test('asset body timeout aborts a server that sends headers and then stalls', { timeout: 15_000 }, async () => {
  stallAssetResponse = true;
  try {
    await assert.rejects(fetchBotThumbnail({ thumbnailId: id(redImage), bearerToken: 'fixture-token', authBaseUrlV2: origin }), error => error instanceof Error && error.name === 'AbortError');
  } finally { stallAssetResponse = false; }
});
