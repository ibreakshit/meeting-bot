import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadTranscriptionConfig } from './config';
import type { CorrectionBudget, CorrectionChunk, CorrectionPatch, CorrectionProposal, OriginalTranscript, OwnedRange } from './types';

async function messagesFor(original: OriginalTranscript, owned: OwnedRange[], context: OwnedRange[] = []) {
  const prompt = await readFile(join(process.cwd(), 'src/transcription/prompts/correction.txt'), 'utf8');
  return [{ role: 'system', content: prompt }, { role: 'user', content: JSON.stringify({ sourceHash: original.sourceHash, language: original.language, owned,
    segments: [...context, ...owned].map(range => {
      const segment = original.segments.find(item => item.id === range.segmentId);
      if (!segment) throw new Error('Unknown correction source segment');
      return { id: segment.id, sourceStart: range.start, text: Array.from(segment.text).slice(range.start, range.end).join('') };
    }) }) }];
}
export async function prepareCorrectionChunks(original: OriginalTranscript, budget: CorrectionBudget): Promise<CorrectionChunk[]> {
  const limit = budget.contextTokens - budget.completionTokens - budget.safetyTokens;
  const make = async (owned: OwnedRange[], context: OwnedRange[] = []) => {
    const messages = await messagesFor(original, owned, context);
    const tokenCount = await budget.countTokens(JSON.stringify(messages));
    if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0) throw new Error('Invalid tokenizer response');
    return { sourceHash: original.sourceHash, owned, messages, tokenCount };
  };
  const ranges = original.segments.map(segment => ({ segmentId: segment.id, start: 0, end: Array.from(segment.text).length }));
  const full = await make(ranges);
  if (full.tokenCount <= limit) return [full];
  const chunks: CorrectionChunk[] = [];
  let owned: OwnedRange[] = [];
  for (const range of ranges) {
    if (!range.end) continue;
    const candidate = await make([...owned, range]);
    if (candidate.tokenCount <= limit) { owned.push(range); continue; }
    if (owned.length) { chunks.push(await make(owned)); owned = []; }
    let start = 0;
    while (start < range.end) {
      let low = start + 1, high = range.end, fitting: CorrectionChunk | undefined;
      while (low <= high) {
        const end = Math.floor((low + high) / 2);
        const part = await make([{ ...range, start, end }]);
        if (part.tokenCount <= limit) { fitting = part; low = end + 1; } else high = end - 1;
      }
      if (!fitting) throw new Error('Correction prompt exceeds tokenizer context budget');
      if (fitting.owned[0].end === range.end) owned = fitting.owned;
      else chunks.push(fitting);
      start = fitting.owned[0].end;
    }
  }
  if (owned.length) chunks.push(await make(owned));
  // Neighbor context is optional and never displaces the owned text.
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const first = ranges.findIndex(range => range.segmentId === chunk.owned[0].segmentId);
    const last = ranges.findIndex(range => range.segmentId === chunk.owned[chunk.owned.length - 1].segmentId);
    const neighbors = [ranges[first - 1], ranges[last + 1]].filter((range): range is OwnedRange => Boolean(range));
    const context: OwnedRange[] = [];
    for (const neighbor of neighbors) {
      const extended = await make(chunk.owned, [...context, neighbor]);
      if (extended.tokenCount <= limit) { context.push(neighbor); chunks[index] = extended; }
    }
  }
  return chunks;
}
function isPatch(value: unknown): value is CorrectionPatch {
  if (!value || typeof value !== 'object') return false;
  const p = value as CorrectionPatch;
  return ['id', 'segmentId', 'original', 'replacement'].every(key => typeof (value as Record<string, unknown>)[key] === 'string') && Number.isSafeInteger(p.start) && Number.isSafeInteger(p.end) && Array.isArray(p.evidence) && p.evidence.every(e => e && typeof e.segmentId === 'string' && typeof e.quote === 'string');
}
export async function proposeCorrections(chunk: CorrectionChunk, signal: AbortSignal, options: { fetcher?: typeof fetch; baseUrl?: string } = {}): Promise<CorrectionProposal> {
  const fetcher = options.fetcher || fetch;
  const response = await fetcher(`${options.baseUrl || loadTranscriptionConfig().gemmaUrl}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    body: JSON.stringify({ model: 'gemma-4-e4b-it-q6', messages: chunk.messages, temperature: 0, max_tokens: 2048,
      reasoning_budget_tokens: 512, chat_template_kwargs: { enable_thinking: true }, response_format: { type: 'json_object' } })
  });
  if (!response.ok) throw new Error('Correction service unavailable');
  const body = await response.json() as { choices?: { finish_reason: string; message: { content: string } }[]; usage?: { prompt_tokens: number } };
  if (body.choices?.length !== 1 || body.choices[0].finish_reason !== 'stop') throw new Error('Correction response incomplete');
  if (body.usage?.prompt_tokens !== chunk.tokenCount) throw new Error('Correction tokenizer usage mismatch');
  let proposal: CorrectionProposal;
  try { proposal = JSON.parse(body.choices[0].message.content) as CorrectionProposal; } catch { throw new Error('Invalid correction JSON'); }
  if (proposal.sourceHash !== chunk.sourceHash || !Array.isArray(proposal.patches) || !proposal.patches.every(isPatch) || !Array.isArray(proposal.unresolved) || !proposal.unresolved.every(span => span && typeof span.segmentId === 'string' && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && typeof span.reason === 'string')) throw new Error('Invalid correction schema');
  return { sourceHash: proposal.sourceHash, patches: proposal.patches, unresolved: proposal.unresolved, owned: chunk.owned };
}
export function localTokenCounter(baseUrl = loadTranscriptionConfig().gemmaUrl, signal = new AbortController().signal): CorrectionBudget['countTokens'] {
  const root = baseUrl.replace(/\/v1\/?$/, '');
  const post = async (path: string, value: unknown) => {
    const response = await fetch(`${root}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new Error('Local tokenizer unavailable');
    return response.json();
  };
  return async formatted => {
    const template = await post('/apply-template', { messages: JSON.parse(formatted), chat_template_kwargs: { enable_thinking: true }, add_generation_prompt: true }) as { prompt?: string };
    if (typeof template.prompt !== 'string') throw new Error('Local template contract unavailable');
    const tokenized = await post('/tokenize', { content: template.prompt, add_special: true }) as { tokens?: unknown[] };
    if (!Array.isArray(tokenized.tokens)) throw new Error('Local tokenizer contract unavailable');
    return tokenized.tokens.length;
  };
}
