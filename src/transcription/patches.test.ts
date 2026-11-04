import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAndApplyCorrections } from './patches';
import type { CorrectionPatch, OriginalTranscript } from './types';
const original: OriginalTranscript = { sourceHash: 'hash', language: 'en', segments: [{ id: 's1', text: '😀 한국 gloomit and gloomit', words: [] }, { id: 's2', text: 'Google Meet', words: [] }] };
const patch: CorrectionPatch = { id: 'p1', segmentId: 's1', start: 5, end: 12, original: 'gloomit', replacement: 'Google Meet', evidence: [{ segmentId: 's2', quote: 'Google Meet' }] };
function apply(patches: CorrectionPatch[], sourceHash = 'hash') { return validateAndApplyCorrections(original, [{ sourceHash, patches, unresolved: [] }]); }
test('code-point offsets preserve emoji, Korean and repeated phrases with exact corrected ranges', () => {
  const before = JSON.stringify(original); const result = apply([patch]);
  assert.equal(result.segments[0].text, '😀 한국 Google Meet and gloomit');
  assert.deepEqual(result.applied[0].correctedRange, { segmentId: 's1', start: 5, end: 16 });
  assert.equal(JSON.stringify(original), before);
});
test('two replacements derive ranges in ascending output order', () => {
  const result = apply([patch, { ...patch, id: 'p2', start: 17, end: 24 }]);
  assert.equal(result.segments[0].text, '😀 한국 Google Meet and Google Meet');
  assert.equal(result.applied[1].correctedRange.start, 21);
});
for (const [label, update] of Object.entries({ missing: { segmentId: 'missing' }, offset: { start: 6 }, empty: { replacement: '' }, evidence: { evidence: [{ segmentId: 's2', quote: 'not there' }] }, removal: { replacement: ' ' } })) {
  test(`rejects ${label} without modifying source`, () => { const result = apply([{ ...patch, ...update }]); assert.equal(result.applied.length, 0); assert.equal(result.segments[0].text, original.segments[0].text); });
}
test('stale hash rejects all edits', () => { assert.equal(apply([patch], 'stale').applied.length, 0); });
test('overlap rejects every conflicting edit rather than choosing model order', () => {
  const result = apply([patch, { ...patch, id: 'p2' }]); assert.equal(result.applied.length, 0); assert.equal(result.rejected.length, 2);
});
test('numerical and negation changes are unresolved', () => {
  for (const replacement of ['Google Meet 2', 'not Google Meet', '안 Google Meet']) {
    const result = apply([{ ...patch, replacement }]); assert.equal(result.applied.length, 0); assert.equal(result.unresolved.length, 1);
  }
});
test('preserves contracted English and Korean negation and rejects sentence removal', () => {
  for (const [text, replacement] of [['I didn\'t agree.', 'I did agree.'], ['I haven’t agreed.', 'I have agreed.'], ['동의하지 않았어요.', '동의했어요.'], ['Hello. Delete this sentence.', 'Hello.']]) {
    const source: OriginalTranscript = { sourceHash: 'hash', language: 'en', segments: [{ id: 's', text, words: [] }] };
    const result = validateAndApplyCorrections(source, [{ sourceHash: 'hash', unresolved: [], patches: [{ id: 'p', segmentId: 's', start: 0, end: Array.from(text).length, original: text, replacement, evidence: [{ segmentId: 's', quote: text }] }] }]);
    assert.equal(result.applied.length, 0, text);
  }
});
test('spelled-out numerical content is preserved', () => {
  const text = 'twenty';
  const result = validateAndApplyCorrections({ sourceHash: 'hash', language: 'en', segments: [{ id: 's', text, words: [] }] }, [{ sourceHash: 'hash', unresolved: [], patches: [{ id: 'p', segmentId: 's', start: 0, end: 6, original: text, replacement: 'thirty', evidence: [{ segmentId: 's', quote: text }] }] }]);
  assert.equal(result.applied.length, 0);
});
