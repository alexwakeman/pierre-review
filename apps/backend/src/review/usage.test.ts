import { describe, expect, it } from 'vitest';
import {
  readTurnUsage,
  recordUsage,
  sumModelUsage,
  sumUsageMap,
  type UsageTokens,
} from './usage.js';

// Build a streamed assistant message with the given per-request usage + ids.
function msg(
  usage: Partial<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  }>,
  ids: { request_id?: string; uuid?: string } = {},
): unknown {
  return { type: 'assistant', message: { usage }, ...ids };
}

const tally = (messages: unknown[]): UsageTokens => {
  const m = new Map<string, UsageTokens>();
  for (const x of messages) recordUsage(m, x);
  return sumUsageMap(m);
};

describe('readTurnUsage', () => {
  it('reads the four token fields, defaulting missing/invalid ones to 0', () => {
    expect(
      readTurnUsage(
        msg({ input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 9 }),
      ),
    ).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 9,
      cacheCreationTokens: 0,
    });
    // Garbage shapes never throw — they read as zeros.
    expect(readTurnUsage(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe('recordUsage + sumUsageMap (live tally de-duplication)', () => {
  it('sums distinct requests', () => {
    const t = tally([
      msg({ output_tokens: 100, cache_read_input_tokens: 1000 }, { request_id: 'r1' }),
      msg({ output_tokens: 200, cache_read_input_tokens: 2000 }, { request_id: 'r2' }),
    ]);
    expect(t.outputTokens).toBe(300);
    expect(t.cacheReadTokens).toBe(3000);
  });

  it('counts a request ONCE even when its usage is emitted twice (the ~2× bug)', () => {
    const u = { output_tokens: 200, cache_read_input_tokens: 5000 };
    const t = tally([
      msg(u, { request_id: 'r1', uuid: 'a' }),
      // same request, a second message (e.g. thinking vs text) — different uuid.
      msg(u, { request_id: 'r1', uuid: 'b' }),
    ]);
    expect(t.outputTokens).toBe(200);
    expect(t.cacheReadTokens).toBe(5000);
  });

  it('keeps the real usage when a later same-request message reports empty usage', () => {
    const t = tally([
      msg({ output_tokens: 200, cache_read_input_tokens: 5000 }, { request_id: 'r1' }),
      msg({}, { request_id: 'r1' }), // must not zero it out
    ]);
    expect(t.outputTokens).toBe(200);
    expect(t.cacheReadTokens).toBe(5000);
  });

  it('falls back to uuid, then position, when request_id is absent', () => {
    const u = { output_tokens: 50 };
    // Same uuid, no request_id → one request.
    expect(tally([msg(u, { uuid: 'x' }), msg(u, { uuid: 'x' })]).outputTokens).toBe(50);
    // No ids at all → positional fallback keeps them distinct (summed).
    expect(tally([msg(u), msg(u)]).outputTokens).toBe(100);
  });
});

describe('sumModelUsage (authoritative finished-run usage)', () => {
  it('sums across models from the result modelUsage', () => {
    const result = {
      total_cost_usd: 0.99,
      modelUsage: {
        'claude-sonnet-4-6': {
          inputTokens: 1000,
          outputTokens: 2000,
          cacheReadInputTokens: 1_340_000,
          cacheCreationInputTokens: 160_000,
          costUSD: 0.99,
        },
      },
    };
    expect(sumModelUsage(result)).toEqual({
      inputTokens: 1000,
      outputTokens: 2000,
      cacheReadTokens: 1_340_000,
      cacheCreationTokens: 160_000,
    });
  });

  it('returns null when modelUsage is absent', () => {
    expect(sumModelUsage({ total_cost_usd: 0.1 })).toBeNull();
    expect(sumModelUsage(null)).toBeNull();
  });
});
