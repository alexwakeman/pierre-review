// The LIVE cost estimate's price table (the persisted cost is the SDK's own figure). Sonnet 5 is
// deliberately NOT pinned here: the plugin's llm/seam.ts carries its own copy of that price, and
// the two must move together if it ever changes.
import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.js';

const M = 1_000_000;
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

describe('estimateCostUsd', () => {
  it('prices Opus 5.5 at $4 in / $20 out / $0.20 cache read / $5 cache write per MTok', () => {
    expect(estimateCostUsd('claude-opus-5-5', { ...zero, inputTokens: M })).toBeCloseTo(4, 10);
    expect(estimateCostUsd('claude-opus-5-5', { ...zero, outputTokens: M })).toBeCloseTo(20, 10);
    expect(estimateCostUsd('claude-opus-5-5', { ...zero, cacheReadTokens: M })).toBeCloseTo(0.2, 10);
    expect(estimateCostUsd('claude-opus-5-5', { ...zero, cacheCreationTokens: M })).toBeCloseTo(5, 10);
  });

  it('still prices a stored Opus 4.8 run', () => {
    expect(estimateCostUsd('claude-opus-4-8', { ...zero, inputTokens: M, outputTokens: M })).toBeCloseTo(30, 10);
  });
});
