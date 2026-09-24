// Per-model Agent SDK options for the agentic runs (Claude Review, AI Fix, the conflict
// resolver). ONE table, read by `review/agent.ts` and `coding/agent.ts` — both used to carry
// their own copy of the effort-capable set, which is how a new model gets its effort in one path
// and silently not in the other.
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
// ⚠ EFFORT IS PASSED EXPLICITLY FOR OPUS 5.5. Its API default is 'medium' (one below Opus 5's
// 'high'), so leaving it unset would not mean "the same as the other models". It gets exactly the
// effort Sonnet 5 gets on the same path.
import { config, type ReviewEffort } from '../config.js';

// Models that accept the `effort` option. Haiku 4.5 rejects it (the API 400s), so it runs
// without an effort hint — its low per-token price is its cost lever instead. 'claude-opus-4-8'
// stays so a stored AI Fix row naming it can still re-run.
export const EFFORT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
]);

// Models that are always given `thinking: { type: 'adaptive' }` (see the header).
export const ALWAYS_ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5']);

export interface SdkModelOptions {
  effort?: ReviewEffort;
  thinking?: { type: 'adaptive' };
}

/**
 * The model-dependent `query()` options for one run. `mode` picks the effort: a diff-only review
 * uses `config.reviewDiffOnlyEffort` (low by default), everything else `config.reviewEffort`
 * (medium by default). A model outside both sets gets `{}`.
 */
export function sdkModelOptions(model: string, mode: 'diff_only' | 'worktree'): SdkModelOptions {
  const out: SdkModelOptions = {};
  if (EFFORT_CAPABLE_MODELS.has(model)) {
    out.effort = mode === 'diff_only' ? config.reviewDiffOnlyEffort : config.reviewEffort;
  }
  if (ALWAYS_ADAPTIVE_THINKING_MODELS.has(model)) out.thinking = { type: 'adaptive' };
  return out;
}
