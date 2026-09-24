/**
 * Per-model token pricing — used ONLY for the LIVE cost ESTIMATE shown while a
 * review runs (accumulated from each turn's usage). The PERSISTED cost of a
 * finished run comes from the SDK's authoritative `total_cost_usd`, not this table,
 * so a price drift here only nudges the running estimate, never the recorded number.
 *
 * Rates are USD per MILLION tokens, standard tier (≤200K context). Cache write is
 * the 5-minute rate (1.25× input); cache read is 0.1× input — except Opus 5.5, whose
 * cache read is 0.05× input ($0.20 on a $4 input). Keep in sync with
 * https://docs.anthropic.com/en/docs/about-claude/pricing if a model is re-priced.
 */
import type { ClaudeReviewModel } from '@pierre-review/shared';
import type { UsageTokens } from './usage.js';

interface Rate {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

const RATES: Record<ClaudeReviewModel, Rate> = {
  // Opus 5.5 — the Claude Review default. $4 in / $20 out; cache write $5 (1.25×), read $0.20.
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Sonnet 5 (≤200K tier) — Sonnet pricing, near-Opus quality. AI Fix's default model.
  'claude-sonnet-5': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  // Opus 4.8 (≤200K tier). No longer offered; kept so a stored run's estimate still prices.
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

/** A running USD estimate from accumulated turn usage. Falls back to Sonnet rates. */
export function estimateCostUsd(
  model: ClaudeReviewModel,
  u: UsageTokens,
): number {
  const r = RATES[model] ?? RATES['claude-sonnet-5'];
  return (
    (u.inputTokens * r.input +
      u.outputTokens * r.output +
      u.cacheReadTokens * r.cacheRead +
      u.cacheCreationTokens * r.cacheWrite) /
    1_000_000
  );
}
