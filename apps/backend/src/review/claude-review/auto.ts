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
// THE COST GUARD is `AUTO_REVIEW_DAILY_CAP` auto runs per workspace per UTC day, counting rows
// already started today plus items still waiting in the lane. Past it, PRs wait for tomorrow. An
// account whose agent credits are spent is skipped for the rest of the tick.
//
// RE-REVIEW ON NEW COMMITS. A PR already reviewed (a SUCCEEDED run, manual or auto — opened at or
// after the switch-on, like every auto candidate) whose synced head moves past every run — new
// commits OR a rewritten history — gets ONE fresh, full review of the new head. Still a pull: the
// candidate read (`reReview`) re-derives it from the DB each tick, and any row at the new head
// settles it. DEBOUNCED here: a head must hold still for AUTO_REREVIEW_SETTLE_MS (first seen →
// now, in memory) before it is queued, so a burst of pushes costs one run on the last head. A
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
// "addressed" / "met" — follow-up.ts, threads.ts, ticket.ts `sameHeadTicketCarry`); the new work is
// the new and changed threads.
//
// WHEN A RUN STARTS — THE ONE RULE (`autoReviewDue`, both re-review reasons and first reviews):
//
//     start ⇔ SETTLED AND NOT HELD BY CI
//     SETTLED          = quiet ≥ AUTO_REREVIEW_SETTLE_MS (5 min since the key last changed)
//                        OR burst ≥ AUTO_REREVIEW_MAX_WAIT_MS (20 min since the FIRST trigger of
//                        this burst — a key change resets the 5 min, never the 20)
//                        (a FIRST review has no settle: it is always settled)
//     HELD BY CI       = the head's synced CI is still running (pending / expected)
//                        AND head age < AUTO_REVIEW_CI_WAIT_MS (30 min since the head was first
//                        seen — the earliest ci_status_events row for it, else first sight here)
//
// A burst ends when its run is queued (or when the PR stops being a candidate); the next trigger
// opens a new one. All of these clocks are in memory: a restart restarts the waits, never skips them. While a
// PR waits, `autoReviewWaiting` says why ('ci' | 'comments' | 'commits'), for the Claude Review
// header. ⚠ WHO counts as a trigger is decided in the candidate read: only a person or a REVIEW
// bot's comment (db/queries.ts `reReviewCommentAuthorFilter`).
//
// AUTO FIX. When an auto run succeeds on the reader's OWN PR, manager.ts hands it to
// coding/ai-fix/auto-fix.ts, which may start a review-seeded fix (never pushed).
//
// ⚠ IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF: `autoReviewAvailable` needs the agentic switch
// (config.aiEnabled) AND a local host — checked separately, so the cloud guarantee does not rest on
// one flag. It is OFF PER WORKSPACE until someone switches it on: it spends the user's own Claude
// in the background.
import type { ClaudeAutoReviewWaiting } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';
import { agenticRunReady } from './ai-ready.js';
import { AUTO_REVIEW_DAILY_CAP, listAutoReviewWorkspaces } from './auto-settings.js';
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
/** How long a run waits for a head's running CI, from when that head was first seen. */
export const AUTO_REVIEW_CI_WAIT_MS = 30 * 60 * 1000;

// `${accountId}:${prId}` → the re-review KEY last seen — `${headSha}|${commentsAtMs}` — when it was
// first seen (the quiet clock), and when this burst began (the ceiling's clock, kept across key
// changes). Pruned each full tick to the current candidates.
const headSeen = new Map<string, { key: string; firstSeenMs: number; burstStartMs: number }>();
// `${accountId}:${prId}` → the head we last saw and when we first saw it (the CI wait's fallback
// clock when no ci_status_events row exists).
const headFirstSeen = new Map<string, { headSha: string | null; ms: number }>();
// `${accountId}:${prId}` → why that PR's auto review is waiting right now.
const waitingNow = new Map<string, ClaudeAutoReviewWaiting>();

/** Test hook. */
export function _resetAutoReReviewForTest(): void {
  headSeen.clear();
  headFirstSeen.clear();
  waitingNow.clear();
}

/** Why the sweeper is holding this PR's auto review, or null. Account-checked (the key carries it). */
export function autoReviewWaiting(prId: number, accountId: number): ClaudeAutoReviewWaiting | null {
  return waitingNow.get(`${accountId}:${prId}`) ?? null;
}

/**
 * THE START RULE (see the header). Pure. `settle` is null for a FIRST review (no settle wait);
 * otherwise the quiet / burst clocks and which kind of trigger it is, for the wait reason.
 */
export function autoReviewDue(input: {
  nowMs: number;
  settle: { quietSinceMs: number; burstStartMs: number; reason: 'head' | 'comments' } | null;
  ciRunning: boolean;
  headSeenMs: number;
}): { due: true } | { due: false; reason: ClaudeAutoReviewWaiting } {
  const { nowMs, settle } = input;
  if (settle) {
    const quiet = nowMs - settle.quietSinceMs >= AUTO_REREVIEW_SETTLE_MS;
    const ceiling = nowMs - settle.burstStartMs >= AUTO_REREVIEW_MAX_WAIT_MS;
    if (!quiet && !ceiling) {
      return { due: false, reason: settle.reason === 'comments' ? 'comments' : 'commits' };
    }
  }
  if (input.ciRunning && nowMs - input.headSeenMs < AUTO_REVIEW_CI_WAIT_MS) {
    return { due: false, reason: 'ci' };
  }
  return { due: true };
}

/** Can auto review run in this process at all? The Settings toggle and the sweeper both ask. */
export function autoReviewAvailable(ctx: AgentContext): boolean {
  return AGENTIC_AI_ENABLED && !ctx.host.isCloud;
}

/** 00:00 UTC of the day `nowMs` falls in — the daily cap's day. */
export function utcDayStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface AutoSweepResult {
  queued: number;
  // Of `queued`, how many were RE-reviews (a moved head, or new review comments).
  reQueued: number;
  // Why the sweep stopped early, if it did.
  stopped: 'lane_full' | 'ai_not_ready' | null;
}

let sweeping = false;

/**
 * One tick. Exported for tests; the host scheduler calls it through `registerAutoReview`.
 */
export async function runAutoReviewSweep(
  ctx: AgentContext,
  nowMs: number = Date.now(),
): Promise<AutoSweepResult> {
  const result: AutoSweepResult = { queued: 0, reQueued: 0, stopped: null };
  const candidatesOf = ctx.queries.getAutoReviewCandidates?.bind(ctx.queries);
  if (!autoReviewAvailable(ctx) || !candidatesOf) return result;
  if (sweeping) return result; // re-entrancy: a slow tick must not double-enqueue
  // AI not set up yet (no runtime, or no Claude credential): queue nothing, so no PR gets a failed
  // row that would use up its one automatic review. The PRs still qualify on a later tick.
  if (!agenticRunReady(ctx)) {
    result.stopped = 'ai_not_ready';
    return result;
  }
  sweeping = true;
  try {
    const dayStartMs = utcDayStartMs(nowMs);
    const creditsOk = new Map<number, boolean>();
    const liveHeads = new Set<string>();
    const livePrs = new Set<string>();
    const roster = await listAutoReviewWorkspaces(ctx);
    // A workspace switched off since its items were queued: they wait no longer (the settings
    // PUT drops them at once; this catches any other way the switch went off).
    const on = new Set(roster.map((w) => `${w.accountId}:${w.workspaceId}`));
    dropAutoReviews((accountId, workspaceId) => on.has(`${accountId}:${workspaceId}`));
    for (const ws of roster) {
      if (autoLaneRoom() === 0) {
        result.stopped = 'lane_full';
        break;
      }
      let ok = creditsOk.get(ws.accountId);
      if (ok === undefined) {
        ok = !(await ctx.aiCredits.check(ws.accountId)).agentBlocked;
        creditsOk.set(ws.accountId, ok);
      }
      if (!ok) continue; // credits_exhausted: this account sits the tick out

      const waiting = autoPendingPrIds();
      const res = await candidatesOf(ws.accountId, ws.workspaceId, {
        openedSinceMs: ws.enabledAtMs,
        dayStartMs,
        // Enough to see every waiting item of ours plus a full day's worth of new ones.
        limit: AUTO_REVIEW_DAILY_CAP + waiting.size,
      });
      if (!res) continue; // the workspace is gone
      const waitingHere = [...new Set([...res.prIds, ...(res.reReview ?? []).map((r) => r.prId)])].filter(
        (id) => waiting.has(id),
      ).length;
      let budget = AUTO_REVIEW_DAILY_CAP - res.autoToday - waitingHere;
      const ciByPr = new Map((res.ci ?? []).map((c) => [c.prId, c]));
      // The CI half of the rule, and the head-first-seen clock it reads (DB first, else memory).
      const ciOf = (prId: number): { ciRunning: boolean; headSeenMs: number } => {
        const k = `${ws.accountId}:${prId}`;
        livePrs.add(k);
        const c = ciByPr.get(prId);
        const head = c?.headSha ?? null;
        let mem = headFirstSeen.get(k);
        if (!mem || mem.headSha !== head) {
          mem = { headSha: head, ms: nowMs };
          headFirstSeen.set(k, mem);
        }
        return {
          ciRunning: c?.running === true,
          headSeenMs: Math.min(mem.ms, c?.headSeenAtMs ?? Number.POSITIVE_INFINITY),
        };
      };
      for (const prId of res.prIds) {
        if (budget <= 0) break;
        if (waiting.has(prId)) continue;
        const k = `${ws.accountId}:${prId}`;
        const due = autoReviewDue({ nowMs, settle: null, ...ciOf(prId) });
        if (!due.due) {
          waitingNow.set(k, due.reason);
          continue;
        }
        waitingNow.delete(k); // due: from here it is queued, or waits on the daily cap / lane
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

      // ---- re-reviews of a moved head (debounced) ----
      for (const { prId, headSha, commentsAtMs } of res.reReview ?? []) {
        const k = `${ws.accountId}:${prId}`;
        liveHeads.add(k);
        const ci = ciOf(prId);
        if (waiting.has(prId)) continue;
        // (head, newest qualifying comment): a new push OR a new comment restarts the 5-minute
        // quiet wait; the burst's start (the 20-minute ceiling's clock) is kept.
        const key = `${headSha}|${commentsAtMs ?? ''}`;
        let seen = headSeen.get(k);
        if (!seen) {
          seen = { key, firstSeenMs: nowMs, burstStartMs: nowMs };
          headSeen.set(k, seen);
        } else if (seen.key !== key) {
          seen.key = key;
          seen.firstSeenMs = nowMs;
        }
        const due = autoReviewDue({
          nowMs,
          settle: {
            quietSinceMs: seen.firstSeenMs,
            burstStartMs: seen.burstStartMs,
            reason: commentsAtMs != null ? 'comments' : 'head',
          },
          ...ci,
        });
        if (!due.due) {
          waitingNow.set(k, due.reason);
          continue;
        }
        waitingNow.delete(k); // due: from here it is queued, or waits on the daily cap / lane
        if (budget <= 0) continue;
        const r = enqueueAutoReview(ctx, ws.accountId, prId, ws.workspaceId, commentsAtMs ?? null);
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
    // FULL pass, or a skipped workspace would restart its wait.
    if (!result.stopped) {
      for (const k of headSeen.keys()) if (!liveHeads.has(k)) headSeen.delete(k);
      for (const k of headFirstSeen.keys()) if (!livePrs.has(k)) headFirstSeen.delete(k);
      for (const k of waitingNow.keys()) if (!livePrs.has(k)) waitingNow.delete(k);
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
