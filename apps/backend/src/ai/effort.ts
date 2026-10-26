// THE EFFORT SETTING and THE ONE RESOLVER for "what effort does this run send?" (packages/shared
// `ai-effort.ts` holds the levels, the words and the provider map — the identity, see its header).
//
// THE CHOICE: an explicitly set REVIEW_EFFORT (one of the five levels) WINS and locks the Settings
// control; otherwise the level stored per machine (`accounts.ai_effort`, PUT /api/ai/effort, loaded at
// boot by ai/provider-store.ts), held HERE in memory so a change reaches the next run with no restart.
// Neither ⇒ DEFAULT (null). No DB import here, for the same reason as ai/provider-setting.ts.
//
// WHO IT REACHES (`agenticRunEffort`): the PR review (lead, specialists, follow-up re-reviews), AI Fix
// and Plan first, on BOTH providers. A worktree run sends the level; a diff-only review one step
// lower (never below low), unless REVIEW_DIFF_ONLY_EFFORT is set, which then decides every diff-only
// run. Every other agent kind keeps its provider's own depth (`defaultRunEffort`), except that an
// explicit REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT still moves every Claude run, as it always did for
// Sonnet.
//
// DEFAULT = today's behaviour, exactly:
//   • Claude: worktree medium; diff-only medium on Opus 5.5 (the old pin), low on Sonnet 5.
//   • Codex: by depth (deep = high, standard = medium, fast = low), one step lower diff-only.
// ⚠ Opus 5.5 is no longer PINNED: a chosen level or REVIEW_EFFORT moves it like any model. What stays
// fixed is real — adaptive thinking (review/model-options.ts).
import { isAiEffort, stepDownEffort, type AiEffort, type AiEffortSettingStatus } from '@pierre-review/shared';
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
 * The effort a run sends when the Settings level does NOT reach it (every kind outside the review and
 * AI Fix, and those too while the level is Default). Claude: REVIEW_EFFORT / REVIEW_DIFF_ONLY_EFFORT
 * when set, else medium, and diff-only medium on Opus (deep), low otherwise. Codex: by role, one step
 * lower diff-only. Pure in `env`.
 */
export function defaultRunEffort(
  provider: AgentProviderId,
  role: ModelRole,
  mode: 'diff_only' | 'worktree',
  env: NodeJS.ProcessEnv = process.env,
): AiEffort {
  if (provider === 'codex') {
    const base = CODEX_DEFAULT_EFFORT_FOR_ROLE[role];
    return mode === 'worktree' ? base : stepDownEffort(base);
  }
  if (mode === 'worktree') return envEffort(env, REVIEW_EFFORT_ENV) ?? 'medium';
  return envEffort(env, REVIEW_DIFF_ONLY_EFFORT_ENV) ?? (role === 'deep' ? 'medium' : 'low');
}

/**
 * THE EFFORT of a review / AI Fix / Plan first run on `provider`: the chosen level on a worktree run,
 * one step lower diff-only (REVIEW_DIFF_ONLY_EFFORT, when set, decides diff-only); Default ⇒
 * `defaultRunEffort`. Read once per run, at its start; the run stores what it used.
 */
export function agenticRunEffort(
  provider: AgentProviderId,
  choice: Pick<ModelChoice, 'role'>,
  mode: 'diff_only' | 'worktree',
  env: NodeJS.ProcessEnv = process.env,
): AiEffort {
  const level = chosenAiEffort(env);
  if (level == null) return defaultRunEffort(provider, choice.role, mode, env);
  if (mode === 'worktree') return level;
  return envEffort(env, REVIEW_DIFF_ONLY_EFFORT_ENV) ?? stepDownEffort(level);
}

/** How much more room a review gets at a higher level: High ×1.5, Extra high ×2, Max ×2.5. */
export const EFFORT_TURN_FACTOR: Readonly<Record<AiEffort, number>> = {
  low: 1,
  medium: 1,
  high: 1.5,
  xhigh: 2,
  max: 2.5,
};

/**
 * A review's turn cap at the chosen level: the base cap times `EFFORT_TURN_FACTOR`, unless the cap was
 * set explicitly in the environment (`pinned`), which always wins. Default and Low/Medium keep the base.
 */
export function effortTurnCap(base: number, level: AiEffort | null, pinned: boolean): number {
  if (pinned || level == null) return base;
  return Math.round(base * EFFORT_TURN_FACTOR[level]);
}
