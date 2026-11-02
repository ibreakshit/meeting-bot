import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createRecordingDownloadHandler, RecordingStorageResponse } from './download';
import { GetObjectCommand, GetObjectCommandInput, HeadObjectCommand, HeadObjectCommandInput } from '@aws-sdk/client-s3';
import type { StoredRecording } from './types';
interface StorageCall { name: string; input: GetObjectCommandInput | HeadObjectCommandInput; opts: { abortSignal?: AbortSignal } }
async function fixture(run: (url: string, calls: StorageCall[]) => Promise<void>, options: {
    error?: number;
    race?: boolean;
    stream?: () => Readable;
    recording?: StoredRecording & { blobUrl?: string };
} = {}) {
    const calls: StorageCall[] = [];
    const bytes = Buffer.from('0123456789');
    let raced = false;
    const s3 = { send: async (command: GetObjectCommand | HeadObjectCommand, opts?: { abortSignal?: AbortSignal }) : Promise<RecordingStorageResponse> => { calls.push({ name: command.constructor.name, input: command.input, opts: opts ?? {} }); if (options.error)
            throw { $metadata: { httpStatusCode: options.error } }; if (command instanceof HeadObjectCommand)
            return { ContentLength: 10, ContentType: 'video/mp4', ETag: raced ? '"v2"' : '"v1"', LastModified: new Date('2026-01-01T00:00:00Z') }; if (options.race && !raced) {
            raced = true;
            throw { $metadata: { httpStatusCode: 412 } };
        } let body = bytes; if (command instanceof GetObjectCommand && command.input.Range) {
            const match = command.input.Range.match(/bytes=(\d+)-(\d+)/);
            assert.ok(match, 'Expected normalized S3 byte range');
            body = bytes.subarray(Number(match[1]), Number(match[2]) + 1);
        } return { Body: options.stream?.() ?? Readable.from([body]), ContentLength: body.length, ETag: raced ? '"v2"' : '"v1"' }; } };
    const app = express();
    const handler = createRecordingDownloadHandler({ config: { s3: { bucket: 'private', region: 'local', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true } }, getRecording: async () => options.recording ?? ({ botId: 'bot', recordingId: 'r', timestamp: 'now', storage: { provider: 's3', bucket: 'private', key: 'object.mp4' } }), s3 });
    app.get('/recordings/:botId/download', handler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
        await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/recordings/bot/download`, calls);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    }
}
test('full and HEAD downloads keep private storage metadata server-side', async () => { await fixture(async (u, calls) => { const r = await fetch(u); assert.equal(r.status, 200); assert.equal(await r.text(), '0123456789'); assert.equal(r.headers.get('content-length'), '10'); assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.equal(r.headers.get('accept-ranges'), 'bytes'); const disposition = r.headers.get('content-disposition'); assert.ok(disposition); assert.match(disposition, /^attachment/); assert.ok(!JSON.stringify([...r.headers]).includes('private/')); const head = await fetch(u, { method: 'HEAD', headers: { Range: 'bytes=0-1' } }); assert.equal(head.status, 200); assert.equal(await head.text(), ''); assert.equal(calls.filter(c => c.name === 'GetObjectCommand').length, 1); }); });
test('bounded, open, suffix, invalid, unsatisfiable and multipart ranges', async () => { await fixture(async (u) => { for (const [range, status, text, contentRange] of [['bytes=2-4', 206, '234', 'bytes 2-4/10'], ['bytes=7-', 206, '789', 'bytes 7-9/10'], ['bytes=-3', 206, '789', 'bytes 7-9/10'], ['bytes=20-', 416, '', 'bytes */10'], ['bytes=2-1', 400, '', null], ['invalid', 400, '', null], ['bytes=0-1,4-5', 200, '0123456789', null]] as const) {
    const r = await fetch(u, { headers: { Range: range } });
    assert.equal(r.status, status, range);
    if (status < 300)
        assert.equal(await r.text(), text);
    assert.equal(r.headers.get('content-range'), contentRange, range);
} }); });
test('If-Range matches validators and conditional GET retries object-version races', async () => { await fixture(async (u, calls) => { for (const [validator, status] of [['"v1"', 206], ['"old"', 200], ['W/"v1"', 200], ['Thu, 01 Jan 2026 00:00:00 GMT', 206], ['Wed, 01 Jan 2025 00:00:00 GMT', 200]] as const) {
    const r = await fetch(u, { headers: { Range: 'bytes=2-4', 'If-Range': validator } });
    assert.equal(r.status, status);
    await r.arrayBuffer();
} const objectCall = calls.find(c => c.name === 'GetObjectCommand'); assert.ok(objectCall); assert.equal(objectCall.input.IfMatch, '"v1"'); }); await fixture(async (u, calls) => { const r = await fetch(u, { headers: { Range: 'bytes=2-4', 'If-Range': '"v1"' } }); assert.equal(r.status, 200); assert.equal(await r.text(), '0123456789'); assert.equal(calls.filter(c => c.name === 'HeadObjectCommand').length, 2); }, { race: true }); });
test('storage missing/denied errors and invalid metadata are sanitized', async () => { for (const [code, status] of [[404, 404], [403, 502], [500, 503]])
    await fixture(async (u) => { const r = await fetch(u); assert.equal(r.status, status); assert.ok(!(await r.text()).includes('secret')); }, { error: code }); await fixture(async (u, calls) => { assert.equal((await fetch(u)).status, 404); assert.equal(calls.length, 0); }, { recording: { botId: 'bot', recordingId: 'r', timestamp: 'now', storage: { provider: 's3', bucket: 'attacker', key: 'object' }, blobUrl: 'http://attacker/secret' } }); });
test('first bytes stream before completion and client cancellation aborts storage read', async () => { let destroyed = false; await fixture(async (u, calls) => { const controller = new AbortController(); const r = await fetch(u, { signal: controller.signal }); assert.equal(r.status, 200); assert.ok(r.body); const reader = r.body.getReader(); const firstChunk = await reader.read(); assert.ok(firstChunk.value); assert.equal(Buffer.from(firstChunk.value).toString(), '0'); controller.abort(); await new Promise<void>(resolve => setTimeout(resolve, 30)); assert.ok(calls[1].opts.abortSignal); assert.equal(calls[1].opts.abortSignal.aborted, true); assert.equal(destroyed, true); }, { stream: () => new Readable({ read() { this.push('0'); this._read = () => undefined; }, destroy(error, callback) { destroyed = true; callback(error); } }) }); });

test('If-Range mismatch ignores even an unsatisfiable range', async () => {
  await fixture(async url => {
    const response = await fetch(url, { headers: { Range: 'bytes=100-', 'If-Range': '"different"' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '0123456789');
  });
});

test('upstream errors are sanitized before bytes and interrupt a response after bytes', async () => {
  await fixture(async url => {
    const response = await fetch(url);
    assert.equal(response.status, 502);
    assert.equal(await response.text(), 'Recording storage unavailable');
  }, { stream: () => new Readable({ read() { this.destroy(Error('http://secret-storage/private')); } }) });
  await fixture(async url => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
  }, { stream: () => new Readable({ read() { this.push('012'); this._read = () => undefined; setTimeout(() => this.destroy(Error('stream failed')), 10); } }) });
});
