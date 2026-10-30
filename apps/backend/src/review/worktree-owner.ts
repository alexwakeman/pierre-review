import { AsyncLocalStorage } from 'node:async_hooks';

// WHO A WORKTREE IS FOR (docs/BACKEND.md § Worktree cleanup).
//
// `addWorktree` (clone-manager.ts) is the ONE place a per-run checkout is made, but it sits several
// calls below the run that wants it — a review's manager → `ctx.review.runReview` → `prepWorktree`,
// an AI Fix's manager → `ctx.coding.generateFix` → `prepWorktree`. Threading an owner argument
// through every one of those signatures (and the platform contract) would be the wrong cost, so the
// run's manager names the owner ONCE around its call and `addWorktree` reads it here.
//
// A checkout made with no owner in scope is still ledgered — kind 'other', no PR — so its process
// and age still decide when it goes. The owner only ADDS reasons to keep or remove it.
//
// This module imports nothing: clone-manager.ts and every manager import it.

export type WorktreeKind =
  | 'review'
  | 'chat'
  | 'fix'
  | 'plan'
  | 'thread_check'
  | 'replies_check'
  | 'ci_review'
  | 'ticket_review'
  | 'diagram'
  | 'merge'
  | 'resolve'
  // "Implement story" (docs/STORY-BUILD.md): TWO kinds, so a runId names ONE table — the plan pass's
  // read-only checkouts ('story_plan', runId = story_builds.id) and each repository's KEPT write worktree
  // ('story_build', runId = story_build_repos.id).
  | 'story_plan'
  | 'story_build'
  | 'other';

export interface WorktreeOwner {
  kind: WorktreeKind;
  accountId?: number | null;
  prId?: number | null;
  /** A ticket review's / diagram's ticket ident. */
  ticket?: string | null;
  /** The owning run's row id (ai_fixes for 'fix' / 'plan', claude_reviews for 'review', story_build_repos
   *  for 'story_build', story_builds for 'story_plan'). */
  runId?: number | null;
}

const store = new AsyncLocalStorage<WorktreeOwner>();

/** Run `fn` with every worktree it makes ledgered to `owner`. */
export function withWorktreeOwner<T>(owner: WorktreeOwner, fn: () => Promise<T>): Promise<T> {
  return store.run(owner, fn);
}

/** The owner named by the nearest enclosing `withWorktreeOwner`, or null. */
export function currentWorktreeOwner(): WorktreeOwner | null {
  return store.getStore() ?? null;
}
