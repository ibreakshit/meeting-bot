import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCorrectionContext } from './context';
import type { CorrectionChunk, OriginalTranscript } from './types';

const source: OriginalTranscript = { sourceHash: 'source', language: 'en', segments: Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, text: `Topic ${index}: Project Atlas is mentioned.`, words: [] })) };
const chunks: CorrectionChunk[] = source.segments.map(segment => ({ sourceHash: 'source', owned: [{ segmentId: segment.id, start: 0, end: segment.text.length }], messages: [], tokenCount: 100 }));

test('bounded map and reduction summaries carry context from both ends of the meeting', async () => {
  const requests: { segments?: { id: string; text: string }[]; summaries?: { summary: string; evidence: { segmentId: string; quote: string }[] }[] }[] = [];
  const countTokens = async (text: string) => Math.ceil(text.length / 4);
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.ok(await countTokens(JSON.stringify(body.messages)) <= 650);
    const input = JSON.parse(body.messages[1].content); requests.push(input);
    const evidence = input.segments ? input.segments.map((segment: { id: string; text: string }) => ({ segmentId: segment.id, quote: segment.text })) : input.summaries.flatMap((summary: { evidence: unknown[] }) => summary.evidence);
    const selected = [evidence[0], evidence.at(-1)].filter((item, index, all) => item && all.indexOf(item) === index);
    const summary = { summary: 'Project Atlas context. '.repeat(30), sourceSegmentIds: selected.map(item => item.segmentId) };
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summary) } }], usage: { prompt_tokens: await countTokens(JSON.stringify(body.messages)) } }));
  };
  const result = await buildCorrectionContext(source, chunks, { countTokens, fetcher, signal: new AbortController().signal, inputTokens: 650 });
  assert.equal(requests.filter(request => request.segments).length, 8);
  assert.ok(requests.filter(request => request.summaries).length > 1);
  assert.ok(result.summary.evidence.some(item => item.segmentId === 's0'));
  assert.ok(result.summary.evidence.some(item => item.segmentId === 's7'));
});

test('summary references must belong to its supplied source and truncated summaries fail closed', async () => {
  for (const [finish, segmentId, expected] of [['stop', 'invented-segment', /evidence/], ['length', 's0', /incomplete/]] as const) {
    await assert.rejects(buildCorrectionContext(source, chunks.slice(0, 1), {
      countTokens: async () => 100, signal: new AbortController().signal,
      fetcher: async () => new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content: JSON.stringify({ summary: 'Context', sourceSegmentIds: [segmentId] }) } }], usage: { prompt_tokens: 100 } }))
    }), expected);
  }
});
