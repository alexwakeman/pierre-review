// Chronology "Over time" — the render model behind the four trend charts (ChronologyTrend.tsx).
// Pure: no renderer, no fetch. docs/BOTTLENECKS.md § Over time.
//
// ⚠ THIN AND PARTIAL WEEKS NEVER ENTER THE MATHS. A week under `FLOW_TREND.thinWeekPrs` measured
// pull requests, and the unfinished current week, are drawn faint and left out of the baseline and
// the running gain — the server's lens and shift detection skip the same weeks (db/flow-trend.ts
// `usableWeek`), so the two halves cannot disagree about which weeks count.
import {
  FLOW_TREND,
  type FlowTrendEvent,
  type FlowTrendEventKind,
  type FlowTrendWeek,
} from '@pierre-review/shared';

/** A week the maths may use — the server's `usableWeek`, spelled once here for the client. */
export function usableWeek(w: FlowTrendWeek): boolean {
  return !w.thin && !w.partial && w.medianLeadWorkHours != null;
}

/** A true median (the mean of the middle two) — the same definition the server's lens uses. */
export function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// ── The running gain ─────────────────────────────────────────────────────────────────────────

export interface RunningGain {
  /** The first week counted against the baseline. */
  start: number;
  /** The weeks the baseline is the median of (usable weeks only, nearest first, oldest kept first). */
  baselineWeeks: number[];
  /** Median whole-PR time over `baselineWeeks`, working hours. */
  baseline: number;
  /** Cumulative working hours saved, per week; null before `start`. Unusable weeks carry the
   *  running total unchanged. */
  cumulative: (number | null)[];
  /** Hours saved that week (baseline − week median) × pull requests; null where not counted. */
  weekly: (number | null)[];
}

/**
 * Cumulative working hours saved against a baseline, for "Opened to merged, half within" (the week's
 * median whole-PR time, `medianLeadWorkHours`). Each counted week adds
 * `(baseline − week median) × pull requests measured that week` — the hours that week's pull
 * requests spent less (or more) than they would have at the baseline pace. A rising line is
 * improvement.
 *
 * `from` is the week accumulation starts: the baseline is the median of up to
 * `FLOW_TREND.baselineWeeks` usable weeks BEFORE it. With no `from`, the default: accumulation starts
 * right after the first `baselineWeeks` usable weeks, so the default needs ALL `baselineWeeks` (its
 * empty-state copy quotes that constant). A picked `from` needs only `MIN_BASELINE_WEEKS` usable weeks
 * before it; fewer is null — too few to call a baseline.
 */
export function runningGain(weeks: FlowTrendWeek[], from: number | null = null): RunningGain | null {
  let start = from;
  if (start == null) {
    let seen = 0;
    for (let i = 0; i < weeks.length; i += 1) {
      if (usableWeek(weeks[i] as FlowTrendWeek)) seen += 1;
      if (seen === FLOW_TREND.baselineWeeks) {
        start = i + 1;
        break;
      }
    }
    if (start == null) return null;
  }
  const baselineWeeks: number[] = [];
  for (let i = start - 1; i >= 0 && baselineWeeks.length < FLOW_TREND.baselineWeeks; i -= 1) {
    if (usableWeek(weeks[i] as FlowTrendWeek)) baselineWeeks.unshift(i);
  }
  if (baselineWeeks.length < MIN_BASELINE_WEEKS) return null;
  const baseline = medianOf(baselineWeeks.map((i) => (weeks[i] as FlowTrendWeek).medianLeadWorkHours as number));
  if (baseline == null) return null;
  const cumulative: (number | null)[] = weeks.map(() => null);
  const weekly: (number | null)[] = weeks.map(() => null);
  let total = 0;
  for (let i = start; i < weeks.length; i += 1) {
    const w = weeks[i] as FlowTrendWeek;
    if (usableWeek(w)) {
      const saved = (baseline - (w.medianLeadWorkHours as number)) * w.measuredPrs;
      weekly[i] = saved;
      total += saved;
    }
    cumulative[i] = total;
  }
  return { start, baselineWeeks, baseline, cumulative, weekly };
}

/** The change-point test's per-side floor, mirrored: fewer usable weeks is no baseline. */
export const MIN_BASELINE_WEEKS = 4;

// ── Event markers ────────────────────────────────────────────────────────────────────────────

export const EVENT_KIND_ORDER: readonly FlowTrendEventKind[] = ['repo', 'bot', 'contributor', 'setting', 'shift'];

export const EVENT_KIND_LABEL: Record<FlowTrendEventKind, string> = {
  repo: 'Repository joined',
  bot: 'New bot',
  contributor: 'New contributor',
  setting: 'Setting changed',
  shift: 'Detected shift',
};

/** All the events that share one week: one stacked marker. */
export interface EventCluster {
  week: number;
  events: FlowTrendEvent[];
  /** The kind the marker shows: the first in `EVENT_KIND_ORDER` present. */
  lead: FlowTrendEventKind;
  /** Only detected shifts — drawn dashed. */
  shiftsOnly: boolean;
}

export function clusterEvents(events: FlowTrendEvent[], shown: ReadonlySet<FlowTrendEventKind>): EventCluster[] {
  const byWeek = new Map<number, FlowTrendEvent[]>();
  for (const e of events) {
    if (!shown.has(e.kind) || e.week < 0) continue;
    const list = byWeek.get(e.week);
    if (list) list.push(e);
    else byWeek.set(e.week, [e]);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, list]) => {
      const sorted = [...list].sort(
        (a, b) => EVENT_KIND_ORDER.indexOf(a.kind) - EVENT_KIND_ORDER.indexOf(b.kind) || a.at.localeCompare(b.at),
      );
      return {
        week,
        events: sorted,
        lead: (sorted[0] as FlowTrendEvent).kind,
        shiftsOnly: sorted.every((e) => e.kind === 'shift'),
      };
    });
}

export function eventCounts(events: FlowTrendEvent[]): Record<FlowTrendEventKind, number> {
  const out: Record<FlowTrendEventKind, number> = { repo: 0, bot: 0, contributor: 0, setting: 0, shift: 0 };
  for (const e of events) out[e.kind] += 1;
  return out;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

/** "Mar 3" — a week's label, from its local Monday (`YYYY-MM-DD`, read as a calendar date). */
export function weekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  if (!y || !m || !d) return weekStart;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Working hours, short: "45 min", "6.2 h", "38 h". */
export function hoursShort(h: number): string {
  const a = Math.abs(h);
  if (a < 1) return `${Math.round(h * 60)} min`;
  if (a < 10) return `${h.toFixed(1).replace(/\.0$/, '')} h`;
  return `${Math.round(h).toLocaleString()} h`;
}

/** A signed gain: "+120 h", "−35 h", "0 h". The minus is a real minus sign. */
export function signedHours(h: number): string {
  const r = Math.round(h);
  if (r === 0) return '0 h';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toLocaleString()} h`;
}

/** A lens figure in its unit: a share as a whole percent, hours as `hoursShort`. */
export function lensValue(measure: string, v: number | null): string {
  if (v == null) return '–';
  return measure.endsWith('Share') ? `${Math.round(v * 100)}%` : hoursShort(v);
}

/** The change between two lens figures, signed, in the same unit ("−2.1 h", "+6 points"). */
export function lensChange(measure: string, before: number | null, after: number | null): string {
  if (before == null || after == null) return '–';
  const d = after - before;
  if (measure.endsWith('Share')) {
    const p = Math.round(d * 100);
    if (p === 0) return 'No change';
    return `${p > 0 ? '+' : '−'}${Math.abs(p)} ${Math.abs(p) === 1 ? 'point' : 'points'}`;
  }
  if (Math.abs(d) < 0.05) return 'No change';
  return `${d > 0 ? '+' : '−'}${hoursShort(Math.abs(d))}`;
}

/**
 * A lens row's SIGNIFICANT direction, or null. Only a `shift` verdict (z ≥ 3) is ever called; a
 * normal or too-few row says nothing at all. Every measure is a WAIT (working hours, or a share of
 * the working hours spent in one wait), so lower is better throughout.
 */
export function lensSignificance(row: {
  verdict: 'shift' | 'normal' | 'too_few';
  before: number | null;
  after: number | null;
}): 'better' | 'worse' | null {
  if (row.verdict !== 'shift' || row.before == null || row.after == null || row.after === row.before) return null;
  return row.after < row.before ? 'better' : 'worse';
}
