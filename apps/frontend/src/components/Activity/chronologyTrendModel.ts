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
 * Accumulation starts right after the first `FLOW_TREND.baselineWeeks` usable weeks, and the baseline
 * is the median of exactly those weeks (its empty-state copy quotes that constant). Fewer usable
 * weeks is null: too few to call a baseline.
 */
export function runningGain(weeks: FlowTrendWeek[]): RunningGain | null {
  const baselineWeeks: number[] = [];
  for (let i = 0; i < weeks.length && baselineWeeks.length < FLOW_TREND.baselineWeeks; i += 1) {
    if (usableWeek(weeks[i] as FlowTrendWeek)) baselineWeeks.push(i);
  }
  if (baselineWeeks.length < FLOW_TREND.baselineWeeks) return null;
  const start = (baselineWeeks[baselineWeeks.length - 1] as number) + 1;
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

// ── A marker's popover: what happened, when, and why it can move the line ────────────────────

/**
 * Why each kind of event can move a weekly figure — fixed copy, one line per kind present. It says
 * what the event CAN do to the figures, never that it did: a change can line up with an event
 * without being caused by it (the lens is where a change is tested).
 */
export const EVENT_KIND_WHY: Record<FlowTrendEventKind, string> = {
  repo: 'Its pull requests count in every weekly figure from this week on, so the line can move without anything changing in how people work.',
  bot: 'A bot never counts as someone reviewing, but its comments can give authors more to answer before a merge.',
  contributor: 'Someone new often needs more review rounds at first, so their pull requests can take longer to merge.',
  setting: 'It can change how pull requests are reviewed or merged from this week on.',
  shift: 'Nobody recorded this: the figures themselves moved this week, by more than their usual week-to-week spread.',
};

/** A working-hours or budget change alters how every wait is counted, not how anyone works. */
const FLOW_SETTINGS_WHY =
  'Working hours or budgets changed, which changes how every wait is counted and judged from this week on.';

/** Lines listed per kind before "and N more". */
export const EVENT_POPOVER_LINES = 6;

export interface EventPopoverGroup {
  kind: FlowTrendEventKind;
  /** The kind's name, e.g. "Repository joined". */
  heading: string;
  /** The day every event in the group happened, when they share one (printed once, by the
   *  heading); null when they differ (each item carries its own) or for a shift. */
  date: string | null;
  /** One per event: its line and, when the group has no shared day, the day it happened. */
  items: { id: string; text: string; date: string | null }[];
  /** Events past `EVENT_POPOVER_LINES`. */
  more: number;
  why: string;
}

export interface EventPopoverModel {
  /** "Week of 13 Jul". */
  title: string;
  groups: EventPopoverGroup[];
  /** That week on the hours-saved chart, as plain facts from the figures. */
  facts: string[];
}

/** "14 Jul" — the day an event happened, in the reader's locale like `weekLabel`. */
export function eventDay(at: string): string | null {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The popover a marker on "Working hours saved" opens: the events of one week grouped by kind (in
 * `EVENT_KIND_ORDER`), why each kind can move the line, and where that week sits on the chart.
 * Pure — `lineOf` names an event (the SPA names a bot by its product), and `gain` is the chart's own
 * `runningGain` (null when there is too little history for a baseline).
 */
export function eventPopoverModel(
  events: FlowTrendEvent[],
  week: number,
  weeks: FlowTrendWeek[],
  gain: RunningGain | null,
  lineOf: (e: FlowTrendEvent) => string = (e) => e.label,
): EventPopoverModel {
  const w = weeks[week];
  const title = w ? `Week of ${weekLabel(w.weekStart)}` : 'This week';
  const groups: EventPopoverGroup[] = [];
  for (const kind of EVENT_KIND_ORDER) {
    const of = events.filter((e) => e.kind === kind && e.week === week);
    if (of.length === 0) continue;
    const why =
      kind === 'setting' && of.every((e) => e.settingKind === 'flow_settings') ? FLOW_SETTINGS_WHY : EVENT_KIND_WHY[kind];
    // A shift is dated by its week, which the title already says.
    const days = kind === 'shift' ? [] : of.map((e) => eventDay(e.at));
    const shared = days.length > 0 && days.every((d) => d === days[0]) ? (days[0] ?? null) : null;
    groups.push({
      kind,
      heading: EVENT_KIND_LABEL[kind],
      date: shared,
      items: of.slice(0, EVENT_POPOVER_LINES).map((e, i) => ({
        id: e.id,
        text: lineOf(e),
        date: shared != null || kind === 'shift' ? null : (days[i] ?? null),
      })),
      more: Math.max(0, of.length - EVENT_POPOVER_LINES),
      why,
    });
  }
  return { title, groups, facts: w == null ? [] : weekFacts(w, week, gain) };
}

function prCount(n: number): string {
  return `${n.toLocaleString()} pull ${n === 1 ? 'request' : 'requests'}`;
}

function weekFacts(w: FlowTrendWeek, week: number, gain: RunningGain | null): string[] {
  const merged = `${prCount(w.measuredPrs)} merged${w.partial ? ' so far' : ''}`;
  if (w.measuredPrs === 0) return ['Nothing merged that week'];
  if (w.partial) return [merged, 'Not counted until the week ends'];
  if (!usableWeek(w)) return [merged, `Not counted: fewer than ${FLOW_TREND.thinWeekPrs} pull requests`];
  const half = `Half merged within ${hoursShort(w.medianLeadWorkHours as number)} (working hours)`;
  if (gain == null) return [merged, half];
  if (gain.baselineWeeks.includes(week)) return [merged, half, 'One of the weeks the baseline is taken from'];
  if (week < gain.start) return [merged, half, 'Before hours saved are counted'];
  const saved = gain.weekly[week];
  const total = gain.cumulative[week];
  const out = [merged, `${half}, against ${hoursShort(gain.baseline)} at the baseline`];
  if (saved != null) out.push(`That week ${signedHours(saved)}; running total ${signedHours(total ?? 0)}`);
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

// ── Hours saved in US$ ───────────────────────────────────────────────────────────────────────

/** Whole US dollars, thousands separated: `$11,400`. Cents only when the figure has them and is
 *  under $100 (an hourly rate of $87.50 stays legible). */
export function usd(v: number): string {
  const abs = Math.abs(v);
  const cents = abs < 100 && Math.round(abs * 100) % 100 !== 0;
  return `$${abs.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

/**
 * The working hours saved (or lost) priced at the workspace's hourly cost: |hours| × rate, rounded
 * to the dollar — the sign is already on the hours figure beside it. Null when no rate is set or
 * the rate is not a positive number (a blank figure, never a $0).
 */
export function hoursCostUsd(hours: number, hourlyCostUsd: number | null): number | null {
  if (hourlyCostUsd == null || !Number.isFinite(hourlyCostUsd) || hourlyCostUsd <= 0) return null;
  return Math.round(Math.abs(Math.round(hours)) * hourlyCostUsd);
}
