import {
  STORY_BUILD_MAX_TURNS_DEFAULT,
  STORY_BUILD_PATCH_MAX_BYTES_DEFAULT,
  STORY_BUILD_REPO_BUDGET_USD_DEFAULT,
  STORY_BUILD_SESSION_BUDGET_USD_DEFAULT,
  STORY_PLAN_BUDGET_USD_DEFAULT,
  STORY_PLAN_MAX_TURNS_DEFAULT,
} from '@pierre-review/shared';

// "IMPLEMENT STORY" SPEND AND RUN LIMITS (docs/STORY-BUILD.md § Limits). The defaults live in
// packages/shared (one spelling, the SPA words its budget line from them); the environment overrides
// them, read AT CALL TIME so a test or a restart-free env change reaches the next pass. An unset,
// unparseable or non-positive value falls back to the default.

export interface StoryBuildLimits {
  /** STORY_BUILD_SESSION_BUDGET_USD — the whole session (plan + docs + every repository). */
  sessionBudgetUsd: number;
  /** STORY_PLAN_BUDGET_USD — the assess + plan passes, summed across revisions. */
  planBudgetUsd: number;
  /** STORY_BUILD_REPO_BUDGET_USD — one repository's build + its hook repairs. */
  repoBudgetUsd: number;
  /** STORY_PLAN_MAX_TURNS. */
  planMaxTurns: number;
  /** STORY_BUILD_MAX_TURNS. */
  buildMaxTurns: number;
  /** STORY_BUILD_PATCH_MAX_BYTES — a stored patch. */
  patchMaxBytes: number;
  /** STORY_BUILD_CONCURRENCY — builds at once on this machine. ONE (owner decision 3); not an env knob. */
  concurrency: 1;
}

function positive(env: NodeJS.ProcessEnv, key: string, fallback: number, parse: (s: string) => number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = parse(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function storyBuildLimits(env: NodeJS.ProcessEnv = process.env): StoryBuildLimits {
  const f = (k: string, d: number) => positive(env, k, d, Number.parseFloat);
  const i = (k: string, d: number) => positive(env, k, d, (s) => Number.parseInt(s, 10));
  return {
    sessionBudgetUsd: f('STORY_BUILD_SESSION_BUDGET_USD', STORY_BUILD_SESSION_BUDGET_USD_DEFAULT),
    planBudgetUsd: f('STORY_PLAN_BUDGET_USD', STORY_PLAN_BUDGET_USD_DEFAULT),
    repoBudgetUsd: f('STORY_BUILD_REPO_BUDGET_USD', STORY_BUILD_REPO_BUDGET_USD_DEFAULT),
    planMaxTurns: i('STORY_PLAN_MAX_TURNS', STORY_PLAN_MAX_TURNS_DEFAULT),
    buildMaxTurns: i('STORY_BUILD_MAX_TURNS', STORY_BUILD_MAX_TURNS_DEFAULT),
    patchMaxBytes: i('STORY_BUILD_PATCH_MAX_BYTES', STORY_BUILD_PATCH_MAX_BYTES_DEFAULT),
    concurrency: 1,
  };
}
