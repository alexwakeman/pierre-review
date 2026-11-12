import { and, eq, inArray } from 'drizzle-orm';
import { isTrackerIdent, parseTicketIdent } from '@pierre-review/shared';
import { config } from '../../config.js';
import type { AgentContext } from '../agent-context.js';
import { getTicketSource } from '../../tracker/ticket-source.js';
import { agenticRunReady } from '../claude-review/ai-ready.js';
import { automaticRunAllowed } from '../budget-gate.js';
import { autoReviewAvailable } from '../claude-review/auto.js';
import { listAutoReviewWorkspaces } from '../claude-review/auto-settings.js';
import { onAutoReviewLaunched } from '../claude-review/manager.js';
import { getTicketIdentsForPr } from './persist.js';
import { loadTicketAutoState, readerUserIdOf } from './auto-inputs.js';
import {
  startTicketReview,
  ticketAutoLaneRoom,
  ticketReviewHeld,
  type StartTicketArgs,
  type StartTicketResult,
} from './manager.js';
import { automationAllowedForPr, externalRepoIdsVia } from '../../db/external-repos.js';

// THE TICKET REVIEW SWEEPER — re-checks a ticket when the PRs on it move, where auto review is on.
//
// A PULL, like the PR review's sweeper (claude-review/auto.ts): every tick re-derives what is due
// from the database and the tracker's stored ticket rows, so a restart loses nothing.
//
//   1. CANDIDATES. The tickets of PRs that CHANGED since the last tick — a new head, a new open PR,
//      or a PR that stopped being open (merged or closed) — read through the tracker's
//      `ticketsForPr` plus the tickets this PR was already judged on; the tracker's
//      `listChangedTicketIdents` (a PR joined or left, the story was edited, a person's comment was
//      stored — it re-checks only while the latest check has a criterion not done); the tickets of a PR
//      whose auto PR review just launched (the kick — claude-review/manager.ts
//      `onAutoReviewLaunched` — so a PR's first auto review and its tickets' check start together);
//      and tickets still waiting from earlier ticks. ⚠ ONE HOP: only the tickets the changed PR is itself on. A ticket that merely
//      shares another PR with one of them is never added — its own fingerprint did not move.
//   2. ONE RULE DECIDES, for each candidate: `loadTicketAutoState` (auto-inputs.ts) reads the stored
//      rows and the pure `ticketAutoCheckPlan` (auto-plan.ts) answers — the SAME answer the states
//      route shows the reader. Due when the live fingerprint differs from the latest SUCCEEDED run's
//      (or there is none) and no newer attempt already ran on exactly these inputs (it would only
//      stop the same way again; a run that THREW stores no fingerprint, so it stays retryable).
//   3. THE GRACE WINDOW, from STORED stamps (no in-memory timer, so a restart loses nothing): 2 quiet
//      minutes after the newest push to ANY member PR (`head_seen_at`), PR joining (`linked_at`),
//      merge or ticket change — a FIRST check too — with a 20-minute ceiling from the burst's first
//      change. A ticket whose run is queued or running WAITS (never cancelled) and is judged again
//      once the run has stored its fingerprint; the changes it did not see restart the window then.
//      NO CI hold.
//   4. ITS OWN DAILY CAP, `TICKET_REVIEW_DAILY_CAP` (60) automatic runs ('auto' and 'cascade') per
//      workspace per UTC day — counted from rows, which an automatic run writes when it is QUEUED.
//      ⚠ A ticket with a PR the READER owns is never held by it. NO per-ticket limit (removed
//      2026-11-09: it counted PR joins and story edits as pushes, and held BMD-1175 until midnight).
//      The spend budget is the money brake.
//   5. Each queued run stores its CAUSE (`ticket_reviews.cause`).
//
// THE WORKSPACE. Members may span workspaces (same Jira site); the run counts against an
// AUTO-ENABLED member workspace — the changed PR's when it is one. A ticket with no member in an
// auto-enabled workspace is never run automatically. A FIRST run also needs the onboarding floor
// the PR review uses: an open member opened at or after that workspace switched auto review on,
// or the kick (an auto review of one of its PRs launched) — so switching auto review on never reviews
// every old ticket at once.

export const TICKET_SWEEP_CRON = '* * * * *';
// The most changed PRs whose tickets are read in one tick; the rest stay "changed" for the next.
const MAX_CHANGED_PRS_PER_TICK = 100;
// The first tick after boot asks the tracker for tickets changed in this window.
const FIRST_TICK_LOOKBACK_MS = 60 * 60 * 1000;
// listChangedTicketIdents overlap, so a row stamped while a tick ran is never missed.
const CHANGED_SLACK_MS = 60 * 1000;

// accountId → (prId → `${headSha}`) of the open PRs seen last tick, in auto-enabled workspaces.
const prSnap = new Map<number, Map<number, string>>();
// accountId → the last completed tick's time (the listChangedTicketIdents cursor).
const lastTick = new Map<number, number>();
// accountId → PRs whose auto PR review launched since the last tick.
const kicked = new Map<number, Set<number>>();
// `${accountId}:${ident}` → still waiting (the grace window, a run in flight, the cap or the lane).
// Re-checked every tick; only WHICH tickets to look at — when to run is read from stored rows.
const watching = new Map<string, { accountId: number; ident: string; kicked: boolean; viaPrId: number | null }>();

export function _resetTicketSweepForTest(): void {
  prSnap.clear();
  lastTick.clear();
  kicked.clear();
  watching.clear();
  sweeping = false;
}

export interface TicketSweepDeps {
  roster(ctx: AgentContext): Promise<Array<{ accountId: number; workspaceId: number; enabledAtMs: number }>>;
  enqueue(ctx: AgentContext, a: StartTicketArgs): Promise<StartTicketResult>;
  laneRoom(): number;
  held(accountId: number, ident: string): boolean;
  dailyCap: number;
  // The reader's users.id (the cap exemption); default reads it from the account.
  readerUserId?: (ctx: AgentContext, accountId: number) => Promise<number | null>;
}

const defaultDeps: TicketSweepDeps = {
  roster: listAutoReviewWorkspaces,
  enqueue: startTicketReview,
  laneRoom: ticketAutoLaneRoom,
  held: ticketReviewHeld,
  dailyCap: config.ticketReviewDailyCap,
  readerUserId: readerUserIdOf,
};

export interface TicketSweepResult {
  // Idents evaluated this tick.
  considered: string[];
  queued: Array<{ ident: string; trigger: 'auto' | 'cascade'; workspaceId: number }>;
  stopped: 'lane_full' | 'ai_not_ready' | null;
  // True when the Claude spend budget paused an account this tick (its work waits, nothing is lost).
  overBudget?: boolean;
}

/**
 * The one-hop rule as a pure function: the tickets to look at are exactly the tickets each CHANGED
 * PR is on — never the tickets of their fellow members.
 */
export function oneHopIdents(
  changedPrIds: Iterable<number>,
  ticketsOf: ReadonlyMap<number, readonly string[]>,
): string[] {
  const out = new Set<string>();
  for (const prId of changedPrIds) for (const ident of ticketsOf.get(prId) ?? []) out.add(ident);
  return [...out].sort();
}

/** A PR's auto review launched: look at its tickets now (a first ticket run skips the onboarding floor). */
export function kickTicketSweep(ctx: AgentContext, accountId: number, prId: number): void {
  const set = kicked.get(accountId) ?? new Set<number>();
  set.add(prId);
  kicked.set(accountId, set);
  void runTicketReviewSweep(ctx).catch(() => {});
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const s = (ctx: AgentContext): any => ctx.schema as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

async function openPrsIn(
  ctx: AgentContext,
  accountId: number,
  workspaceIds: readonly number[],
): Promise<Array<{ prId: number; repoId: number; headSha: string; workspaceId: number }>> {
  if (workspaceIds.length === 0) return [];
  const { pullRequests: pr, workspaceRepos: wr } = s(ctx);
  const rows = (await ctx.db
    .select({ prId: pr.id, repoId: pr.repoId, headSha: pr.headSha, workspaceId: wr.workspaceId })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .where(and(eq(pr.accountId, accountId), eq(pr.state, 'open'), inArray(wr.workspaceId, [...workspaceIds])))
    .execute()) as Array<{ prId: number; repoId: number; headSha: string | null; workspaceId: number }>;
  return rows.map((r) => ({ ...r, headSha: r.headSha ?? '' }));
}

let sweeping = false;

/** One tick. Exported for tests; the host scheduler calls it through `registerTicketReviewSweep`. */
export async function runTicketReviewSweep(
  ctx: AgentContext,
  nowMs: number = Date.now(),
  deps: TicketSweepDeps = defaultDeps,
): Promise<TicketSweepResult> {
  const result: TicketSweepResult = { considered: [], queued: [], stopped: null };
  const providers = getTicketSource();
  const ticketsForPr = providers.ticketsForPr;
  if (!autoReviewAvailable(ctx)) return result;
  if (sweeping) return result;
  if (!agenticRunReady(ctx, 'ticket_review')) {
    result.stopped = 'ai_not_ready';
    return result;
  }
  sweeping = true;
  try {
    const roster = await deps.roster(ctx);
    const byAccount = new Map<number, Map<number, number>>(); // account → (workspace → enabledAtMs)
    for (const w of roster) {
      const m = byAccount.get(w.accountId) ?? new Map<number, number>();
      m.set(w.workspaceId, w.enabledAtMs);
      byAccount.set(w.accountId, m);
    }
    // An account with nothing switched on any more forgets everything it was waiting on.
    for (const [k, w] of watching) if (!byAccount.has(w.accountId)) watching.delete(k);

    for (const [accountId, enabled] of byAccount) {
      if (result.stopped) break;
      // THE CLAUDE SPEND BUDGET (ai/budget.ts): over it, read nothing and queue nothing. The PR
      // snapshot, the kicks and the change cursor are left as they are, so every change made while
      // paused is still "changed" on the first tick back under the limit.
      if (!(await automaticRunAllowed(ctx, accountId, 'ticket review'))) {
        result.overBudget = true;
        continue;
      }

      // ---- 1. what changed since the last tick ----
      // EXTERNAL REPOS (db/external-repos.ts): an external repo's PR never starts an automatic ticket
      // review (its changes are not watched). Its auto-post target is off too (auto-settings.ts).
      const externals = await externalRepoIdsVia(accountId, ctx);
      const open = (await openPrsIn(ctx, accountId, [...enabled.keys()])).filter((p) => !externals.has(p.repoId));
      const before = prSnap.get(accountId);
      const now = new Map(open.map((p) => [p.prId, p.headSha]));
      const changed: number[] = [];
      for (const [prId, head] of now) if (before?.get(prId) !== head) changed.push(prId);
      if (before) for (const prId of before.keys()) if (!now.has(prId)) changed.push(prId);
      const kickedHere = kicked.get(accountId) ?? new Set<number>();
      kicked.delete(accountId);
      // A kick (sync saw a PR change) on an external repo's PR is dropped the same way.
      for (const prId of [...kickedHere]) if (!(await automationAllowedForPr(accountId, prId, ctx))) kickedHere.delete(prId);
      const toRead = [...new Set([...kickedHere, ...changed])].slice(0, MAX_CHANGED_PRS_PER_TICK);
      const readSet = new Set(toRead);

      // ---- the tickets of exactly those PRs (one hop) ----
      const ticketsOf = new Map<number, string[]>();
      for (const prId of toRead) {
        const idents = new Set<string>();
        try {
          for (const t of await ticketsForPr(accountId, prId)) idents.add(t.ident);
        } catch {
          /* "nothing known" for this PR */
        }
        for (const i of await getTicketIdentsForPr(ctx, accountId, prId)) idents.add(i);
        ticketsOf.set(prId, [...idents].filter((i) => isTrackerIdent(parseTicketIdent(i))));
      }
      const candidates = new Map<string, { kicked: boolean; viaPrId: number | null }>();
      for (const ident of oneHopIdents(toRead, ticketsOf)) {
        const via = toRead.find((p) => ticketsOf.get(p)?.includes(ident)) ?? null;
        candidates.set(ident, { kicked: via != null && kickedHere.has(via), viaPrId: via });
      }
      // A kicked PR's tickets count as kicked even when another changed PR named them first.
      for (const prId of kickedHere) {
        for (const ident of ticketsOf.get(prId) ?? []) {
          const c = candidates.get(ident);
          if (c) c.kicked = true;
        }
      }
      const since = (lastTick.get(accountId) ?? nowMs - FIRST_TICK_LOOKBACK_MS) - CHANGED_SLACK_MS;
      try {
        for (const ident of await providers.listChangedTicketIdents(accountId, since)) {
          if (!candidates.has(ident) && isTrackerIdent(parseTicketIdent(ident))) {
            candidates.set(ident, { kicked: false, viaPrId: null });
          }
        }
      } catch {
        /* the cheap feed is optional; the PR half still runs */
      }
      for (const w of watching.values()) {
        if (w.accountId !== accountId) continue;
        const c = candidates.get(w.ident);
        if (c) c.kicked ||= w.kicked;
        else candidates.set(w.ident, { kicked: w.kicked, viaPrId: w.viaPrId });
      }

      // ---- 2–5. per ticket: one rule (auto-plan.ts), read from stored rows ----
      const capUsed = new Map<number, number>();
      const readerUserId = await (deps.readerUserId ?? readerUserIdOf)(ctx, accountId).catch(() => null);
      const ordered = [...candidates].sort(([a], [b]) => a.localeCompare(b));
      for (let ci = 0; ci < ordered.length; ci += 1) {
        const [ident, cand] = ordered[ci]!;
        const key = `${accountId}:${ident}`;
        const forget = (): void => {
          watching.delete(key);
        };
        const wait = (): void => {
          watching.set(key, { accountId, ident, kicked: cand.kicked, viaPrId: cand.viaPrId });
        };
        // The lane is full: this candidate AND every one not reached yet keep waiting. The PR
        // snapshot below still advances, so a candidate dropped here would never come back.
        const waitRest = (): void => {
          for (const [i, c] of ordered.slice(ci)) {
            watching.set(`${accountId}:${i}`, { accountId, ident: i, kicked: c.kicked, viaPrId: c.viaPrId });
          }
        };
        result.considered.push(ident);
        // ⚠ Queued or running: WAIT, never forget. The run's fingerprint was fixed when it was
        // prepared, so a member that moves while it runs is a change the run never saw — and the PR
        // snapshot advances this tick, so nothing else would bring the ticket back.
        if (deps.held(accountId, ident)) {
          wait();
          continue;
        }
        const st = await loadTicketAutoState(
          ctx,
          ident,
          {
            accountId,
            enabled,
            viaPrId: cand.viaPrId,
            kicked: cand.kicked,
            // Both gated above, for the whole account.
            aiReady: true,
            overBudget: false,
            laneRoom: deps.laneRoom(),
            held: false,
            dailyCap: deps.dailyCap,
            readerUserId,
            capUsed,
          },
          nowMs,
        );
        if (st == null || st.workspaceId == null) {
          forget();
          continue;
        }
        const { plan } = st;
        if (plan.status === 'off' || plan.status === 'up_to_date') {
          forget();
          continue;
        }
        if (plan.status === 'waiting' && plan.reason === 'lane_full') {
          waitRest();
          result.stopped = 'lane_full';
          break;
        }
        if (!plan.due) {
          // running, settling, or held by the cap: look again next tick.
          wait();
          continue;
        }
        const trigger = st.first ? 'auto' : 'cascade';
        const workspaceId = st.workspaceId;
        const live = st.live;
        const r = await deps.enqueue(ctx, {
          accountId,
          workspaceId,
          ident,
          ticketKey: st.ticket?.key ?? null,
          ticketTitle: st.ticket?.title ?? null,
          originPrId: cand.viaPrId ?? live.find((m) => m.state === 'open')?.prId ?? live[0]!.prId,
          trigger,
          cause: st.cause,
        });
        if (r.outcome === 'queued') {
          capUsed.set(workspaceId, (capUsed.get(workspaceId) ?? 0) + 1);
          result.queued.push({ ident, trigger, workspaceId });
          forget();
        } else if (r.outcome === 'already_running') {
          wait();
        } else if (r.outcome === 'busy') {
          waitRest();
          result.stopped = 'lane_full';
          break;
        } else {
          return result; // disabled
        }
      }

      // Commit what this tick read: PRs beyond the per-tick budget stay "changed" for the next.
      const snap = new Map(before ?? []);
      for (const prId of [...snap.keys()]) if (!now.has(prId) && readSet.has(prId)) snap.delete(prId);
      for (const [prId, head] of now) if (readSet.has(prId) || before?.get(prId) === head) snap.set(prId, head);
      prSnap.set(accountId, snap);
      if (!result.stopped) lastTick.set(accountId, nowMs);
    }
    for (const accountId of kicked.keys()) if (!byAccount.has(accountId)) kicked.delete(accountId);
    if (result.queued.length > 0) ctx.log.info(`ticket review sweep: queued ${result.queued.length} ticket(s)`);
    return result;
  } catch (err) {
    ctx.log.warn(`ticket review sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  } finally {
    sweeping = false;
  }
}

/** Register the sweeper and the first-auto-review kick — only where auto review can run at all. */
export function registerTicketReviewSweep(ctx: AgentContext): void {
  if (!autoReviewAvailable(ctx)) return;
  onAutoReviewLaunched((c, accountId, prId) => kickTicketSweep(c, accountId, prId));
  ctx.registerScheduledJob(
    TICKET_SWEEP_CRON,
    async () => {
      await runTicketReviewSweep(ctx);
    },
    'ticket-review-sweep',
  );
}
