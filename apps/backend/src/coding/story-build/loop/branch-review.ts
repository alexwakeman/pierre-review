// THE REVIEW LOOP'S CODE REVIEW OF ONE TARGET — ONE HALF (docs/CLAUDE-REVIEW.md § Reviewing a branch).
// Limn's own review machinery, pointed at a BRANCH with no pull request: the same diff preparation
// (`prepareBranchReview`: the clone cache's base...head, noise-stripped, ranked, capped), the same routing
// (`decideReviewMode`), the same system prompt and specialists, the same user prompt with a `subject`
// (byte-identical PR prompts when it is absent), the same runner (`runReview`, which checks the commit out
// through `checkout`), and the same pure follow-up steps (reconcile, link re-raises, drop accepted re-raises).
// NO claude_reviews row, NO GitHub write, NO lane: the loop stores the result in its own tables.
// Never throws: a failure is a `failed` result with a reason.
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  type AiProviderId,
  type ClaudeReviewFollowUpRecord,
  type ClaudeReviewVerdict,
} from '@pierre-review/shared';
import type { AgentContext } from '../../../review/agent-context.js';
import type { ReviewFinding } from '../../../platform/contract.js';
import { automaticRunAllowed } from '../../../review/budget-gate.js';
import {
  dropAcceptedReraises,
  linkReraisedFindings,
  reconcileFollowUp,
  selectPriorFindings,
  type PriorReviewForFollowUp,
} from '../../../review/claude-review/follow-up.js';
import { buildUserPrompt, pickReviewNonce, systemPromptForMode, untrustedTexts } from '../../../review/claude-review/prompts.js';
import { decideReviewMode } from '../../../review/claude-review/routing.js';
import { similarTitles } from '../../../review/claude-review/settled-by-reply.js';
import { offeredSpecialists } from '../../../review/claude-review/specialists.js';

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

export type LoopFinding = ReviewFinding & { priorFindingId: number | null };

export interface LoopHalfResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  failureReason: string | null;
  reviewMode: 'diff_only' | 'worktree' | 'skip' | null;
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  findings: LoopFinding[];
  followUp: ClaudeReviewFollowUpRecord | null;
  ranOn: { provider: AiProviderId; model: string | null; effort: string | null };
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

export const LOOP_REVIEW_FEATURE = 'story_loop_review';

/** Run one half (see the header). */
export async function runLoopReviewHalf(ctx: AgentContext, i: LoopHalfInput): Promise<LoopHalfResult> {
  const base: LoopHalfResult = {
    status: 'failed',
    failureReason: null,
    reviewMode: null,
    summary: null,
    verdict: null,
    findings: [],
    followUp: null,
    ranOn: { provider: i.provider, model: null, effort: null },
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
  };
  try {
    const prep = await ctx.review.prepareBranchReview({ owner: i.owner, name: i.name, baseSha: i.baseSha, headSha: i.headSha });
    const decision = decideReviewMode(prep.fileMetrics);
    if (decision.mode === 'skip') {
      return { ...base, status: 'succeeded', reviewMode: 'skip', summary: 'Nothing to review.', verdict: 'COMMENT' };
    }
    const mode = decision.mode === 'worktree' ? 'worktree' : 'diff_only';
    const specialists = mode === 'worktree' ? offeredSpecialists(prep.changedFiles) : [];
    const plan = i.prior && i.prior.findings.length > 0 ? selectPriorFindings(i.prior, i.headSha) : null;
    const nonce = pickReviewNonce(untrustedTexts(plan, null));
    const { reviewDocsFor } = await import('../../../reference-docs/context.js');
    const docs = await reviewDocsFor(i.accountId, i.workspaceId).catch(() => null);
    const prompt = buildUserPrompt({
      repoFullName: i.fullName,
      prNumber: 0,
      title: i.title,
      body: i.body,
      headSha: i.headSha,
      baseRef: i.baseRef,
      changedFiles: prep.changedFiles,
      excludedFiles: prep.excludedFiles,
      diff: prep.promptDiff,
      mode,
      omittedFiles: prep.omittedFiles,
      followUp: plan ? { plan, since: null } : null,
      nonce,
      subject: { kind: 'branch', branch: i.branch },
    });
    const { REVIEW_APPLY_AUTH_ENV } = await import('../../../review/claude-review/manager.js');
    const res = await ctx.review.runReview({
      owner: i.owner,
      name: i.name,
      prNumber: 0,
      headSha: i.headSha,
      model: DEFAULT_CLAUDE_REVIEW_MODEL,
      provider: i.provider,
      mode,
      systemPrompt: systemPromptForMode(mode, specialists, docs?.dir ?? null),
      prompt,
      strippedDiff: prep.strippedDiff,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: i.abort,
      onProgress: () => {},
      specialists,
      docsDir: docs?.dir ?? null,
      checkout: { remoteRef: `refs/heads/${i.branch}`, destRef: `refs/pierre/story-loop/${i.buildId}`, sha: i.headSha },
      usage: { accountId: i.accountId, prId: null, repoId: i.repoId },
      allowSpecialistStart: () => (i.byReader ? true : automaticRunAllowed(ctx, i.accountId, LOOP_REVIEW_FEATURE, i.provider)),
    });
    const ranOn = { provider: (res.ranOn?.provider ?? i.provider) as AiProviderId, model: res.ranOn?.model ?? null, effort: res.ranOn?.effort ?? null };
    const telemetry = { costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, numTurns: res.numTurns };
    // Claude's spend is recorded here (Codex wrote its own ledger row: `usageRecorded`).
    if (!res.usageRecorded && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: i.accountId,
          seam: 'agent',
          feature: LOOP_REVIEW_FEATURE,
          model: ranOn.model ?? DEFAULT_CLAUDE_REVIEW_MODEL,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          prId: null,
          repoId: i.repoId,
          provider: ranOn.provider,
        })
        .catch(() => {});
    }
    if (res.aborted) return { ...base, ...telemetry, ranOn, status: 'cancelled', reviewMode: mode };
    if (!res.submitted) return { ...base, ...telemetry, ranOn, reviewMode: mode, failureReason: res.failureReason ?? 'The review did not finish.' };
    const items = plan ? reconcileFollowUp(plan, res.followUp) : null;
    const linked: LoopFinding[] =
      plan && items ? linkReraisedFindings(plan, items, res.findings, new Set(prep.changedFiles)) : res.findings.map((f) => ({ ...f, priorFindingId: null }));
    const { kept } = items ? dropAcceptedReraises(linked, items, similarTitles) : { kept: linked };
    return {
      ...base,
      ...telemetry,
      ranOn,
      status: 'succeeded',
      reviewMode: mode,
      summary: res.summary,
      verdict: res.verdict,
      findings: kept,
      followUp:
        plan && items
          ? { priorReviewId: plan.priorReviewId, priorHeadSha: plan.priorHeadSha, headMoved: plan.headMoved, changesSinceShown: false, items }
          : null,
    };
  } catch (err) {
    if (i.abort.signal.aborted) return { ...base, status: 'cancelled' };
    return { ...base, failureReason: err instanceof Error ? err.message : String(err) };
  }
}
