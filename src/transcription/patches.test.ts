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
