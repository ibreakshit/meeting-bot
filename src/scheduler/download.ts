import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RequestHandler } from 'express';
import { Readable } from 'node:stream';
import type { SchedulerConfig, StoredRecording } from './types';

export interface RecordingStorageResponse {
  ContentLength?: number;
  ContentType?: string;
  ETag?: string;
  LastModified?: Date;
  VersionId?: string;
  Body?: unknown;
}
export interface RecordingStorageClient {
  send(command: HeadObjectCommand | GetObjectCommand, options?: { abortSignal?: AbortSignal }): Promise<RecordingStorageResponse>;
}
export interface DownloadDependencies {
  config: Pick<SchedulerConfig, 's3'>;
  getRecording(botId: string): Promise<StoredRecording | undefined | null>;
  s3?: RecordingStorageClient;
}

type ByteRange = { start: number; end: number };
function parseRange(header: string | undefined, size: number): ByteRange | 'malformed' | 'unsatisfiable' | undefined {
  if (!header) return;
  const match = /^bytes=(.+)$/.exec(header);
  if (!match) return 'malformed';
  const parts = match[1].split(',').map(part => part.trim());
  const ranges: ByteRange[] = [];
  for (const part of parts) {
    const bounds = /^(\d*)-(\d*)$/.exec(part);
    if (!bounds || (!bounds[1] && !bounds[2])) return 'malformed';
    const first = bounds[1] ? Number(bounds[1]) : undefined;
    const last = bounds[2] ? Number(bounds[2]) : undefined;
    if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return 'malformed';
    if (first !== undefined && last !== undefined && first > last) return 'malformed';
    const start = first === undefined ? Math.max(0, size - (last ?? 0)) : first;
    const end = first === undefined || last === undefined ? size - 1 : Math.min(last, size - 1);
    if (size === 0 || start >= size || (first === undefined && last === 0)) {
      if (parts.length === 1) return 'unsatisfiable';
    } else ranges.push({ start, end });
  }
  // A syntactically valid multipart request falls back to a full object.
  return parts.length === 1 ? ranges[0] : undefined;
}
function matchesIfRange(value: string | undefined, etag?: string, modified?: Date): boolean {
  if (!value) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return !value.startsWith('W/') && value === etag;
  const instant = Date.parse(value);
  return Number.isFinite(instant) && !!modified && Math.floor(modified.getTime() / 1000) <= Math.floor(instant / 1000);
}
function storageStatus(error: unknown): number {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404 ? 404 : status === 403 || status === 401 ? 502 : 503;
}

/** Mounted only after the dashboard session guard; object locations never come from the request. */
export function createRecordingDownloadHandler({ config, getRecording, s3 }: DownloadDependencies): RequestHandler {
  const client = s3 ?? new S3Client({
    region: config.s3.region, endpoint: config.s3.endpoint, forcePathStyle: config.s3.forcePathStyle,
    credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  });
  return async (req, res) => {
    const abort = new AbortController();
    let upstream: Readable | undefined;
    const disconnect = () => { abort.abort(); upstream?.destroy(); };
    res.once('close', disconnect);
    try {
      const recording = await getRecording(req.params.botId);
      const location = recording?.storage;
      if (!recording || recording.locationConflict || location?.provider !== 's3' || location.bucket !== config.s3.bucket || !location.key || /[\u0000-\u001f]/.test(location.key)) {
        res.status(404).send('Recording location unavailable'); return;
      }
      const base = { Bucket: config.s3.bucket, Key: location.key };
      for (let attempt = 0; attempt < 2; attempt++) {
        const metadata = await client.send(new HeadObjectCommand(base), { abortSignal: abort.signal });
        const size = metadata.ContentLength;
        if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw Error('Invalid object size');
        const modified = metadata.LastModified instanceof Date ? metadata.LastModified : undefined;
        const etag = typeof metadata.ETag === 'string' ? metadata.ETag : undefined;
        let range: ByteRange | undefined;
        if (req.method !== 'HEAD') {
          let parsedRange = parseRange(req.get('Range'), size);
          if (parsedRange === 'malformed') { res.status(400).send('Malformed byte range'); return; }
          if (!matchesIfRange(req.get('If-Range'), etag, modified)) parsedRange = undefined;
          if (parsedRange === 'unsatisfiable') { res.set('Content-Range', `bytes */${size}`).status(416).end(); return; }
          range = parsedRange;
        }
        let object;
        if (req.method !== 'HEAD') {
          // Pin the body to the metadata used for range calculations, including on unversioned stores.
          if ((!metadata.VersionId || metadata.VersionId === 'null') && !etag) throw Error('Object validator unavailable');
          try {
            object = await client.send(new GetObjectCommand({ ...base, ...(metadata.VersionId ? { VersionId: metadata.VersionId } : {}), ...(etag ? { IfMatch: etag } : {}), ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }), { abortSignal: abort.signal });
          } catch (error) {
            if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412 && attempt === 0) continue;
            throw error;
          }
          if (!(object.Body instanceof Readable)) throw Error('Object body unavailable');
          upstream = object.Body;
          const expectedLength = range ? range.end - range.start + 1 : size;
          if (object.ContentLength !== expectedLength || (etag && etag !== object.ETag)) throw Error('Object changed during download');
        }
        const safeId = recording.recordingId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'recording';
        const contentType = metadata.ContentType || recording.contentType || 'application/octet-stream';
        const extension = contentType.split(';')[0].trim().toLowerCase() === 'video/webm' ? 'webm' : contentType.split(';')[0].trim().toLowerCase() === 'video/mp4' ? 'mp4' : 'bin';
        res.status(range ? 206 : 200).set({
          'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
          'Content-Type': contentType,
          'Content-Length': String(range ? range.end - range.start + 1 : size),
          'Content-Disposition': `attachment; filename="recording-${safeId}.${extension}"`,
        });
        if (etag) res.set('ETag', etag);
        if (modified) res.set('Last-Modified', modified.toUTCString());
        if (range) res.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
        if (req.method === 'HEAD') { res.end(); return; }
        if (!upstream) throw Error('Object body unavailable');
        const bodyStream = upstream;
        let streamedBytes = 0;
        const expectedBytes = range ? range.end - range.start + 1 : size;
        bodyStream.on('data', (chunk: Buffer) => { streamedBytes += chunk.length; });
        bodyStream.once('end', () => { if (streamedBytes !== expectedBytes) res.destroy(); });
        bodyStream.once('close', () => { if (!bodyStream.readableEnded && !res.writableEnded) res.destroy(); });
        bodyStream.once('error', () => {
          if (res.headersSent) res.destroy();
          else { res.removeHeader('Content-Length'); res.removeHeader('Content-Range'); res.status(502).type('text').end('Recording storage unavailable'); }
        });
        // Node's pipe manages backpressure without buffering the recording in application memory.
        bodyStream.pipe(res);
        return;
      }
    } catch (error) {
      upstream?.destroy();
      if (!abort.signal.aborted && !res.headersSent) res.status(storageStatus(error)).type('text').send(storageStatus(error) === 404 ? 'Recording not found' : 'Recording storage unavailable');
      else if (!res.writableEnded) res.destroy();
    }
  };
}
