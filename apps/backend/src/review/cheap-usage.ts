// A CHEAP COMPLETION'S LEDGER FACTS (review/llm.ts `cheapComplete`). Pure and import-free, so every
// caller (core and platform) can price a result without loading the provider registry.
import type { CheapCompleteResult } from './llm.js';

/** One cheap completion's ledger facts, ready for `recordAiUsage`. */
export interface CheapUsage {
  provider: 'claude' | 'codex';
  model: string;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * The ONE place a cheap completion becomes a ledger row's facts. A CODEX answer keeps what Codex
 * reported — its provider, its model, its own US$ (0 on a login), and its tokens (null when unknown,
 * never 0), so the budget's token-weighted share reads a Codex row; a CLAUDE answer is priced by the
 * caller at the model it asked for, as before. Never a Claude price on a Codex row.
 */
export function cheapUsage(
  out: CheapCompleteResult,
  claudeModel: string,
  claudeCostUsd: (inputTokens: number, outputTokens: number) => number,
): CheapUsage {
  if (out.provider === 'codex') {
    return {
      provider: 'codex',
      model: out.model ?? 'codex',
      costUsd: out.costUsd ?? 0,
      inputTokens: out.usage?.inputTokens ?? null,
      outputTokens: out.usage?.outputTokens ?? null,
    };
  }
  const inputTokens = out.usage?.inputTokens ?? 0;
  const outputTokens = out.usage?.outputTokens ?? 0;
  return { provider: 'claude', model: claudeModel, costUsd: claudeCostUsd(inputTokens, outputTokens), inputTokens, outputTokens };
}
