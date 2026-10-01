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
//   • one review per PR, ever: any row — manual, auto, failed — settles it.
//
// THE LANE. Items go onto the manager's AUTO lane (manager.ts), which runs only when no manual
// item is waiting and has its OWN queue cap, so auto work can never make a click answer 'busy'.
// PRO_REVIEW_CONCURRENCY is unchanged and shared.
//
// THE COST GUARD is `AUTO_REVIEW_DAILY_CAP` auto runs per workspace per UTC day, counting rows
// already started today plus items still waiting in the lane. Past it, PRs wait for tomorrow. An
// account whose agent credits are spent is skipped for the rest of the tick.
//
// ⚠ IT NEVER RUNS WHERE CLAUDE REVIEW IS OFF: `autoReviewAvailable` needs the agentic switch
// (config.aiEnabled) AND a local host — checked separately, so the cloud guarantee does not rest on
// one flag. It is OFF PER WORKSPACE until someone switches it on: it spends the user's own Claude
// in the background.
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
  const result: AutoSweepResult = { queued: 0, stopped: null };
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
      const waitingHere = res.prIds.filter((id) => waiting.has(id)).length;
      let budget = AUTO_REVIEW_DAILY_CAP - res.autoToday - waitingHere;
      for (const prId of res.prIds) {
        if (budget <= 0) break;
        if (waiting.has(prId)) continue;
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
