import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createTranscriptHandlers } from './transcripts';
import type { TranscriptManifest } from '../transcription/types';

test('published original is explicitly selected when correction fails; private fields stay server-side', async () => {
  const manifest = { originalState: 'ready', correctionState: 'failed', warnings: [], original: { revisionId: 'g1', sourceHash: 'hash', keys: {}, hashes: {} } } as unknown as TranscriptManifest;
  const handlers = createTranscriptHandlers({ bucket: 'private', getRecording: async botId => botId === 'b' ? { botId, recordingId: 'r', timestamp: '2026-11-04', storage: { provider: 's3', bucket: 'private', key: 'secret' } } : undefined,
    transcriptQueue: { get: async () => manifest }, transcriptStorage: { readArtifact: async () => Buffer.from(JSON.stringify({ language: 'en', segments: [{ id: 's', text: '<script>bad()</script>', words: [] }] })) } });
  const app = express(); app.get('/:botId', handlers.view); app.get('/:botId/download', handlers.download);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(url + '/b'); const view = await response.json();
    assert.equal(view.selectedVersion, 'original'); assert.equal(view.fallback, true); assert.equal(view.correctionState, 'failed');
    assert.equal(view.segments[0].text, '<script>bad()</script>'); assert.equal(JSON.stringify(view).includes('secret'), false);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(url + '/unknown')).status, 404);
    assert.equal((await fetch(url + '/b?version=bogus')).status, 400);
    assert.equal((await fetch(url + '/b/download?format=html')).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('a previous successful correction remains selectable after a failed retry and Original selection', async () => {
  const original = { revisionId: 'original', sourceHash: 'hash', keys: {}, hashes: {} };
  const correction = { ...original, revisionId: 'corrected-1' };
  const handlers = createTranscriptHandlers({ bucket: 'private', getRecording: async botId => ({ botId, recordingId: 'r', timestamp: '2026-11-04', storage: { provider: 's3', bucket: 'private', key: 'secret' } }),
    transcriptQueue: { get: async () => ({ originalState: 'ready', correctionState: 'failed', original, latestCorrection: correction, warnings: [] } as unknown as TranscriptManifest) },
    transcriptStorage: { readArtifact: async manifest => Buffer.from(JSON.stringify({ segments: [{ id: 's', text: manifest.revisionId === 'original' ? 'gloomit' : 'Google Meet', words: [] }] })) } });
  const app = express(); app.get('/:botId', handlers.view);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/b`;
  try {
    const latest = await (await fetch(url)).json(); assert.equal(latest.selectedRevision, 'corrected-1'); assert.equal(latest.correctionState, 'failed');
    const source = await (await fetch(url + '?version=original')).json(); assert.equal(source.correctedAvailable, true); assert.equal(source.selectedVersion, 'original'); assert.equal(source.segments[0].text, 'gloomit');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
