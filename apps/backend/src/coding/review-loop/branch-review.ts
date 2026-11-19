// A BRANCH'S CODE REVIEW — ONE HALF (SHARED; docs/CLAUDE-REVIEW.md § Reviewing a branch). Ensemble's own
// review machinery, pointed at a BRANCH with no pull request: the same diff preparation
// (`prepareBranchReview`: the clone cache's base...head, noise-stripped, ranked, capped), the same routing
// (`decideReviewMode`), the same system prompt and specialists, the same user prompt with a `subject`
// (byte-identical PR prompts when it is absent; the branch prompt has its own golden), the same runner
// (`runReview`, which checks the head out through `checkout`), and the same pure follow-up steps
// (reconcile, link re-raises, drop accepted re-raises).
//
// SUBJECT-INDEPENDENT: it takes a repository, a base, a HEAD SOURCE (a remote branch, or a LOCAL PINNED REF
// in the clone cache — review/clone-manager.ts `BranchHeadSource`), the earlier findings and one provider.
// It writes NO row, makes NO GitHub write and takes NO lane: the caller stores the result in its own tables.
// Never throws: a failure is a `failed` result with a reason.
//
// Also here: the PAIR's consolidation (two blind halves → ONE review) and the provider list a loop's review
// rounds run on (Settings → AI → Review through the ONE resolver, ai/run-profile.ts).
import {
  DEFAULT_CLAUDE_REVIEW_MODEL,
  type AiEffort,
  type AiProviderId,
  type ClaudeReview,
  type ClaudeReviewFollowUpRecord,
  type ClaudeReviewPairConsolidation,
  type ClaudeReviewVerdict,
} from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { BranchHeadSource } from '../../review/clone-manager.js';
import type { ReviewFinding } from '../../platform/contract.js';
import { automaticRunAllowed } from '../../review/budget-gate.js';
import {
  dropAcceptedReraises,
  linkReraisedFindings,
  reconcileFollowUp,
  selectPriorFindings,
  type PriorReviewForFollowUp,
} from '../../review/claude-review/follow-up.js';
import { buildUserPrompt, pickReviewNonce, systemPromptForMode, untrustedTexts } from '../../review/claude-review/prompts.js';
import { decideReviewMode } from '../../review/claude-review/routing.js';
import { similarTitles } from '../../review/claude-review/settled-by-reply.js';
import { offeredSpecialists } from '../../review/claude-review/specialists.js';

export interface BranchReviewHalfInput {
  accountId: number;
  /** The workspace whose reference docs the review reads. */
  workspaceId: number;
  repo: { owner: string; name: string; fullName: string; repoId: number };
  /** The branch name the prompt's subject shows ("branch X (no pull request yet)"). */
  branch: string;
  /** "What the branch is for". */
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  /** Where the head commit comes from; `head.sha` is the reviewed commit. */
  head: BranchHeadSource;
  provider: AiProviderId;
  /** The earlier round's findings, with the fix agent's answers. */
  prior: PriorReviewForFollowUp | null;
  abort: AbortController;
  /** A reader's press started this run: the specialists' gate is not asked. */
  byReader: boolean;
  /** The spend ledger's feature and the gate's question (e.g. 'story_loop_review'). */
  feature: string;
  /** Codex writes its own ledger row under this feature too (absent ⇒ 'claude_review', as before). */
  ledgerFeature?: string;
  /** ONE RUN'S EFFORT named by the reader (a local branch review); absent ⇒ Settings → AI → Review's. */
  effort?: AiEffort | null;
}

export type BranchReviewFinding = ReviewFinding & { priorFindingId: number | null };

export interface BranchReviewHalfResult {
  status: 'succeeded' | 'failed' | 'cancelled';
  failureReason: string | null;
  reviewMode: 'diff_only' | 'worktree' | 'skip' | null;
  summary: string | null;
  verdict: ClaudeReviewVerdict | null;
  findings: BranchReviewFinding[];
  followUp: ClaudeReviewFollowUpRecord | null;
  ranOn: { provider: AiProviderId; model: string | null; effort: string | null };
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** Run one half (see the header). */
export async function runBranchReviewHalf(ctx: AgentContext, i: BranchReviewHalfInput): Promise<BranchReviewHalfResult> {
  const base: BranchReviewHalfResult = {
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
  const { owner, name, fullName, repoId } = i.repo;
  const headSha = i.head.sha;
  try {
    const prep = await ctx.review.prepareBranchReview({ owner, name, baseSha: i.baseSha, headSha, ...('localRef' in i.head ? { localRef: i.head.localRef } : {}) });
    const decision = decideReviewMode(prep.fileMetrics);
    if (decision.mode === 'skip') {
      return { ...base, status: 'succeeded', reviewMode: 'skip', summary: 'Nothing to review.', verdict: 'COMMENT' };
    }
    const mode = decision.mode === 'worktree' ? 'worktree' : 'diff_only';
    const specialists = mode === 'worktree' ? offeredSpecialists(prep.changedFiles) : [];
    const plan = i.prior && i.prior.findings.length > 0 ? selectPriorFindings(i.prior, headSha) : null;
    const nonce = pickReviewNonce(untrustedTexts(plan, null));
    const { reviewDocsFor } = await import('../../reference-docs/context.js');
    const docs = await reviewDocsFor(i.accountId, i.workspaceId).catch(() => null);
    const prompt = buildUserPrompt({
      repoFullName: fullName,
      prNumber: 0,
      title: i.title,
      body: i.body,
      headSha,
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
    const { REVIEW_APPLY_AUTH_ENV } = await import('../../review/claude-review/manager.js');
    const res = await ctx.review.runReview({
      owner,
      name,
      prNumber: 0,
      headSha,
      // The vendor's Settings → AI → Review model (ai/run-profile.ts); its effort follows in the run.
      model: (await import('../../ai/run-profile.js')).reviewRunModel(i.provider),
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
      checkout: i.head,
      usage: { accountId: i.accountId, prId: null, repoId, ...(i.ledgerFeature ? { feature: i.ledgerFeature } : {}) },
      ...(i.effort ? { effort: i.effort } : {}),
      allowSpecialistStart: () => (i.byReader ? true : automaticRunAllowed(ctx, i.accountId, i.feature, i.provider)),
    });
    const ranOn = { provider: (res.ranOn?.provider ?? i.provider) as AiProviderId, model: res.ranOn?.model ?? null, effort: res.ranOn?.effort ?? null };
    const telemetry = { costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, numTurns: res.numTurns };
    // Claude's spend is recorded here (Codex wrote its own ledger row: `usageRecorded`).
    if (!res.usageRecorded && res.costUsd != null && res.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: i.accountId,
          seam: 'agent',
          feature: i.feature,
          model: ranOn.model ?? DEFAULT_CLAUDE_REVIEW_MODEL,
          costUsd: res.costUsd,
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
          prId: null,
          repoId,
          provider: ranOn.provider,
        })
        .catch(() => {});
    }
    if (res.aborted) return { ...base, ...telemetry, ranOn, status: 'cancelled', reviewMode: mode };
    if (!res.submitted) return { ...base, ...telemetry, ranOn, reviewMode: mode, failureReason: res.failureReason ?? 'The review did not finish.' };
    const items = plan ? reconcileFollowUp(plan, res.followUp) : null;
    const linked: BranchReviewFinding[] =
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

// ---- the pair ------------------------------------------------------------------------------------------

export interface BranchPairConsolidation {
  summary: string | null;
  verdict: ClaudeReview['verdict'];
  how: 'pass' | 'code';
  sourceOf: Record<string, 'claude' | 'codex' | 'both'>;
  /** dropped finding id → the kept finding id it merged into. */
  mergedFrom: Record<string, number>;
}

/** A PAIR whose two halves succeeded → ONE consolidated review (duplicates merged, one verdict), as the PR pair. */
export async function consolidateBranchPair(ctx: AgentContext, accountId: number, a: ClaudeReview, b: ClaudeReview): Promise<BranchPairConsolidation> {
  const { consolidateHalves } = await import('../../review/claude-review/pair-consolidate.js');
  const r = await consolidateHalves(ctx, accountId, null, a, b);
  return { summary: r.summary, verdict: r.verdict, how: r.how, sourceOf: r.sourceOf, mergedFrom: r.mergedFrom };
}

/** The record a loop stores on the pair's lead run. Pure. */
export function pairConsolidationRecord(c: BranchPairConsolidation, at: Date): ClaudeReviewPairConsolidation {
  return { how: c.how, summary: c.summary, verdict: c.verdict, sourceOf: c.sourceOf, mergedFrom: c.mergedFrom, failedHalf: null, at: at.toISOString() };
}

/** A half's role in a round of `n` providers: a pair is first/second, a single review has none. */
export const pairRoleOf = (index: number, n: number): 'first' | 'second' | null => (n < 2 ? null : index === 0 ? 'first' : 'second');

// ---- who reviews -----------------------------------------------------------------------------------------

/**
 * The providers a loop's review round runs on: the workspace's auto-review "both / one" choice, through THE
 * ONE PAIR RESOLVER's rule (ai/run-profile.ts): only the review vendors switched on in Settings → AI, signed
 * in, not locked out; "one vendor" = the first on and signed in.
 */
export async function branchReviewProviders(ctx: AgentContext, accountId: number, workspaceId: number): Promise<AiProviderId[]> {
  const [{ resolveAutoReviewProviders }, { automaticRunProviders, isLockedOut, anyUsageLockout }, { preflightFor }, { reviewDefaultProvider, reviewProvidersEnabled }] = await Promise.all([
    import('../../review/claude-review/pair.js'),
    import('../../ai/usage-lockout.js'),
    import('../../ai/run-choice.js'),
    import('../../ai/run-profile.js'),
  ]);
  const { readWorkspaceAutoReview } = await import('../../review/claude-review/auto-settings.js');
  const ws = await readWorkspaceAutoReview(ctx, accountId, workspaceId).catch(() => null);
  const pair = resolveAutoReviewProviders(ws?.autoReviewProviders ?? null) === 'both';
  const detect = preflightFor(ctx);
  return automaticRunProviders({
    defaultProvider: reviewDefaultProvider(detect),
    pair,
    order: reviewProvidersEnabled(),
    ready: (p) => detect(p, 'review').status === 'ok',
    locked: (p) => anyUsageLockout() && isLockedOut(p),
  });
}

/** Who runs a loop's story check: a review kind, so Settings → AI's review vendor (the first on and signed in). */
export async function storyCheckProvider(): Promise<AiProviderId> {
  const [{ reviewDefaultProvider }, { detectProviderAuth }] = await Promise.all([import('../../ai/run-profile.js'), import('../../review/auth.js')]);
  return reviewDefaultProvider((p, k) => detectProviderAuth(p, k));
}
