import { and, desc, eq, inArray } from 'drizzle-orm';
import { TICKET_REVIEW_MAX_PRS, isTrackerIdent, parseTicketIdent } from '@pierre-review/shared';
import { config } from '../../config.js';
import type { AgentContext } from '../agent-context.js';
import { getTicketSource } from '../../tracker/ticket-source.js';
import { agenticRunReady } from '../claude-review/ai-ready.js';
import { autoReviewAvailable, autoReviewDue, utcDayStartMs } from '../claude-review/auto.js';
import { listAutoReviewWorkspaces } from '../claude-review/auto-settings.js';
import { onAutoReviewLaunched } from '../claude-review/manager.js';
import { fingerprint, readLiveMembers, ticketHash } from './fingerprint.js';
import { countAutoTicketReviewsSince, getTicketIdentsForPr, getTicketStateInputs } from './persist.js';
import { jiraMemberIds, jiraStoryFor } from './prepare.js';
import {
  startTicketReview,
  ticketAutoLaneRoom,
  ticketReviewHeld,
  type StartTicketArgs,
  type StartTicketResult,
} from './manager.js';

// THE TICKET REVIEW SWEEPER — re-checks a ticket when the PRs on it move, where auto review is on.
//
// A PULL, like the PR review's sweeper (claude-review/auto.ts): every tick re-derives what is due
// from the database and the tracker's stored ticket rows, so a restart loses nothing.
//
//   1. CANDIDATES. The tickets of PRs that CHANGED since the last tick — a new head, a new open PR,
//      or a PR that stopped being open (merged or closed) — read through the tracker's
//      `ticketsForPr` plus the tickets this PR was already judged on; the tracker's
//      `listChangedTicketIdents` (a PR joined or left, the story was edited); the tickets of a PR
//      whose auto PR review just launched (the kick — claude-review/manager.ts
//      `onAutoReviewLaunched` — so a PR's first auto review and its tickets' check start together);
//      and tickets still waiting from earlier ticks. ⚠ ONE HOP: only the tickets the changed PR is itself on. A ticket that merely
//      shares another PR with one of them is never added — its own fingerprint did not move.
//   2. LIVE FINGERPRINT from the synced heads (fingerprint.ts).
//   3. DUE when it differs from the latest SUCCEEDED run's — and no newer attempt (refused, failed
//      without an answer, or cancelled) already ran on exactly these inputs, which would only stop
//      the same way again. A run that THREW, or was cut off by a restart, stores no fingerprint
//      (persist.ts), so it stays retryable. A ticket whose run is queued or running WAITS, and is
//      judged again once the run has stored its fingerprint.
//   4. THE PR REVIEW'S START RULE, reused as is (`autoReviewDue`), keyed `account:ident` with the
//      fingerprint as the "head": a first run starts at once; a re-run starts at once when no run
//      of the ticket is in flight and none started or finished in the last 5 minutes, else after 5
//      quiet minutes (20-minute ceiling from the burst's first change). A run in flight is never
//      cancelled: the ticket WAITS, its clock running from the first change seen. NO CI hold — a
//      member's running CI does not delay the check.
//   5. ITS OWN DAILY CAP, `TICKET_REVIEW_DAILY_CAP` automatic runs ('auto' and 'cascade') per
//      workspace per UTC day — counted from rows, which an automatic run writes when it is QUEUED.
//      Never shared with the PR review's cap.
//
// THE WORKSPACE. Members may span workspaces (same Jira site); the run counts against an
// AUTO-ENABLED member workspace — the changed PR's when it is one. A ticket with no member in an
// auto-enabled workspace is never run automatically. A FIRST run also needs the onboarding floor
// the PR review uses: an open member opened at or after that workspace switched auto review on,
// or the kick (an auto review of one of its PRs launched) — so switching auto review on never reviews
// every old ticket at once.
//
// Pasted ('manual:') tickets never cascade: they have one PR and no tracker membership.

export const TICKET_SWEEP_CRON = '* * * * *';
// The most changed PRs whose tickets are read in one tick; the rest stay "changed" for the next.
const MAX_CHANGED_PRS_PER_TICK = 100;
// The first tick after boot asks the tracker for tickets changed in this window.
const FIRST_TICK_LOOKBACK_MS = 60 * 60 * 1000;
// listChangedTicketIdents overlap, so a row stamped while a tick ran is never missed.
const CHANGED_SLACK_MS = 60 * 1000;

interface Settle {
  key: string;
  firstSeenMs: number;
  burstStartMs: number;
}

// accountId → (prId → `${headSha}`) of the open PRs seen last tick, in auto-enabled workspaces.
const prSnap = new Map<number, Map<number, string>>();
// accountId → the last completed tick's time (the listChangedTicketIdents cursor).
const lastTick = new Map<number, number>();
// accountId → PRs whose auto PR review launched since the last tick.
const kicked = new Map<number, Set<number>>();
// `${accountId}:${ident}` → still waiting (settle, CI or the daily cap). Re-checked every tick.
const watching = new Map<string, { accountId: number; ident: string; kicked: boolean; viaPrId: number | null }>();
const settleSeen = new Map<string, Settle>();
// The settle key recorded while a run is in flight (its fingerprint is not read until it finishes).
const HELD = '\u0000held';

export function _resetTicketSweepForTest(): void {
  prSnap.clear();
  lastTick.clear();
  kicked.clear();
  watching.clear();
  settleSeen.clear();
  sweeping = false;
}

export interface TicketSweepDeps {
  roster(ctx: AgentContext): Promise<Array<{ accountId: number; workspaceId: number; enabledAtMs: number }>>;
  enqueue(ctx: AgentContext, a: StartTicketArgs): Promise<StartTicketResult>;
  laneRoom(): number;
  held(accountId: number, ident: string): boolean;
  dailyCap: number;
}

const defaultDeps: TicketSweepDeps = {
  roster: listAutoReviewWorkspaces,
  enqueue: startTicketReview,
  laneRoom: ticketAutoLaneRoom,
  held: ticketReviewHeld,
  dailyCap: config.ticketReviewDailyCap,
};

export interface TicketSweepResult {
  // Idents evaluated this tick.
  considered: string[];
  queued: Array<{ ident: string; trigger: 'auto' | 'cascade'; workspaceId: number }>;
  stopped: 'lane_full' | 'ai_not_ready' | null;
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
): Promise<Array<{ prId: number; headSha: string; workspaceId: number }>> {
  if (workspaceIds.length === 0) return [];
  const { pullRequests: pr, workspaceRepos: wr } = s(ctx);
  const rows = (await ctx.db
    .select({ prId: pr.id, headSha: pr.headSha, workspaceId: wr.workspaceId })
    .from(pr)
    .innerJoin(wr, and(eq(wr.repoId, pr.repoId), eq(wr.accountId, pr.accountId)))
    .where(and(eq(pr.accountId, accountId), eq(pr.state, 'open'), inArray(wr.workspaceId, [...workspaceIds])))
    .execute()) as Array<{ prId: number; headSha: string | null; workspaceId: number }>;
  return rows.map((r) => ({ ...r, headSha: r.headSha ?? '' }));
}

/** Per member: when it was opened (the onboarding floor). */
async function memberOpenedAt(
  ctx: AgentContext,
  accountId: number,
  prIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (prIds.length === 0) return out;
  const { pullRequests: pr } = s(ctx);
  const rows = (await ctx.db
    .select({ id: pr.id, openedAt: pr.openedAt })
    .from(pr)
    .where(and(eq(pr.accountId, accountId), inArray(pr.id, [...prIds])))
    .execute()) as Array<{ id: number; openedAt: Date }>;
  for (const r of rows) out.set(r.id, new Date(r.openedAt).getTime());
  return out;
}

/** The latest start or finish of any run of this ticket (null = none) — the "on receipt" test. */
async function lastTicketRunAtMs(ctx: AgentContext, accountId: number, ident: string): Promise<number | null> {
  const { ticketReviews: tr } = s(ctx);
  const rows = (await ctx.db
    .select({ createdAt: tr.createdAt, startedAt: tr.startedAt, completedAt: tr.completedAt })
    .from(tr)
    .where(and(eq(tr.accountId, accountId), eq(tr.ticketIdent, ident)))
    .orderBy(desc(tr.id))
    .limit(1)
    .execute()) as Array<{ createdAt: Date | null; startedAt: Date | null; completedAt: Date | null }>;
  const r = rows[0];
  if (!r) return null;
  const t = (d: Date | null): number => (d ? new Date(d).getTime() : 0);
  return Math.max(t(r.createdAt), t(r.startedAt), t(r.completedAt)) || null;
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
    // An account with nothing switched on any more forgets everything it was waiting on.
    for (const [k, w] of watching) if (!byAccount.has(w.accountId)) {
      watching.delete(k);
      settleSeen.delete(k);
    }

    for (const [accountId, enabled] of byAccount) {
      if (result.stopped) break;
      if ((await ctx.aiCredits.check(accountId)).agentBlocked) continue;

      // ---- 1. what changed since the last tick ----
      const open = await openPrsIn(ctx, accountId, [...enabled.keys()]);
      const before = prSnap.get(accountId);
      const now = new Map(open.map((p) => [p.prId, p.headSha]));
      const changed: number[] = [];
      for (const [prId, head] of now) if (before?.get(prId) !== head) changed.push(prId);
      if (before) for (const prId of before.keys()) if (!now.has(prId)) changed.push(prId);
      const kickedHere = kicked.get(accountId) ?? new Set<number>();
      kicked.delete(accountId);
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
      // `fromChange`: named by something that happened THIS tick (a moved/kicked PR, an edited story),
      // as opposed to only being carried in from `watching` — a held burst's quiet clock restarts on it.
      const candidates = new Map<string, { kicked: boolean; viaPrId: number | null; fromChange: boolean }>();
      for (const ident of oneHopIdents(toRead, ticketsOf)) {
        const via = toRead.find((p) => ticketsOf.get(p)?.includes(ident)) ?? null;
        candidates.set(ident, { kicked: via != null && kickedHere.has(via), viaPrId: via, fromChange: true });
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
            candidates.set(ident, { kicked: false, viaPrId: null, fromChange: true });
          }
        }
      } catch {
        /* the cheap feed is optional; the PR half still runs */
      }
      for (const w of watching.values()) {
        if (w.accountId !== accountId) continue;
        const c = candidates.get(w.ident);
        if (c) c.kicked ||= w.kicked;
        else candidates.set(w.ident, { kicked: w.kicked, viaPrId: w.viaPrId, fromChange: false });
      }

      // ---- 2–5. per ticket ----
      const capUsed = new Map<number, number>();
      const ordered = [...candidates].sort(([a], [b]) => a.localeCompare(b));
      for (let ci = 0; ci < ordered.length; ci += 1) {
        const [ident, cand] = ordered[ci]!;
        const key = `${accountId}:${ident}`;
        const forget = (): void => {
          watching.delete(key);
          settleSeen.delete(key);
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
        // A change seen while a run is in flight opens the burst; every LATER change restarts its
        // quiet clock (spec: 5 quiet minutes since the LAST push), and the burst start never moves.
        const holdSettle = (): void => {
          const prev = settleSeen.get(key);
          settleSeen.set(key, {
            key: HELD,
            firstSeenMs: cand.fromChange || prev == null ? nowMs : prev.firstSeenMs,
            burstStartMs: prev?.burstStartMs ?? nowMs,
          });
        };
        result.considered.push(ident);
        // ⚠ Queued or running: WAIT, never forget. The run's fingerprint was fixed when it was
        // prepared, so a member that moves while it runs is a change the run never saw — and the PR
        // snapshot advances this tick, so nothing else would bring the ticket back.
        if (deps.held(accountId, ident)) {
          // A change seen while a run is in flight opens the burst NOW (never cancelled; the run
          // finishes, then the new fingerprint settles from this moment, not from the run's end).
          holdSettle();
          wait();
          continue;
        }
        const membersWs = await providers.ticketMembers(accountId, ident).catch(() => []);
        const memberIds = [...new Set(membersWs.map((m) => m.prId))];
        if (memberIds.length === 0) {
          forget();
          continue;
        }
        const wsOfPr = new Map(membersWs.map((m) => [m.prId, m.workspaceId]));
        const viaWs = cand.viaPrId != null ? wsOfPr.get(cand.viaPrId) : undefined;
        const enabledWs = [...new Set(membersWs.map((m) => m.workspaceId))].filter((w) => enabled.has(w)).sort((a, b) => a - b);
        const workspaceId = viaWs != null && enabled.has(viaWs) ? viaWs : enabledWs[0];
        if (workspaceId == null) {
          forget();
          continue;
        }
        const ticket = await jiraStoryFor(accountId, ident, memberIds);
        if (!ticket) {
          forget();
          continue;
        }
        const live = await readLiveMembers(ctx, accountId, memberIds);
        // Over the member cap an automatic run would only store a refusal; a click explains it.
        if (live.length === 0 || live.length > TICKET_REVIEW_MAX_PRS) {
          forget();
          continue;
        }
        const fp = fingerprint(ticketHash(ticket), live);
        const st = (await getTicketStateInputs(ctx, accountId, [ident])).get(ident);
        if (st?.runningRunId != null) {
          holdSettle();
          wait();
          continue;
        }
        if (st?.latest?.fingerprint === fp) {
          forget();
          continue;
        }
        const attempt = st?.latestAttempt;
        if (attempt && attempt.id > (st?.latest?.id ?? 0) && attempt.fingerprint === fp) {
          forget();
          continue;
        }
        const first = st?.latest == null;
        if (first && !cand.kicked) {
          const opened = await memberOpenedAt(ctx, accountId, live.map((m) => m.prId));
          const floor = enabled.get(workspaceId)!;
          const fresh = live.some((m) => m.state === 'open' && (opened.get(m.prId) ?? 0) >= floor);
          if (!fresh) {
            forget();
            continue;
          }
        }

        // ---- the settle rule, the PR review's own (no CI hold) ----
        let settle: Settle | null = null;
        if (!first) {
          settle = settleSeen.get(key) ?? { key: fp, firstSeenMs: nowMs, burstStartMs: nowMs };
          if (settle.key !== fp) {
            settle = { ...settle, key: fp, firstSeenMs: settle.key === HELD ? settle.firstSeenMs : nowMs };
          }
          settleSeen.set(key, settle);
        }
        const due = autoReviewDue({
          nowMs,
          settle: settle ? { quietSinceMs: settle.firstSeenMs, burstStartMs: settle.burstStartMs, reason: 'head' } : null,
          lastRunAtMs: first ? null : await lastTicketRunAtMs(ctx, accountId, ident),
        });
        if (!due.due) {
          wait();
          continue;
        }

        // ---- the daily cap (rows: an automatic run's row exists from the moment it is queued) ----
        let used = capUsed.get(workspaceId);
        if (used == null) {
          used = await countAutoTicketReviewsSince(ctx, accountId, workspaceId, dayStartMs);
          capUsed.set(workspaceId, used);
        }
        if (used >= deps.dailyCap) {
          wait();
          continue;
        }
        if (deps.laneRoom() <= 0) {
          waitRest();
          result.stopped = 'lane_full';
          break;
        }
        const trigger = first ? 'auto' : 'cascade';
        const r = await deps.enqueue(ctx, {
          accountId,
          workspaceId,
          ident,
          ticketKey: ticket.key ?? null,
          ticketTitle: ticket.title,
          manualTicket: null,
          originPrId: cand.viaPrId ?? live.find((m) => m.state === 'open')?.prId ?? live[0]!.prId,
          trigger,
        });
        if (r.outcome === 'queued') {
          capUsed.set(workspaceId, used + 1);
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
