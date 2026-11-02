import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const maxSourceBytes = 2 * 1024 * 1024;
const maxOutputBytes = 8 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type ImageFormat = 'png' | 'jpeg' | 'webp';
type ImageNormalizer = (source: Buffer, format: ImageFormat) => Promise<Buffer>;
export class InvalidBotThumbnailError extends Error {}
const invalidImage = () => new InvalidBotThumbnailError('Choose a valid PNG, JPEG or WebP image up to 2 MiB and 16 million pixels.');
export const validThumbnailId = (id: string): boolean => /^[a-f0-9]{64}$/.test(id);

function dimensions(source: Buffer, format: ImageFormat): [number, number] | undefined {
  if (format === 'png') {
    if (source.length < 33 || !source.subarray(0, 8).equals(pngSignature) || source.toString('ascii', 12, 16) !== 'IHDR') return;
    return [source.readUInt32BE(16), source.readUInt32BE(20)];
  }
  if (format === 'jpeg') {
    if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return;
    let offset = 2;
    while (offset + 3 < source.length) {
      if (source[offset++] !== 0xff) return;
      while (source[offset] === 0xff) offset++;
      const marker = source[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > source.length) return;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = source.readUInt16BE(offset);
      if (length < 2 || offset + length > source.length) return;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) return;
        return [source.readUInt16BE(offset + 5), source.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    return;
  }
  if (source.length < 20 || source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WEBP') return;
  const encoding = source.toString('ascii', 12, 16);
  if (encoding === 'VP8X' && source.length >= 30) return [1 + source.readUIntLE(24, 3), 1 + source.readUIntLE(27, 3)];
  if (encoding === 'VP8 ' && source.length >= 30 && source.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return [source.readUInt16LE(26) & 0x3fff, source.readUInt16LE(28) & 0x3fff];
  if (encoding === 'VP8L' && source.length >= 25 && source[20] === 0x2f) {
    const bits = source.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
}

function decodeImage(dataUrl: string): { source: Buffer; format: ImageFormat } {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxSourceBytes / 3) * 4 + 64) throw invalidImage();
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw invalidImage();
  const source = Buffer.from(match[2], 'base64');
  const format = match[1] as ImageFormat;
  if (source.length > maxSourceBytes || source.toString('base64') !== match[2]) throw invalidImage();
  const size = dimensions(source, format);
  if (!size || size.some(value => value < 1 || value > 8192) || size[0] * size[1] > 16_000_000) throw invalidImage();
  return { source, format };
}

export const normalizeBotThumbnail: ImageNormalizer = (source, format) => new Promise((resolve, reject) => {
  // Fix the decoder and prohibit network protocols so uploaded bytes cannot select another input source.
  const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'pipe', '-f', 'image2pipe', '-c:v', format === 'jpeg' ? 'mjpeg' : format, '-max_pixels', '16000000', '-i', 'pipe:0', '-an', '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1', '-frames:v', '1', '-map_metadata', '-1', '-c:v', 'png', '-threads', '1', '-f', 'image2pipe', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  let length = 0;
  let failed = false;
  const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 10_000);
  child.stdout.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length > maxOutputBytes) { failed = true; child.kill('SIGKILL'); }
    else chunks.push(chunk);
  });
  child.stderr.resume();
  child.stdin.on('error', () => { /* A decoder rejection can close its input before the upload finishes. */ });
  child.once('error', () => { clearTimeout(timer); reject(invalidImage()); });
  child.once('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(invalidImage()); else resolve(Buffer.concat(chunks)); });
  child.stdin.end(source);
});

export class BotThumbnailStore {
  constructor(private readonly directory: string, private readonly normalize: ImageNormalizer = normalizeBotThumbnail) {}

  async save(dataUrl: string): Promise<string> {
    const { source, format } = decodeImage(dataUrl);
    let image: Buffer;
    try { image = await this.normalize(source, format); } catch { throw invalidImage(); }
    const size = dimensions(image, 'png');
    if (image.length > maxOutputBytes || !size || size[0] !== 1280 || size[1] !== 720) throw invalidImage();
    const id = createHash('sha256').update(image).digest('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.${randomBytes(16).toString('hex')}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(image);
      await file.sync();
      await file.close();
      // Hard-link publication is atomic and never overwrites an immutable image used by an earlier job.
      try { await link(temporary, join(this.directory, `${id}.png`)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (!await this.read(id)) throw Error('Stored bot image failed integrity verification');
      }
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file.close(); await unlink(temporary); }
    return id;
  }

  async read(id: string): Promise<Buffer | null> {
    if (!validThumbnailId(id)) return null;
    try {
      const file = await open(join(this.directory, `${id}.png`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > maxOutputBytes) return null;
        const image = await file.readFile();
        return createHash('sha256').update(image).digest('hex') === id ? image : null;
      } finally { await file.close(); }
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code || '')) return null;
      throw error;
    }
  }
}
