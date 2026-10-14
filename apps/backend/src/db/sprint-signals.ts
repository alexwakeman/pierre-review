import { and, eq } from 'drizzle-orm';
import {
  SPRINT_STAGE_LABEL,
  SPRINT_VISIT_GAP_MS,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintSignal,
  type SprintStage,
} from '@pierre-review/shared';
import type { SprintTiming } from './sprint-story.js';

// ACTIVITY → THIS SPRINT — THE STRIP'S CODE-WRITTEN CARDS (`SprintGraphResponse.signals`;
// docs/CLAUDE-REVIEW.md § Sprint story → The code cards). FREE, no model: every sentence is a template
// filled with counts taken here, from the SAME folded graph the page draws (db/sprint-graph.ts). Computed
// on every GET /api/sprint-graph — DB only, never a tracker or GitHub call.
//
//   • OUT OF STEP — a sprint ticket whose tracker stage disagrees with its pull requests: In review with
//     no open pull request (said apart: its code already merged, or no pull request at all — on workspace 1
//     11 of 14 such tickets had merged code, a team that moves a ticket to In review AFTER the merge, so
//     one undivided count read as 14 problems); Complete with one still open; Not started with one open
//     (a draft-only one said apart).
//   • PACE — the share of the sprint's days gone (shared `sprintDayOf`: day / days, the header's count)
//     beside the share of its tickets Complete. Neutral: no "behind" / "on track" verdict. Needs a REAL
//     sprint window (`sprintTimingFor`: the tracker's dates, else the cadence in mode 'sprint').
//   • BLOCKED OUTSIDE THE SPRINT — unfinished sprint tickets with a `depends_on` edge (a tracker blocking
//     link or a current brief's reading) onto a ticket OUTSIDE the sprint (a ghost) that is not Complete
//     (status unknown counts as not complete, as on the graph).
//   • SINCE YOU LAST LOOKED — what moved against the reader's BASELINE: tickets whose stage changed,
//     tickets added to the sprint, pull requests merged on sprint tickets. The baseline is a stored
//     snapshot per (account, workspace) in `sprint_view_snapshots`, two slots: CURRENT (refreshed on every
//     view) and BASELINE. ⚠ A view rolls CURRENT into BASELINE only when CURRENT is older than
//     SPRINT_VISIT_GAP_MS — so the page's own refetches (every few seconds while a pass runs) never erase
//     the diff, and a new visit compares against how the sprint looked at the END of the previous one. A
//     first-ever view (no baseline) and a baseline sharing no ticket with today's sprint (a new sprint)
//     show no card.
//
// ⚠ PURE AT IMPORT: the DB client is reached LAZILY inside the store functions.

const isDone = (n: Pick<SprintGraphNode, 'stage'>): boolean => n.stage === 'done';
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((100 * n) / of));
const stageLabel = (s: SprintStage): string => SPRINT_STAGE_LABEL[s];

// ── Out of step ──────────────────────────────────────────────────────────────────────────────────

/** Tracker stage vs the code, over the sprint's tickets. null when none disagree. Pure. */
export function outOfStepSignal(nodes: readonly SprintGraphNode[]): SprintSignal | null {
  const reviewMerged: string[] = [];
  const reviewNoPr: string[] = [];
  const doneOpen: string[] = [];
  const notStartedOpen: string[] = [];
  const notStartedDraft: string[] = [];
  for (const n of nodes) {
    if (n.ghost) continue;
    const open = n.prs.filter((p) => p.state === 'open');
    if (n.stage === 'in_review' && open.length === 0) (n.prs.some((p) => p.state === 'merged') ? reviewMerged : reviewNoPr).push(n.ident);
    else if (n.stage === 'done' && open.length > 0) doneOpen.push(n.ident);
    else if (n.stage === 'not_started' && open.length > 0) (open.some((p) => !p.draft) ? notStartedOpen : notStartedDraft).push(n.ident);
  }
  const idents = [...reviewNoPr, ...reviewMerged, ...doneOpen, ...notStartedOpen, ...notStartedDraft];
  if (idents.length === 0) return null;
  const parts: string[] = [];
  if (reviewNoPr.length > 0) parts.push(`${reviewNoPr.length} in review with no pull request`);
  if (reviewMerged.length > 0) parts.push(`${reviewMerged.length} in review with ${reviewMerged.length === 1 ? 'its' : 'their'} code already merged`);
  if (doneOpen.length > 0) parts.push(`${doneOpen.length} complete with a pull request still open`);
  if (notStartedOpen.length > 0) parts.push(`${notStartedOpen.length} not started with a pull request open`);
  if (notStartedDraft.length > 0) parts.push(`${notStartedDraft.length} not started with a draft pull request open`);
  return {
    kind: 'out_of_step',
    title: 'Tracker and code disagree',
    sentence: `${plural(idents.length, 'ticket', 'tickets')}: ${parts.join(', ')}.`,
    idents,
  };
}

// ── Pace ─────────────────────────────────────────────────────────────────────────────────────────

/** Days gone beside tickets complete. null with no real sprint window or no sprint ticket. Pure. */
export function paceSignal(nodes: readonly SprintGraphNode[], timing: SprintTiming | null | undefined): SprintSignal | null {
  if (timing == null) return null;
  const sprint = nodes.filter((n) => !n.ghost);
  if (sprint.length === 0) return null;
  const done = sprint.filter(isDone).length;
  return {
    kind: 'pace',
    title: `Day ${timing.day} of ${timing.days}`,
    sentence: `${pct(timing.day, timing.days)}% of the sprint's time has gone and ${pct(done, sprint.length)}% of its tickets are complete (${done} of ${sprint.length}).`,
    idents: sprint.filter((n) => !isDone(n)).map((n) => n.ident),
  };
}

// ── Blocked outside the sprint ───────────────────────────────────────────────────────────────────

/** Unfinished sprint tickets waiting on an unfinished ticket outside the sprint. null when none. Pure. */
export function blockedOutsideSignal(nodes: readonly SprintGraphNode[], edges: readonly SprintGraphEdge[]): SprintSignal | null {
  const byIdent = new Map(nodes.map((n) => [n.ident, n]));
  const blocked = new Set<string>();
  const outside = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'depends_on') continue;
    const from = byIdent.get(e.from);
    const to = byIdent.get(e.to);
    if (from == null || to == null || from.ghost || isDone(from) || !to.ghost || isDone(to)) continue;
    blocked.add(from.ident);
    outside.add(to.ident);
  }
  if (blocked.size === 0) return null;
  const notStarted = [...outside].filter((id) => byIdent.get(id)!.stage === 'not_started').length;
  const tail =
    outside.size === 1
      ? notStarted === 1
        ? 'it has not started'
        : 'it has started'
      : notStarted === 0
        ? 'all of them have started'
        : `${notStarted} of them ${notStarted === 1 ? 'has' : 'have'} not started`;
  return {
    kind: 'blocked_outside',
    title: `${plural(blocked.size, 'ticket', 'tickets')} waiting`,
    sentence: `${plural(blocked.size, 'sprint ticket waits', 'sprint tickets wait')} on ${plural(outside.size, 'ticket', 'tickets')} outside the sprint that ${outside.size === 1 ? 'is' : 'are'} not complete; ${tail}.`,
    idents: [...blocked, ...outside],
  };
}

// ── Since you last looked ────────────────────────────────────────────────────────────────────────

/** What one view saw: each sprint ticket's stage, and the merged pull requests on sprint tickets. */
export interface SprintViewSnapshot {
  v: 1;
  /** ident → stage (null = status unknown). The keys are the sprint's ticket set. */
  stages: Record<string, SprintStage | null>;
  /** prIds merged on sprint tickets. */
  merged: number[];
}

export interface SprintViewSlots {
  current: SprintViewSnapshot;
  currentAt: Date;
  baseline: SprintViewSnapshot | null;
  baselineAt: Date | null;
}

/** The snapshot of a folded graph (sprint tickets only). Pure. */
export function sprintViewSnapshotOf(nodes: readonly SprintGraphNode[]): SprintViewSnapshot {
  const stages: Record<string, SprintStage | null> = {};
  const merged = new Set<number>();
  for (const n of nodes) {
    if (n.ghost) continue;
    stages[n.ident] = n.stage;
    for (const p of n.prs) if (p.state === 'merged') merged.add(p.prId);
  }
  return { v: 1, stages, merged: [...merged].sort((a, b) => a - b) };
}

/** A tolerant read of a stored snapshot (null when it is not one). Pure. */
export function parseSprintViewSnapshot(v: unknown): SprintViewSnapshot | null {
  if (typeof v !== 'object' || v == null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.stages !== 'object' || o.stages == null || Array.isArray(o.stages) || !Array.isArray(o.merged)) return null;
  const stages: Record<string, SprintStage | null> = {};
  for (const [k, s] of Object.entries(o.stages as Record<string, unknown>)) {
    stages[k] = s === 'not_started' || s === 'in_progress' || s === 'in_review' || s === 'done' ? s : null;
  }
  return { v: 1, stages, merged: o.merged.filter((x): x is number => typeof x === 'number') };
}

/**
 * The two slots after a view at `nowMs`. ⚠ CURRENT rolls into BASELINE only when it is at least `gapMs`
 * old (the previous VISIT ended); otherwise only CURRENT is refreshed and the baseline stays. Pure.
 */
export function rollSprintViewSlots(
  prev: SprintViewSlots | null,
  snap: SprintViewSnapshot,
  nowMs: number,
  gapMs: number = SPRINT_VISIT_GAP_MS,
): SprintViewSlots {
  const now = new Date(nowMs);
  if (prev == null) return { current: snap, currentAt: now, baseline: null, baselineAt: null };
  if (nowMs - prev.currentAt.getTime() >= gapMs) return { current: snap, currentAt: now, baseline: prev.current, baselineAt: prev.currentAt };
  return { current: snap, currentAt: now, baseline: prev.baseline, baselineAt: prev.baselineAt };
}

/** "Since 40 minutes ago" / "Since 3 hours ago" / "Since yesterday" / "Since 4 days ago". Pure. */
export function sinceTitle(atMs: number, nowMs: number): string {
  const min = Math.max(1, Math.round((nowMs - atMs) / 60_000));
  if (min < 60) return `Since ${plural(min, 'minute', 'minutes')} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `Since ${plural(h, 'hour', 'hours')} ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'Since yesterday' : `Since ${d} days ago`;
}

const MOVE_ORDER: readonly SprintStage[] = ['done', 'in_review', 'in_progress', 'not_started'];

/** What moved since the baseline. null with no baseline, a baseline sharing no ticket with today's
 *  sprint (a new sprint), or nothing moved. Pure. */
export function sinceLastLookedSignal(
  baseline: SprintViewSnapshot | null,
  baselineAt: Date | null,
  nodes: readonly SprintGraphNode[],
  nowMs: number,
): SprintSignal | null {
  if (baseline == null || baselineAt == null) return null;
  const sprint = nodes.filter((n) => !n.ghost);
  if (!sprint.some((n) => n.ident in baseline.stages)) return null;
  const movedTo = new Map<SprintStage, string[]>();
  const added: string[] = [];
  const mergedOn: string[] = [];
  let mergedPrs = 0;
  const wasMerged = new Set(baseline.merged);
  for (const n of sprint) {
    if (!(n.ident in baseline.stages)) added.push(n.ident);
    else if (n.stage != null && baseline.stages[n.ident] !== n.stage) movedTo.set(n.stage, [...(movedTo.get(n.stage) ?? []), n.ident]);
    const fresh = n.prs.filter((p) => p.state === 'merged' && !wasMerged.has(p.prId)).length;
    if (fresh > 0) {
      mergedPrs += fresh;
      mergedOn.push(n.ident);
    }
  }
  const parts: string[] = [];
  const moves = MOVE_ORDER.filter((s) => movedTo.has(s));
  if (moves.length > 0) {
    parts.push(
      moves
        .map((s, i) => {
          const c = movedTo.get(s)!.length;
          return i === 0 ? `${plural(c, 'ticket', 'tickets')} moved to ${stageLabel(s)}` : `${c} to ${stageLabel(s)}`;
        })
        .join(', '),
    );
  }
  if (added.length > 0) parts.push(`${plural(added.length, 'ticket', 'tickets')} added to the sprint`);
  if (mergedPrs > 0) parts.push(`${plural(mergedPrs, 'pull request', 'pull requests')} merged`);
  if (parts.length === 0) return null;
  const idents = [...new Set([...moves.flatMap((s) => movedTo.get(s)!), ...added, ...mergedOn])];
  return { kind: 'since_last', title: sinceTitle(baselineAt.getTime(), nowMs), sentence: `${parts.join('; ')}.`, idents };
}

// ── The store ────────────────────────────────────────────────────────────────────────────────────

/** The stored slots, this account + workspace only. */
export async function readSprintViewSlots(accountId: number, workspaceId: number): Promise<SprintViewSlots | null> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintViewSnapshots;
  const rows = (await db
    .select({ currentJson: t.currentJson, currentAt: t.currentAt, baselineJson: t.baselineJson, baselineAt: t.baselineAt })
    .from(t)
    .where(and(eq(t.accountId, accountId), eq(t.workspaceId, workspaceId)))
    .limit(1)
    .execute()) as Array<{ currentJson: unknown; currentAt: Date; baselineJson: unknown; baselineAt: Date | null }>;
  const r = rows[0];
  if (r == null) return null;
  const current = parseSprintViewSnapshot(r.currentJson);
  if (current == null) return null;
  const baseline = parseSprintViewSnapshot(r.baselineJson);
  return { current, currentAt: new Date(r.currentAt), baseline, baselineAt: baseline != null && r.baselineAt != null ? new Date(r.baselineAt) : null };
}

/** Upsert the workspace's ONE slots row. */
export async function writeSprintViewSlots(accountId: number, workspaceId: number, s: SprintViewSlots): Promise<void> {
  const { db, schema } = await import('./client.js');
  const t = schema.sprintViewSnapshots;
  const values = { currentJson: s.current, currentAt: s.currentAt, baselineJson: s.baseline, baselineAt: s.baselineAt };
  await db
    .insert(t)
    .values({ accountId, workspaceId, ...values })
    .onConflictDoUpdate({ target: [t.accountId, t.workspaceId], set: values })
    .execute();
}

/**
 * The strip's code cards for one view, in their order (since you last looked, pace, out of step,
 * blocked outside the sprint), and the view's snapshot recorded. `record` false (no sprint read yet / no
 * sprint ticket) reads the baseline but writes nothing — an empty list must never become a baseline that
 * makes every ticket "added". Never throws: a store failure only loses "Since you last looked".
 */
export async function sprintSignalsFor(
  accountId: number,
  workspaceId: number,
  g: { nodes: readonly SprintGraphNode[]; edges: readonly SprintGraphEdge[]; timing: SprintTiming | null; record: boolean },
  nowMs: number,
): Promise<SprintSignal[]> {
  let since: SprintSignal | null = null;
  if (g.record) {
    try {
      const prev = await readSprintViewSlots(accountId, workspaceId);
      const slots = rollSprintViewSlots(prev, sprintViewSnapshotOf(g.nodes), nowMs);
      await writeSprintViewSlots(accountId, workspaceId, slots);
      since = sinceLastLookedSignal(slots.baseline, slots.baselineAt, g.nodes, nowMs);
    } catch {
      since = null;
    }
  }
  return [since, paceSignal(g.nodes, g.timing), outOfStepSignal(g.nodes), blockedOutsideSignal(g.nodes, g.edges)].filter(
    (s): s is SprintSignal => s != null,
  );
}
