// Per-model Agent SDK options for the agentic runs (Claude Review, AI Fix, …). ONE table, read by
// `ai/providers/claude.ts` for every run — the effort-capable set lives once here, so a new model
// cannot get its effort in one path and silently not in another.
//
// No SDK import here: this is plain data, reached only from the dynamically imported agents.
//
// ⚠ CLAUDE OPUS 5.5 REFUSES THREE REQUEST SHAPES WITH AN HTTP 400:
//   * `thinking: { type: 'disabled' }` — its thinking cannot be switched off;
//   * a thinking BUDGET (`budget_tokens`, i.e. the SDK's `thinking: {type:'enabled', budgetTokens}`
//     or the deprecated `maxThinkingTokens`);
//   * a FORCED `tool_choice` ('any' / 'tool').
// Nothing in the review, coding or llm call paths sends any of them (the review relies on the model
// CHOOSING `submit_review`; tool choice stays auto). Keep it that way. For Opus 5.5 we pass
// `thinking: { type: 'adaptive' }` explicitly, which also overrides a `MAX_THINKING_TOKENS=0` the
// environment might carry into the SDK's child process. That is the one fixed rule left: Opus 5.5
// accepts every effort level (low … max) with adaptive thinking.
//
// EFFORT is passed EXPLICITLY on every run (its API default is 'medium' on Opus 5.5 and 'high' on
// Sonnet 5; we never rely on an API default staying put). The caller decides it: the review and AI
// Fix pass `agenticRunEffort` (Settings → AI → Effort, ai/effort.ts); every other run gets
// `defaultRunEffort` — today's depth. Opus 5.5's effort is no longer PINNED to medium: a chosen level
// or REVIEW_EFFORT moves it. Default still runs it at medium (diff-only too), so nothing changes
// until the reader picks.
import type { AiEffort } from '@pierre-review/shared';
import { defaultRunEffort } from '../ai/effort.js';

// Models that accept the `effort` option — both offered models. A model outside the offered list
// (the old Opus 4.8, Sonnet 4.6, Haiku 4.5) left this set: nothing can start a run on one (both
// generate routes 400 it, and the chat falls back to the default), so nothing here needs to know it.
export const EFFORT_CAPABLE_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5', 'claude-sonnet-5']);

// Models that are always given `thinking: { type: 'adaptive' }` (see the header).
export const ALWAYS_ADAPTIVE_THINKING_MODELS: ReadonlySet<string> = new Set(['claude-opus-5-5']);

export interface SdkModelOptions {
  effort?: AiEffort;
  thinking?: { type: 'adaptive' };
}

/**
 * The model-dependent `query()` options for one run. `effort` is the caller's (the review and AI Fix:
 * `agenticRunEffort`); absent ⇒ `defaultRunEffort` for the mode (Default: worktree medium; diff-only
 * medium on Opus, low on Sonnet; REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT when set). A model outside
 * both sets gets `{}`.
 */
export function sdkModelOptions(model: string, mode: 'diff_only' | 'worktree', effort?: AiEffort): SdkModelOptions {
  const out: SdkModelOptions = {};
  if (EFFORT_CAPABLE_MODELS.has(model)) {
    out.effort = effort ?? defaultRunEffort('claude', model.startsWith('claude-opus') ? 'deep' : 'standard', mode);
  }
  if (ALWAYS_ADAPTIVE_THINKING_MODELS.has(model)) out.thinking = { type: 'adaptive' };
  return out;
}
