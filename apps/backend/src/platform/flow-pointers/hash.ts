// The CHRONOLOGY POINTERS payload hash — the $0-on-unchanged gate and the free GET's staleness
// probe, in ONE function both callers import (a second hand-copied formula drifts, and drift here
// is permanent staleness that re-bills on every click).
//
// ── WHAT IT FOLDS ───────────────────────────────────────────────────────────────────────────
//   - the schema and prompt versions, so a bump flips every stored row stale at once;
//   - the scope key (`ws:<id>|d:<days>`) and the workspace's calendar and budgets — a change of
//     working hours re-measures every figure the pointers were written against;
//   - per row, SORTED: its id, its working-hour figures (to two decimals, as they travel) and
//     its structural facts;
//   - per exemplar, SORTED: its id, side, band and a digest of its two texts.
//
// ── WHAT IT MUST NEVER FOLD ─────────────────────────────────────────────────────────────────
// Anything derived from `now()`. The per-PR figures here are computed from each PR's own fixed
// timestamps, so they do not move on a timer. The WINDOW does slide — a PR merged thirty-one days
// ago leaves the thirty-day population — and that moves the hash, which is right: the pointers
// really are about a different set of pull requests then. Nothing generates on its own; a moved
// hash raises the "out of date" marker and a person decides whether to spend.
import { createHash } from 'node:crypto';
import type { FlowPointerEvidence, FlowPointerRow } from '@pierre-review/shared';

/** Bump when the STORED output shape changes. */
export const FLOW_POINTERS_SCHEMA_VERSION = 1;
/** Bump when the prompt materially changes, so stored pointers read as out of date. */
// 1 → 2: the first real generation restated the charts and dropped three of five pointers for
// quoting ticket keys; the prompt now points the model at content and shape, bans numbers and
// ticket keys by name, and asks for one of each kind.
// 2 → 3: the evidence gained who was asked first (a person, a team or nobody).
// 3 → 4: the prompt now leads with what the quick pull requests did (examples first) and names
// the reporting window ("this sprint so far") instead of a day count.
export const FLOW_POINTERS_PROMPT_VERSION = 4;

export function flowPointersScopeKey(workspaceId: number, windowDays: number): string {
  return `ws:${workspaceId}|d:${windowDays}`;
}

/** The scope key for the evidence actually measured. The REPORTING WINDOW (Chronology's default)
 *  keys on its mode, plus the sprint's start for a sprint — so each sprint stores its own row and
 *  a rolling window (whose start slides every second) still hits its cache. */
export function flowPointersScopeKeyFor(e: FlowPointerEvidence): string {
  const w = e.reportingWindow;
  if (w == null) return flowPointersScopeKey(e.workspaceId, e.windowDays);
  return w.mode === 'sprint'
    ? `ws:${e.workspaceId}|r:sprint:${w.from}`
    : `ws:${e.workspaceId}|r:${w.mode}`;
}

function rowSig(r: FlowPointerRow): string {
  return [
    r.prId,
    r.quarter,
    r.leadWorkHours,
    r.workHours.reviewer,
    r.workHours.author,
    r.workHours.landing,
    r.firstLookWorkHours ?? '-',
    r.rounds,
    r.lines ?? '-',
    r.files ?? '-',
    r.reachAreas.join(','),
    r.ciRedHours,
    r.ticketKey ?? '-',
    r.selfMerged ? 's' : '-',
    r.requestKind ?? '-',
  ].join('#');
}

function digest(s: string | null): string {
  return s == null ? '-' : createHash('sha1').update(s).digest('hex').slice(0, 12);
}

export function flowPointersPayloadHash(scopeKey: string, e: FlowPointerEvidence): string {
  const s = e.settings;
  const sig = [
    `sv:${FLOW_POINTERS_SCHEMA_VERSION}`,
    `pv:${FLOW_POINTERS_PROMPT_VERSION}`,
    scopeKey,
    `cal:${s.timeZone}:${s.days.join(',')}:${s.startMinute}-${s.endMinute}`,
    `bud:${Object.entries(s.budgets)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v.good}/${v.ok}`)
      .join(',')}`,
    ...e.rows.map(rowSig).sort(),
    ...e.exemplars
      .map((x) => `x:${x.prId}:${x.side}:${x.sizeBand}:${digest(x.firstReview)}:${digest(x.description)}`)
      .sort(),
  ].join('|');
  return createHash('sha256').update(sig).digest('hex');
}
