// AUTO CLAUDE REVIEW — the per-workspace sweeper (Settings → Workspace → "Review new PRs
// automatically"). When a workspace switches it on, each human-authored, non-draft PR OPENED at or
// after that moment gets ONE Claude review, with the same model and per-review budget as a click.
//
// IT IS A PULL, NOT A HOOK (the core sync/ml-enrichment.ts pattern). Nothing enqueues from sync:
// `sync/upsert.ts` runs inside a transaction and sees every PR of a first sync or a 90-day backfill
// as "new". Each tick instead asks core which PRs qualify (`getAutoReviewCandidates`: open, not a
// draft, opened at/after the switch-on, a PERSON under the workspace's own bot judgement, no
// `claude_reviews` row at all). So:
//   • the DATABASE is the queue — a restart loses nothing, and a waiting item has no row;
//   • a draft is picked up the tick after it is marked ready (if it was opened late enough);
//   • one FIRST review per PR: any row — manual, auto, failed — settles it (a re-review, below,
//     needs a new head).
//
// THE LANE. Items go onto the manager's AUTO lane (manager.ts), which runs only when no manual
// item is waiting and has its OWN queue cap, so auto work can never make a click answer 'busy'.
// PRO_REVIEW_CONCURRENCY is unchanged and shared.
//
// THE COST GUARD is the workspace's daily cap (`workspaces.auto_review_daily_cap`, default
// `AUTO_REVIEW_DAILY_CAP` = 20, set in Settings) auto runs per workspace per UTC day, counting rows
// already started today plus items still waiting in the lane. Past it, PRs wait for tomorrow.
//
// RE-REVIEW ON NEW COMMITS. A PR already reviewed (a SUCCEEDED run, manual or auto — opened at or
// after the switch-on, like every auto candidate) whose synced head moves past every run — new
// commits OR a rewritten history — gets ONE fresh, full review of the new head. Still a pull: the
// candidate read (`reReview`) re-derives it from the DB each tick, and any row at the new head
// settles it. The first push after a quiet spell starts AT ONCE; pushes during or just after a run
// are DEBOUNCED (the rule below), so a burst of pushes costs one more run on the last head. A
// restart only restarts the wait. The run is an ordinary auto run: same lane, slot, daily cap,
// model; it carries the previous run's stories, and the follow-up (follow-up.ts) reads what was
// already posted.
//
// RE-REVIEW ON NEW REVIEW COMMENTS. The same read also offers a PR whose head has NOT moved but whose
// unresolved review threads gained a QUALIFYING comment — a person's or another bot's, never one Limn
// posted (db/review-threads-for-review.ts `isLimnPostedComment`, so a review never re-triggers
// itself) — newer than what every run at that head saw (`claude_reviews.comments_through`, else the
// run's start). THE SETTLE KEY IS (head, newest qualifying comment time): any change restarts the
// AUTO_REREVIEW_SETTLE_MS wait, so a burst of comments (or of pushes, or both) costs ONE run. On such
// a same-head run, every earlier judgement carries forward unchanged (only new commits can change
// "addressed" — follow-up.ts, threads.ts); the new work is
// the new and changed threads.
//
// A COMMENT BURST AT THE SAME HEAD IS A LIGHT PASS, NOT A FULL REVIEW (2026-10-18; replies
// 2026-10-27). When the only news is review comments (the head has not moved), the code has not
// changed, so a full review would re-judge the same diff. Instead (`commentBurstRoute`):
//   • a reply on one of Limn's OWN posted findings newer than what the reviews AND the replies passes
//     at this head saw ⇒ a REPLIES PASS (replies-check.ts: only those replies, at most
//     REPLIES_PASS_AUTO_DAILY_CAP automatic passes per PR per rolling 24 h, never beside a full
//     review in flight), under the same settle rule;
//   • any other new comment ⇒ a CHECK THREADS pass (thread-check.ts — only the changed threads, its
//     own THREAD_CHECK_DAILY_CAP, the same settle rule).
// A check (or replies) row at the head whose `comments_through` reaches the burst COVERS its half (any
// status: one attempt per burst, like the review's "any row at the head settles it"). A replies pass
// that had nothing to judge (or the per-PR cap) covers its half IN MEMORY (`repliesSettled`), so the
// other half is never starved and nothing is asked again every minute.
//
// WHEN A RUN STARTS — THE ONE RULE (`autoReviewDue`, both re-review reasons and first reviews):
//
//     FIRST REVIEW     → start now (no settle)
//     A MOVED HEAD     → start now when NO run is in flight on the PR and none started or finished
//                        in the AUTO_REREVIEW_SETTLE_MS (5 min) before the burst's first push was
//                        seen — "immediately on receipt";
//                        otherwise SETTLED (below). A run in flight is NEVER cancelled: the head
//                        waits for it, its clock running from first sight while it runs.
//     NEW COMMENTS     → SETTLED (below), as before
//     SETTLED          = quiet ≥ AUTO_REREVIEW_SETTLE_MS (5 min since the key last changed)
//                        OR burst ≥ AUTO_REREVIEW_MAX_WAIT_MS (20 min since the FIRST trigger of
//                        this burst — a key change resets the 5 min, never the 20)
//
//     A FAILED AUTO RUN → the latest run at the current head is an AUTO run that FAILED (nothing at
//                        that head succeeded): due again only when the error is TRANSIENT (usage or
//                        rate limit, overload, network/timeout, sign-in/runtime, a restart), fewer
//                        than 3 auto rows exist at the head (counted in the DB, so the cap holds across
//                        restarts), and the default provider changed, OR the usage reset the error or
//                        the usage reading names has passed, OR (no reset known) 1 h / then 4 h passed.
//                        A reader's Stop (cancelled) and a manual failure are never retried by
//                        themselves. The lane re-checks the failed run is still the latest at the head.
//     A READER'S PRESS   → "Run auto reviews now" / "Retry" (POST …/auto-review/sweep): one sweep of
//                        one workspace (or one PR) through THIS rule with `pressed` — the settle waits,
//                        the retry backoff, the attempt cap and the transient test are waived; the
//                        daily cap and a run in flight are not; the spend budget is not asked (the
//                        SPA's over-budget confirm is the reader's choice). For a press the head is
//                        done only when an AUTO run succeeded at it: a failed auto run there is re-run
//                        even when manual runs came after it (db/auto-retry-at-head.ts); the tick keeps
//                        "a manual success at the head is final".
//
// ⚠ IT DOES NOT WAIT FOR CI. The old hold (CI running on a head younger than 30 min) is gone: a
// failing check is diagnosed by its own process, not by holding the code review back.
//
// A burst ends when its run is queued (or when the PR stops being a candidate); the next trigger
// opens a new one. All of these clocks are in memory: a restart restarts the waits, never skips them.
// While a PR waits, `autoReviewWaiting` says why ('comments' | 'commits'), for the Claude Review
// header. ⚠ WHO counts as a trigger is decided in the candidate read: only a person or a REVIEW
// bot's comment (db/queries.ts `reReviewCommentAuthorFilter`).
//
// TEAM CLAIMS ("Mark auto reviews on GitHub", team-claim.ts). When on, the lane checks the head's
// `limn/review-<provider>` status before a run's row is written: a teammate's Limn holding it drops
// the item with NO row (not a failure). The sweeper then holds that PR (`teamClaimHeldHead`) until
// the remembered skip's recheck time, unless the synced head moved; a press reads GitHub afresh.
//
// AUTO FIX. When an auto run succeeds on the reader's OWN PR, manager.ts hands it to
// coding/ai-fix/auto-fix.ts, which may start a review-seeded fix (never pushed).
//
// ⚠ IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF: `autoReviewAvailable` needs the agentic switch
// (config.aiEnabled) AND a local host — checked separately, so the cloud guarantee does not rest on
// one flag. It is OFF PER WORKSPACE until someone switches it on: it spends the user's own Claude
// in the background.
import type { ClaudeAutoReviewWaiting } from '@pierre-review/shared';
import { config } from '../../config.js';
import type { AgentContext } from '../agent-context.js';
import { agenticRunReady } from './ai-ready.js';
import {
  AUTO_RETRY_BACKOFF_FIRST_MS,
  AUTO_RETRY_BACKOFF_LATER_MS,
  AUTO_RETRY_MAX_ATTEMPTS,
  classifyAutoReviewFailure,
  parseRetryAtMs,
} from './auto-retry.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { listAutoReviewWorkspaces } from './auto-settings.js';
import { teamClaimHeldHead } from './team-claim.js';
import { REPLIES_PASS_AUTO_DAILY_CAP } from './replies-pass.js';
import {
  autoLaneRoom,
  autoPendingPrIds,
  AGENTIC_AI_ENABLED,
  dropAutoReviews,
  enqueueAutoReview,
} from './manager.js';

export const AUTO_REVIEW_CRON = '* * * * *';

/** How long a moved head must hold still before its re-review is queued. */
export const AUTO_REREVIEW_SETTLE_MS = 5 * 60 * 1000;
/** The settle never delays a run more than this from the FIRST trigger of the burst. */
export const AUTO_REREVIEW_MAX_WAIT_MS = 20 * 60 * 1000;
/** The replies pass's per-PR cap counts automatic passes in this rolling window. */
export const REPLIES_PASS_WINDOW_MS = 24 * 60 * 60 * 1000;
// `${accountId}:${prId}` → the re-review KEY last seen — `${headSha}|${commentsAtMs}` — when it was
// first seen (the quiet clock), and when this burst began (the ceiling's clock, kept across key
// changes). Pruned each full tick to the current candidates (and PRs with a run in flight whose head
// moved, so a push made DURING a run is clocked from when it was seen, not from the run's end).
const headSeen = new Map<string, { key: string; firstSeenMs: number; burstStartMs: number }>();
// `${accountId}:${prId}` → why that PR's auto review is waiting right now.
const waitingNow = new Map<string, ClaudeAutoReviewWaiting>();
// `${accountId}:${prId}` → { head, the newest own-finding reply time } a replies pass covered WITHOUT a
// row: it had nothing to judge, or the PR's daily cap was used. That half of the burst is settled
// until a newer reply (or a new head); a restart asks once more (no model: a refusal reads the DB).
const repliesSettled = new Map<string, { headSha: string; ms: number }>();

/** Test hook. */
export function _resetAutoReReviewForTest(): void {
  headSeen.clear();
  waitingNow.clear();
  repliesSettled.clear();
}

/** Why the sweeper is holding this PR's auto review, or null. Account-checked (the key carries it). */
export function autoReviewWaiting(prId: number, accountId: number): ClaudeAutoReviewWaiting | null {
  return waitingNow.get(`${accountId}:${prId}`) ?? null;
}

/** What `autoReviewDue` says while a PR is not due: a settle wait (shown in the Claude Review
 *  header), or one of the RETRY holds (a failed auto run at this head; not shown as a wait). */
export type AutoReviewHold = ClaudeAutoReviewWaiting | 'retry_wait' | 'not_retryable' | 'attempts_used';

/** The latest AUTO run at the PR's current head FAILED: what the retry branch of the rule reads. */
export interface AutoRetryInput {
  /** AUTO rows at this (PR, head), the failed one included — the attempt cap's count. */
  attempts: number;
  failedAtMs: number;
  error: string | null;
  /** Who ran the failed run, and the DEFAULT provider now (an automatic run goes to it). */
  failedProvider: 'claude' | 'codex';
  currentProvider: 'claude' | 'codex';
  /** The failed provider's usage reading's reset for this failure (`usageResetFromReading`), if any. */
  usageResetAtMs?: number | null;
}

/**
 * THE START RULE (see the header). Pure. `settle` is null for a FIRST review (no settle wait);
 * otherwise the quiet / burst clocks and which kind of trigger it is, for the wait reason.
 * `inFlight`: a run of this PR is queued or running (never cancelled — the head waits).
 * `lastRunAtMs`: the latest start or finish of any run of this PR (null = none), compared with
 * when this burst's first push was seen.
 * `retry`: the latest AUTO run at the current head FAILED (the RETRY branch, below).
 * `pressed`: the reader pressed "Run auto reviews now" / "Retry" — the settle wait, the retry
 * backoff, the attempt cap and the transient test are waived (a run in flight still waits; the
 * daily cap is the sweeper's and is never waived).
 *
 * THE RETRY BRANCH. A failed auto run is retried automatically only when its error is TRANSIENT
 * (`classifyAutoReviewFailure`), fewer than AUTO_RETRY_MAX_ATTEMPTS auto rows exist at this head,
 * and one of: the DEFAULT provider changed since that run; for a usage limit, the reset time the
 * error or the usage reading names has passed (when one is known the backoff does not apply — an
 * earlier retry would fail the same way and use up an attempt); otherwise the backoff has passed
 * (1 h after the first failure, 4 h after later ones). A succeeded run at the head never reaches
 * here: it is final. A run the reader STOPPED (cancelled) is never retried by itself.
 */
export function autoReviewDue(input: {
  nowMs: number;
  settle: { quietSinceMs: number; burstStartMs: number; reason: 'head' | 'comments' } | null;
  inFlight?: boolean;
  lastRunAtMs?: number | null;
  retry?: AutoRetryInput | null;
  pressed?: boolean;
}): { due: true } | { due: false; reason: AutoReviewHold; retryAtMs?: number } {
  const { nowMs, settle, retry } = input;
  if (retry) {
    if (input.inFlight) return { due: false, reason: 'retry_wait' };
    if (input.pressed) return { due: true };
    const kind = classifyAutoReviewFailure(retry.error);
    if (kind === 'final') return { due: false, reason: 'not_retryable' };
    if (retry.attempts >= AUTO_RETRY_MAX_ATTEMPTS) return { due: false, reason: 'attempts_used' };
    if (retry.failedProvider !== retry.currentProvider) return { due: true };
    const resetAtMs =
      kind === 'usage_limit' ? (parseRetryAtMs(retry.error, retry.failedAtMs) ?? retry.usageResetAtMs ?? null) : null;
    const retryAtMs =
      resetAtMs ??
      retry.failedAtMs + (retry.attempts <= 1 ? AUTO_RETRY_BACKOFF_FIRST_MS : AUTO_RETRY_BACKOFF_LATER_MS);
    return nowMs >= retryAtMs ? { due: true } : { due: false, reason: 'retry_wait', retryAtMs };
  }
  if (!settle) return { due: true };
  const reason: ClaudeAutoReviewWaiting = settle.reason === 'comments' ? 'comments' : 'commits';
  if (input.inFlight) return { due: false, reason };
  if (input.pressed) return { due: true };
  // A new head after a quiet spell — the burst's first push came ≥ 5 min after the last run
  // started or finished: on receipt. (A push during a run, or within 5 min of one, settles.)
  if (
    settle.reason === 'head' &&
    (input.lastRunAtMs == null || settle.burstStartMs - input.lastRunAtMs >= AUTO_REREVIEW_SETTLE_MS)
  ) {
    return { due: true };
  }
  const quiet = nowMs - settle.quietSinceMs >= AUTO_REREVIEW_SETTLE_MS;
  const ceiling = nowMs - settle.burstStartMs >= AUTO_REREVIEW_MAX_WAIT_MS;
  return quiet || ceiling ? { due: true } : { due: false, reason };
}

/**
 * Where a same-head comment burst goes (see the header). Pure.
 *   'replies'  a reply on one of Limn's own findings is newer than the reviews and the replies passes
 *              at this head saw
 *   'covered'  nothing else is newer than what the reviews and the Check threads rows reached
 *   'check'    otherwise: a light Check threads pass
 * `newestOtherCommentAtMs` is the newest comment OUTSIDE Limn's own threads; absent (an older
 * candidate read) ⇒ the burst's newest comment stands for it.
 */
export function commentBurstRoute(input: {
  commentsAtMs: number;
  reviewCoveredMs: number | null;
  newestOwnThreadCommentAtMs: number | null;
  checkCoveredMs: number | null;
  repliesCoveredMs?: number | null;
  newestOtherCommentAtMs?: number | null;
}): 'replies' | 'check' | 'covered' {
  const reviewCovered = input.reviewCoveredMs ?? 0;
  const own = input.newestOwnThreadCommentAtMs;
  if (own != null && own > Math.max(reviewCovered, input.repliesCoveredMs ?? 0)) return 'replies';
  const other = input.newestOtherCommentAtMs !== undefined ? input.newestOtherCommentAtMs : input.commentsAtMs;
  if (other == null || other <= reviewCovered) return 'covered';
  if (input.checkCoveredMs != null && input.checkCoveredMs >= other) return 'covered';
  return 'check';
}

/** Can auto review run in this process at all? The Settings toggle and the sweeper both ask. */
export function autoReviewAvailable(ctx: AgentContext): boolean {
  return AGENTIC_AI_ENABLED;
}

/** 00:00 UTC of the day `nowMs` falls in — the daily cap's day. */
export function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** `commentBurstRoute`'s DB half (an older candidate read). Never throws: a failed read keeps the
 *  full review (the old path). */
async function routeCommentBurst(
  ctx: AgentContext,
  accountId: number,
  prId: number,
  headSha: string,
  commentsAtMs: number,
  reviewCoveredMs: number | null,
  repliesCoveredMs: number | null,
): Promise<'review' | 'replies' | 'check' | 'covered'> {
  const load = ctx.queries.loadReviewThreads?.bind(ctx.queries);
  if (!load) return 'review';
  try {
    const [loaded, { getLatestThreadCheck }] = await Promise.all([
      load(accountId, prId),
      import('./thread-check-persist.js'),
    ]);
    const latest = await getLatestThreadCheck(ctx, accountId, prId);
    const atHead = latest && latest.headSha === headSha ? latest : null;
    return commentBurstRoute({
      commentsAtMs,
      reviewCoveredMs,
      newestOwnThreadCommentAtMs: loaded.newestOwnThreadCommentAt?.getTime() ?? null,
      checkCoveredMs: atHead ? (atHead.commentsThrough ?? atHead.createdAt).getTime() : null,
      repliesCoveredMs,
    });
  } catch {
    return 'review';
  }
}

async function syncedHeadOf(ctx: AgentContext, accountId: number, prId: number): Promise<string | null> {
  const { getReviewPrContext } = await import('./persist.js');
  return (await getReviewPrContext(ctx, prId, accountId).catch(() => null))?.headSha ?? null;
}

async function repoOfPr(ctx: AgentContext, accountId: number, prId: number): Promise<number> {
  const { getCiPrContext } = await import('../ci-review/persist.js');
  return (await getCiPrContext(ctx, accountId, prId))?.repoId ?? 0;
}

export interface AutoSweepResult {
  queued: number;
  // Of `queued`, how many were RE-reviews (a moved head, or new review comments).
  reQueued: number;
  // Check threads passes started instead of a full review (a same-head comment burst).
  checksQueued?: number;
  // Replies passes started (a same-head reply on one of Limn's own findings).
  repliesQueued?: number;
  // Why the sweep stopped early, if it did.
  stopped: 'lane_full' | 'ai_not_ready' | null;
  // True when the Claude spend budget paused at least one account's automatic runs this tick.
  overBudget?: boolean;
  // Of `queued`, how many were RETRIES of a failed auto run at the PR's current head.
  retried?: number;
  // True when at least one due PR was left for tomorrow by the workspace's daily cap.
  capped?: boolean;
  // A press only: another sweep was running, so this one did nothing (never two at once).
  busy?: boolean;
  // A press only: auto review is not on for that workspace (or it is not the account's).
  off?: boolean;
}

/** A READER'S PRESS ("Run auto reviews now", or "Retry" on one PR): ONE workspace (and, for
 *  Retry, one PR). It waives the settle wait, the retry backoff, the attempt cap and the transient
 *  test (`autoReviewDue`'s `pressed`), and does not ask the spend budget (the SPA's over-budget
 *  confirm is the reader's choice). The daily cap, the lane cap and AI readiness still hold. */
export interface AutoSweepPress {
  accountId: number;
  workspaceId: number;
  prId?: number;
}

let sweeping = false;

// The DEFAULT provider now (Settings → AI): an automatic run goes to it. Lazy, so this module's
// import stays light; a test may pin it.
const defaultProviderOf = async (): Promise<'claude' | 'codex'> =>
  (await import('../../ai/provider-setting.js')).activeProviderId();
let currentProviderOf: () => Promise<'claude' | 'codex'> = defaultProviderOf;
/** Test hook. */
export function _setAutoProviderForTest(p: (() => 'claude' | 'codex') | null): void {
  currentProviderOf = p ? async () => p() : defaultProviderOf;
}

/**
 * One tick, or one reader's press (`press`). Exported for tests; the host scheduler calls it
 * through `registerAutoReview`, the sweep route (auto-settings.ts) with `press`.
 */
export async function runAutoReviewSweep(
  ctx: AgentContext,
  nowMs: number = Date.now(),
  press: AutoSweepPress | null = null,
): Promise<AutoSweepResult> {
  const result: AutoSweepResult = { queued: 0, reQueued: 0, stopped: null };
  const candidatesOf = ctx.queries?.getAutoReviewCandidates?.bind(ctx.queries);
  if (!autoReviewAvailable(ctx) || !candidatesOf) return result;
  if (sweeping) {
    // re-entrancy: a slow tick must not double-enqueue (and a press waits for the tick)
    if (press) result.busy = true;
    return result;
  }
  // AI not set up yet (no runtime, or no Claude credential): queue nothing, so no PR gets a failed
  // row that would use up its one automatic review. The PRs still qualify on a later tick.
  if (!agenticRunReady(ctx, 'review')) {
    result.stopped = 'ai_not_ready';
    return result;
  }
  sweeping = true;
  try {
    const dayStartMs = utcDayStartMs(nowMs);
    const liveHeads = new Set<string>();
    const livePrs = new Set<string>();
    const fullRoster = await listAutoReviewWorkspaces(ctx);
    // A workspace switched off since its items were queued: they wait no longer (the settings
    // PUT drops them at once; this catches any other way the switch went off).
    const on = new Set(fullRoster.map((w) => `${w.accountId}:${w.workspaceId}`));
    dropAutoReviews((accountId, workspaceId) => on.has(`${accountId}:${workspaceId}`));
    // A press covers its ONE workspace, and only while auto review is on there.
    const roster = press
      ? fullRoster.filter((w) => w.accountId === press.accountId && w.workspaceId === press.workspaceId)
      : fullRoster;
    if (press && roster.length === 0) {
      result.off = true;
      return result;
    }
    const only = (prId: number): boolean => press?.prId == null || press.prId === prId;
    const pressed = press != null;
    // THE CLAUDE SPEND BUDGET (ai/budget.ts): asked once per account per tick. Over it, the account's
    // workspaces queue nothing (first reviews, re-reviews and Check threads alike) and keep their
    // settle clocks; the next tick under the limit picks them up.
    // A PRESS does not ask: the reader chose the run (the SPA's two-press confirm ran when over).
    const budgetOk = new Map<number, boolean>();
    for (const accountId of pressed ? [] : new Set(roster.map((w) => w.accountId))) {
      const ok = await automaticRunAllowed(ctx, accountId, 'auto review');
      budgetOk.set(accountId, ok);
      if (!ok) result.overBudget = true;
    }
    for (const ws of roster) {
      if (budgetOk.get(ws.accountId) === false) continue;
      if (autoLaneRoom() === 0) {
        result.stopped = 'lane_full';
        break;
      }
      const waiting = autoPendingPrIds();
      const res = await candidatesOf(ws.accountId, ws.workspaceId, {
        openedSinceMs: ws.enabledAtMs,
        dayStartMs,
        // Enough to see every waiting item of ours plus a full day's worth of new ones.
        limit: ws.dailyCap + waiting.size,
        // A PRESS reads the press's retry rule (db/auto-retry-at-head.ts): a head is done only when
        // an AUTO run succeeded there; manual rows are ignored. The sweeper's own tick keeps the
        // automatic rule (a manual success makes the head final).
        ...(pressed ? { pressed: true } : {}),
        // "Retry" on one PR: the read lists that PR's failed auto run whatever the population.
        ...(press?.prId != null ? { pressPrId: press.prId } : {}),
      });
      if (!res) continue; // the workspace is gone
      const waitingHere = [
        ...new Set([
          ...res.prIds,
          ...(res.reReview ?? []).map((r) => r.prId),
          ...(res.retry ?? []).map((r) => r.prId),
        ]),
      ].filter((id) => waiting.has(id)).length;
      let budget = ws.dailyCap - res.autoToday - waitingHere;
      // TEAM CLAIMS: a PR a teammate's Limn holds at its synced head waits for its recheck time
      // without taking a lane place (team-claim.ts). A press reads GitHub afresh.
      const heldByTeammate = async (prId: number, headSha?: string | null): Promise<boolean> => {
        if (pressed) return false;
        const held = teamClaimHeldHead(ws.accountId, prId, nowMs);
        if (held == null) return false;
        const head = headSha ?? (await syncedHeadOf(ctx, ws.accountId, prId));
        return head === held;
      };
      for (const prId of res.prIds) {
        if (!only(prId)) continue;
        if (waiting.has(prId)) continue;
        if (await heldByTeammate(prId)) continue;
        if (budget <= 0) {
          result.capped = true;
          break;
        }
        const k = `${ws.accountId}:${prId}`;
        livePrs.add(k);
        waitingNow.delete(k); // a first review is always due: queued, or waits on the cap / lane
        const r = enqueueAutoReview(ctx, ws.accountId, prId, ws.workspaceId);
        if (r === 'queued') {
          result.queued += 1;
          budget -= 1;
        } else if (r === 'full') {
          result.stopped = 'lane_full';
          break;
        } else if (r === 'disabled') {
          return result;
        }
        // 'already': a person started it meanwhile — it no longer counts against auto.
      }
      if (result.stopped) break;

      // ---- retries: the latest AUTO run at the current head FAILED ----
      // THE ONE START RULE decides (`autoReviewDue`'s retry branch); a press waives its waits.
      const retried = new Set<number>();
      let providerNow: 'claude' | 'codex' | null = null;
      for (const cand of res.retry ?? []) {
        if (!only(cand.prId) || waiting.has(cand.prId)) continue;
        if (await heldByTeammate(cand.prId, cand.headSha)) continue;
        providerNow ??= await currentProviderOf().catch(() => cand.provider);
        // The usage reading's reset, read only when the rule could need it (a usage limit whose
        // error names no time, on the same provider).
        let usageResetAtMs: number | null = null;
        if (
          !pressed &&
          cand.provider === providerNow &&
          classifyAutoReviewFailure(cand.error) === 'usage_limit' &&
          parseRetryAtMs(cand.error, cand.failedAtMs) == null &&
          ctx.aiBudget?.usageResetAfter
        ) {
          usageResetAtMs = await ctx.aiBudget.usageResetAfter(cand.provider, cand.failedAtMs).catch(() => null);
        }
        const due = autoReviewDue({
          nowMs,
          settle: null,
          retry: {
            attempts: cand.attempts,
            failedAtMs: cand.failedAtMs,
            error: cand.error,
            failedProvider: cand.provider,
            currentProvider: providerNow,
            usageResetAtMs,
          },
          pressed,
        });
        if (!due.due) continue;
        if (budget <= 0) {
          result.capped = true;
          continue;
        }
        const r = enqueueAutoReview(ctx, ws.accountId, cand.prId, ws.workspaceId, null, {
          retryOfReviewId: cand.failedReviewId,
          pressed,
        });
        if (r === 'queued' || r === 'already') retried.add(cand.prId);
        if (r === 'queued') {
          headSeen.delete(`${ws.accountId}:${cand.prId}`);
          waitingNow.delete(`${ws.accountId}:${cand.prId}`);
          result.queued += 1;
          result.retried = (result.retried ?? 0) + 1;
          budget -= 1;
        } else if (r === 'full') {
          result.stopped = 'lane_full';
          break;
        } else if (r === 'disabled') {
          return result;
        }
      }
      if (result.stopped) break;

      // The settle key's clocks: a new push OR a new comment restarts the 5-minute quiet wait; the
      // burst's start (the 20-minute ceiling's clock) is kept.
      const clock = (k: string, key: string) => {
        let seen = headSeen.get(k);
        if (!seen) {
          seen = { key, firstSeenMs: nowMs, burstStartMs: nowMs };
          headSeen.set(k, seen);
        } else if (seen.key !== key) {
          seen.key = key;
          seen.firstSeenMs = nowMs;
        }
        return seen;
      };

      // ---- a run is in flight and the head moved past it: never cancel, start the clock ----
      for (const { prId, headSha } of res.inFlightMoved ?? []) {
        if (!only(prId)) continue;
        const k = `${ws.accountId}:${prId}`;
        liveHeads.add(k);
        livePrs.add(k);
        clock(k, `${headSha}|`);
        waitingNow.set(k, 'commits');
      }

      // ---- re-reviews: a moved head, or new review comments ----
      let checkBudget: number | null = null;
      for (const cand of res.reReview ?? []) {
        const { prId, headSha, commentsAtMs, lastRunAtMs, coveredMs } = cand;
        if (!only(prId)) continue;
        const k = `${ws.accountId}:${prId}`;
        liveHeads.add(k);
        livePrs.add(k);
        if (waiting.has(prId) || retried.has(prId)) continue;
        // A same-head comment burst: a replies pass for a reply on a Limn finding, else a light
        // Check threads pass. The candidate read already carries the coverage and the reply times
        // (all filtered like the trigger); an older host without them falls back to the DB read.
        const settledInMemory = repliesSettled.get(k);
        const repliesCoveredMs = Math.max(
          cand.repliesCoveredMs ?? 0,
          settledInMemory && settledInMemory.headSha === headSha ? settledInMemory.ms : 0,
        );
        const route =
          commentsAtMs == null
            ? 'review'
            : cand.checkCoveredMs !== undefined && cand.newestOwnThreadCommentAtMs !== undefined
              ? commentBurstRoute({
                  commentsAtMs,
                  reviewCoveredMs: coveredMs ?? null,
                  newestOwnThreadCommentAtMs: cand.newestOwnThreadCommentAtMs,
                  checkCoveredMs: cand.checkCoveredMs,
                  repliesCoveredMs,
                  ...(cand.newestOtherCommentAtMs !== undefined ? { newestOtherCommentAtMs: cand.newestOtherCommentAtMs } : {}),
                })
              : await routeCommentBurst(ctx, ws.accountId, prId, headSha, commentsAtMs, coveredMs ?? null, repliesCoveredMs);
        if (route === 'covered') {
          headSeen.delete(k);
          waitingNow.delete(k);
          continue;
        }
        if (route === 'replies') {
          const ownMs = cand.newestOwnThreadCommentAtMs ?? commentsAtMs!;
          const seen = clock(k, `${headSha}|${commentsAtMs ?? ''}`);
          const due = autoReviewDue({
            nowMs,
            settle: { quietSinceMs: seen.firstSeenMs, burstStartMs: seen.burstStartMs, reason: 'comments' },
            lastRunAtMs: null,
            pressed,
          });
          if (!due.due) {
            if (isSettleWait(due.reason)) waitingNow.set(k, due.reason);
            continue;
          }
          waitingNow.delete(k);
          const rc = await import('./replies-check.js');
          if (rc.repliesCheckHeld(ws.accountId, prId) || rc.repliesCheckAutoRoom() === 0) continue;
          // THE PER-PR CAP, counted in the DB (rolling 24 h). Past it, this reply waits for the next
          // full review; the burst's other half (Check threads) is not held back.
          const used = await rc.countAutoRepliesPassesSince(ctx, ws.accountId, prId, nowMs - REPLIES_PASS_WINDOW_MS);
          if (used >= REPLIES_PASS_AUTO_DAILY_CAP) {
            repliesSettled.set(k, { headSha, ms: ownMs });
            headSeen.delete(k);
            continue;
          }
          const r = await rc.startRepliesCheck(ctx, {
            accountId: ws.accountId,
            prId,
            trigger: 'auto',
            commentsThroughMs: ownMs,
            ...(pressed ? { pressed: true } : {}),
          });
          if (r.outcome === 'queued') result.repliesQueued = (result.repliesQueued ?? 0) + 1;
          if (r.outcome === 'queued' || r.outcome === 'already_running') headSeen.delete(k);
          // Nothing to judge (or no review to follow): settled in memory, so the next tick routes the
          // burst's other half. A full review in flight judges the replies itself and covers them.
          if (r.outcome === 'refused' && r.reason !== 'review_in_progress') {
            repliesSettled.set(k, { headSha, ms: ownMs });
            headSeen.delete(k);
          }
          continue;
        }
        if (route === 'check') {
          const seen = clock(k, `${headSha}|${commentsAtMs ?? ''}`);
          const due = autoReviewDue({
            nowMs,
            settle: { quietSinceMs: seen.firstSeenMs, burstStartMs: seen.burstStartMs, reason: 'comments' },
            lastRunAtMs: null,
            pressed,
          });
          if (!due.due) {
            if (isSettleWait(due.reason)) waitingNow.set(k, due.reason);
            continue;
          }
          waitingNow.delete(k);
          const tcm = await import('./thread-check.js');
          if (tcm.threadCheckHeld(ws.accountId, prId)) continue;
          if (checkBudget == null) {
            const { countAutoThreadChecksSince } = await import('./thread-check-persist.js');
            checkBudget =
              config.threadCheckDailyCap -
              (await countAutoThreadChecksSince(ctx, ws.accountId, ws.workspaceId, dayStartMs));
          }
          if (checkBudget <= 0 || tcm.threadCheckAutoRoom() === 0) continue;
          const r = await tcm.startThreadCheck(ctx, {
            accountId: ws.accountId,
            workspaceId: ws.workspaceId,
            prId,
            repoId: await repoOfPr(ctx, ws.accountId, prId),
            headSha,
            trigger: 'auto',
            commentsThrough: new Date(commentsAtMs!),
          });
          if (r.outcome === 'queued' || r.outcome === 'already_running' || r.outcome === 'refused') headSeen.delete(k);
          if (r.outcome === 'queued') {
            checkBudget -= 1;
            result.checksQueued = (result.checksQueued ?? 0) + 1;
          }
          continue;
        }
        const seen = clock(k, `${headSha}|${commentsAtMs ?? ''}`);
        const due = autoReviewDue({
          nowMs,
          settle: {
            quietSinceMs: seen.firstSeenMs,
            burstStartMs: seen.burstStartMs,
            reason: commentsAtMs != null ? 'comments' : 'head',
          },
          lastRunAtMs: lastRunAtMs ?? null,
          pressed,
        });
        if (!due.due) {
          if (isSettleWait(due.reason)) waitingNow.set(k, due.reason);
          continue;
        }
        waitingNow.delete(k); // due: from here it is queued, or waits on the daily cap / lane
        if (await heldByTeammate(prId, headSha)) continue;
        if (budget <= 0) {
          result.capped = true;
          continue;
        }
        const r = enqueueAutoReview(ctx, ws.accountId, prId, ws.workspaceId, commentsAtMs ?? null, { pressed });
        // Queued (or a person already started it): this burst is covered. Forget its clocks NOW —
        // the PR can be a candidate again before any full pass prunes it (a comment landing while
        // the run is in flight), and an inherited burst start would hit the 20-minute ceiling at
        // once, skipping the next burst's quiet wait.
        if (r === 'queued' || r === 'already') headSeen.delete(k);
        if (r === 'queued') {
          result.queued += 1;
          result.reQueued += 1;
          budget -= 1;
        } else if (r === 'full') {
          result.stopped = 'lane_full';
          break;
        } else if (r === 'disabled') {
          return result;
        }
      }
      if (result.stopped) break;
    }
    // Forget heads that are no longer candidates (reviewed, closed, switched off) — only after a
    // FULL pass, or a skipped workspace would restart its wait (a press covers one workspace).
    if (!result.stopped && !result.overBudget && !pressed) {
      for (const k of headSeen.keys()) if (!liveHeads.has(k)) headSeen.delete(k);
      for (const k of waitingNow.keys()) if (!livePrs.has(k)) waitingNow.delete(k);
      for (const k of repliesSettled.keys()) if (!livePrs.has(k)) repliesSettled.delete(k);
    }
    if (result.queued > 0) ctx.log.info(`auto claude review: queued ${result.queued} PR(s)`);
    return result;
  } catch (err) {
    ctx.log.warn(
      `auto claude review sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  } finally {
    sweeping = false;
  }
}

function isSettleWait(r: AutoReviewHold): r is ClaudeAutoReviewWaiting {
  return r === 'comments' || r === 'commits' || r === 'ci';
}

/** Register the sweeper — only where it can run, so a cloud host never even schedules it. */
export function registerAutoReview(ctx: AgentContext): void {
  if (!autoReviewAvailable(ctx)) return;
  ctx.registerScheduledJob(
    AUTO_REVIEW_CRON,
    async () => {
      await runAutoReviewSweep(ctx);
    },
    'claude-auto-review',
  );
}
