import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BotThumbnailStore } from './thumbnails';

const source = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${source.toString('base64')}`;
function canonical(): Buffer {
  const image = Buffer.from(source);
  image.writeUInt32BE(1280, 16);
  image.writeUInt32BE(720, 20);
  return image;
}

test('thumbnail storage canonicalizes privately, reuses content IDs and retains earlier assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-thumbnails-'));
  try {
    let calls = 0;
    const png = canonical();
    const store = new BotThumbnailStore(directory, async (input, format) => { calls++; assert.deepEqual(input, source); assert.equal(format, 'png'); return png; });
    const id = await store.save(dataUrl);
    assert.equal(id, createHash('sha256').update(png).digest('hex'));
    assert.deepEqual(await store.read(id), png);
    assert.equal((await stat(join(directory, `${id}.png`))).mode & 0o777, 0o600);
    assert.equal(await store.save(dataUrl), id);
    assert.equal(calls, 2);
    assert.deepEqual(await readdir(directory), [`${id}.png`]);
    assert.equal(await store.read('../secret'), null);
    assert.equal(await store.read('f'.repeat(64)), null);
    await symlink('/etc/passwd', join(directory, `${'a'.repeat(64)}.png`));
    assert.equal(await store.read('a'.repeat(64)), null);
    assert.deepEqual(await readFile(join(directory, `${id}.png`)), png);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('thumbnail uploads reject SVG, malformed base64, mismatched formats, oversized bytes and pixel bombs before normalization', async () => {
  let calls = 0;
  const store = new BotThumbnailStore('/unused', async () => { calls++; return canonical(); });
  const giant = Buffer.from(source); giant.writeUInt32BE(100000, 16);
  for (const value of [
    'data:image/svg+xml;base64,PHN2Zy8+', 'https://example.com/image.png',
    'data:image/png;base64,!!!!', `data:image/jpeg;base64,${source.toString('base64')}`,
    `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}`,
    `data:image/png;base64,${giant.toString('base64')}`,
  ]) await assert.rejects(store.save(value), /image|Image|PNG|JPEG|WebP/);
  assert.equal(calls, 0);
});

test('failed normalization leaves no asset or temporary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-thumbnails-'));
  try {
    const store = new BotThumbnailStore(directory, async () => { throw Error('decoder failed'); });
    await assert.rejects(store.save(dataUrl), /image|Image/);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt preexisting immutable asset cannot be acknowledged as saved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bot-thumbnails-'));
  try {
    const png = canonical();
    const id = createHash('sha256').update(png).digest('hex');
    const path = join(directory, `${id}.png`);
    await writeFile(path, 'corrupt', { mode: 0o600 });
    const store = new BotThumbnailStore(directory, async () => png);
    assert.equal(await store.read(id), null);
    await assert.rejects(store.save(dataUrl), /integrity/);
    assert.equal(await readFile(path, 'utf8'), 'corrupt');
    assert.deepEqual(await readdir(directory), [`${id}.png`]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production FFmpeg decodes all supported formats to fitted canonical PNGs in an isolated container', { timeout: 60_000 }, async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { resolve } = await import('node:path');
  const { transpileModule, ModuleKind, ScriptTarget } = await import('typescript');
  const directory = await mkdtemp(join(tmpdir(), 'bot-thumbnail-ffmpeg-'));
  try {
    const compiled = transpileModule(await readFile(resolve('src/scheduler/thumbnails.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } }).outputText;
    await writeFile(join(directory, 'thumbnails.cjs'), compiled, { mode: 0o600 });
    const program = `
      const assert = require('node:assert/strict');
      const { execFileSync } = require('node:child_process');
      const { BotThumbnailStore } = require('/test/thumbnails.cjs');
      const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', ...args], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
      (async () => {
        const store = new BotThumbnailStore('/tmp/private-images');
        let first;
        for (const [format, codec] of [['png', 'png'], ['jpeg', 'mjpeg'], ['webp', 'libwebp']]) {
          const input = ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=64x32', '-frames:v', '1', '-threads', '1', '-c:v', codec, '-f', 'image2pipe', 'pipe:1']);
          const url = 'data:image/' + format + ';base64,' + input.toString('base64');
          const id = await store.save(url);
          const output = await store.read(id);
          assert.ok(output);
          assert.equal(output.readUInt32BE(16), 1280);
          assert.equal(output.readUInt32BE(20), 720);
          assert.equal(await store.save(url), id);
          const pixels = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-i', 'pipe:0', '-vf', 'format=rgb24,' + args, '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { input: output, timeout: 10000 });
          const center = pixels('crop=1:1:640:360');
          assert.ok(center[0] > 240 && center[1] < 12 && center[2] < 12, 'red image content survives normalization');
          assert.deepEqual([...pixels('crop=1:1:640:0')], [0, 0, 0], 'non-16:9 content is fitted with black padding');
          if (!first) first = id;
        }
        assert.ok(await store.read(first), 'earlier immutable assets survive later uploads');
        const invalid = Buffer.from('${source.toString('base64')}', 'base64');
        invalid.fill(0, 33);
        await assert.rejects(store.save('data:image/png;base64,' + invalid.toString('base64')));
        console.log('PNG/JPEG/WebP normalized, fitted pixels verified, immutable images retained, invalid decoder input rejected');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const result = await promisify(execFile)('docker', ['run', '--rm', '--network', 'none', '--read-only', '--memory', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--mount', `type=bind,source=${directory},target=/test,readonly`, '--entrypoint', 'node', 'meeting-bot:local', '-e', program], { timeout: 50_000, maxBuffer: 1024 * 1024 });
    assert.match(result.stdout, /PNG\/JPEG\/WebP normalized/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
