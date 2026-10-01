// Per-model Agent SDK options for the agentic runs (Claude Review, AI Fix). ONE table, read by
// `review/agent.ts` and `coding/agent.ts` — both used to carry their own copy of the
// effort-capable set, which is how a new model gets its effort in one path and silently not in
// the other.
//
// No SDK import here: this is plain data, reached only from the dynamically imported agents.
//
// ⚠ CLAUDE OPUS 5.5 REFUSES THREE REQUEST SHAPES WITH AN HTTP 400:
//   * `thinking: { type: 'disabled' }` — its thinking cannot be switched off;
//   * a thinking BUDGET (`budget_tokens`, i.e. the SDK's `thinking: {type:'enabled', budgetTokens}`
//     or the deprecated `maxThinkingTokens`);
//   * a FORCED `tool_choice` ('any' / 'tool').
// Nothing in the review, coding or llm call paths sends any of them (the review relies on the
// model CHOOSING `submit_review`; tool choice stays auto). Keep it that way. For Opus 5.5 we pass
// `thinking: { type: 'adaptive' }` explicitly, which also overrides a `MAX_THINKING_TOKENS=0` the
// environment might carry into the SDK's child process.
//
// ⚠ EFFORT IS PASSED EXPLICITLY FOR OPUS 5.5, AND IT IS PINNED TO 'medium' ON EVERY PATH — a
// product decision: the diff-only 'low' default that suits Sonnet 5 is not used for it, and
// REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT do not move it. (Its API default is also 'medium', but
// we never rely on an API default staying put.) This pin is also what makes AI Fix's default,
// `DEFAULT_AI_FIX_MODEL` (packages/shared), "Opus 5.5 on medium": the fixer runs through
// coding/agent.ts → sdkModelOptions(model, 'worktree'), and nothing else sets its effort.
import { config, type ReviewEffort } from '../config.js';

// Models that accept the `effort` option. Haiku 4.5 rejects it (the API 400s), so it runs
// without an effort hint — its low per-token price is its cost lever instead. The old Opus 4.8
// left this set with the rest of its entries: nothing can start a run on it (both generate
// routes 400 a model outside the offered list), so nothing here needs to know it.
export const EFFORT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

// Models whose effort is PINNED regardless of mode or env (see the header).
export const PINNED_EFFORT: Readonly<Record<string, ReviewEffort>> = { 'claude-opus-5-5': 'medium' };

// Models that are always given `thinking: { type: 'adaptive' }` (see the header).
export const ALWAYS_ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5']);

export interface SdkModelOptions {
  effort?: ReviewEffort;
  thinking?: { type: 'adaptive' };
}

/**
 * The model-dependent `query()` options for one run. `mode` picks the effort: a diff-only review
 * uses `config.reviewDiffOnlyEffort` (low by default), everything else `config.reviewEffort`
 * (medium by default), unless the model's effort is PINNED. A model outside both sets gets `{}`.
 */
export function sdkModelOptions(model: string, mode: 'diff_only' | 'worktree'): SdkModelOptions {
  const out: SdkModelOptions = {};
  if (EFFORT_CAPABLE_MODELS.has(model)) {
    out.effort =
      PINNED_EFFORT[model] ?? (mode === 'diff_only' ? config.reviewDiffOnlyEffort : config.reviewEffort);
  }
  if (ALWAYS_ADAPTIVE_THINKING_MODELS.has(model)) out.thinking = { type: 'adaptive' };
  return out;
}
