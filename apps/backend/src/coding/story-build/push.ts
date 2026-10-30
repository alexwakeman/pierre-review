import type { PushRepoFn } from './seams.js';

// PUSH ONE REPOSITORY — WORK PACKAGE 2 (docs/STORY-BUILD.md § Push). STUB from the contract commit: WP2
// replaces the body (the no-PR `applyAndPush` variant, `createPullRequest` with `draft`, `getViewerCanPush`,
// the title `${KEY}: ${title}`, the body, the tracker manual link, `syncNewPrInRepo`) and keeps THIS
// signature (seams.ts `PushRepoFn`). Nothing reaches GitHub from the stub.

export const STORY_PUSH_NOT_AVAILABLE = 'Pushing a story build is not available in this version of Limn yet.';

export const pushRepo: PushRepoFn = async (_ctx, a) => ({
  repoId: a.repoId,
  outcome: 'failed',
  prNumber: null,
  prUrl: null,
  code: 'NotAvailable',
  error: STORY_PUSH_NOT_AVAILABLE,
});
