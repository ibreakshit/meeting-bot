import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ArtifactManifest, RecordingSource, SourceFingerprint, TranscriptVersion } from './types';
import type { RawTranscriptArtifacts } from './whisperx';

export class SourceConflictError extends Error {}
export class TranscriptStorage {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}
  async downloadRecording(source: RecordingSource, destination: string, signal: AbortSignal): Promise<SourceFingerprint> {
    if (source.bucket !== this.bucket) throw new SourceConflictError('Recording bucket mismatch');
    const head = await this.client.send(new HeadObjectCommand({ Bucket: source.bucket, Key: source.key }), { abortSignal: signal });
    if (!head.ETag) throw new SourceConflictError('Recording ETag unavailable');
    const object = await this.client.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key, IfMatch: head.ETag, VersionId: head.VersionId }), { abortSignal: signal });
    if (!object.Body || object.ETag !== head.ETag) throw new SourceConflictError('Recording changed during download');
    const hash = createHash('sha256');
    const digest = new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    await pipeline(object.Body as Readable, digest, createWriteStream(destination, { mode: 0o600, flags: 'wx' }), { signal });
    return { sha256: hash.digest('hex'), etag: head.ETag, versionId: head.VersionId };
  }
  async uploadArtifacts(jobId: string, revisionId: string, artifacts: RawTranscriptArtifacts, version: TranscriptVersion = 'original', sourceHash?: string, auditPath?: string, signal?: AbortSignal): Promise<ArtifactManifest> {
    if (!/^[a-f0-9]{64}$/.test(jobId) || !/^[a-zA-Z0-9-]+$/.test(revisionId)) throw new Error('Invalid artifact identity');
    const prefix = `meeting-bot/transcripts/${jobId}/${version === 'original' ? 'original' : 'corrections'}/${revisionId}/`;
    const paths = { json: artifacts.json, display: artifacts.display, txt: artifacts.txt, srt: artifacts.srt, vtt: artifacts.vtt, diarization: artifacts.diarization, ...(artifacts.runtime ? { runtime: artifacts.runtime } : {}), ...(auditPath ? { audit: auditPath } : {}) };
    const keys: Record<string, string> = {}, hashes: Record<string, string> = {};
    for (const [name, path] of Object.entries(paths)) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      hashes[name] = hash.digest('hex'); keys[name] = `${prefix}${name}.${['txt', 'srt', 'vtt'].includes(name) ? name : 'json'}`;
      // Unique generations plus conditional creation keep stale attempts immutable.
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: keys[name], Body: createReadStream(path), IfNoneMatch: '*', ContentType: name === 'json' || name === 'display' || name === 'diarization' || name === 'audit' ? 'application/json' : 'text/plain; charset=utf-8' }), { abortSignal: signal });
    }
    const manifest: ArtifactManifest = { warnings: artifacts.warnings, revisionId, sourceHash: sourceHash || hashes.json, keys: keys as ArtifactManifest['keys'], hashes };
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: prefix + 'manifest.json', Body: JSON.stringify(manifest), IfNoneMatch: '*', ContentType: 'application/json' }), { abortSignal: signal });
    return manifest;
  }
  async readArtifact(manifest: ArtifactManifest, name: keyof ArtifactManifest['keys'], maxBytes = 16 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
    const key = manifest.keys[name];
    if (!key?.startsWith('meeting-bot/transcripts/') || !manifest.hashes[name]) throw new Error('Invalid artifact manifest');
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), { abortSignal: signal });
    if (!response.Body || (response.ContentLength || 0) > maxBytes) throw new Error('Transcript artifact unavailable or too large');
    const chunks: Buffer[] = []; let size = 0;
    const stream = response.Body as Readable;
    const abort = () => stream.destroy(new Error('Artifact read cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
    signal?.throwIfAborted();
    for await (const data of stream) {
      const chunk = Buffer.from(data); size += chunk.length;
      if (size > maxBytes) { (response.Body as Readable).destroy(); throw new Error('Transcript artifact too large'); }
      chunks.push(chunk);
    }
    } finally { signal?.removeEventListener('abort', abort); }
    const bytes = Buffer.concat(chunks);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.hashes[name]) throw new Error('Transcript artifact hash mismatch');
    return bytes;
  }
  async restoreArtifacts(manifest: ArtifactManifest, directory: string, signal?: AbortSignal): Promise<RawTranscriptArtifacts> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const paths: Record<string, string> = {};
    for (const name of ['json', 'display', 'txt', 'srt', 'vtt', 'diarization'] as const) {
      paths[name] = join(directory, `${name}.${['txt', 'srt', 'vtt'].includes(name) ? name : 'json'}`);
      await writeFile(paths[name], await this.readArtifact(manifest, name, 16 * 1024 * 1024, signal), { mode: 0o600 });
    }
    const display = JSON.parse(await readFile(paths.display, 'utf8')) as { language: string };
    return { ...paths, language: display.language, warnings: manifest.warnings || [] } as unknown as RawTranscriptArtifacts;
  }
}
