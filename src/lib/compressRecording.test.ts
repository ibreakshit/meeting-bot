import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { createLogger, transports } from 'winston';
import config from '../config';
import DiskUploader from '../middleware/disk-uploader';
import { writeWebmDurationMetadata } from './webmDuration';
import { compressRecording } from './compressRecording';

const execute = promisify(execFile);
const logger = createLogger({ transports: [new transports.Console({ silent: process.env.COMPRESSION_TEST_DIAGNOSTICS !== 'true' })] });
const fixtureUser = 'compression-fixture-' + randomUUID();
const stagingDirectory = join(process.cwd(), 'dist/_tempvideo', fixtureUser);
const server = createServer();
let directory: string;
let source: Buffer;
let uploadStatus = 200;
const uploads: { key: string; contentType: string; body: Buffer }[] = [];
let completion: { metadata: { contentType: string; storage: { key: string } } } | undefined;

async function media(args: string[]): Promise<void> {
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '2', '-filter_threads', '1', ...args], { timeout: 30000 });
}
async function probe(file: string) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number }[]; format: { duration: string } };
}
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'meeting-bot-compression-'));
  const input = join(directory, 'source.webm');
  await media(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2', '-c:a', 'libopus', input]);
  await writeWebmDurationMetadata(input, 2);
  source = await readFile(input);
  server.on('request', async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (request.url === '/completed') {
      completion = JSON.parse(body.toString());
      response.writeHead(200).end('{}');
    } else {
      assert.ok(request.url);
      uploads.push({ key: decodeURIComponent(request.url.split('?')[0]), contentType: String(request.headers['content-type']), body });
      response.writeHead(uploadStatus, { ETag: '"fixture"' }).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  config.uploaderType = 's3'; config.uploaderFileExtension = '.webm';
  config.s3CompatibleStorage = { endpoint: origin, region: 'us-east-1', accessKeyId: 'fixture', secretAccessKey: 'fixture', bucket: 'recordings', forcePathStyle: true };
  config.notifyRedisEnabled = false; config.notifyWebhookEnabled = true; config.notifyWebhookUrl = origin + '/completed';
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
});

async function uploader(extension = '.webm', data = source) {
  const id = randomUUID();
  config.uploaderFileExtension = extension;
  const instance = await DiskUploader.initialize('fixture', 'fixture', 'UTC', fixtureUser, id, 'Compression fixture', id, logger);
  const input = join(stagingDirectory, id + extension);
  await writeFile(input, data);
  instance.setRecordingDuration(2);
  return { instance, input };
}

test('before-upload processing publishes a smaller 720p MP4 with audio and matching completion metadata', async () => {
  const { instance, input } = await uploader();
  assert.equal(await instance.uploadRecordingToRemoteStorage(), true);
  const uploaded = uploads[uploads.length - 1];
  assert.equal(uploaded.contentType, 'video/mp4');
  assert.match(uploaded.key, /\.mp4$/);
  assert.ok(uploaded.body.length < source.length);
  assert.equal(completion?.metadata.contentType, 'video/mp4');
  assert.ok(completion);
  assert.ok(uploaded.key.endsWith(completion.metadata.storage.key));
  const output = join(directory, 'uploaded.mp4'); await writeFile(output, uploaded.body);
  const metadata = await probe(output);
  const video = metadata.streams.find(stream => stream.codec_type === 'video'); assert.ok(video);
  assert.deepEqual([video.codec_name, video.width, video.height], ['h264', 1280, 720]);
  assert.equal(metadata.streams.find(stream => stream.codec_type === 'audio')?.codec_name, 'aac');
  assert.ok(Math.abs(Number(metadata.format.duration) - 2) < 0.25);
  await media(['-i', output, '-f', 'null', '-']);
  await assert.rejects(stat(input), { code: 'ENOENT' });
  assert.deepEqual(await readdir(stagingDirectory), []);
});

test('failed upload retains original and candidate, then retry cleans both after success', async () => {
  const { instance, input } = await uploader();
  uploadStatus = 403;
  try {
    assert.equal(await instance.uploadRecordingToRemoteStorage(), false);
    assert.equal(digest(await readFile(input)), digest(source));
    const files = await readdir(stagingDirectory);
    assert.equal(files.length, 2);
    const failedCandidate = digest(uploads[uploads.length - 1].body);
    uploadStatus = 200;
    assert.equal(await instance.uploadRecordingToRemoteStorage(), true);
    assert.equal(digest(uploads[uploads.length - 1].body), failedCandidate);
    assert.deepEqual(await readdir(stagingDirectory), []);
  } finally { uploadStatus = 200; }
});

test('durationless browser WebM staged under an MP4 extension is compressed to 720p with truthful metadata', async () => {
  const streamed = join(directory, 'streamed.webm');
  await media(['-i', join(directory, 'source.webm'), '-map_metadata', '-1', '-map_metadata:s', '-1', '-c', 'copy', '-live', '1', streamed]);
  assert.equal(Number.isFinite(Number((await probe(streamed)).format.duration)), false);
  const data = await readFile(streamed);
  const { instance } = await uploader('.mp4', data);
  assert.equal(await instance.uploadRecordingToRemoteStorage(), true);
  const uploaded = uploads[uploads.length - 1];
  assert.equal(uploaded.contentType, 'video/mp4');
  assert.match(uploaded.key, /\.mp4$/);
  assert.equal(uploaded.body.toString('ascii', 4, 8), 'ftyp');
  assert.ok(uploaded.body.length < data.length);
  const output = join(directory, 'streamed-upload.mp4'); await writeFile(output, uploaded.body);
  const video = (await probe(output)).streams.find(stream => stream.codec_type === 'video'); assert.ok(video);
  assert.deepEqual([video.width, video.height], [1280, 720]);
});

test('small portrait and non-square-pixel recordings retain display aspect ratio and optional audio', async () => {
  for (const fixture of [
    { name: 'portrait', width: 321, height: 641, sar: '1/1', aspect: 321 / 641 },
    { name: 'wide-pixels', width: 640, height: 480, sar: '2/1', aspect: 8 / 3 }
  ]) {
    const input = join(directory, fixture.name + '.nut');
    await media(['-f', 'lavfi', '-i', `testsrc=size=${fixture.width}x${fixture.height}:rate=5`, '-t', '1', '-vf', 'setsar=' + fixture.sar, '-c:v', 'rawvideo', '-threads', '2', input]);
    const originalHash = digest(await readFile(input));
    const output = await compressRecording(input, logger); assert.ok(output);
    const metadata = await probe(output);
    const video = metadata.streams.find(stream => stream.codec_type === 'video'); assert.ok(video);
    const { width, height } = video; assert.ok(typeof width === 'number' && typeof height === 'number');
    assert.ok(width <= 1280 && height <= fixture.height);
    assert.ok(width <= fixture.height * fixture.aspect);
    assert.equal(width % 2, 0); assert.equal(height % 2, 0);
    assert.ok(Math.abs(width / height - fixture.aspect) < fixture.aspect * 0.02);
    assert.equal(metadata.streams.some(stream => stream.codec_type === 'audio'), false);
    assert.equal(digest(await readFile(input)), originalHash);
  }
});

test('a larger compressed candidate is discarded while the original remains byte-for-byte intact', async () => {
  const input = join(directory, 'tiny.webm');
  await media(['-f', 'lavfi', '-i', 'color=black:size=16x16:rate=1', '-t', '1', '-c:v', 'libvpx-vp9', '-crf', '50', '-b:v', '0', '-threads', '2', input]);
  const original = await readFile(input);
  assert.equal(await compressRecording(input, logger), undefined);
  assert.equal(digest(await readFile(input)), digest(original));
  assert.equal((await readdir(directory)).some(name => name.startsWith('tiny.webm.') && name.endsWith('.compressed.mp4')), false);
});

test('encoder failure uploads exact original bytes and removes the partial candidate', async () => {
  const scripts = await mkdtemp(join(directory, 'failed-encoder-'));
  await writeFile(join(scripts, 'ffmpeg'), '#!/bin/sh\nfor output; do :; done\nprintf broken > "$output"\nexit 1\n', { mode: 0o700 });
  const originalPath = process.env.PATH;
  process.env.PATH = scripts + ':' + originalPath;
  try {
    const { instance } = await uploader();
    assert.equal(await instance.uploadRecordingToRemoteStorage(), true);
    const uploaded = uploads[uploads.length - 1];
    assert.equal(uploaded.contentType, 'video/webm');
    assert.match(uploaded.key, /\.webm$/);
    assert.equal(digest(uploaded.body), digest(source));
    assert.equal(completion?.metadata.contentType, 'video/webm');
    assert.deepEqual(await readdir(stagingDirectory), []);
  } finally { process.env.PATH = originalPath; }
});

test('apparently successful encoding that loses audio or truncates the recording is rejected', async () => {
  const input = join(directory, 'validation-source.webm'); await writeFile(input, source);
  const originalHash = digest(source);
  const scripts = await mkdtemp(join(directory, 'invalid-encoder-'));
  await writeFile(join(scripts, 'ffmpeg'), '#!/bin/sh\nfor output; do :; done\ncp "$COMPRESSION_TEST_OUTPUT" "$output"\n', { mode: 0o700 });
  for (const kind of ['silent', 'truncated']) {
    const substitute = join(directory, kind + '.mp4');
    await media(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=12', ...(kind === 'truncated' ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []), '-t', kind === 'silent' ? '2' : '0.5', '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', substitute]);
    const originalPath = process.env.PATH;
    process.env.PATH = scripts + ':' + originalPath;
    process.env.COMPRESSION_TEST_OUTPUT = substitute;
    try {
      assert.equal(await compressRecording(input, logger), undefined);
      assert.equal(digest(await readFile(input)), originalHash);
      assert.equal((await readdir(directory)).some(name => name.startsWith('validation-source.webm.') && name.endsWith('.compressed.mp4')), false);
    } finally { process.env.PATH = originalPath; delete process.env.COMPRESSION_TEST_OUTPUT; }
  }
});
