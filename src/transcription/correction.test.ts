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
