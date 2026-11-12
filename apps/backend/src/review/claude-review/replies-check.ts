import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { and, asc, desc, eq, gt, gte, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  aiProviderName,
  aiRunProvider,
  isStillOpenFollowUp,
  type AiProviderId,
  type ClaudeAutoPostWire,
  type ClaudeNotApproved,
  type ClaudeFollowUpItemRecord,
  type ClaudeRepliesCheckRun,
  type ClaudeRepliesCheckState,
  type ClaudeReviewFollowUpRecord,
  type ClaudeReviewModel,
  type ClaudeReviewTrigger,
  type RepliesCheckRefusal,
} from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { cleanupCloneCache } from '../clone-manager.js';
import { prepareMemberWorktrees } from '../ticket-review/prepare.js';
import { getCiPrContext } from '../ci-review/persist.js';
import { followUpProvider, preflightFor } from '../../ai/run-choice.js';
import { activeProviderId } from '../../ai/provider-setting.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { agenticRunReady } from './ai-ready.js';
import {
  AGENTIC_AI_ENABLED,
  REVIEW_APPLY_AUTH_ENV,
  pumpReviewLane,
  registerReviewSlotPeer,
  reviewPeersFor,
  runPeerOf,
  type ReviewPeer,
  reviewHeldForPr,
  reviewLaneWaiting,
  reviewSlotFree,
} from './manager.js';
import {
  autoPostWireOf,
  insertQueuedReview,
  isSettledJudgement,
  latestJudgementsSinceByProvider,
  loadPriorReviewForFollowUp,
  loadSettledByReplyFindings,
  markReviewCancelled,
  markReviewCommentsSeen,
  markReviewFailed,
  markReviewRanOn,
  markReviewRunning,
  saveReviewSuccess,
} from './persist.js';
import { attachFindingThreads } from './finding-replies.js';
import {
  reconcileFollowUp,
  selectPriorFindings,
  type FollowUpPlan,
  type PriorFindingForFollowUp,
} from './follow-up.js';
import type { ReviewFollowUpReport } from '../../platform/contract.js';
import type { AutoPostDeps } from './auto-post.js';
import type { PairCoverHold } from './auto-verdict.js';
import type { AutoResolveDeps } from './auto-resolve.js';
import { peerTexts, pickReviewNonce } from './prompts.js';
import { checkOutPeers } from '../peer-checkouts.js';
import { linkedPrsFor, linkedRunPeer, type LinkedPr } from './replies-linked-prs.js';
import {
  REPLIES_PASS_CODE_CONTEXT_LINES,
  coverReports,
  coverSummary,
  judgedThroughFor,
  newestJudgeableReplyMs,
  planRepliesPass,
  reconcileReplies,
  repliesPlanTexts,
  repliesSummary,
  unjudgedReplyFindings,
  type CodeAround,
  type JudgingRun,
} from './replies-pass.js';
import {
  buildCoverPrompt,
  buildRepliesPrompt,
  coverPlanTexts,
  coverSystemPrompt,
  repliesSystemPrompt,
} from './replies-check-prompt.js';
import { withWorktreeOwner } from '../worktree-owner.js';
import { automationAllowedForPr } from '../../db/external-repos.js';

// THE REPLIES PASS — the I/O half (docs/CLAUDE-REVIEW.md § The replies pass; the pure half is
// replies-pass.ts). A cheap run that judges ONLY people's replies on Limn's own posted findings, at
// the current head, without new commits.
//
// WHO STARTS IT: the auto-review sweeper (auto.ts — a same-head reply burst on Limn's own finding,
// settled 5 quiet minutes, at most REPLIES_PASS_AUTO_DAILY_CAP automatic passes per PR per rolling
// 24 h counted in the DB, the ONE automatic budget gate first), or a reader's "Check replies" on the
// AI Review tab. Never while a FULL review of the PR is queued or running (`reviewHeldForPr`: it
// judges the replies itself), never on a closed PR, never with nothing to judge (no row, no model).
//
// THE RUN: per thread, the PROVIDER of the run that OWNS the thread (the first inline-posted finding
// up the re-raise chain) when it can still run and is not over its usage limit, else the default
// (`followUpProvider`, which moves off a locked provider too); one agent run —
// one `claude_reviews` row, `kind = 'replies'` — per provider, one after the other in the ONE shared
// review slot (`registerReviewSlotPeer`). Standard depth, the Effort setting, read-only: Read / Glob /
// Grep in the PR's read-only worktree behind the path guard, Bash denied (replies-check-agent.ts).
// Beside it, read-only and behind the same guard (each checkout a root, removed after the pass): the
// RELATED REPOS' code a full review of the PR reads (`reviewPeersFor`, the same peers and checkouts),
// and at most REPLIES_LINKED_PR_MAX pull requests a judged reply LINKS to in the PR's own or a related
// repo (replies-linked-prs.ts: an open one at its head, a merged one as its default branch), so "fixed
// in the backend PR" can be checked instead of left not_checked.
//
// AFTER IT: an AUTO pass hands each row to auto resolve and auto pushback (their own switches and
// claimed records — at most ONE pushback per thread, ever), then the outcome re-check
// (replies-outcome.ts). A MANUAL pass writes nothing to GitHub: its rows hold drafts ("Post reply")
// and the outcome the replies point to (the newest row's `verdict`).

// The STANDARD depth (Check threads' model): Codex resolves the role to its own standard model.
export const REPLIES_CHECK_MODEL: ClaudeReviewModel = 'claude-sonnet-5';
const AUTO_MAX = 20;
const MANUAL_MAX = 50;
const ALL_RUNS = Number.MAX_SAFE_INTEGER;

/* eslint-disable @typescript-eslint/no-explicit-any */
const sch = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

interface Group {
  provider: AiProviderId;
  reviewId: number;
  findingIds: number[];
}

interface Job {
  ctx: AgentContext;
  accountId: number;
  prId: number;
  trigger: ClaudeReviewTrigger;
  groups: Group[];
  // The sweeper's newest reply time (auto) — recorded as the rows' coverage with the replies judged.
  commentsThroughMs: number | null;
  // A reader's press of the sweep: the budget is not asked again.
  pressed: boolean;
  // A COVER PASS (`startCoverCheck`): the failed half's provider, whose open findings it checks, and
  // the coverage its row records (the pair's start: it claims no reply the pair did not already see).
  cover?: { failed: AiProviderId; coverageMs: number | null };
  // Called ONCE when the job ends (ran, failed, cancelled or dropped from the lane): the pair waits
  // on it before it posts (`runCoverCheck`).
  onDone?: () => void;
}

/** End a job's waiter (once). */
function jobDone(job: Job): void {
  const done = job.onDone;
  job.onDone = undefined;
  try {
    done?.();
  } catch {
    /* a waiter never fails the lane */
  }
}

const claimed = new Map<string, number>();
const lane: Job[] = [];
const running = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const phaseByKey = new Map<string, 'queued' | 'running'>();

const keyOf = (accountId: number, prId: number): string => `${accountId}:${prId}`;
const isAuto = (j: Job): boolean => j.trigger === 'auto';

registerReviewSlotPeer({ inFlight: () => running.size, pump: () => pump() });

// ---- planning (DB-only) ----

interface FullReviewMeta {
  id: number;
  headSha: string;
  createdAt: Date;
  commentsThrough: Date | null;
  // A Claude + Codex pair half: the FIRST half's id. NULL on an ordinary run.
  pairId: number | null;
  // Its follow-up record (which earlier findings it judged).
  followUp: ClaudeReviewFollowUpRecord | null;
}

/** The latest succeeded FULL review that read code (the one the follow-up chain anchors on). */
async function latestFullReview(ctx: AgentContext, accountId: number, prId: number): Promise<FullReviewMeta | null> {
  const cr = sch(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({
      id: cr.id,
      headSha: cr.headSha,
      createdAt: cr.createdAt,
      commentsThrough: cr.commentsThrough,
      pairId: cr.pairId,
      followUp: cr.followUp,
    })
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
    .execute()) as FullReviewMeta[];
  return rows[0] ?? null;
}

interface PassRow {
  id: number;
  status: string;
  trigger: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  commentsThrough: Date | null;
  followUp: ClaudeReviewFollowUpRecord | null;
  verdict: string | null;
  error: string | null;
  autoPost: unknown;
  // Why the outcome is not an approval (migration 0145); absent on an older schema.
  verdictReason?: unknown;
}

/** The replies passes of this PR after a review id, oldest first (any status). */
async function passesAfter(ctx: AgentContext, accountId: number, prId: number, afterId: number): Promise<PassRow[]> {
  const cr = sch(ctx).claudeReviews;
  return (await ctx.db
    .select({
      id: cr.id,
      status: cr.status,
      trigger: cr.trigger,
      createdAt: cr.createdAt,
      finishedAt: cr.finishedAt,
      commentsThrough: cr.commentsThrough,
      followUp: cr.followUp,
      verdict: cr.verdict,
      error: cr.error,
      autoPost: cr.autoPost,
      ...(cr.verdictReason ? { verdictReason: cr.verdictReason } : {}),
    })
    .from(cr)
    .where(and(eq(cr.prId, prId), eq(cr.accountId, accountId), eq(cr.kind, 'replies'), gt(cr.id, afterId)))
    .orderBy(asc(cr.id))
    .execute()) as PassRow[];
}

export interface PlannedReplies {
  full: FullReviewMeta;
  // The findings with a reply no run has judged yet, each with its thread.
  findings: PriorFindingForFollowUp[];
  // The newest judgeable reply among them (ms).
  newestReplyMs: number | null;
}

/**
 * What a pass would judge now: the findings the next full review would follow up (own + carried,
 * minus the settled), with their threads, whose newest judgeable reply is newer than their latest
 * judgement. A refusal when there is nothing to judge. DB-only. Exported for the tests and the GET.
 */
export async function planRepliesCheck(
  ctx: AgentContext,
  accountId: number,
  prId: number,
): Promise<PlannedReplies | { refused: RepliesCheckRefusal }> {
  const full = await latestFullReview(ctx, accountId, prId);
  if (!full) return { refused: 'no_review' };
  const settled = await loadSettledByReplyFindings(ctx, prId, accountId, ALL_RUNS);
  const settledIds = new Set(settled.map((f) => f.id));
  // EACH PROVIDER'S CHAIN, always: a Claude + Codex pair is ONE review in two runs (each half's posted
  // findings and their replies are this pass's to judge), and after a run on one provider the other
  // provider's comments are still on the PR. Each chain is read as a pair half reads it (its own
  // findings only), so a finding is listed by the chain of the provider that raised it.
  const priors = await Promise.all(
    (['claude', 'codex'] as const).map((p) => loadPriorReviewForFollowUp(ctx, prId, accountId, ALL_RUNS, settledIds, p, true)),
  );
  const seen = new Set<number>();
  const priorFindings = priors
    .flatMap((p) => p?.findings ?? [])
    .filter((f) => (seen.has(f.id) ? false : (seen.add(f.id), true)));
  if (priorFindings.length === 0) return { refused: 'nothing_to_check' };
  const attached = await attachFindingThreads(ctx, accountId, prId, priorFindings);
  const passes = (await passesAfter(ctx, accountId, prId, full.id)).filter((p) => p.status === 'succeeded');
  const judged = judgedThroughFor(
    { createdAtMs: full.createdAt.getTime(), commentsThroughMs: full.commentsThrough?.getTime() ?? null },
    passes.map((p) => ({
      createdAtMs: p.createdAt.getTime(),
      commentsThroughMs: p.commentsThrough?.getTime() ?? null,
      items: p.followUp?.items ?? [],
    })),
    await baseRunsFor(ctx, accountId, prId, full, priors),
  );
  const findings = unjudgedReplyFindings(attached, judged);
  if (findings.length === 0) return { refused: 'nothing_to_check' };
  let newest: number | null = null;
  for (const f of findings) {
    const t = newestJudgeableReplyMs(f);
    if (t != null && (newest == null || t > newest)) newest = t;
  }
  return { full, findings, newestReplyMs: newest };
}

/**
 * Each finding's judged-through base. A PAIR: the half whose chain listed it (`pairBaseRuns`). A
 * single run: the same, except a finding the full review itself followed up (sent to the model — its
 * own, or the other provider's carried across) takes the full review.
 */
async function baseRunsFor(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  full: FullReviewMeta,
  priors: ReadonlyArray<{ reviewId: number; findings: ReadonlyArray<{ id: number }> } | null>,
): Promise<Map<number, JudgingRun>> {
  const base = await pairBaseRuns(ctx, accountId, prId, priors);
  if (full.pairId == null) {
    for (const it of full.followUp?.items ?? []) if (it.sent) base.delete(it.priorFindingId);
  }
  return base;
}

/**
 * A PAIR's per-finding judged-through base: the run (half) whose follow-up chain listed the finding.
 * The Codex half follows up only Codex's findings, so its later start must not stand for a reply on
 * a Claude thread that arrived while the Claude half ran. A finding listed by both chains takes the
 * EARLIER-reaching run (a reply is judged again rather than never).
 */
async function pairBaseRuns(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  priors: ReadonlyArray<{ reviewId: number; findings: ReadonlyArray<{ id: number }> } | null>,
): Promise<Map<number, JudgingRun>> {
  const out = new Map<number, JudgingRun>();
  const ids = [...new Set(priors.flatMap((p) => (p ? [p.reviewId] : [])))];
  if (ids.length === 0) return out;
  const cr = sch(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id, createdAt: cr.createdAt, commentsThrough: cr.commentsThrough })
    .from(cr)
    .where(and(inArray(cr.id, ids), eq(cr.prId, prId), eq(cr.accountId, accountId)))
    .execute()) as Array<{ id: number; createdAt: Date; commentsThrough: Date | null }>;
  const runOf = new Map<number, JudgingRun>(
    rows.map((r) => [r.id, { createdAtMs: r.createdAt.getTime(), commentsThroughMs: r.commentsThrough?.getTime() ?? null }]),
  );
  const reach = (r: JudgingRun): number => Math.max(r.createdAtMs, r.commentsThroughMs ?? 0);
  for (const p of priors) {
    const run = p ? runOf.get(p.reviewId) : undefined;
    if (!p || !run) continue;
    for (const f of p.findings) {
      const prev = out.get(f.id);
      if (!prev || reach(run) < reach(prev)) out.set(f.id, run);
    }
  }
  return out;
}

/** Each finding's thread OWNER's provider (the run that posted the comment), by finding id. */
async function ownerProviders(
  ctx: AgentContext,
  findings: readonly PriorFindingForFollowUp[],
): Promise<Map<number, AiProviderId>> {
  // The thread's owner, or a PR-level finding's (the row that posted the PR comment).
  const ownerOf = (f: PriorFindingForFollowUp): number | undefined => f.thread?.threadFindingId ?? f.conversation?.ownerFindingId;
  const ownerIds = [...new Set(findings.map(ownerOf).filter((x): x is number => x != null))];
  const out = new Map<number, AiProviderId>();
  if (ownerIds.length === 0) return out;
  const t = sch(ctx);
  const rows = (await ctx.db
    .select({ id: t.claudeReviewFindings.id, provider: t.claudeReviews.provider, model: t.claudeReviews.model })
    .from(t.claudeReviewFindings)
    .innerJoin(t.claudeReviews, eq(t.claudeReviews.id, t.claudeReviewFindings.reviewId))
    .where(inArray(t.claudeReviewFindings.id, ownerIds))
    .execute()) as Array<{ id: number; provider: string | null; model: string | null }>;
  const byOwner = new Map(rows.map((r) => [r.id, aiRunProvider(r.provider, r.model)]));
  for (const f of findings) {
    const owner = ownerOf(f);
    const p = owner != null ? byOwner.get(owner) : undefined;
    if (p) out.set(f.id, p);
  }
  return out;
}

/** Threads grouped by the provider that runs them (the owner's when it can, else the default). Pure. */
export function groupByProvider(
  findings: readonly PriorFindingForFollowUp[],
  ownerOf: ReadonlyMap<number, AiProviderId>,
  runsOn: (owner: AiProviderId | null) => AiProviderId,
): Array<{ provider: AiProviderId; findingIds: number[] }> {
  const by = new Map<AiProviderId, number[]>();
  for (const f of findings) {
    const p = runsOn(ownerOf.get(f.id) ?? null);
    const list = by.get(p) ?? [];
    list.push(f.id);
    by.set(p, list);
  }
  // Claude first, then Codex: a stable order (the pass runs them one after the other).
  return (['claude', 'codex'] as const).filter((p) => by.has(p)).map((p) => ({ provider: p, findingIds: by.get(p)! }));
}

/** AUTOMATIC passes of this PR created at or after `sinceMs` (the per-PR cap's count; rows). */
export async function countAutoRepliesPassesSince(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  sinceMs: number,
): Promise<number> {
  const cr = sch(ctx).claudeReviews;
  const rows = (await ctx.db
    .select({ id: cr.id })
    .from(cr)
    .where(
      and(
        eq(cr.prId, prId),
        eq(cr.accountId, accountId),
        eq(cr.kind, 'replies'),
        eq(cr.trigger, 'auto'),
        gte(cr.createdAt, new Date(sinceMs)),
      ),
    )
    .execute()) as Array<{ id: number }>;
  return rows.length;
}

// ---- the door ----

export type StartRepliesCheckResult =
  | { outcome: 'queued'; reviewId: number; threads: number }
  | { outcome: 'already_running'; reviewId: number | null }
  | { outcome: 'refused'; reason: RepliesCheckRefusal }
  | { outcome: 'not_found' }
  | { outcome: 'not_open' }
  | { outcome: 'not_ready' }
  | { outcome: 'over_budget' }
  | { outcome: 'busy' }
  | { outcome: 'disabled' };

export interface StartRepliesCheckArgs {
  accountId: number;
  prId: number;
  trigger: ClaudeReviewTrigger;
  // Auto: the sweeper's newest reply on a Limn finding (the burst it covers). Manual: absent.
  commentsThroughMs?: number | null;
  // The reader pressed the sweep: the spend budget is not asked again (the SPA's confirm ran).
  pressed?: boolean;
}

/**
 * Queue one PR's replies pass (the route's and the sweeper's ONE door). The claim is taken before any
 * await; nothing to judge, a full review in flight, a closed PR ⇒ refused with no row and no model.
 */
export async function startRepliesCheck(ctx: AgentContext, a: StartRepliesCheckArgs): Promise<StartRepliesCheckResult> {
  if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
  const key = keyOf(a.accountId, a.prId);
  const held = claimed.get(key);
  if (held != null) return { outcome: 'already_running', reviewId: held > 0 ? held : null };
  // ⚠ A FULL REVIEW of the PR is queued or running: it judges the replies itself.
  if (reviewHeldForPr(a.prId)) return { outcome: 'refused', reason: 'review_in_progress' };
  const auto = a.trigger === 'auto';
  if (lane.filter((j) => isAuto(j) === auto).length >= (auto ? AUTO_MAX : MANUAL_MAX)) return { outcome: 'busy' };
  claimed.set(key, -1); // reserve synchronously before any await
  try {
    const pr = await getCiPrContext(ctx, a.accountId, a.prId);
    if (!pr || !pr.headSha) {
      claimed.delete(key);
      return { outcome: 'not_found' };
    }
    if (pr.state !== 'open') {
      claimed.delete(key);
      return { outcome: 'not_open' };
    }
    if (auto) {
      // AI not set up: wait, never fail (ai-ready.ts). Over the spend budget: skipped, never queued.
      if (!agenticRunReady(ctx, 'thread_check')) {
        claimed.delete(key);
        return { outcome: 'not_ready' };
      }
    }
    const planned = await planRepliesCheck(ctx, a.accountId, a.prId);
    if ('refused' in planned) {
      claimed.delete(key);
      return { outcome: 'refused', reason: planned.refused };
    }
    // A review started while we read: it will judge them.
    if (reviewHeldForPr(a.prId)) {
      claimed.delete(key);
      return { outcome: 'refused', reason: 'review_in_progress' };
    }
    const owners = await ownerProviders(ctx, planned.findings);
    const detect = preflightFor(ctx);
    // The OWNER's provider when it can still run the kind, else the default (`followUpProvider`).
    // ⚠ A provider OVER ITS USAGE LIMIT is passed over for one with capacity (`followUpProvider`): a
    // thread Codex raised is judged by Claude while Codex is locked out, as the OTHER provider's
    // (never disputed). Before 2026-11-11 the owner was used whenever it was signed in, so every pass on
    // Codex's threads failed until its limit reset.
    const groups = groupByProvider(planned.findings, owners, (owner) =>
      followUpProvider(owner ?? activeProviderId(), 'thread_check', detect),
    );
    // Over the spend budget, or every provider it would use is locked out: skipped, never queued. The
    // gate is asked about the providers the pass RUNS on, not the default.
    if (auto && !a.pressed) {
      // EXTERNAL REPOS (db/external-repos.ts): no automatic run on an external repo's PR.
      if (!(await automationAllowedForPr(a.accountId, a.prId, ctx))) {
        claimed.delete(key);
        return { outcome: 'disabled' };
      }
      for (const p of new Set(groups.map((g) => g.provider))) {
        if (!(await automaticRunAllowed(ctx, a.accountId, 'replies check', p))) {
          claimed.delete(key);
          return { outcome: 'over_budget' };
        }
      }
    }
    const rows: Group[] = [];
    for (const g of groups) {
      const reviewId = await insertQueuedReview(
        ctx,
        a.prId,
        pr.headSha,
        REPLIES_CHECK_MODEL,
        a.accountId,
        [],
        a.trigger,
        g.provider,
        false,
        null,
        'replies',
      );
      rows.push({ provider: g.provider, reviewId, findingIds: g.findingIds });
    }
    const job: Job = {
      ctx,
      accountId: a.accountId,
      prId: a.prId,
      trigger: a.trigger,
      groups: rows,
      commentsThroughMs: a.commentsThroughMs ?? null,
      pressed: a.pressed === true,
    };
    claimed.set(key, rows[0]!.reviewId);
    phaseByKey.set(key, 'queued');
    const firstAuto = lane.findIndex(isAuto);
    if (!auto && firstAuto >= 0) lane.splice(firstAuto, 0, job);
    else lane.push(job);
    pump();
    return { outcome: 'queued', reviewId: rows[0]!.reviewId, threads: planned.findings.length };
  } catch (err) {
    claimed.delete(key);
    throw err;
  }
}

// ---- THE COVER PASS (docs/CLAUDE-REVIEW.md § Claude + Codex, a failed half is covered) ----
//
// One half of a Claude + Codex pair failed or never started. Its provider's open findings would then
// be judged by nobody at this head (the half that ran is a pair half: it never carries the other
// provider's findings). Straight after the pair ends, the provider that succeeded runs a SHORT
// follow-up-only pass over them, through this lane: the same agent, tools, path guard and row shape
// as a replies pass (`kind = 'replies'`, so every "latest review" reader skips it and its items
// overlay the chain like a pass's), with `followUp.cover` naming the failed provider. It may mark a
// finding addressed (auto resolve may then close the thread) but never disputes one and never pushes
// back. ⚠ THE PAIR POSTS AFTER IT (changed 2026-11-09, manager.ts `startPairCover` → `runCoverCheck`):
// its still-open warning-or-above items count as earlier points in the pair's auto verdict, and a
// cover that could not check them (failed, skipped, cancelled) holds the approval (`pairCoverHold`).
// An AUTO pair's cover asks the spend budget first (skipped, never queued, when over). Nothing to
// check (every open finding already SETTLED since) ⇒ no row, no model.

export interface StartCoverCheckArgs {
  accountId: number;
  prId: number;
  // The half that succeeded (it runs the pass) and the one that failed (whose findings it checks).
  survivor: AiProviderId;
  failed: AiProviderId;
  trigger: ClaudeReviewTrigger;
  // A reader's press started the pair: the budget is not asked again.
  pressed?: boolean;
  // The pair's first half: the cover records the pair's start as its coverage.
  pairId: number;
  // Called once the queued pass ends (only when the outcome is 'queued').
  onDone?: () => void;
}

/** The failed provider's open findings no run of the survivor's provider SETTLED since. DB-only. */
export async function planCoverCheck(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  failed: AiProviderId,
  survivor: AiProviderId,
): Promise<{ reviewId: number; headSha: string; findings: PriorFindingForFollowUp[] } | null> {
  const settled = await loadSettledByReplyFindings(ctx, prId, accountId, ALL_RUNS);
  const chain = await loadPriorReviewForFollowUp(ctx, prId, accountId, ALL_RUNS, new Set(settled.map((f) => f.id)), failed, true);
  if (!chain || chain.findings.length === 0) return null;
  // Only what the survivor's provider SETTLED since is left out; one it last judged still open is
  // checked again, with that judgement as its prior status (so a same-head re-check keeps it).
  const latest = await latestJudgementsSinceByProvider(ctx, prId, accountId, survivor, chain.reviewId, ALL_RUNS);
  const open = chain.findings.filter((f) => !isSettledJudgement(latest.get(f.id)));
  if (open.length === 0) return null;
  const attached = await attachFindingThreads(ctx, accountId, prId, open);
  return {
    reviewId: chain.reviewId,
    headSha: chain.headSha,
    findings: attached.map((f) => {
      const j = latest.get(f.id);
      return { ...f, carried: true, raisedBy: failed, ...(j ? { priorStatus: j } : {}) };
    }),
  };
}

/** Queue a pair's cover pass. Never throws; the outcome names why nothing was queued. */
export async function startCoverCheck(ctx: AgentContext, a: StartCoverCheckArgs): Promise<StartRepliesCheckResult> {
  try {
    if (!AGENTIC_AI_ENABLED) return { outcome: 'disabled' };
    if (a.survivor === a.failed) return { outcome: 'refused', reason: 'nothing_to_check' };
    const key = keyOf(a.accountId, a.prId);
    const held = claimed.get(key);
    if (held != null) return { outcome: 'already_running', reviewId: held > 0 ? held : null };
    if (reviewHeldForPr(a.prId)) return { outcome: 'refused', reason: 'review_in_progress' };
    const auto = a.trigger === 'auto';
    if (lane.filter((j) => isAuto(j) === auto).length >= (auto ? AUTO_MAX : MANUAL_MAX)) return { outcome: 'busy' };
    claimed.set(key, -1);
    try {
      const pr = await getCiPrContext(ctx, a.accountId, a.prId);
      if (!pr || !pr.headSha) {
        claimed.delete(key);
        return { outcome: 'not_found' };
      }
      if (pr.state !== 'open') {
        claimed.delete(key);
        return { outcome: 'not_open' };
      }
      // EXTERNAL REPOS (db/external-repos.ts): no automatic run on an external repo's PR.
      if (auto && !a.pressed && !(await automationAllowedForPr(a.accountId, a.prId, ctx))) {
        claimed.delete(key);
        return { outcome: 'disabled' };
      }
      if (auto && !a.pressed && !(await automaticRunAllowed(ctx, a.accountId, 'cover check', a.survivor))) {
        claimed.delete(key);
        return { outcome: 'over_budget' };
      }
      const planned = await planCoverCheck(ctx, a.accountId, a.prId, a.failed, a.survivor);
      if (!planned) {
        claimed.delete(key);
        return { outcome: 'refused', reason: 'nothing_to_check' };
      }
      const cr = sch(ctx).claudeReviews;
      const start = (await ctx.db
        .select({ createdAt: cr.createdAt })
        .from(cr)
        .where(and(eq(cr.id, a.pairId), eq(cr.accountId, a.accountId)))
        .execute()) as Array<{ createdAt: Date }>;
      const reviewId = await insertQueuedReview(
        ctx,
        a.prId,
        pr.headSha,
        REPLIES_CHECK_MODEL,
        a.accountId,
        [],
        a.trigger,
        a.survivor,
        false,
        null,
        'replies',
      );
      const job: Job = {
        ctx,
        accountId: a.accountId,
        prId: a.prId,
        trigger: a.trigger,
        groups: [{ provider: a.survivor, reviewId, findingIds: planned.findings.map((f) => f.id) }],
        commentsThroughMs: null,
        pressed: a.pressed === true,
        cover: { failed: a.failed, coverageMs: start[0]?.createdAt.getTime() ?? null },
        ...(a.onDone ? { onDone: a.onDone } : {}),
      };
      claimed.set(key, reviewId);
      phaseByKey.set(key, 'queued');
      const firstAuto = lane.findIndex(isAuto);
      if (!auto && firstAuto >= 0) lane.splice(firstAuto, 0, job);
      else lane.push(job);
      pump();
      return { outcome: 'queued', reviewId, threads: planned.findings.length };
    } catch (err) {
      claimed.delete(key);
      throw err;
    }
  } catch (err) {
    ctx.log.warn(`cover check pr ${a.prId}: ${err instanceof Error ? err.message : String(err)}`);
    return { outcome: 'refused', reason: 'nothing_to_check' };
  }
}

// The longest a pair waits for its cover pass before it posts anyway (then as UNCHECKED: no approval
// while the failed provider's warning-or-above findings are open).
export const COVER_WAIT_MAX_MS = 30 * 60_000;

/**
 * START A PAIR'S COVER PASS AND WAIT FOR IT (docs/CLAUDE-REVIEW.md § Claude + Codex → A FAILED HALF IS
 * COVERED, changed 2026-11-09): the pair posts only after it. Resolves to the cover row's id once the
 * pass ended (ran, failed or was cancelled), or null when none was queued (nothing to check, over the
 * budget, refused, busy). At most `maxWaitMs`; then null-or-the-row as it stands. Never throws.
 */
export async function runCoverCheck(
  ctx: AgentContext,
  a: Omit<StartCoverCheckArgs, 'onDone'>,
  maxWaitMs = COVER_WAIT_MAX_MS,
): Promise<{ result: StartRepliesCheckResult; coverReviewId: number | null }> {
  let markDone: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  const result = await startCoverCheck(ctx, { ...a, onDone: () => markDone() });
  if (result.outcome !== 'queued') return { result, coverReviewId: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, maxWaitMs);
    (timer as { unref?: () => void }).unref?.();
  });
  await Promise.race([ended, timedOut]);
  if (timer) clearTimeout(timer);
  return { result, coverReviewId: result.reviewId };
}

const sevCount = (sev: string | null | undefined): 'blockers' | 'warnings' | null =>
  sev === 'blocker' ? 'blockers' : sev === 'warning' ? 'warnings' : null;

/**
 * WHAT THE COVER LEFT FOR THE PAIR'S VERDICT (auto-verdict.ts `PairCoverHold`), DB-only. With a
 * SUCCEEDED cover row: its still-open warning-or-above items are `open`, its 'not_checked' ones
 * (over the cap) `unchecked`. With none (the cover failed, was cancelled, skipped by the budget gate,
 * refused, or is still running past the wait): every warning-or-above finding of the failed provider
 * the survivor's provider has not settled (`planCoverCheck`) is `unchecked`. Never throws: a failed
 * read counts nothing as checked — every open one of the failed chain, else zero.
 */
export async function pairCoverHold(
  ctx: AgentContext,
  a: { accountId: number; prId: number; failed: AiProviderId; survivor: AiProviderId; coverReviewId: number | null },
): Promise<PairCoverHold> {
  const hold: PairCoverHold = { by: aiProviderName(a.failed), open: { blockers: 0, warnings: 0 }, unchecked: { blockers: 0, warnings: 0 } };
  try {
    if (a.coverReviewId != null) {
      const cr = sch(ctx).claudeReviews;
      const rows = (await ctx.db
        .select({ status: cr.status, followUp: cr.followUp, kind: cr.kind })
        .from(cr)
        .where(and(eq(cr.id, a.coverReviewId), eq(cr.accountId, a.accountId), eq(cr.prId, a.prId)))
        .execute()) as Array<{ status: string; followUp: ClaudeReviewFollowUpRecord | null; kind: string | null }>;
      const row = rows[0];
      if (row?.status === 'succeeded' && row.kind === 'replies' && row.followUp?.cover != null) {
        for (const it of row.followUp.items ?? []) {
          const k = sevCount(it.severity);
          if (k == null) continue;
          if (it.status === 'not_checked') hold.unchecked[k] += 1;
          else if (isStillOpenFollowUp(it.status)) hold.open[k] += 1;
        }
        return hold;
      }
    }
    const planned = await planCoverCheck(ctx, a.accountId, a.prId, a.failed, a.survivor);
    for (const f of planned?.findings ?? []) {
      const k = sevCount(f.severity);
      if (k != null) hold.unchecked[k] += 1;
    }
  } catch (err) {
    ctx.log.warn(`cover check pr ${a.prId}: could not read what it left open: ${err instanceof Error ? err.message : String(err)}`);
  }
  return hold;
}

/** Run one cover group (re-planned at run time) and store it. The row's items, or null (failed / none). */
async function runCoverGroup(
  job: Job,
  failed: AiProviderId,
  g: Group,
  run: {
    headSha: string;
    pr: NonNullable<Awaited<ReturnType<typeof getCiPrContext>>>;
    worktreePath: string | null;
    scratch: string;
    controller: AbortController;
  },
): Promise<{ reviewId: number; items: ClaudeFollowUpItemRecord[] } | null> {
  const { ctx, accountId, prId } = job;
  const { headSha, pr, worktreePath } = run;
  const planned = await planCoverCheck(ctx, accountId, prId, failed, g.provider);
  if (!planned) {
    await markReviewFailed(ctx, g.reviewId, 'Nothing left to check: the findings were judged meanwhile.');
    return null;
  }
  await markReviewRunning(ctx, g.reviewId);
  const plan: FollowUpPlan = selectPriorFindings({ reviewId: planned.reviewId, headSha: planned.headSha, findings: planned.findings }, headSha);
  const code = new Map<number, CodeAround>();
  if (worktreePath) {
    for (const { finding: f } of plan.sent) {
      const c = codeAround(worktreePath, f.path, f.line);
      if (c) code.set(f.id, c);
    }
  }
  // Every sent finding decided in code (raised at this head, nothing moved): no model.
  const needsModel = plan.sent.some(({ finding: f }) => !plan.locked.has(f.id) || f.thread?.replies.length || f.conversation?.replies.length);
  let reported: ReviewFollowUpReport[] = [];
  let telemetry: { costUsd: number | null; inputTokens: number | null; outputTokens: number | null; numTurns: number | null } = {
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 0,
  };
  let usageRecorded = false;
  if (needsModel) {
    const nonce = pickReviewNonce([pr.title, ...coverPlanTexts(plan, code)]);
    const prompt = buildCoverPrompt({
      repoFullName: `${pr.owner}/${pr.name}`,
      number: pr.number,
      title: pr.title,
      headSha,
      worktreePath,
      plan,
      code,
      nonce,
      provider: g.provider,
    });
    const { runRepliesCheckAgent } = await import('./replies-check-agent.js');
    const res = await runRepliesCheckAgent({
      model: REPLIES_CHECK_MODEL,
      cwd: run.scratch,
      worktrees: worktreePath ? [worktreePath] : [],
      systemPrompt: coverSystemPrompt(g.provider),
      prompt,
      applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
      abortController: run.controller,
      usage: { accountId, prId, repoId: pr.repoId ?? null },
      provider: g.provider,
    });
    if (res.ranOn) await markReviewRanOn(ctx, g.reviewId, res.ranOn);
    telemetry = { costUsd: res.costUsd, inputTokens: res.inputTokens, outputTokens: res.outputTokens, numTurns: res.numTurns };
    usageRecorded = res.usageRecorded === true;
    if (res.aborted) {
      await markReviewCancelled(ctx, g.reviewId);
      return null;
    }
    if (!res.submitted) {
      await markReviewFailed(ctx, g.reviewId, res.failureReason ?? 'The check of the other review failed.', telemetry);
      return null;
    }
    reported = coverReports(res.replies);
  }
  const items = reconcileFollowUp(plan, reported);
  await saveReviewSuccess(ctx, g.reviewId, {
    scope: worktreePath ? 'worktree' : 'diff_only',
    summary: coverSummary(items, failed),
    verdict: 'COMMENT',
    ...telemetry,
    ...(usageRecorded ? { usageRecorded: true } : {}),
    excludedFiles: [],
    findings: [],
    followUp: {
      priorReviewId: planned.reviewId,
      priorHeadSha: planned.headSha,
      headMoved: planned.headSha !== headSha,
      changesSinceShown: false,
      items,
      cover: { provider: failed },
    },
    threadAssessments: null,
  });
  return { reviewId: g.reviewId, items };
}

/** Is a pass of this PR queued or running here? */
export function repliesCheckHeld(accountId: number, prId: number): boolean {
  return claimed.has(keyOf(accountId, prId));
}

/** How many more automatic passes the lane takes right now. */
export function repliesCheckAutoRoom(): number {
  return Math.max(0, AUTO_MAX - lane.filter(isAuto).length);
}

/** One PR's live pass (account-checked), or null. */
export function liveRepliesCheck(accountId: number, prId: number): 'queued' | 'running' | null {
  const k = keyOf(accountId, prId);
  if (!claimed.has(k)) return null;
  return phaseByKey.get(k) ?? 'queued';
}

/** Cancel this account's queued or running pass of a PR. False when there is none. */
export function requestRepliesCheckCancel(accountId: number, prId: number): boolean {
  const k = keyOf(accountId, prId);
  const live = running.get(k);
  if (live) {
    controllers.get(k)?.abort();
    return true;
  }
  const idx = lane.findIndex((j) => j.accountId === accountId && j.prId === prId);
  if (idx < 0) return false;
  const job = lane.splice(idx, 1)[0]!;
  claimed.delete(k);
  phaseByKey.delete(k);
  for (const g of job.groups) void markReviewCancelled(job.ctx, g.reviewId).catch(() => {});
  jobDone(job);
  return true;
}

function pump(): void {
  for (;;) {
    if (lane.length === 0 || !reviewSlotFree()) return;
    const waiting = reviewLaneWaiting();
    if (waiting.manual) return;
    const idx = lane.findIndex((j) => !isAuto(j));
    if (idx >= 0) {
      launch(lane.splice(idx, 1)[0]!);
      continue;
    }
    if (waiting.auto) return;
    launch(lane.shift()!);
  }
}

function launch(job: Job): void {
  const k = keyOf(job.accountId, job.prId);
  running.set(k, job);
  phaseByKey.set(k, 'running');
  const controller = new AbortController();
  controllers.set(k, controller);
  void runJob(job, controller)
    .catch((err) => {
      job.ctx.log.error({ err }, `replies check pr ${job.prId} failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      running.delete(k);
      controllers.delete(k);
      phaseByKey.delete(k);
      claimed.delete(k);
      jobDone(job);
      pump();
      pumpReviewLane();
    });
}

/**
 * The code around a finding's line at the current head, read from the read-only checkout. Never
 * leaves the checkout (a path that resolves outside it reads nothing). null when it cannot be read.
 */
export function codeAround(worktree: string, path: string, line: number | null): CodeAround | null {
  if (line == null || line < 1) return null;
  try {
    const root = realpathSync(worktree);
    const full = realpathSync(resolve(root, path));
    if (full !== root && !full.startsWith(root + sep)) return null;
    const lines = readFileSync(full, 'utf8').split('\n');
    const from = Math.max(1, line - REPLIES_PASS_CODE_CONTEXT_LINES);
    const to = Math.min(lines.length, line + REPLIES_PASS_CODE_CONTEXT_LINES);
    if (from > lines.length) return null;
    return { startLine: from, text: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n') };
  } catch {
    return null;
  }
}

async function runJob(job: Job, controller: AbortController): Promise<void> {
  const { ctx, accountId, prId } = job;
  const pr = await getCiPrContext(ctx, accountId, prId);
  const fail = async (msg: string) => {
    for (const g of job.groups) await markReviewFailed(ctx, g.reviewId, msg).catch(() => {});
  };
  if (!pr || !pr.headSha || pr.state !== 'open') {
    await fail(pr && pr.state !== 'open' ? 'The pull request is no longer open.' : 'The pull request or its head commit is not known.');
    return;
  }
  const headSha = pr.headSha;
  // A full review may have started while this waited: it judges the replies itself.
  if (reviewHeldForPr(prId)) {
    for (const g of job.groups) await markReviewCancelled(ctx, g.reviewId).catch(() => {});
    return;
  }
  const member = { prId, owner: pr.owner, name: pr.name, number: pr.number, headSha };
  let cleanupWorktree: (() => Promise<void>) | null = null;
  let scratch: string | null = null;
  const succeeded: Array<{ reviewId: number; items: ClaudeFollowUpItemRecord[] }> = [];
  // Coverage stamps, written once every group ran (`passCoverageMs`): a thread left out over the cap
  // in ANY group must not be covered by another group's row.
  const stamps: Array<{ reviewId: number; newestSentMs: number }> = [];
  const omittedReplyMs: number[] = [];
  // The related repos' and the linked PRs' read-only checkouts; each cleanup runs in finally.
  const peerCleanups: Array<() => Promise<void>> = [];
  try {
    let worktreePath: string | null = null;
    try {
      const wt = await withWorktreeOwner({ kind: 'replies_check', accountId, prId }, () => prepareMemberWorktrees([member]));
      cleanupWorktree = wt.cleanup;
      worktreePath = wt.byPr.get(prId)?.path ?? null;
    } catch {
      worktreePath = null;
    }
    // A cover pass reads the PR's own code only (it checks findings, not replies that point elsewhere).
    const related: RelatedCheckouts = job.cover
      ? { peers: [], linked: [], paths: new Map() }
      : await relatedCheckouts(ctx, accountId, prId, headSha, peerCleanups);
    scratch = mkdtempSync(join(tmpdir(), 'pierre-replies-check-'));
    for (const g of job.groups) {
      if (controller.signal.aborted) {
        await markReviewCancelled(ctx, g.reviewId).catch(() => {});
        continue;
      }
      if (job.cover) {
        const done = await runCoverGroup(job, job.cover.failed, g, { headSha, pr, worktreePath, scratch, controller });
        if (done) succeeded.push(done);
        continue;
      }
      // Re-plan at run time (a reply may have landed while it waited); keep this group's threads.
      const planned = await planRepliesCheck(ctx, accountId, prId);
      const want = new Set(g.findingIds);
      const wanted = 'refused' in planned ? [] : planned.findings.filter((f) => want.has(f.id));
      // A thread whose owner's provider could not run is judged by this one as the OTHER provider's
      // finding (`raisedBy`): it may be accepted, never disputed (follow-up.ts `isCrossDispute`).
      const owners = wanted.length > 0 ? await ownerProviders(ctx, wanted) : new Map<number, AiProviderId>();
      const findings = wanted.map((f) => {
        const owner = owners.get(f.id);
        return owner != null && owner !== g.provider ? { ...f, raisedBy: owner } : f;
      });
      if ('refused' in planned || findings.length === 0) {
        await markReviewFailed(ctx, g.reviewId, 'Nothing left to check: the replies were judged meanwhile.');
        continue;
      }
      await markReviewRunning(ctx, g.reviewId);
      const code = new Map<number, CodeAround>();
      if (worktreePath) {
        for (const f of findings) {
          const c = codeAround(worktreePath, f.path, f.line);
          if (c) code.set(f.id, c);
        }
      }
      const plan = planRepliesPass(findings, headSha, code);
      // This group's threads' linked PRs (the job-wide set, narrowed to the threads it sends).
      const sentIds = new Set(plan.sent.map((x) => x.finding.id));
      const linked = related.linked
        .map((l) => ({ ...l, findingIds: l.findingIds.filter((id) => sentIds.has(id)) }))
        .filter((l) => l.findingIds.length > 0);
      const checkouts = [
        ...related.peers.map((p) => ({ ref: p.ref, path: related.paths.get(p.ref) ?? null })),
        ...linked.map((l) => ({ ref: l.ref, path: related.paths.get(l.ref) ?? null })),
      ];
      const nonce = pickReviewNonce([
        pr.title,
        ...repliesPlanTexts(plan),
        ...peerTexts(related.peers),
        ...linked.map((l) => l.title),
      ]);
      const prompt = buildRepliesPrompt({
        repoFullName: `${pr.owner}/${pr.name}`,
        number: pr.number,
        title: pr.title,
        headSha,
        worktreePath,
        plan,
        nonce,
        provider: g.provider,
        peers: related.peers,
        linked,
        checkouts,
      });
      const roots = [
        ...(worktreePath ? [worktreePath] : []),
        ...checkouts.flatMap((c) => (c.path ? [c.path] : [])),
      ];
      const { runRepliesCheckAgent } = await import('./replies-check-agent.js');
      const res = await runRepliesCheckAgent({
        model: REPLIES_CHECK_MODEL,
        cwd: scratch,
        worktrees: [...new Set(roots)],
        systemPrompt: repliesSystemPrompt(g.provider),
        prompt,
        applyAuthEnv: REVIEW_APPLY_AUTH_ENV,
        abortController: controller,
        usage: { accountId, prId, repoId: pr.repoId ?? null },
        provider: g.provider,
      });
      if (res.ranOn) await markReviewRanOn(ctx, g.reviewId, res.ranOn);
      const telemetry = {
        costUsd: res.costUsd,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        numTurns: res.numTurns,
      };
      if (res.aborted) {
        await markReviewCancelled(ctx, g.reviewId);
        continue;
      }
      if (!res.submitted) {
        await markReviewFailed(ctx, g.reviewId, res.failureReason ?? 'The replies check failed.', telemetry);
        continue;
      }
      const items = reconcileReplies(plan, res.replies ?? []);
      // Coverage for the sweeper: the newest reply this run judged (and the burst it was started for),
      // held below any reply left out over the cap (stamped after the loop).
      stamps.push({
        reviewId: g.reviewId,
        newestSentMs: Math.max(0, ...plan.sent.map((s) => newestJudgeableReplyMs(s.finding) ?? 0)),
      });
      for (const f of plan.omitted) {
        const t = newestJudgeableReplyMs(f);
        if (t != null) omittedReplyMs.push(t);
      }
      await saveReviewSuccess(ctx, g.reviewId, {
        scope: worktreePath ? 'worktree' : 'diff_only',
        summary: repliesSummary(items),
        verdict: 'COMMENT',
        ...telemetry,
        ...(res.usageRecorded ? { usageRecorded: true } : {}),
        excludedFiles: [],
        findings: [],
        followUp: {
          priorReviewId: 'refused' in planned ? 0 : planned.full.id,
          priorHeadSha: 'refused' in planned ? headSha : planned.full.headSha,
          headMoved: 'refused' in planned ? false : planned.full.headSha !== headSha,
          changesSinceShown: false,
          items,
        },
        threadAssessments: null,
      });
      succeeded.push({ reviewId: g.reviewId, items });
    }
    for (const st of stamps) {
      const through = passCoverageMs(st.newestSentMs, job.commentsThroughMs, omittedReplyMs);
      if (through > 0) await markReviewCommentsSeen(ctx, st.reviewId, new Date(through));
    }
    // A cover pass covers no reply the pair had not already seen (the sweeper's coverage reads every
    // `kind = 'replies'` row at the head).
    if (job.cover?.coverageMs != null) {
      for (const r of succeeded) await markReviewCommentsSeen(ctx, r.reviewId, new Date(job.cover.coverageMs));
    }
  } finally {
    await cleanupWorktree?.().catch(() => {});
    for (const c of peerCleanups) await c().catch(() => {});
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        /* advisory cleanup */
      }
    }
    setImmediate(() => {
      try {
        cleanupCloneCache();
      } catch {
        /* advisory cleanup */
      }
    });
  }
  if (succeeded.length === 0) return;
  await afterPass(ctx, job, succeeded, headSha);
}

interface RelatedCheckouts {
  // The related repos' peers, as a full review of the PR gets them (refs X1…).
  peers: ReviewPeer[];
  // The PRs the judged replies link to (refs L1…), every group's threads.
  linked: LinkedPr[];
  // Where each ref was checked out (absent = it could not be).
  paths: Map<string, string>;
}

/**
 * The related code a pass may read beside the PR (see the header): the full review's peers and the
 * linked PRs, checked out read-only through the deep review's own mechanism (`checkOutPeers`). Two
 * separate checkouts, so a linked PR's default branch never shares a related repo's feature-branch
 * checkout. Each cleanup is pushed to `cleanups` (run in the caller's finally, success or failure).
 * Never throws: related code is optional; a failure costs it, never the pass.
 */
async function relatedCheckouts(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  cleanups: Array<() => Promise<void>>,
): Promise<RelatedCheckouts> {
  const out: RelatedCheckouts = { peers: [], linked: [], paths: new Map() };
  try {
    out.peers = await reviewPeersFor({ ctx, accountId, prId });
    const planned = await planRepliesCheck(ctx, accountId, prId);
    if (!('refused' in planned)) {
      // The order the pass sends them in (most severe first), so the cap keeps the weightiest links.
      const ordered = planRepliesPass(planned.findings, headSha).sent.map((x) => x.finding);
      const rest = planned.findings.filter((f) => !ordered.includes(f));
      out.linked = await linkedPrsFor(ctx, accountId, prId, [...ordered, ...rest]);
    }
    // One after the other: a rejection never leaves the other's cleanup to arrive after the caller's
    // finally has run.
    if (out.peers.length > 0) {
      for (const [ref, path] of await checkOutPeers(out.peers.map(runPeerOf), cleanups)) out.paths.set(ref, path);
    }
    if (out.linked.length > 0) {
      for (const [ref, path] of await checkOutPeers(out.linked.map(linkedRunPeer), cleanups)) out.paths.set(ref, path);
    }
  } catch (err) {
    ctx.log.warn(`replies check pr ${prId}: related code not read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

/**
 * How far a pass row says it covered (its `comments_through`, read by the sweeper): the newest reply
 * it judged, or the burst it was started for (a reply it could not judge — a settled thread, Limn's
 * own — must not re-route the burst on every tick). ⚠ A reply LEFT OUT over the thread / character
 * cap was never judged: coverage stays just below the oldest such reply, so the next tick routes
 * another pass for it (the per-PR daily cap still bounds them). Pure; exported for the tests.
 */
export function passCoverageMs(
  newestSentMs: number,
  burstMs: number | null | undefined,
  omittedReplyMs: readonly number[],
): number {
  const through = Math.max(newestSentMs, burstMs ?? 0);
  if (omittedReplyMs.length === 0) return through;
  return Math.max(0, Math.min(through, Math.min(...omittedReplyMs) - 1));
}

/**
 * After a pass: the outcome the replies point to (stored as the newest row's verdict, manual and
 * auto alike), auto resolve (manual passes: the own-PR path only), and — AUTO only — auto pushback
 * and the outcome review. Never throws.
 */
async function afterPass(
  ctx: AgentContext,
  job: Job,
  succeeded: Array<{ reviewId: number; items: ClaudeFollowUpItemRecord[] }>,
  headSha: string,
): Promise<void> {
  const { accountId, prId } = job;
  const last = succeeded[succeeded.length - 1]!;
  if (job.cover) {
    // A COVER PASS: auto resolve only (its own switches and claimed records). It never pushes back
    // (it checks the other provider's findings) and posts no outcome of its own: the pair's one post,
    // which waits for this pass, reads what it left open (`pairCoverHold`).
    try {
      const { maybeAutoResolveFindings } = await import('./auto-resolve.js');
      for (const r of succeeded) {
        await maybeAutoResolveFindings(ctx, { accountId, prId, reviewId: r.reviewId }, autoDeps.post, autoDeps.resolve);
      }
    } catch (err) {
      ctx.log.warn(`cover check pr ${prId}: after the pass: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }
  try {
    {
      // The existing writers, on their own switches and claimed records (at most ONE pushback per
      // thread, ever). Each reads the row's follow-up items exactly as it reads a review's. Resolve
      // runs for a MANUAL pass too — only its own-PR path ("Resolve my Limn threads when addressed")
      // can act there (auto-resolve.ts gates it); pushback stays AUTO only.
      const { maybeAutoResolveFindings } = await import('./auto-resolve.js');
      const { maybeAutoPushback } = await import('./auto-pushback.js');
      for (const r of succeeded) {
        await maybeAutoResolveFindings(ctx, { accountId, prId, reviewId: r.reviewId }, autoDeps.post, autoDeps.resolve);
        if (job.trigger === 'auto') {
          await maybeAutoPushback(ctx, { accountId, prId, reviewId: r.reviewId }, autoDeps.post, autoDeps.resolve);
        }
      }
    }
    const { computeRepliesOutcome, maybePostRepliesOutcome } = await import('./replies-outcome.js');
    const outcome = await computeRepliesOutcome(
      ctx,
      accountId,
      prId,
      succeeded.flatMap((r) => r.items),
      headSha,
    );
    if (outcome.wanted != null && outcome.wanted !== 'COMMENT') {
      const cr = sch(ctx).claudeReviews;
      await ctx.db.update(cr).set({ verdict: outcome.wanted }).where(eq(cr.id, last.reviewId)).execute();
    }
    // WHY NOT APPROVED (migration 0145), shown in Limn manual and auto alike — only while the
    // workspace's auto verdict is on.
    if (outcome.autoVerdict === true && outcome.reason != null) {
      const cr = sch(ctx).claudeReviews;
      await ctx.db.update(cr).set({ verdictReason: outcome.reason }).where(eq(cr.id, last.reviewId)).execute();
    }
    if (job.trigger === 'auto') {
      await maybePostRepliesOutcome(ctx, { accountId, prId, reviewId: last.reviewId, outcome }, autoDeps.post);
    }
  } catch (err) {
    ctx.log.warn(`replies check pr ${prId}: after the pass: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- the tab's state (GET /api/prs/:id/claude-review) ----

function runWire(r: PassRow): ClaudeRepliesCheckRun {
  const items = r.followUp?.items ?? [];
  const autoPost = autoPostWireOf(r.autoPost);
  return {
    reviewId: r.id,
    status: r.status as ClaudeRepliesCheckRun['status'],
    trigger: r.trigger === 'auto' ? 'auto' : 'manual',
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    error: r.error ?? null,
    accepted: items.filter((i) => i.status === 'reply_accepted').length,
    disputed: items.filter((i) => i.status === 'reply_disputed').length,
    notChecked: items.filter((i) => i.status === 'not_checked').length,
    verdict: (r.verdict as ClaudeRepliesCheckRun['verdict']) ?? null,
    autoPost,
    notApproved: passNotApproved(autoPost, r.verdictReason),
  };
}

/** A pass's not-approved reason: what auto-posting recorded (a gate's reason included), else the row's
 *  own (`verdict_reason`); none on an approval. */
function passNotApproved(autoPost: ClaudeAutoPostWire | null, stored: unknown): ClaudeNotApproved | null {
  const v = autoPost?.verdict;
  if (v?.submitted === 'APPROVE' && (autoPost?.status === 'posted' || autoPost?.status === 'partial')) return null;
  if (v?.reasonText) return { heldReason: v.heldReason ?? 'open_findings', text: v.reasonText };
  if (stored != null && typeof stored === 'object') {
    const s = stored as Partial<ClaudeNotApproved>;
    if (typeof s.text === 'string' && typeof s.heldReason === 'string') return { heldReason: s.heldReason, text: s.text };
  }
  return null;
}

/** The AI Review tab's replies state. DB-only (plus the in-memory live phase). Never throws. */
export async function repliesCheckState(ctx: AgentContext, accountId: number, prId: number): Promise<ClaudeRepliesCheckState | null> {
  try {
    const full = await latestFullReview(ctx, accountId, prId);
    if (!full) return null;
    const [planned, passes] = await Promise.all([
      planRepliesCheck(ctx, accountId, prId),
      passesAfter(ctx, accountId, prId, full.id),
    ]);
    const newest = passes[passes.length - 1] ?? null;
    return {
      unjudged: 'refused' in planned ? 0 : planned.findings.length,
      live: liveRepliesCheck(accountId, prId),
      latest: newest ? runWire(newest) : null,
    };
  } catch (err) {
    ctx.log.warn(`replies check state pr ${prId}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// The GitHub-facing deps of an AUTO pass's writes (tests replace them; nothing else does).
let autoDeps: { post?: AutoPostDeps; resolve?: AutoResolveDeps } = {};
/** Test seam: fake GitHub for auto resolve, auto pushback and the outcome review. */
export function _setRepliesAutoDepsForTest(d: { post?: AutoPostDeps; resolve?: AutoResolveDeps } | null): void {
  autoDeps = d ?? {};
}

/** Test seam. */
export function _resetRepliesChecksForTest(): void {
  claimed.clear();
  lane.length = 0;
  running.clear();
  controllers.clear();
  phaseByKey.clear();
}

/** Test seam: the lane, in launch order. */
export function _repliesLaneForTest(): Array<{ accountId: number; prId: number; trigger: ClaudeReviewTrigger; providers: AiProviderId[] }> {
  return lane.map((j) => ({ accountId: j.accountId, prId: j.prId, trigger: j.trigger, providers: j.groups.map((g) => g.provider) }));
}
