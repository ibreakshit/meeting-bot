import type { Request, RequestHandler } from 'express';
import { transcriptJobId } from '../transcription/queue';
import type { TranscriptQueue } from '../transcription/queue';
import type { TranscriptStorage } from '../transcription/storage';
import type { AppliedCorrection, TranscriptFormat, TranscriptSegment, TranscriptVersion, TranscriptView } from '../transcription/types';
import type { StoredRecording } from './types';

interface TranscriptDependencies {
  bucket: string; getRecording(botId: string): Promise<StoredRecording | undefined | null>;
  transcriptQueue: Pick<TranscriptQueue, 'get'>; transcriptStorage: Pick<TranscriptStorage, 'readArtifact'>;
}
function validateDisplay(value: unknown): { segments: TranscriptSegment[]; corrections: AppliedCorrection[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid transcript display');
  const display = value as { segments: TranscriptSegment[]; corrections?: AppliedCorrection[] };
  if (!Array.isArray(display.segments) || display.segments.length > 100000) throw new Error('Invalid transcript segments');
  const ids = new Set<string>();
  const segments = display.segments.map(segment => {
    if (!segment || typeof segment.id !== 'string' || ids.has(segment.id) || typeof segment.text !== 'string' || !Array.isArray(segment.words)) throw new Error('Invalid transcript segment');
    ids.add(segment.id);
    const timing = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    return { id: segment.id, text: segment.text, start: timing(segment.start), end: timing(segment.end), speaker: typeof segment.speaker === 'string' ? segment.speaker : undefined, words: [] };
  });
  const corrections = (display.corrections || []).map(patch => {
    const range = patch.correctedRange;
    const segment = segments.find(item => item.id === range?.segmentId);
    if (!segment || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > Array.from(segment.text).length || typeof patch.original !== 'string' || typeof patch.replacement !== 'string' || Array.from(segment.text).slice(range.start, range.end).join('') !== patch.replacement) throw new Error('Invalid correction display range');
    return { id: patch.id, segmentId: patch.segmentId, start: patch.start, end: patch.end, original: patch.original, replacement: patch.replacement, evidence: [], correctedRange: range };
  });
  return { segments, corrections };
}
export function createTranscriptHandlers(deps: TranscriptDependencies): { view: RequestHandler; download: RequestHandler } {
  async function lookup(req: Request) {
    const version = req.query.version || 'corrected';
    if (version !== 'original' && version !== 'corrected') return { status: 400 };
    const recording = await deps.getRecording(req.params.botId);
    const location = recording?.storage;
    if (!recording || recording.locationConflict || location?.provider !== 's3' || location.bucket !== deps.bucket || !location.key) return { status: 404 };
    const manifest = await deps.transcriptQueue.get(transcriptJobId({ botId: req.params.botId, recordingId: recording.recordingId, bucket: deps.bucket, key: location.key }));
    if (!manifest) return { status: 404 };
    const corrected = version === 'corrected' && manifest.latestCorrection;
    return { status: 200, manifest, selected: corrected || manifest.original, version: (corrected ? 'corrected' : 'original') as TranscriptVersion, fallback: version === 'corrected' && !corrected };
  }
  const view: RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      const found = await lookup(req);
      if (!found.manifest) { res.status(found.status).json({ error: found.status === 400 ? 'Invalid transcript version' : 'Transcript unavailable' }); return; }
      const { manifest, selected } = found;
      const display = selected ? validateDisplay(JSON.parse((await deps.transcriptStorage.readArtifact(selected, 'display')).toString('utf8'))) : { segments: [], corrections: [] };
      const result: TranscriptView = { correctedAvailable: Boolean(manifest.latestCorrection), originalState: manifest.originalState, correctionState: manifest.correctionState, selectedVersion: found.version || 'original', selectedRevision: selected?.revisionId,
        fallback: Boolean(found.fallback), segments: display.segments, corrections: found.version === 'corrected' ? display.corrections : [], warnings: manifest.warnings, error: manifest.error };
      res.json(result);
    } catch { res.status(503).json({ error: 'Transcript retrieval failed' }); }
  };
  const download: RequestHandler = async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const format = req.query.format || 'txt';
    if (!['json', 'txt', 'srt', 'vtt'].includes(String(format)) || typeof format !== 'string') { res.status(400).send('Invalid transcript format'); return; }
    try {
      const found = await lookup(req);
      // Downloads never silently substitute original content for corrected.
      if (!found.selected || found.fallback) { res.status(found.status === 400 ? 400 : 404).send('Selected transcript unavailable'); return; }
      const bytes = await deps.transcriptStorage.readArtifact(found.selected, format as TranscriptFormat);
      const contentTypes = { json: 'application/json', txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt' };
      res.set({ 'Content-Type': contentTypes[format as TranscriptFormat] + '; charset=utf-8', 'Content-Disposition': `attachment; filename="transcript-${found.version}.${format}"`, 'X-Content-Type-Options': 'nosniff' }).send(bytes);
    } catch { res.status(503).send('Transcript download unavailable'); }
  };
  return { view, download };
}
