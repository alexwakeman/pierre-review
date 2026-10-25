// THE PROVIDER OF ONE RUN — the small shared half of the ticket-review, card, CI-review and story-docs
// runners' Codex port (docs/CODEX-PLAN.md Phase 3 (c)). Each manager resolves the provider ONCE
// (`activeProviderId()`), words its prompts for it (ai/prompt-tools.ts) and hands the same id to the
// runner, so a run's prompt and the provider that runs it cannot disagree.
//
// What differs by provider, and only here:
//   • the Claude credential env tweak (`applyClaudeReviewAuth`) is Claude's — a Codex run builds its
//     own minimal environment (ai/providers/codex.ts) and must not touch ANTHROPIC_API_KEY;
//   • the LIVE US$ on the status line is Claude's price table over Claude tokens; a Codex run is US$ 0
//     on its ChatGPT sign-in (the only Codex route that runs), so its live figure is 0, never a Claude
//     price applied to another vendor's tokens;
//   • the LEDGER: the Codex provider records its own row (provider 'codex', its model, its tokens)
//     when handed `usageRecord`, so the manager's own recorder must not write a second one
//     (`ledgerByProvider`). On Claude nothing changes: the manager records, as it always has.
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { activeProviderId, getProvider, type AgentProvider, type AgentProviderId, type AgentTokens } from '../ai/provider.js';
import { estimateCostUsd } from './pricing.js';

/** The run's provider: the one the manager resolved, else the active one. */
export function runProvider(id?: AgentProviderId | null): AgentProvider {
  return getProvider(id ?? activeProviderId());
}

/** The live US$ for the status line (see the header). */
export function liveCostUsd(provider: AgentProvider, model: ClaudeReviewModel, usage: AgentTokens): number {
  return provider.id === 'claude' ? estimateCostUsd(model, usage) : 0;
}

/**
 * The run's whole US$ when the provider gave none (a run cut off before its outcome): Claude's estimate
 * from the live tokens, as before; null on any other provider (it never emitted a figure to estimate from).
 */
export function fallbackCostUsd(provider: AgentProvider, model: ClaudeReviewModel, usage: AgentTokens): number | null {
  const has = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  return provider.id === 'claude' && has ? estimateCostUsd(model, usage) : null;
}

/** Does the PROVIDER write this run's ledger row (so the manager must not)? */
export function ledgerByProvider(provider: AgentProvider): boolean {
  return provider.id !== 'claude';
}
