export interface RecordingSource { botId: string; recordingId: string; bucket: string; key: string }
export interface SourceFingerprint { sha256: string; etag?: string; versionId?: string }
export interface TranscriptJob { jobId: string; source: RecordingSource; attempt: number; requestedAt: number }
export interface ClaimedTranscriptJob extends TranscriptJob { token: string; leaseExpiry: number }
export interface TranscriptWord { word: string; start?: number; end?: number; speaker?: string; score?: number }
export interface TranscriptSegment { id: string; start?: number; end?: number; text: string; speaker?: string; words: TranscriptWord[] }
export interface CorrectionPatch {
  id: string; segmentId: string; start: number; end: number; original: string; replacement: string;
  evidence: { segmentId: string; quote: string }[];
}
export interface AppliedCorrection extends CorrectionPatch { correctedRange: { segmentId: string; start: number; end: number } }
export interface UnresolvedSpan { segmentId: string; start: number; end: number; reason: string }
export type TranscriptVersion = 'original' | 'corrected';
export type TranscriptFormat = 'json' | 'txt' | 'srt' | 'vtt';
export interface ArtifactManifest {
  warnings?: string[];
  revisionId: string; sourceHash: string; keys: Record<TranscriptFormat | 'display' | 'diarization', string> & { runtime?: string; audit?: string };
  hashes: Record<string, string>;
}
export interface TranscriptManifest extends TranscriptJob {
  schemaVersion: 1; originalState: 'queued' | 'running' | 'ready' | 'failed';
  correctionState: 'pending' | 'running' | 'ready' | 'failed' | 'skipped';
  fingerprint?: SourceFingerprint;
  original?: ArtifactManifest; latestCorrection?: ArtifactManifest;
  revisions: ArtifactManifest[]; warnings: string[]; error?: string; nextAttemptAt?: number;
}
export interface TranscriptView {
  originalState: TranscriptManifest['originalState']; correctionState: TranscriptManifest['correctionState'];
  correctedAvailable?: boolean;
  selectedVersion: TranscriptVersion; selectedRevision?: string; fallback: boolean;
  segments: TranscriptSegment[]; corrections: AppliedCorrection[]; warnings: string[]; error?: string;
}
export interface OriginalTranscript { sourceHash: string; language: string; segments: TranscriptSegment[] }
export interface OwnedRange { segmentId: string; start: number; end: number }
export interface CorrectionProposal { sourceHash: string; patches: CorrectionPatch[]; unresolved: UnresolvedSpan[]; owned?: OwnedRange[] }
export interface CorrectionResult { segments: TranscriptSegment[]; applied: AppliedCorrection[]; rejected: { patch: CorrectionPatch; reason: string }[]; unresolved: UnresolvedSpan[] }
export interface CorrectionChunk { sourceHash: string; owned: OwnedRange[]; messages: { role: string; content: string }[]; tokenCount: number }
export interface CorrectionBudget { contextTokens: number; completionTokens: number; safetyTokens: number; countTokens: (formattedMessages: string) => Promise<number> }
