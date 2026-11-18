import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareCorrectionChunks, proposeCorrections } from './correction';
import type { OriginalTranscript } from './types';
const original: OriginalTranscript = { sourceHash: 'hash', language: 'en', segments: [{ id: 'a', text: 'gloomit', speaker: 's1', words: [] }, { id: 'b', text: 'Google Meet', speaker: 's2', words: [] }] };
const budget = { contextTokens: 8192, completionTokens: 2048, safetyTokens: 512, countTokens: async (text: string) => Array.from(text).length };
test('fitting conversation uses one chunk; context and output reserves are counted', async () => {
  const chunks = await prepareCorrectionChunks(original, budget); assert.equal(chunks.length, 1); assert.equal(chunks[0].owned.length, 2);
});
test('oversized segment splits into reversible owned code-point ranges', async () => {
  const long = { ...original, segments: [{ id: 'a', text: '😀한국'.repeat(1500), words: [] }] };
  const chunks = await prepareCorrectionChunks(long, { ...budget, contextTokens: 4500 });
  assert.ok(chunks.length > 1);
  const ranges = chunks.flatMap(chunk => chunk.owned);
  assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1)?.end, Array.from(long.segments[0].text).length);
  ranges.slice(1).forEach((range, index) => assert.equal(range.start, ranges[index].end));
});
test('tokenizer failure aborts instead of guessing', async () => {
  await assert.rejects(prepareCorrectionChunks(original, { ...budget, countTokens: async () => { throw new Error('tokenizer unavailable'); } }), /tokenizer/);
});
test('malformed or truncated output is never salvaged; requests enable reasoning', async () => {
  const [chunk] = await prepareCorrectionChunks(original, budget);
  let request: Record<string, unknown> = {};
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"patches":[]}' } }], usage: { prompt_tokens: chunk.tokenCount } }));
  };
  await assert.rejects(proposeCorrections(chunk, new AbortController().signal, { fetcher: fetcher as typeof fetch }), /incomplete/);
  assert.equal(request.temperature, 0); assert.equal(request.reasoning_budget_tokens, 512);
  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true });
});

test('latency budget splits a conversation even when it fits the model context', async () => {
  const source = { ...original, segments: Array.from({ length: 12 }, (_, index) => ({ id: `s${index}`, text: 'Discussion about a project. '.repeat(12), words: [] })) };
  const chunks = await prepareCorrectionChunks(source, { ...budget, maxInputTokens: 2400 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.tokenCount <= 2400));
  assert.deepEqual(chunks.flatMap(chunk => chunk.owned).filter(range => range.start === 0).map(range => range.segmentId), source.segments.map(segment => segment.id));
});

test('shared meeting summary is included and budgeted in every chunk without owning its evidence', async () => {
  const source = { ...original, segments: Array.from({ length: 10 }, (_, index) => ({ id: `s${index}`, text: 'Project details. '.repeat(30), words: [] })) };
  const summary = { summary: 'The meeting discusses a project.', evidence: [{ segmentId: 's0', quote: 'Project details.' }] };
  const chunks = await prepareCorrectionChunks(source, { ...budget, maxInputTokens: 2700 }, summary);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.deepEqual(JSON.parse(chunk.messages[1].content).contextSummary, summary);
    assert.ok(chunk.tokenCount <= 2700);
  }
  assert.ok(chunks.some(chunk => !chunk.owned.some(range => range.segmentId === 's0')));
});

test('correction requests allow bounded configured time and still honor cancellation', async () => {
  const [chunk] = await prepareCorrectionChunks(original, budget);
  let requestSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requestSignal = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true }));
  };
  const pending = proposeCorrections(chunk, controller.signal, { fetcher: fetcher as typeof fetch, timeoutMs: 20 });
  // Keep the process alive while the unref'ed AbortSignal timeout expires.
  const keepAlive = setTimeout(() => undefined, 1000);
  try { await assert.rejects(pending, /timeout/i); assert.equal(requestSignal?.aborted, true); }
  finally { clearTimeout(keepAlive); controller.abort(); }
});

test('adaptive split preserves Unicode source ownership and shared context', async () => {
  const { splitCorrectionChunk } = await import('./correction');
  const source = { ...original, segments: [{ id: 'a', text: '😀한국어 '.repeat(80), words: [] }] };
  const summary = { summary: 'Korean discussion', evidence: [{ segmentId: 'a', quote: '한국어' }] };
  const [parent] = await prepareCorrectionChunks(source, budget, summary);
  const children = await splitCorrectionChunk(source, parent, budget, summary);
  assert.equal(children.length, 2);
  const ranges = children.flatMap(child => child.owned);
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[0].end, ranges[1].start);
  assert.equal(ranges[1].end, Array.from(source.segments[0].text).length);
  for (const child of children) {
    assert.ok(child.tokenCount < parent.tokenCount);
    const input = JSON.parse(child.messages[1].content);
    assert.deepEqual(input.contextSummary, summary);
    assert.equal(input.segments[0].text, Array.from(source.segments[0].text).slice(child.owned[0].start, child.owned[0].end).join(''));
  }
});
