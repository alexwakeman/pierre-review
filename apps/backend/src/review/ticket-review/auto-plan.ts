import {
  criterionDone,
  TICKET_AUTO_GRACE_MS,
  TICKET_AUTO_MAX_WAIT_MS,
  type TicketAutoChangeKind,
  type TicketAutoCheck,
  type TicketAutoCheckReason,
  type TicketAutoCheckStatus,
} from '@pierre-review/shared';

// THE AUTOMATIC STORY CHECK'S ONE RULE (docs/CLAUDE-REVIEW.md § The automatic story check's clock).
// PURE: the sweeper (sweep.ts) acts on it and the states route (routes.ts) shows it, from the SAME
// inputs read from stored rows (auto-inputs.ts) — so the time the reader is promised is the time the
// sweeper keeps, and it survives a restart. No in-memory timer.
//
//   THE GRACE WINDOW. quietSince = the newest change: a push to ANY member PR (`head_seen_at`, when
//   Limn saw the head move), a PR joining (`tracker_tickets.linked_at`), a member merging, the ticket
//   changing (`changed_at`), a person's comment the latest check did not see (only while it has a
//   criterion not done — auto-inputs.ts). The check is due TICKET_AUTO_GRACE_MS (2 min) after it — every change
//   restarts the window, and a ticket's FIRST check waits too (its PRs are often linked minutes
//   apart; 2026-11-09 BMD-1175: five of the day's checks ran on part of a ticket, each followed by a
//   "PR joined" re-check).
//   THE CEILING. A burst — changes each less than the window apart, after the latest run — is checked
//   at most TICKET_AUTO_MAX_WAIT_MS (20 min) after its first change, so constant pushes still get one.
//   ALL MET. When the latest succeeded check found EVERY acceptance criterion done (`criterionDone`),
//   nothing re-checks it automatically — pushes, joins, merges and comments alike — until the story
//   text changes (its criteria may then differ). A click (Re-check) still runs one.
//   THE LIMITS. The workspace's daily cap (not for a ticket with a PR the reader owns) and the spend
//   budget. NO per-ticket limit (removed 2026-11-09: it counted joins and story edits as pushes).

export interface TicketAutoChange {
  atMs: number;
  // A run of changes ending at `atMs` began here (a PR's push burst, `head_burst_at`): every point
  // between is less than the window apart. Absent = a single change.
  sinceMs?: number | null;
  prId: number | null;
  kind: TicketAutoChangeKind;
}

export interface TicketAutoPlanInputs {
  // A run is queued or running now.
  running: boolean;
  // No succeeded run yet, or the latest one's fingerprint moved.
  needsRun: boolean;
  // A member is in a workspace with auto review on (and auto review can run at all here).
  autoOn: boolean;
  tooManyPrs: boolean;
  // The newest attempt failed (or was refused) on exactly these inputs: it would stop the same way.
  alreadyTried: boolean;
  // A person stopped the newest check while it was queued, and nothing changed since (auto-inputs.ts).
  stopped?: boolean;
  // No succeeded run yet.
  first: boolean;
  // The latest succeeded run found every acceptance criterion done (≥ 1 criterion) and the story text
  // has not changed since: no automatic re-check.
  allMet: boolean;
  // A first check's onboarding floor: a member opened after auto review was switched on, or the kick.
  floorOk: boolean;
  aiReady: boolean;
  overBudget: boolean;
  // The changes that may have moved the ticket (any order; times in the future are ignored).
  changes: readonly TicketAutoChange[];
  // When the latest run of the ticket (any status) was queued or started; null = none.
  lastRunAtMs: number | null;
  cap: { used: number; limit: number; exempt: boolean };
  // Free automatic check slots right now (null = not known; never a reason then).
  laneRoom: number | null;
}

export interface TicketAutoPlan {
  status: TicketAutoCheckStatus;
  reason: TicketAutoCheckReason | null;
  startsAtMs: number | null;
  lastChange: TicketAutoChange | null;
  // The sweeper queues the check now.
  due: boolean;
}

/** Every acceptance criterion of a stored assessment is done (met, or met outside code). No criteria = false. */
export function latestAllMet(
  assessment: { criteria?: ReadonlyArray<{ status: string }> | null } | null | undefined,
): boolean {
  const criteria = assessment?.criteria ?? [];
  return criteria.length > 0 && criteria.every((c) => criterionDone(c.status));
}

/** The next 00:00 UTC after `nowMs` — when the daily cap resets. */
export function nextUtcMidnightMs(nowMs: number): number {
  return nowMs - (nowMs % 86_400_000) + 86_400_000;
}

/**
 * The grace window alone: when the check may start, from the changes and the latest run. null = no
 * change to wait for (due at once). Pure.
 */
export function ticketAutoDueAt(
  changes: readonly TicketAutoChange[],
  lastRunAtMs: number | null,
  nowMs: number,
): { dueAtMs: number | null; last: TicketAutoChange | null } {
  const seen = changes.filter((c) => Number.isFinite(c.atMs) && c.atMs <= nowMs).sort((a, b) => a.atMs - b.atMs);
  const floor = lastRunAtMs ?? -Infinity;
  // The change the check waits on is the newest one the latest run did NOT see — anything after it,
  // or an unseen comment (the caller lists only comments the run did not see, whatever their date) —
  // never a push the run already checked. With none, the newest change overall (as before).
  const unseen = seen.filter((c) => c.atMs > floor || c.kind === 'commented');
  const last = unseen[unseen.length - 1] ?? seen[seen.length - 1] ?? null;
  if (last == null) return { dueAtMs: null, last: null };
  // The burst: walk back from the newest change while each step is shorter than the window and
  // after the latest run (that run saw everything before it: a burst that began before it counts
  // from the run).
  const startOf = (c: TicketAutoChange): number => Math.max(Math.min(c.sinceMs ?? c.atMs, c.atMs), floor);
  let burstStart = last.atMs > floor ? startOf(last) : last.atMs;
  for (let i = seen.length - 2; i >= 0; i -= 1) {
    const c = seen[i]!;
    if (c.atMs <= floor) break;
    if (burstStart - c.atMs >= TICKET_AUTO_GRACE_MS) break;
    burstStart = Math.min(burstStart, startOf(c));
  }
  return { dueAtMs: Math.min(last.atMs + TICKET_AUTO_GRACE_MS, burstStart + TICKET_AUTO_MAX_WAIT_MS), last };
}

/** THE RULE. What the automatic story check does next, and when. Pure. */
export function ticketAutoCheckPlan(inp: TicketAutoPlanInputs, nowMs: number): TicketAutoPlan {
  const { dueAtMs, last } = ticketAutoDueAt(inp.changes, inp.lastRunAtMs, nowMs);
  const out = (
    status: TicketAutoCheckStatus,
    reason: TicketAutoCheckReason | null = null,
    startsAtMs: number | null = null,
  ): TicketAutoPlan => ({ status, reason, startsAtMs, lastChange: last, due: status === 'due' });
  if (inp.running) return out('running');
  if (!inp.needsRun) return out('up_to_date');
  if (!inp.autoOn) return out('off', 'auto_off');
  if (inp.tooManyPrs) return out('off', 'too_many_prs');
  if (inp.allMet) return out('off', 'all_met');
  if (inp.alreadyTried) return out('off', 'already_tried');
  if (inp.stopped === true) return out('off', 'stopped');
  if (inp.first && !inp.floorOk) return out('off', 'no_floor');
  // What holds it past the window is said first: a time that will not be kept is never promised.
  if (!inp.aiReady) return out('held', 'ai_not_ready');
  if (inp.overBudget) return out('held', 'over_budget');
  if (!inp.cap.exempt && inp.cap.used >= inp.cap.limit) return out('held', 'daily_limit', nextUtcMidnightMs(nowMs));
  if (dueAtMs != null && nowMs < dueAtMs) return out('waiting', 'settling', dueAtMs);
  if (inp.laneRoom != null && inp.laneRoom <= 0) return out('waiting', 'lane_full');
  return out('due', null, dueAtMs);
}

/** The wire shape (shared `TicketAutoCheck`). */
export function toWireAutoCheck(p: TicketAutoPlan): TicketAutoCheck {
  return {
    status: p.status,
    reason: p.reason,
    startsAt: p.startsAtMs != null ? new Date(p.startsAtMs).toISOString() : null,
    lastChange:
      p.lastChange != null
        ? { prId: p.lastChange.prId, kind: p.lastChange.kind, at: new Date(p.lastChange.atMs).toISOString() }
        : null,
  };
}
