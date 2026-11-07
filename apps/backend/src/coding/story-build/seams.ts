import type { StoryBuildRepoPushResult } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';

// THE PUSH CONTRACT (docs/STORY-BUILD.md § Push). A workspace session stores each repository's work as
// a patch on its `story_build_repos` row; Push applies it on the HOST (push.ts `pushRepo`). The routes
// (routes-build.ts) reach the push only through `PushRepoFn`, so a test can pass a fake.

export interface PushRepoArgs {
  accountId: number;
  buildId: number;
  /** The REPO id (the route's `:repoId`). */
  repoId: number;
  /** Open the PR as a draft (owner decision 2: default true). */
  draft: boolean;
  /** Bodies link sibling PRs already pushed in this session (Push all runs in build order). */
  signal?: AbortSignal;
}

/** Push one ready repository: a NEW branch, a new PR (stacked repos target the PR they stack on). The
 *  outcome is recorded on the repo row by the implementation; the result is also returned to the route. */
export type PushRepoFn = (ctx: AgentContext, args: PushRepoArgs) => Promise<StoryBuildRepoPushResult>;
