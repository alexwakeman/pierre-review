import type { BuildRepoFn } from './seams.js';

// ONE REPOSITORY'S BUILD — WORK PACKAGE 2 (docs/STORY-BUILD.md § The builder). STUB from the contract
// commit: WP2 replaces the body (the `story_build` agent through `coding/agent.ts buildInWorktree`, the
// kept worktree via `prepBranchWorktree` under `withWorktreeOwner({kind:'story_build', runId: repo.id})`,
// "Run tests", hook repair, the write-deny hook) and keeps THIS signature (seams.ts `BuildRepoFn`).

export const STORY_BUILD_NOT_AVAILABLE = 'Building is not available in this version of Limn yet.';

export const buildRepo: BuildRepoFn = async () => ({
  ok: false,
  error: STORY_BUILD_NOT_AVAILABLE,
  worktreePath: null,
  patch: null,
  filesChanged: [],
  summary: null,
  commitMessage: null,
  changeReport: null,
  checks: null,
  provider: null,
  model: null,
  effort: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: null,
});
