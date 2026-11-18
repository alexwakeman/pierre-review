// THE BUILD LOOP'S STORY CHECK OF ONE ROUND (docs/CLAUDE-REVIEW.md § The ticket review → in the review
// loop). The shared branch story check (coding/review-loop/story-check.ts) over every target of the build,
// each read at its PUSHED loop branch (the remote head, as the round's code review). Never throws.
import type { AiProviderId, ClaudeReviewTicket, TicketAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import { runBranchStoryCheck, type BranchStoryCheckResult } from '../../review-loop/story-check.js';
import { loopBranchHead } from './branch-review.js';
import type { LoopClaim, LoopStoryCheckMember } from './persist.js';

export interface LoopCheckTarget {
  member: LoopStoryCheckMember;
  owner: string;
  name: string;
  /** The diff base (the repository base, or the PR before it). */
  baseSha: string;
  title: string | null;
}

export interface LoopStoryCheckInput {
  accountId: number;
  workspaceId: number;
  buildId: number;
  ident: string;
  ticket: ClaudeReviewTicket;
  targets: readonly LoopCheckTarget[];
  /** The previous round's assessment (members' prId = target id) and the targets whose head moved. */
  prior: { assessment: TicketAssessment; changedTargetIds: number[] } | null;
  claims: readonly LoopClaim[];
  provider: AiProviderId;
  abort: AbortController;
}

export type LoopStoryCheckResult = BranchStoryCheckResult;

export const LOOP_CHECK_FEATURE = 'story_loop_check';

/** Run the round's story check (see the header). */
export async function runLoopStoryCheck(ctx: AgentContext, i: LoopStoryCheckInput): Promise<LoopStoryCheckResult> {
  return runBranchStoryCheck(ctx, {
    accountId: i.accountId,
    workspaceId: i.workspaceId,
    ident: i.ident,
    ticket: i.ticket,
    targets: i.targets.map((t) => ({
      ref: t.member.ref,
      id: t.member.targetId,
      repoId: t.member.repoId,
      repo: t.member.repo,
      owner: t.owner,
      name: t.name,
      branch: t.member.branch,
      head: loopBranchHead(i.buildId, t.member.branch, t.member.headSha),
      baseSha: t.baseSha,
      title: t.title,
    })),
    prior: i.prior,
    claims: i.claims,
    provider: i.provider,
    abort: i.abort,
    feature: LOOP_CHECK_FEATURE,
  });
}
