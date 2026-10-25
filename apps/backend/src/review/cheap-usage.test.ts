// A cheap completion's LEDGER FACTS (review/cheap-usage.ts, platform/llm/seam.ts): a Codex answer is
// never priced at a Claude rate and its row says 'codex' with Codex's model; a Claude answer is priced
// by the caller exactly as before.
import { describe, expect, it } from 'vitest';
import { makeHaikuClient, makeReportClient } from '../platform/llm/seam.js';
import type { ProContext } from '../platform/contract.js';
import { cheapUsage } from './cheap-usage.js';

const price = (i: number, o: number): number => i * 1 + o * 10;

describe('cheapUsage', () => {
  it('a Claude answer: the caller’s model and price', () => {
    expect(cheapUsage({ text: 'x', usage: { inputTokens: 3, outputTokens: 2 } }, 'claude-haiku-5-5', price)).toEqual({
      provider: 'claude',
      model: 'claude-haiku-5-5',
      costUsd: 23,
      inputTokens: 3,
      outputTokens: 2,
    });
  });
  it('a Codex answer: Codex’s provider, model and own US$ — never the Claude price', () => {
    expect(
      cheapUsage(
        { text: 'x', usage: { inputTokens: 3, outputTokens: 2 }, provider: 'codex', model: 'gpt-6-luna', costUsd: 0 },
        'claude-haiku-5-5',
        price,
      ),
    ).toEqual({ provider: 'codex', model: 'gpt-6-luna', costUsd: 0, inputTokens: 3, outputTokens: 2 });
    // Unknown tokens stay unknown (null), never 0.
    expect(cheapUsage({ text: 'x', provider: 'codex', model: 'gpt-6-luna' }, 'm', price)).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: 0 });
  });
});

describe('the platform LlmClient', () => {
  const ctxAnswering = (res: Awaited<ReturnType<ProContext['llm']['complete']>>): ProContext =>
    ({ llm: { complete: async () => res, detectAuth: () => ({ status: 'ok' }) } }) as unknown as ProContext;

  it('a Codex answer keeps Codex’s US$, model and provider (Haiku and report clients alike)', async () => {
    const ctx = ctxAnswering({ text: 'hi', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, provider: 'codex', model: 'gpt-6-luna', costUsd: 0 });
    for (const client of [makeHaikuClient(ctx), makeReportClient(ctx, 'claude-haiku-5-5')]) {
      expect(await client.complete({ system: 's', user: 'u', maxTokens: 10 })).toEqual({
        text: 'hi',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        costUsd: 0,
        provider: 'codex',
        model: 'gpt-6-luna',
      });
    }
  });
  it('a Claude answer is priced at the Haiku rate, as before', async () => {
    const ctx = ctxAnswering({ text: 'hi', usage: { inputTokens: 10_000, outputTokens: 10_000 } });
    const out = await makeHaikuClient(ctx).complete({ system: 's', user: 'u', maxTokens: 10 });
    expect(out.provider).toBe('claude');
    expect(out.costUsd).toBeCloseTo(0.001 + 0.005, 9);
    expect(out.model).toBeUndefined();
  });
});
