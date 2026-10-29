// THE EFFORT SETTING and THE ONE RESOLVER for "what effort does this run send?" (packages/shared
// `ai-effort.ts` holds the levels, the words and the provider map — the identity, see its header).
//
// THE CHOICE: an explicitly set REVIEW_EFFORT (one of the five levels) WINS and locks the Settings
// control; otherwise the level stored per machine (`accounts.ai_effort`, PUT /api/ai/effort, loaded at
// boot by ai/provider-store.ts), held HERE in memory so a change reaches the next run with no restart.
// Neither ⇒ DEFAULT (null). No DB import here, for the same reason as ai/provider-setting.ts.
//
// WHO IT REACHES (`agenticRunEffort`): the PR review (lead, specialists, follow-up re-reviews), AI Fix
// and Plan first, on BOTH providers — and NOTHING ELSE. REVIEW_EFFORT and REVIEW_DIFF_ONLY_EFFORT reach
// exactly the same runs as the Settings control (REVIEW_EFFORT IS the control, locked), so "Set by
// REVIEW_EFFORT" under it is the whole story. Every other agent kind (CI review, ticket review,
// diagrams, Check threads, chats, Resolve with Claude) runs at its provider's own fixed depth
// (`defaultRunEffort`), which reads no environment — except Check against docs, whose read is pinned to
// 'low' on both providers (review/story-docs/prompts.ts STORY_DOCS_EFFORT: the sections' text is in the
// prompt, so it is reading, not search). Still a fixed depth; this setting does not reach it.
//
// A worktree run sends the level. A diff-only review runs ONE STEP LOWER, but never below what Default
// runs it at — unless the chosen level is itself below that, when it runs at the chosen level
// (`diffOnlyEffortAt`). So picking Medium, which is what Default runs Opus 5.5 at, never drops its quick
// reviews to low. REVIEW_DIFF_ONLY_EFFORT, when set, decides every diff-only review on both providers,
// at Default too.
//
// DEFAULT = today's behaviour, exactly:
//   • Claude: worktree medium; diff-only medium on Opus 5.5 (the old pin), low on Sonnet 5.
//   • Codex: by depth (deep = high, standard = medium, fast = low), one step lower diff-only.
// ⚠ Opus 5.5 is no longer PINNED on the review and AI Fix: a chosen level or REVIEW_EFFORT moves it like
// any model. Every other kind still runs it at medium. What stays fixed everywhere is adaptive thinking
// (review/model-options.ts).
import { AI_EFFORTS, isAiEffort, stepDownEffort, type AiEffort, type AiEffortSettingStatus } from '@pierre-review/shared';
import type { AgentProviderId, ModelChoice, ModelRole } from './provider.js';

export const REVIEW_EFFORT_ENV = 'REVIEW_EFFORT';
export const REVIEW_DIFF_ONLY_EFFORT_ENV = 'REVIEW_DIFF_ONLY_EFFORT';

let storedEffort: AiEffort | null = null;

/** The stored level (Settings → AI), or null when none is stored. Memory only. */
export function storedAiEffort(): AiEffort | null {
  return storedEffort;
}

/** Hold the stored level in memory (the boot's load, the route's write, tests). null ⇒ Default. */
export function setStoredAiEffort(value: AiEffort | null): void {
  storedEffort = value;
}

function envEffort(env: NodeJS.ProcessEnv, key: string): AiEffort | null {
  const raw = env[key]?.trim().toLowerCase();
  return isAiEffort(raw) ? raw : null;
}

/** REVIEW_EFFORT when set to a known level; null when unset, empty or unknown. */
export function aiEffortEnvSetting(env: NodeJS.ProcessEnv = process.env): AiEffort | null {
  return envEffort(env, REVIEW_EFFORT_ENV);
}

/** THE chosen level, read at call time: REVIEW_EFFORT, else the stored one, else null (Default). */
export function chosenAiEffort(env: NodeJS.ProcessEnv = process.env): AiEffort | null {
  return aiEffortEnvSetting(env) ?? storedEffort;
}

/** The level and who chose it (`MeResponse.ai.effortSetting`). */
export function aiEffortSettingStatus(env: NodeJS.ProcessEnv = process.env): AiEffortSettingStatus {
  const fromEnv = aiEffortEnvSetting(env);
  return fromEnv ? { value: fromEnv, source: 'env' } : { value: storedEffort, source: 'settings' };
}

/** Codex's own depth per role (CODEX-SPIKE.md § 8): what Codex runs at by Default. */
export const CODEX_DEFAULT_EFFORT_FOR_ROLE: Readonly<Record<ModelRole, AiEffort>> = {
  deep: 'high',
  standard: 'medium',
  fast: 'low',
};

/**
 * The effort a run sends when the Settings level does NOT reach it: every kind outside the review and
 * AI Fix, and those too while the level is Default. Claude: medium, and diff-only medium on Opus (deep),
 * low otherwise. Codex: by role, one step lower diff-only. Reads NO environment — REVIEW_EFFORT and
 * REVIEW_DIFF_ONLY_EFFORT reach only `agenticRunEffort`'s runs. Pure.
 */
export function defaultRunEffort(provider: AgentProviderId, role: ModelRole, mode: 'diff_only' | 'worktree'): AiEffort {
  if (provider === 'codex') {
    const base = CODEX_DEFAULT_EFFORT_FOR_ROLE[role];
    return mode === 'worktree' ? base : stepDownEffort(base);
  }
  if (mode === 'worktree') return 'medium';
  return role === 'deep' ? 'medium' : 'low';
}

const rank = (e: AiEffort): number => AI_EFFORTS.indexOf(e);
const lowerOf = (a: AiEffort, b: AiEffort): AiEffort => (rank(a) <= rank(b) ? a : b);
const higherOf = (a: AiEffort, b: AiEffort): AiEffort => (rank(a) >= rank(b) ? a : b);

/**
 * A diff-only review's effort at a chosen `level`, given what Default runs that review at
 * (`atDefault`): one step lower, but never below `atDefault` — nor above `level`, so a level chosen
 * below Default runs at that level. Pure.
 */
export function diffOnlyEffortAt(level: AiEffort, atDefault: AiEffort): AiEffort {
  return higherOf(stepDownEffort(level), lowerOf(level, atDefault));
}

/**
 * THE EFFORT of a review / AI Fix / Plan first run on `provider`: the chosen level on a worktree run;
 * diff-only, REVIEW_DIFF_ONLY_EFFORT when set (at any level, on both providers), else
 * `diffOnlyEffortAt`; Default ⇒ `defaultRunEffort`. Read once per run, at its start; the run stores
 * what it used.
 */
export function agenticRunEffort(
  provider: AgentProviderId,
  choice: Pick<ModelChoice, 'role'>,
  mode: 'diff_only' | 'worktree',
  env: NodeJS.ProcessEnv = process.env,
): AiEffort {
  const level = chosenAiEffort(env);
  const atDefault = defaultRunEffort(provider, choice.role, mode);
  if (mode === 'worktree') return level ?? atDefault;
  const fromEnv = envEffort(env, REVIEW_DIFF_ONLY_EFFORT_ENV);
  if (fromEnv) return fromEnv;
  return level == null ? atDefault : diffOnlyEffortAt(level, atDefault);
}

