import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../../config.js';
import { globalAutomationUserIds } from '../../db/automation-ids.js';
import type { AgentContext } from '../agent-context.js';
import { agenticRunReady } from '../claude-review/ai-ready.js';
import { autoReviewAvailable, utcDayStartMs } from '../claude-review/auto.js';
import { listAutoReviewWorkspaces } from '../claude-review/auto-settings.js';
import { ciReviewDue } from './currency.js';
import { countAutoCiReviewsSince, getCiStateInputs, readSyncedCi } from './persist.js';
import { ciAutoLaneRoom, ciReviewHeld, startCiReview, type StartCiArgs, type StartCiResult } from './manager.js';

// THE CI REVIEW SWEEPER — explains a failing check as soon as the sync sees it, where auto review is
// on for the workspace (Settings → Workspace → "Review new PRs automatically").
//
// A PULL, like the PR and ticket review sweepers: every tick re-derives what is due from the
// database, so a restart loses nothing and nothing hooks the sync.
//
//   1. CANDIDATES. Open, non-draft PRs in auto-enabled workspaces whose SYNCED rollup is red
//      (failure / error) and which a PERSON opened (the global automation set — a dependency bot's
//      red bump is not worth a Claude run).
//   2. THE FAILING SET of each, read from the synced log (`ci_status_events`: the newest row at the
//      PR's current head — persist.ts `readSyncedCi`).
//   3. DUE (`ciReviewDue`) when something is failing and no run already took exactly this head and
//      failing set — succeeded, refused (no Actions log, nothing readable), failed with an answer,
//      or cancelled. A run that THREW stores no keys, so it stays retryable. A PR whose run is
//      queued or running WAITS: the running run is never cancelled, and the next tick judges the
//      set again once it has stored its keys.
//   4. ⚠ NO SETTLE AND NO CI HOLD. A failing check is FINAL: nothing waits for the rest of the
//      head's checks, or for the pushes to stop. A set that grows later is a new key, and that run
//      carries what is already explained (prepare.ts) and reads only the new failures.
//   5. THE ONBOARDING FLOOR. Only a failure the sync OBSERVED at or after the workspace switched auto
//      review on — so switching it on never explains every red PR at once.
//   6. ITS OWN DAILY CAP, `CI_REVIEW_DAILY_CAP` automatic runs per workspace per UTC day — counted
//      from rows, which an automatic run writes when it is QUEUED. Never shared with the PR or
//      ticket review's caps.
//
// The claim, lane and shared concurrency are the manager's (manager.ts).

export const CI_SWEEP_CRON = '* * * * *';
// The most candidates judged per account per tick; the rest are seen next tick.
const MAX_CANDIDATES_PER_TICK = 200;

export interface CiSweepDeps {
  roster(ctx: AgentContext): Promise<Array<{ accountId: number; workspaceId: number; enabledAtMs: number }>>;
  enqueue(ctx: AgentContext, a: StartCiArgs): Promise<StartCiResult>;
  laneRoom(): number;
  held(accountId: number, prId: number): boolean;
  automationUserIds(): Promise<Set<number>>;
  dailyCap: number;
}

const defaultDeps: CiSweepDeps = {
  roster: listAutoReviewWorkspaces,
  enqueue: startCiReview,
  laneRoom: ciAutoLaneRoom,
  held: ciReviewHeld,
  automationUserIds: globalAutomationUserIds,
  dailyCap: config.ciReviewDailyCap,
};

export interface CiSweepResult {
  considered: number[];
  queued: Array<{ prId: number; workspaceId: number }>;
  stopped: 'lane_full' | 'ai_not_ready' | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Open, non-draft, red PRs in these workspaces, with their repo and author. */
async function redOpenPrs(
  ctx: AgentContext,
  accountId: number,
  workspaceIds: readonly number[],
): Promise<Array<{ prId: number; repoId: number; workspaceId: number; authorId: number | null; headSha: string }>> {
  if (workspaceIds.length === 0) return [];
  const { pullRequests: pr, workspaceRepos: wr } = s(ctx);
  const rows = (await ctx.db
    .select({ prId: pr.id, repoId: pr.repoId, workspaceId: wr.workspaceId, authorId: pr.authorId, headSha: pr.headSha })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .where(
      and(
        eq(pr.accountId, accountId),
        eq(pr.state, 'open'),
        eq(pr.isDraft, false),
        inArray(pr.ciStatus, ['failure', 'error']),
        inArray(wr.workspaceId, [...workspaceIds]),
      ),
    )
    .execute()) as Array<{ prId: number; repoId: number; workspaceId: number; authorId: number | null; headSha: string | null }>;
  return rows.flatMap((r) => (r.headSha ? [{ ...r, headSha: r.headSha }] : []));
}

let sweeping = false;

export function _resetCiSweepForTest(): void {
  sweeping = false;
}

/** One tick. Exported for tests; the host scheduler calls it through `registerCiReviewSweep`. */
export async function runCiReviewSweep(
  ctx: AgentContext,
  nowMs: number = Date.now(),
  deps: CiSweepDeps = defaultDeps,
): Promise<CiSweepResult> {
  const result: CiSweepResult = { considered: [], queued: [], stopped: null };
  if (!autoReviewAvailable(ctx) || sweeping) return result;
  if (!agenticRunReady(ctx)) {
    result.stopped = 'ai_not_ready';
    return result;
  }
  sweeping = true;
  try {
    const dayStartMs = utcDayStartMs(nowMs);
    const roster = await deps.roster(ctx);
    const byAccount = new Map<number, Map<number, number>>(); // account → (workspace → enabledAtMs)
    for (const w of roster) {
      const m = byAccount.get(w.accountId) ?? new Map<number, number>();
      m.set(w.workspaceId, w.enabledAtMs);
      byAccount.set(w.accountId, m);
    }
    if (byAccount.size === 0) return result;
    const automation = await deps.automationUserIds();

    for (const [accountId, enabled] of byAccount) {
      if (result.stopped) break;
      if ((await ctx.aiCredits.check(accountId)).agentBlocked) continue;
      const red = (await redOpenPrs(ctx, accountId, [...enabled.keys()]))
        .filter((p) => p.authorId == null || !automation.has(p.authorId))
        .sort((a, b) => a.prId - b.prId)
        .slice(0, MAX_CANDIDATES_PER_TICK);
      if (red.length === 0) continue;
      const ids = red.map((p) => p.prId);
      const [synced, inputs] = await Promise.all([
        readSyncedCi(ctx, accountId, ids),
        getCiStateInputs(ctx, accountId, ids),
      ]);
      const capUsed = new Map<number, number>();
      for (const p of red) {
        result.considered.push(p.prId);
        if (deps.held(accountId, p.prId)) continue;
        const sc = synced.get(p.prId);
        if (!sc || sc.headSha !== p.headSha) continue;
        if (!ciReviewDue(inputs.get(p.prId), sc)) continue;
        // The onboarding floor: a failure first observed before auto review was switched on.
        const floor = enabled.get(p.workspaceId) ?? Number.POSITIVE_INFINITY;
        if (sc.observedAtMs == null || sc.observedAtMs < floor) continue;

        let used = capUsed.get(p.workspaceId);
        if (used == null) {
          used = await countAutoCiReviewsSince(ctx, accountId, p.workspaceId, dayStartMs);
          capUsed.set(p.workspaceId, used);
        }
        if (used >= deps.dailyCap) continue;
        if (deps.laneRoom() <= 0) {
          result.stopped = 'lane_full';
          break;
        }
        const r = await deps.enqueue(ctx, {
          accountId,
          workspaceId: p.workspaceId,
          prId: p.prId,
          repoId: p.repoId,
          headSha: p.headSha,
          triggerKey: sc.failingKey,
          trigger: 'auto',
        });
        if (r.outcome === 'queued') {
          capUsed.set(p.workspaceId, used + 1);
          result.queued.push({ prId: p.prId, workspaceId: p.workspaceId });
        } else if (r.outcome === 'busy') {
          result.stopped = 'lane_full';
          break;
        } else if (r.outcome === 'disabled') {
          return result;
        }
      }
    }
    if (result.queued.length > 0) ctx.log.info(`ci review sweep: queued ${result.queued.length} PR(s)`);
    return result;
  } catch (err) {
    ctx.log.warn(`ci review sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  } finally {
    sweeping = false;
  }
}

/** Register the sweeper — only where auto review can run at all. */
export function registerCiReviewSweep(ctx: AgentContext): void {
  if (!autoReviewAvailable(ctx)) return;
  ctx.registerScheduledJob(
    CI_SWEEP_CRON,
    async () => {
      await runCiReviewSweep(ctx);
    },
    'ci-review-sweep',
  );
}
