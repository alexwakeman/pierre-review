// THE REPLIES PASS — THE OUTCOME RE-CHECK (docs/CLAUDE-REVIEW.md § The replies pass → The outcome).
// After a pass, the PR's open findings at the current head are the latest FULL review's counted
// findings minus the ones a reply settled (replies-pass.ts `openFindingsAfterReplies`). If the
// replies point to a different outcome (`repliesVerdict`: a disputed blocker ⇒ REQUEST_CHANGES; no
// blocker and no warning left once a reply settled something ⇒ APPROVE), an AUTO pass submits ONE
// short review saying so — through EXACTLY the auto-post gates (auto-post.ts): the workspace's
// auto-posting and auto-verdict switches, the PR rules (`autoPostEligibility`, the LIVE PR), the
// impact gate for APPROVE, the reader's standing verdict read live (never over a person's review;
// Limn's own automatic block may be superseded by an APPROVE, a second request is held), and the
// lifted-block rules (no blocker left ⇒ Limn's own block is dismissed when no APPROVE lands).
//
// ⚠ CLAIM BEFORE ANY WRITE, NEVER RETRIED: the record is `claude_reviews.auto_post` of the replies
// pass's own row, written by a compare-and-set from NULL (`status: 'posting'`) before GitHub is
// touched. A refused verdict is recorded, never sent again (there are no comments to fall back to).
// THE RULES (migration 0139): the workspace's `approveLeftovers` and, for a Claude + Codex review, its
// strictness (`repliesDissent`: a half that did not approve and raised nothing holds the approval —
// strict: any; relaxed: one that asked for changes). WHY NOT APPROVED (`repliesNotApproved`) is
// stored on the pass row (`verdict_reason`) while the auto verdict is on, and shown in Limn.
// ⚠ A COMMENT-ONLY REVIEW ONLY TO SAY WHY: when the pass HOLDS AN APPROVAL it computed (the leftovers
// rule, a pair half, or a gate — impact, own PR, a standing review), ONE short COMMENT review whose
// body is the reason goes out, at most once per (PR, head) (`reasonPostedAtHead`); any other held
// verdict is recorded (`skipped` + why), nothing posts.
// ⚠ A MANUAL pass never writes: its row's `verdict` shows what the outcome WOULD be.
// ⚠ Never throws.
import { and, desc, eq, isNull, ne, or } from 'drizzle-orm';
import {
  aiRunProviderName,
  autoPostFooter,
  PAIR_AUTO_POST_FOOTER,
  type AutoApproveImpact,
  type AutoVerdictEvent,
  type ClaudeAutoPostRecord,
  type ClaudeAutoVerdictRecord,
  type ClaudeFollowUpItemRecord,
  type ClaudeNotApproved,
  type ClaudeReview,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import {
  autoPostEligibility,
  defaultAutoPostDeps,
  impactAllowsApprove,
  isVerdictRefusal,
  loadEarlierFindings,
  loadLimnAutoBlockIds,
  loadUnpostedBlockersOfBlock,
  ownStandingReview,
  readAutoPostPrFacts,
  unsettledEarlierBlockers,
  verdictGate,
  liftBlockMessage,
  reasonPostedAtHead,
  withReasonLine,
  type AutoPostDeps,
  type ImpactLevel,
  type OwnLatestReview,
} from './auto-post.js';
import { readVerdictRulesForPr, readWorkspaceAutoPostForPr } from './auto-settings.js';
import { DEFAULT_VERDICT_RULES, reasonMayPost, repliesDissent, withReason } from './auto-verdict.js';
import {
  getClaudeReviewById,
  getReviewPostContext,
  isReaderIgnoredFinding,
  loadSettledByReplyFindings,
  readPairConsolidation,
} from './persist.js';
import { sourceOfRun } from './pair-view.js';
import {
  disputedBlockerTitle,
  openFindingsAfterReplies,
  repliesNotApproved,
  repliesReviewBody,
  repliesVerdict,
} from './replies-pass.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const nowIso = (): string => new Date().toISOString();
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const ALL_RUNS = Number.MAX_SAFE_INTEGER;

/** What the replies point to, and what it rests on. */
export interface RepliesOutcome {
  wanted: AutoVerdictEvent | null;
  // No blocker left open (and none left unjudged): Limn's own automatic block may be lifted.
  noBlocker: boolean;
  blockerTitle: string | null;
  full: ClaudeReview | null;
  // Every half the outcome rests on is an AUTO run. Only then may an automatic pass ACT on it: a
  // manual run is the reader's, kept local or posted by hand, and auto-post never acts on it.
  restsOnAuto: boolean;
  // WHY IT IS NOT AN APPROVAL (`repliesNotApproved`; null when it is one or nothing changed), and
  // whether an approval the old rule would give was HELD by the leftovers rule or a pair half.
  reason?: ClaudeNotApproved | null;
  heldApproval?: boolean;
  // The workspace's auto verdict switch, as read with the rules.
  autoVerdict?: boolean;
}

/**
 * The outcome over the latest FULL review after this pass's judgements (`items`: every row of the
 * pass). DB-only. A PR with no succeeded full review has no outcome.
 */
export async function computeRepliesOutcome(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  items: readonly ClaudeFollowUpItemRecord[],
  // The pass's head. ⚠ An outcome rests only on a full review AT this head: a review of older
  // commits never yields an APPROVE (or a lifted block) over commits nobody reviewed. Absent ⇒ unchecked.
  headSha?: string,
): Promise<RepliesOutcome> {
  const halves = await latestFullReviewHalves(ctx, prId, accountId);
  const full = halves[0];
  if (!full || (headSha != null && halves.some((h) => h.headSha !== headSha))) {
    return { wanted: null, noBlocker: false, blockerTitle: null, full: null, restsOnAuto: false };
  }
  const [settled, earlier] = await Promise.all([
    loadSettledByReplyFindings(ctx, prId, accountId, ALL_RUNS),
    loadEarlierFindings(ctx, accountId, prId, ALL_RUNS),
  ]);
  const settledIds = new Set(settled.map((f) => f.id));
  const priorById = new Map(earlier.map((e) => [e.id, e.priorFindingId]));
  // A CLAUDE + CODEX PAIR: both halves' findings are the PR's open findings (the second half's
  // repeats of the first's were already dropped in code).
  const open = openFindingsAfterReplies(
    halves.flatMap((h) => h.findings).map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title,
      priorFindingId: f.priorFindingId ?? null,
      story: f.story ?? null,
      readerIgnored: isReaderIgnoredFinding(f),
    })),
    settledIds,
    (id) => priorById.get(id),
  );
  // An earlier blocker the full review left unjudged is still open — unless a reply settled it since.
  const unjudged = [...new Set(halves.flatMap((h) => unsettledEarlierBlockers(h)))].filter((id) => !settledIds.has(id));
  const disputedBlocker = items.some((it) => it.status === 'reply_disputed' && it.severity === 'blocker');
  // THE WORKSPACE'S RULES (migration 0139); a failed read is the defaults, auto verdict off.
  const rules = await readVerdictRulesForPr(ctx, accountId, prId).catch(() => ({ ...DEFAULT_VERDICT_RULES, autoVerdict: false }));
  const dissent = halves.length >= 2 ? repliesDissent(await pairHalvesRaised(ctx, prId, halves), rules.pairStrictness) : null;
  const input = { open, unjudgedEarlierBlockers: unjudged.length, items, leftovers: rules.approveLeftovers, dissent };
  const why = repliesNotApproved(input);
  return {
    wanted: repliesVerdict(input),
    noBlocker: !disputedBlocker && unjudged.length === 0 && !open.some((f) => f.severity === 'blocker'),
    blockerTitle: disputedBlockerTitle(items),
    full,
    restsOnAuto: halves.every((h) => h.trigger === 'auto'),
    reason: why?.reason ?? null,
    heldApproval: why?.held === true,
    autoVerdict: rules.autoVerdict,
  };
}

/**
 * Each half of a pair as `repliesDissent` reads it: who ran it, its verdict and summary, and how many
 * findings it RAISED (non-praise, non-story) — a finding the consolidation merged and credited to
 * both ('both') counts for both halves, though only one half's row keeps it.
 */
async function pairHalvesRaised(
  ctx: AgentContext,
  prId: number,
  halves: readonly ClaudeReview[],
): Promise<Array<{ by: string; verdict: ClaudeReview['verdict']; summary: string | null; raised: number }>> {
  const pairId = halves.find((h) => h.pair?.pairId != null)?.pair?.pairId ?? null;
  const record = pairId != null ? await readPairConsolidation(ctx, pairId, prId).catch(() => null) : null;
  const raised = new Map<string, number>();
  for (const h of halves) {
    for (const f of h.findings) {
      if (f.severity === 'praise' || f.story != null) continue;
      const src = record?.sourceOf[String(f.id)] ?? sourceOfRun(h);
      for (const p of src === 'both' ? ['claude', 'codex'] : [src]) raised.set(p, (raised.get(p) ?? 0) + 1);
    }
  }
  return halves.map((h) => ({
    by: aiRunProviderName(h),
    verdict: h.verdict,
    summary: h.summary,
    raised: raised.get(sourceOfRun(h)) ?? 0,
  }));
}

/**
 * The latest FULL review the outcome rests on, as its succeeded halves: one run, or both halves of a
 * Claude + Codex pair (newest first). A pair whose newest half failed still counts the half that
 * succeeded. Empty when nothing usable succeeded.
 * ⚠ THE SAME ANCHOR AS THE PASS (replies-check.ts `latestFullReview`): the latest SUCCEEDED,
 * non-skip full review — a cancelled or failed run after it must not hide the review the pass judged.
 */
async function latestFullReviewHalves(ctx: AgentContext, prId: number, accountId: number): Promise<ClaudeReview[]> {
  const cr = s(ctx).claudeReviews;
  const anchor = (
    (await ctx.db
      .select({ id: cr.id })
      .from(cr)
      .where(
        and(
          eq(cr.prId, prId),
          eq(cr.accountId, accountId),
          eq(cr.status, 'succeeded'),
          isNull(cr.kind),
          or(isNull(cr.reviewMode), ne(cr.reviewMode, 'skip')),
        ),
      )
      .orderBy(desc(cr.id))
      .limit(1)
      .execute()) as Array<{ id: number }>
  )[0];
  if (!anchor) return [];
  const latest = await getClaudeReviewById(ctx, anchor.id, accountId);
  if (!latest || latest.prId !== prId) return [];
  const halves = [latest];
  const otherId = latest.pair?.otherReviewId ?? null;
  if (otherId != null) {
    const other = await getClaudeReviewById(ctx, otherId, accountId);
    if (other && other.prId === prId && other.kind !== 'replies') halves.push(other);
  }
  return halves.filter((r) => r.status === 'succeeded' && r.reviewMode !== 'skip');
}

export type RepliesOutcomePost =
  | { kind: 'off' }
  | { kind: 'not_found' }
  | { kind: 'already_claimed' }
  | { kind: 'nothing' }
  | { kind: 'done'; record: ClaudeAutoPostRecord };

async function claimRow(ctx: AgentContext, reviewId: number, rec: ClaudeAutoPostRecord): Promise<boolean> {
  const cr = s(ctx).claudeReviews;
  const rows = (await ctx.db
    .update(cr)
    .set({ autoPost: rec })
    .where(and(eq(cr.id, reviewId), isNull(cr.autoPost)))
    .returning({ id: cr.id })
    .execute()) as Array<{ id: number }>;
  return rows.length > 0;
}

async function writeRow(ctx: AgentContext, reviewId: number, rec: ClaudeAutoPostRecord): Promise<void> {
  const cr = s(ctx).claudeReviews;
  await ctx.db.update(cr).set({ autoPost: rec }).where(eq(cr.id, reviewId)).execute();
}

async function stampReviewDismissed(ctx: AgentContext, prId: number, githubReviewId: string): Promise<void> {
  const rv = s(ctx).reviews;
  await ctx.db
    .update(rv)
    .set({ state: 'dismissed' })
    .where(and(eq(rv.prId, prId), eq(rv.databaseId, githubReviewId)))
    .execute();
}

/**
 * Post the outcome of ONE succeeded AUTO replies pass (`reviewId`: the pass's row that carries the
 * record — its newest). Never throws.
 */
export async function maybePostRepliesOutcome(
  ctx: AgentContext,
  a: { accountId: number; prId: number; reviewId: number; outcome: RepliesOutcome },
  deps: AutoPostDeps = defaultAutoPostDeps,
): Promise<RepliesOutcomePost> {
  try {
    return await postOutcome(ctx, a, deps);
  } catch (err) {
    ctx.log.warn(`replies outcome review ${a.reviewId}: ${errText(err)}`);
    return { kind: 'not_found' };
  }
}

async function postOutcome(
  ctx: AgentContext,
  { accountId, prId, reviewId, outcome }: { accountId: number; prId: number; reviewId: number; outcome: RepliesOutcome },
  deps: AutoPostDeps,
): Promise<RepliesOutcomePost> {
  const ws = await readWorkspaceAutoPostForPr(ctx, accountId, prId);
  if (!ws || !ws.settings.enabled) return { kind: 'off' };
  const row = await getClaudeReviewById(ctx, reviewId, accountId);
  if (!row || row.prId !== prId || row.status !== 'succeeded' || row.kind !== 'replies') return { kind: 'not_found' };
  // AUTO passes only — a pass a person started never writes.
  if (row.trigger !== 'auto') return { kind: 'off' };
  if (row.autoPost != null) return { kind: 'already_claimed' };

  // ⚠ An automatic write rests only on AUTO runs (`restsOnAuto`): never on a run the reader started.
  if (!outcome.restsOnAuto) return { kind: 'nothing' };
  const wanted = ws.settings.autoVerdict ? outcome.wanted : null;
  // An approval the leftovers rule or a pair half held (auto verdict on): its reason may be posted.
  const heldByRules: ClaudeNotApproved | null =
    ws.settings.autoVerdict && outcome.heldApproval === true && wanted == null ? (outcome.reason ?? null) : null;
  const facts = await readAutoPostPrFacts(ctx, deps, accountId, ws.workspaceId, prId);
  if (!facts) return { kind: 'not_found' };
  const limnBlockIds = !facts.authorIsMe ? await loadLimnAutoBlockIds(ctx, accountId, prId, ALL_RUNS) : new Set<string>();
  const mayLift = outcome.noBlocker && limnBlockIds.size > 0;
  // Nothing the replies changed: nothing is recorded and nothing posts.
  if ((wanted == null || wanted === 'COMMENT') && !mayLift && heldByRules == null) return { kind: 'nothing' };

  const skip = async (reason: ClaudeAutoPostRecord['reason'], verdict?: ClaudeAutoVerdictRecord): Promise<RepliesOutcomePost> => {
    const rec: ClaudeAutoPostRecord = {
      status: 'skipped',
      at: nowIso(),
      reason,
      error: null,
      findingIds: [],
      postedFindingIds: [],
      githubReviewId: null,
      ...(verdict ? { verdict } : {}),
    };
    return (await claimRow(ctx, reviewId, rec)) ? { kind: 'done', record: rec } : { kind: 'already_claimed' };
  };
  const notEligible = autoPostEligibility(facts, ws.settings.scope);
  if (notEligible) return skip(notEligible);

  const pctx = await getReviewPostContext(ctx, reviewId, accountId);
  if (!pctx) return { kind: 'not_found' };
  const live = await deps.livePr(pctx.owner, pctx.name, pctx.prNumber);
  if (live.merged || live.state !== 'open') return skip('not_open');
  if (live.draft) return skip('draft');

  // THE IMPACT GATE (APPROVE only), before any live review read.
  let impact: { level: ImpactLevel; allowed: AutoApproveImpact } | undefined;
  if (wanted === 'APPROVE' && !facts.authorIsMe) {
    let level: ImpactLevel = 'unknown';
    try {
      level = (await deps.impactLevel?.(accountId, prId)) ?? 'unknown';
    } catch (err) {
      ctx.log.warn(`replies outcome review ${reviewId}: could not read the PR's impact: ${errText(err)}`);
    }
    impact = { level, allowed: ws.settings.approveImpact };
  }
  const impactHeld = impact != null && !impactAllowsApprove(impact.level, impact.allowed);
  let standing: { state: OwnLatestReview; reviewId: string | null } = { state: 'unreadable', reviewId: null };
  if (!facts.authorIsMe && ((wanted != null && wanted !== 'COMMENT' && !impactHeld) || mayLift)) {
    try {
      const [login, reviews] = await Promise.all([
        deps.accountLogin(accountId),
        deps.liveReviews(pctx.owner, pctx.name, pctx.prNumber),
      ]);
      standing = ownStandingReview(reviews, login, limnBlockIds);
    } catch (err) {
      ctx.log.warn(`replies outcome review ${reviewId}: could not read the PR's reviews: ${errText(err)}`);
    }
  }
  // Every blocker BEHIND Limn's own block must be judged before it is lifted (auto-post.ts).
  let blockersRemain = !outcome.noBlocker;
  if (!blockersRemain && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' && standing.reviewId != null) {
    try {
      const earlier = await loadEarlierFindings(ctx, accountId, prId, ALL_RUNS);
      blockersRemain = (await loadUnpostedBlockersOfBlock(ctx, accountId, prId, standing.reviewId, earlier)).length > 0;
    } catch (err) {
      ctx.log.warn(`replies outcome review ${reviewId}: could not read the blocking run's findings: ${errText(err)}`);
      blockersRemain = true;
    }
  }
  let verdict: ClaudeAutoVerdictRecord | null = null;
  if (wanted != null && wanted !== 'COMMENT') {
    verdict = verdictGate(wanted, { authorIsMe: facts.authorIsMe, ownLatest: standing.state, ...(impact ? { impact } : {}) });
    if (verdict.submitted === 'APPROVE' && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' && blockersRemain) {
      verdict = { ...verdict, submitted: 'COMMENT', heldReason: 'already_requested' };
    }
    verdict = withReason(verdict, outcome.reason ?? null);
  } else if (heldByRules != null) {
    verdict = { wanted: 'COMMENT', submitted: 'COMMENT', heldReason: heldByRules.heldReason, reasonText: heldByRules.text };
  }
  const liftId = !blockersRemain && standing.state === 'LIMN_AUTO_CHANGES_REQUESTED' ? standing.reviewId : null;
  const event = verdict?.submitted ?? 'COMMENT';
  // THE REASON, ALONE: an approval this pass computed and something held (the rules, or a gate) —
  // once per (PR, head).
  const heldApproval = heldByRules != null || (wanted === 'APPROVE' && event !== 'APPROVE');
  // Never a Limn-only gate reason (own PR, unreadable reviews: `reasonMayPost`), and never while a
  // review request of the reader is open (the review would answer it).
  const reasonText = heldApproval && reasonMayPost(verdict) ? (verdict?.reasonText ?? null) : null;
  const reasonOnly =
    event === 'COMMENT' &&
    reasonText != null &&
    facts.openRequestOfMe !== true &&
    !(await reasonPostedAtHead(ctx, accountId, prId, pctx.reviewHeadSha, [reviewId]).catch(() => true));
  // ⚠ Otherwise NO COMMENT-ONLY REVIEW: a held verdict (and no lift) is recorded, nothing posts.
  if (event === 'COMMENT' && liftId == null && !reasonOnly) {
    return verdict ? skip('nothing_new', verdict) : { kind: 'nothing' };
  }

  const record: ClaudeAutoPostRecord = {
    status: 'posting',
    at: nowIso(),
    reason: null,
    error: null,
    findingIds: [],
    postedFindingIds: [],
    githubReviewId: null,
    ...(verdict ? { verdict } : {}),
    // Recorded from the claim on: possibly posted, never sent again at this head.
    ...(reasonOnly ? { reasonPosted: reasonText, reasonOnly: true } : {}),
  };
  if (live.headSha !== pctx.reviewHeadSha) {
    const rec = { ...record, status: 'failed' as const, error: 'The PR changed since the replies were checked.' };
    return (await claimRow(ctx, reviewId, rec)) ? { kind: 'done', record: rec } : { kind: 'already_claimed' };
  }
  // ⚠ THE CLAIM, BEFORE ANY WRITE.
  if (!(await claimRow(ctx, reviewId, record))) return { kind: 'already_claimed' };

  const by = aiRunProviderName(row);
  // The footer names who ran the review the outcome rests on (both, for a pair).
  const footer = outcome.full?.pair != null ? PAIR_AUTO_POST_FOOTER : autoPostFooter(by);
  const errors: string[] = [];
  let reviewFailed = false;
  if (event !== 'COMMENT' || reasonOnly) {
    try {
      const posted = await ctx.review.postReview({
        owner: pctx.owner,
        name: pctx.name,
        prNumber: pctx.prNumber,
        reviewHeadSha: pctx.reviewHeadSha,
        body:
          event === 'COMMENT'
            ? withReasonLine(reasonText, footer)
            : `${repliesReviewBody(event, outcome.blockerTitle)}\n\n${autoPostFooter(by)}`,
        verdict: event,
        includedFindings: [],
        dryRun: false,
      });
      if (posted.headMoved) {
        reviewFailed = true;
        errors.push('The PR changed since the replies were checked.');
      } else if ('postedReviewId' in posted) {
        record.githubReviewId = posted.postedReviewId;
      }
    } catch (err) {
      reviewFailed = true;
      // A refused verdict created nothing; it is recorded and never sent again.
      if (isVerdictRefusal(err) && verdict && event !== 'COMMENT') {
        verdict = { ...verdict, submitted: 'COMMENT', heldReason: 'refused', refusedError: errText(err) };
        record.verdict = verdict;
      }
      errors.push(errText(err));
    }
  }
  const landed = record.githubReviewId != null;
  let dismissed = false;
  if (liftId != null && !(event !== 'COMMENT' && reviewFailed && !isRefused(verdict))) {
    if (landed && verdict?.submitted === 'APPROVE') {
      record.liftedBlock = { reviewId: liftId, how: 'superseded', error: null };
    } else {
      let res: { ok: true } | { ok: false; message: string };
      try {
        res = deps.dismissReview
          ? await deps.dismissReview(accountId, pctx.owner, pctx.name, pctx.prNumber, liftId, liftBlockMessage(by))
          : { ok: false, message: 'Dismissing is not available.' };
      } catch (err) {
        res = { ok: false, message: errText(err) };
      }
      if (res.ok) {
        dismissed = true;
        record.liftedBlock = { reviewId: liftId, how: 'dismissed', error: null };
        await stampReviewDismissed(ctx, prId, liftId).catch(() => {});
      } else {
        record.liftedBlock = { reviewId: liftId, how: 'dismiss_failed', error: res.message.slice(0, 300) };
      }
    }
  }
  const final: ClaudeAutoPostRecord = {
    ...record,
    status: landed || dismissed ? (errors.length > 0 ? 'partial' : 'posted') : 'failed',
    at: nowIso(),
    error: errors[0] ?? (record.liftedBlock?.how === 'dismiss_failed' ? record.liftedBlock.error : null),
  };
  await writeRow(ctx, reviewId, final).catch((err) =>
    ctx.log.warn(`replies outcome review ${reviewId}: could not record the result: ${errText(err)}`),
  );
  if (landed || dismissed) await deps.settle({ accountId, prId, log: ctx.log }).catch(() => ({ visible: false }));
  return { kind: 'done', record: final };
}

const isRefused = (v: ClaudeAutoVerdictRecord | null): boolean => v?.heldReason === 'refused';
