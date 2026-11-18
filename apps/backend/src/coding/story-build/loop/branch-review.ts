// THE BUILD LOOP'S CODE REVIEW OF ONE TARGET — ONE HALF (docs/CLAUDE-REVIEW.md § Reviewing a branch). The
// shared branch-review half (coding/review-loop/branch-review.ts) pointed at a target's PUSHED loop branch:
// the head is the REMOTE branch (`refs/heads/<branch>`, fetched into the build's namespaced
// `refs/pierre/story-loop/<buildId>` only when the commit is not already in the clone cache). The loop stores
// the result in its own tables (driver.ts). Never throws.
import type { AiProviderId } from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import type { PriorReviewForFollowUp } from '../../../review/claude-review/follow-up.js';
import { runBranchReviewHalf, type BranchReviewHalfResult } from '../../review-loop/branch-review.js';

export interface LoopHalfInput {
  accountId: number;
  workspaceId: number;
  buildId: number;
  round: number;
  owner: string;
  name: string;
  fullName: string;
  repoId: number;
  branch: string;
  /** "What the branch is for": the planned PR's text, or the repository summary, with the ticket. */
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  provider: AiProviderId;
  /** The earlier round's findings of this target, with the build agent's answers (persist-side). */
  prior: PriorReviewForFollowUp | null;
  abort: AbortController;
  /** A reader's Continue started this run: the specialists' gate is not asked. */
  byReader: boolean;
}

export type LoopHalfResult = BranchReviewHalfResult;

export const LOOP_REVIEW_FEATURE = 'story_loop_review';

/** The checkout of a target's loop branch (the review's and the story check's). */
export const loopBranchHead = (buildId: number, branch: string, sha: string): { remoteRef: string; destRef: string; sha: string } => ({
  remoteRef: `refs/heads/${branch}`,
  destRef: `refs/pierre/story-loop/${buildId}`,
  sha,
});

/** Run one half (see the header). */
export async function runLoopReviewHalf(ctx: AgentContext, i: LoopHalfInput): Promise<LoopHalfResult> {
  return runBranchReviewHalf(ctx, {
    accountId: i.accountId,
    workspaceId: i.workspaceId,
    repo: { owner: i.owner, name: i.name, fullName: i.fullName, repoId: i.repoId },
    branch: i.branch,
    title: i.title,
    body: i.body,
    baseRef: i.baseRef,
    baseSha: i.baseSha,
    head: loopBranchHead(i.buildId, i.branch, i.headSha),
    provider: i.provider,
    prior: i.prior,
    abort: i.abort,
    byReader: i.byReader,
    feature: LOOP_REVIEW_FEATURE,
  });
}
