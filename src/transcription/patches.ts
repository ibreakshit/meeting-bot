import type { AppliedCorrection, CorrectionPatch, CorrectionProposal, CorrectionResult, OriginalTranscript } from './types';

const points = (text: string) => Array.from(text);
// Protect digits plus explicit English and Korean number words. Other language
// semantics still require the model-quality acceptance gate.
const protectedContent = (text: string) => text.match(/\p{N}+(?:[.,:]\p{N}+)*|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|no|not|never|cannot|[a-z]+n['’]t|without)\b|하나|둘|셋|넷|다섯|여섯|일곱|여덟|아홉|열|않\p{L}*|없\p{L}*|못\p{L}*|안(?=\s)/giu) || [];
export function validateAndApplyCorrections(original: OriginalTranscript, proposals: CorrectionProposal[]): CorrectionResult {
  const result: CorrectionResult = { segments: structuredClone(original.segments), applied: [], rejected: [], unresolved: [] };
  const segments = new Map(original.segments.map(segment => [segment.id, segment]));
  const candidates: CorrectionPatch[] = [];
  const ids = new Set<string>();
  for (const proposal of proposals) {
    result.unresolved.push(...proposal.unresolved);
    for (const patch of proposal.patches) {
      const segment = segments.get(patch.segmentId);
      let reason: string | undefined;
      if (proposal.sourceHash !== original.sourceHash) reason = 'Stale source hash';
      else if (!segment) reason = 'Unknown source segment';
      else if (!Number.isSafeInteger(patch.start) || !Number.isSafeInteger(patch.end) || patch.start < 0 || patch.end <= patch.start || patch.end > points(segment.text).length) reason = 'Invalid source offsets';
      else if (points(segment.text).slice(patch.start, patch.end).join('') !== patch.original) reason = 'Source quote mismatch';
      else if (!patch.replacement.trim()) reason = 'Sentence removal or empty replacement';
      else if (!patch.evidence.length || patch.evidence.some(evidence => !evidence.quote || !segments.get(evidence.segmentId)?.text.includes(evidence.quote))) reason = 'Evidence quote mismatch';
      else if (proposal.owned && !proposal.owned.some(range => range.segmentId === patch.segmentId && patch.start >= range.start && patch.end <= range.end)) reason = 'Outside chunk ownership';
      else if (ids.has(patch.id)) reason = 'Duplicate patch ID';
      if (reason) { result.rejected.push({ patch, reason }); continue; }
      ids.add(patch.id);
      const removedSentence = (patch.original.match(/[.!?。！？]/gu) || []).length > (patch.replacement.match(/[.!?。！？]/gu) || []).length;
      if (removedSentence || JSON.stringify(protectedContent(patch.original)) !== JSON.stringify(protectedContent(patch.replacement))) {
        result.unresolved.push({ segmentId: patch.segmentId, start: patch.start, end: patch.end, reason: 'Numerical or negation change requires review' }); continue;
      }
      candidates.push(patch);
    }
  }
  const accepted = candidates.filter(patch => {
    const overlaps = candidates.some(other => other !== patch && other.segmentId === patch.segmentId && patch.start < other.end && other.start < patch.end);
    if (overlaps) result.rejected.push({ patch, reason: 'Overlapping source edits' });
    return !overlaps;
  });
  for (const segment of result.segments) {
    const edits = accepted.filter(patch => patch.segmentId === segment.id).sort((a, b) => a.start - b.start);
    let shift = 0;
    for (const patch of edits) {
      const start = patch.start + shift;
      result.applied.push({ ...patch, correctedRange: { segmentId: segment.id, start, end: start + points(patch.replacement).length } } as AppliedCorrection);
      shift += points(patch.replacement).length - (patch.end - patch.start);
    }
    const text = points(segment.text);
    for (const patch of edits.reverse()) text.splice(patch.start, patch.end - patch.start, ...points(patch.replacement));
    segment.text = text.join('');
    // These are display segments only. Changed text must be freshly aligned.
    if (edits.length) segment.words = [];
  }
  return result;
}
