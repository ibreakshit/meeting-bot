import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Frame, Page } from 'playwright';

interface CameraOptions {
  thumbnailId?: string;
  bearerToken: string;
  authBaseUrlV2: string;
}
interface CameraLogger { warn(message: string): unknown }
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

/** Only immutable images from the configured internal API may enter the page. */
export async function fetchBotThumbnail(options: CameraOptions): Promise<Buffer> {
  if (!options.thumbnailId || !/^[a-f0-9]{64}$/.test(options.thumbnailId)) throw new Error('Invalid bot thumbnail ID');
  const url = new URL(`${options.authBaseUrlV2.replace(/\/$/, '')}/meeting/app/bot/thumbnail/${options.thumbnailId}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid bot thumbnail API URL');
  const image = await new Promise<Buffer>((resolve, reject) => {
    let finished = false;
    const complete = (error?: Error, image?: Buffer) => {
      if (finished) return;
      finished = true; clearTimeout(timeout);
      if (error) { request.destroy(); reject(error); }
      else if (image) resolve(image);
    };
    // Native requests never follow redirects, and destroying the socket bounds stalled bodies
    // on Node 20, where fetch's body reader can stay pending after AbortController.abort().
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { Authorization: `Bearer ${options.bearerToken}` },
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        complete(new Error(`Bot thumbnail fetch failed (${response.statusCode})`)); return;
      }
      if (Number(response.headers['content-length']) > MAX_THUMBNAIL_BYTES) {
        complete(new Error('Bot thumbnail is too large')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_THUMBNAIL_BYTES) { complete(new Error('Bot thumbnail is too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', error => complete(error));
      response.on('aborted', () => complete(new Error('Bot thumbnail response was interrupted')));
      response.on('end', () => complete(undefined, Buffer.concat(chunks)));
    });
    const timeout = setTimeout(() => complete(new DOMException('Bot thumbnail request timed out', 'AbortError')), 10000);
    request.on('error', error => complete(error));
    request.end();
  });
  if (createHash('sha256').update(image).digest('hex') !== options.thumbnailId) throw new Error('Bot thumbnail hash mismatch');
  if (image.length < 57 || !image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      image.readUInt32BE(8) !== 13 || image.toString('ascii', 12, 16) !== 'IHDR' ||
      image.readUInt32BE(16) !== 1280 || image.readUInt32BE(20) !== 720 ||
      !image.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'))) {
    throw new Error('Bot thumbnail must be a normalized 1280x720 PNG');
  }
  return image;
}

export async function installBotCamera(page: Page, options: CameraOptions): Promise<void> {
  if (!options.thumbnailId) return;
  const image = await fetchBotThumbnail(options);
  // Page scope prevents the persistent CDP context from retaining another job's image.
  await page.addInitScript(({ imageBase64 }) => {
    if (!navigator.mediaDevices) return;
    const mediaDevices = navigator.mediaDevices;
    const nativeEnumerateDevices = mediaDevices.enumerateDevices.bind(mediaDevices);
    const nativeQueryPermission = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async descriptor => {
      if (descriptor.name === 'camera' || descriptor.name === 'microphone') {
        const status = new EventTarget() as PermissionStatus;
        Object.defineProperties(status, {
          state: { value: 'granted' }, name: { value: descriptor.name }, onchange: { value: null, writable: true },
        });
        return status;
      }
      return nativeQueryPermission(descriptor);
    };
    const cameraId = 'meeting-bot-image'; const microphoneId = 'meeting-bot-silent';
    let sourcePromise: Promise<{
      video: MediaStreamTrack; audio: MediaStreamTrack; dispose(): void;
    }> | undefined;
    let disposed = false;
    const liveTracks = new Set<MediaStreamTrack>();

    const createSource = async () => {
      const bytes = Uint8Array.from(atob(imageBase64), character => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
      const context = canvas.getContext('2d');
      if (!context) { bitmap.close(); throw new Error('Camera canvas is unavailable'); }
      const paint = () => context.drawImage(bitmap, 0, 0, 1280, 720);
      paint();
      const video = canvas.captureStream(5).getVideoTracks()[0];
      const audioContext = new AudioContext();
      const destination = audioContext.createMediaStreamDestination();
      // A zero-valued source produces actual silent frames, without opening a microphone.
      const silence = audioContext.createConstantSource(); silence.offset.value = 0;
      silence.connect(destination); silence.start();
      void audioContext.resume().catch(() => undefined);
      const audio = destination.stream.getAudioTracks()[0];
      const timer = setInterval(paint, 200);
      let stopped = false;
      const dispose = () => {
        if (stopped) return; stopped = true;
        clearInterval(timer); video.stop(); audio.stop(); silence.stop(); bitmap.close();
        void audioContext.close().catch(() => undefined);
      };
      if (disposed) { dispose(); throw new DOMException('Page is closed', 'AbortError'); }
      return { video, audio, dispose };
    };
    const trackClone = (original: MediaStreamTrack, kind: 'video' | 'audio'): MediaStreamTrack => {
      const track = original.clone(); liveTracks.add(track);
      const stop = track.stop.bind(track); let stopped = false;
      const release = () => {
        if (stopped) return; stopped = true; liveTracks.delete(track);
      };
      Object.defineProperty(track, 'label', { value: kind === 'video' ? 'Meeting bot image' : 'Meeting bot silence' });
      track.stop = () => { stop(); release(); };
      track.addEventListener('ended', release, { once: true });
      const getSettings = track.getSettings.bind(track);
      track.getSettings = () => ({ ...getSettings(), deviceId: kind === 'video' ? cameraId : microphoneId, groupId: 'meeting-bot' });
      return track;
    };
    mediaDevices.getUserMedia = async (constraints: MediaStreamConstraints = {}) => {
      if (!constraints.video && !constraints.audio) throw new TypeError('At least one media type is required');
      if (disposed) throw new DOMException('Page is closed', 'AbortError');
      // Keep one source until pagehide: native MediaStream.clone() does not call JS track.clone().
      // Retaining this bounded source keeps every clone alive when another consumer stops.
      if (!sourcePromise) sourcePromise = createSource().catch(error => { sourcePromise = undefined; throw error; });
      const source = await sourcePromise;
      const tracks: MediaStreamTrack[] = [];
      if (constraints.audio) tracks.push(trackClone(source.audio, 'audio'));
      if (constraints.video) tracks.push(trackClone(source.video, 'video'));
      return new MediaStream(tracks);
    };
    const device = (kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo => {
      const value = { kind, deviceId, groupId: 'meeting-bot', label };
      return { ...value, toJSON: () => value };
    };
    mediaDevices.enumerateDevices = async () => [
      device('videoinput', cameraId, 'Meeting bot image'), device('audioinput', microphoneId, 'Meeting bot silence'),
      ...(await nativeEnumerateDevices()).filter((item: MediaDeviceInfo) => item.kind === 'audiooutput'),
    ];
    addEventListener('pagehide', () => {
      disposed = true;
      for (const track of liveTracks) track.stop();
      void sourcePromise?.then(source => source.dispose()).catch(() => undefined);
    }, { once: true });
  }, { imageBase64: image.toString('base64') });
}

/** Click only controls whose state is known. Host-disabled video is left alone. */
export async function configureBotCameraControls(root: Page | Frame, provider: 'google' | 'microsoft' | 'zoom', logger: CameraLogger): Promise<void> {
  const labels = {
    google: { on: /^(Turn on camera|Kamera einschalten)/i, off: /^(Turn off camera|Kamera ausschalten)/i, mute: /^(Turn off microphone|Mikrofon ausschalten)/i },
    microsoft: { on: /^Turn camera on/i, off: /^Turn camera off/i, mute: /^Mute (microphone|mic)/i },
    zoom: { on: /^Start Video/i, off: /^Stop Video/i, mute: /^Mute(?: my audio)?(?:\s|$)/i },
  }[provider];
  try {
    const cameraOn = root.getByRole('button', { name: labels.on }).first();
    const cameraOff = root.getByRole('button', { name: labels.off }).first();
    const teamsVideo = root.locator('input[data-tid="toggle-video"]').first();
    if (provider === 'microsoft' && await teamsVideo.count()) {
      if (await teamsVideo.isDisabled()) logger.warn('Bot camera is unavailable or disabled by the host; continuing recording');
      else if (!(await teamsVideo.isChecked())) await teamsVideo.check({ timeout: 2500 });
    } else if (await cameraOn.isVisible()) {
      if (await cameraOn.isEnabled()) await cameraOn.click({ timeout: 2500 });
      else logger.warn('Bot camera is disabled by the host; continuing recording');
    } else if (!(await cameraOff.isVisible())) {
      logger.warn('Bot camera control is unavailable; continuing recording');
    }
    const mute = root.getByRole('button', { name: labels.mute }).first();
    const teamsMute = root.locator('input[data-tid="toggle-mute"]').first();
    if (provider === 'microsoft' && await teamsMute.count()) {
      if (await teamsMute.isEnabled() && !(await teamsMute.isChecked())) await teamsMute.check({ timeout: 2500 });
    } else if (await mute.isVisible() && await mute.isEnabled()) await mute.click({ timeout: 2500 });
  } catch {
    logger.warn('Bot camera or microphone controls are unavailable; continuing recording');
  }
}
