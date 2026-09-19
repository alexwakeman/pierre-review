import {
  FLOW_BUDGET_LABEL,
  type FlowBudgetRow,
  type FlowPrFigures,
  type FlowPrRow,
  type FlowRequestStats,
  type FlowResponse,
  type PrCourt,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';

// The render model for Chronology's WORKING-HOURS half — the budget chart, the scatter, the
// triangle and the per-PR tables. Pure, so `apps/frontend/test/chronologyModel.test.ts` can pin it
// without a renderer. The court-ledger half keeps `bottlenecksModel.ts`.
//
// ⚠ EVERY FIGURE HERE IS WORKING HOURS unless its name says otherwise. The repo rows further down
// the panel stay in CLOCK hours, because the rule that names a repository was calibrated on clock
// hours; the panel labels the two apart, and so must anything built from this file.
//
// ⚠ NO PERSON. The server sends no actor on any of these rows, and nothing here may add one.

/** The windows the panel offers. The server clamps to [7, 90]; these three are the useful ones. */
export const CHRONOLOGY_WINDOWS = [30, 60, 90] as const;
export type ChronologyWindow = (typeof CHRONOLOGY_WINDOWS)[number];

/** A bookmarked or hand-typed window that is not one of the three reads as the default. */
export function effectiveChronologyWindow(raw: number | null | undefined): ChronologyWindow {
  return (CHRONOLOGY_WINDOWS as readonly number[]).includes(raw ?? -1)
    ? (raw as ChronologyWindow)
    : 30;
}

const DAY_LONG = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_SHORT = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function dayShort(isoWeekday: number): string {
  return DAY_SHORT[isoWeekday] ?? '';
}

export function dayLong(isoWeekday: number): string {
  return DAY_LONG[isoWeekday] ?? '';
}

/** Minutes after midnight → "09:00". */
export function clockTime(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * The working days in words. A run that wraps the week (Sunday to Thursday) reads as a range;
 * anything with a gap is listed. Every day is "every day", not a seven-name list.
 */
export function workingDaysText(days: readonly number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (set.length === 7) return 'every day';
  if (set.length === 0) return 'no days';
  if (set.length === 1) return `${dayLong(set[0]!)}s`;
  // Find a start such that the days form one consecutive run, allowing a wrap past Sunday.
  for (const start of set) {
    let ok = true;
    for (let i = 0; i < set.length; i += 1) {
      const d = ((start - 1 + i) % 7) + 1;
      if (!set.includes(d)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const end = ((start - 1 + set.length - 1) % 7) + 1;
      return `${dayLong(start)} to ${dayLong(end)}`;
    }
  }
  return set.map((d) => dayShort(d)).join(', ');
}

/** "Working hours: Monday to Friday, 09:00–18:00, Europe/London." */
export function calendarLine(s: ResolvedFlowSettings): string {
  return `Working hours: ${workingDaysText(s.days)}, ${clockTime(s.startMinute)}–${clockTime(
    s.endMinute,
  )}, ${s.timeZone}.`;
}

// ── Formatting ───────────────────────────────────────────────────────────────────────────────

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

/** A working duration as a compact figure: "40m", "6.5h", "12h". Never days — see below. */
export function formatWorkHours(h: number): string {
  if (!Number.isFinite(h) || h <= 0) return '0h';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 10) return `${oneDp(h)}h`;
  return `${Math.round(h)}h`;
}
// ⚠ NO "d" UNIT FOR WORKING HOURS. "2d" reads as two calendar days; a working day is 9 hours by
// default and whatever the workspace set otherwise. The figure stays in hours, and the chart axis
// marks where a working day falls instead.

export function formatCount(n: number): string {
  return n.toLocaleString('en-GB');
}

export function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// ── The budget chart ─────────────────────────────────────────────────────────────────────────

/** Plain labels for the three verdicts. Status is never colour alone: each ships with this. */
export const VERDICT_LABEL: Record<NonNullable<FlowBudgetRow['verdict']>, string> = {
  good: 'Within budget',
  ok: 'Acceptable',
  slow: 'Slow',
};

/** What each wait measures, in words — the popover's second line and the "i" modal's list. */
export const BUDGET_SUB: Record<FlowBudgetRow['measure'], string> = {
  firstLook: 'Opened to the first human review or comment',
  reply: 'The slowest reply on each pull request that went back to its author',
  land: 'Approved to merged, for pull requests that were approved',
  lead: 'Opened to merged',
};

/**
 * ONE horizontal scale for every budget row, so a bar length means the same number of hours in
 * each. Wide enough to show every "acceptable" mark with room past it, never narrower than a
 * working day, and rounded to a tick step. A percentile past the edge is drawn to the edge with
 * an arrow, not rescaled — one outlying row must not squash the other three.
 */
export function budgetScale(rows: readonly FlowBudgetRow[], dayHours: number): {
  max: number;
  ticks: number[];
} {
  const want = Math.max(dayHours, ...rows.map((r) => r.ok * 1.5));
  const step = want <= 12 ? 2 : want <= 30 ? 4 : want <= 60 ? 8 : 16;
  const max = Math.ceil(want / step) * step;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  return { max, ticks };
}

/** How a row's marks meet the right edge of the shared scale. */
export type BudgetClip = 'none' | 'tail' | 'bar';

/**
 * 'bar' when three in four ran past the axis (p75 > max), 'tail' when only nine in ten did.
 *
 * ⚠ A CLIPPED BAR MUST SAY SO ON THE CHART. The scale is shared, so a row past it is drawn to the
 * edge rather than rescaled — and a bar stopped at the edge looks exactly like one that ended
 * there. The figures moved into a popover, so the mark is the only thing on the page that tells a
 * reader this bar is longer than it looks.
 */
export function budgetClip(row: FlowBudgetRow, max: number): BudgetClip {
  if (row.prs === 0) return 'none';
  if (row.p75 > max) return 'bar';
  if (row.p90 > max) return 'tail';
  return 'none';
}

/**
 * The popover's content: the server's reason when there is no verdict, then the figures.
 *
 * ⚠ FIGURES AND SERVER PROSE ONLY. A judged row's own sentence restates the figures and the chip,
 * so it is not shown; a row without a verdict has no chip to say why, so its reason is.
 */
export function budgetPopoverRows(row: FlowBudgetRow): {
  note: string | null;
  figures: [string, string][];
} {
  const figures: [string, string][] = [];
  if (row.prs > 0) {
    figures.push(
      ['Pull requests', formatCount(row.prs)],
      ['Median', formatWorkHours(row.p50)],
      ['Three in four within', formatWorkHours(row.p75)],
      ['Nine in ten within', formatWorkHours(row.p90)],
    );
  }
  figures.push(['Budget', formatWorkHours(row.good)], ['Acceptable up to', formatWorkHours(row.ok)]);
  return { note: row.verdict == null && row.sentence !== '' ? row.sentence : null, figures };
}

/** The chart trigger's accessible name — every figure the popover holds, in one sentence. */
export function budgetAriaLabel(row: FlowBudgetRow): string {
  const label = FLOW_BUDGET_LABEL[row.measure];
  const budget = `Budget ${formatWorkHours(row.good)}, acceptable up to ${formatWorkHours(row.ok)}.`;
  if (row.prs === 0) return `${label}: No pull requests. ${budget}`;
  const verdict = row.verdict == null ? 'Too few to judge' : VERDICT_LABEL[row.verdict];
  return (
    `${label}: ${verdict}. ${formatCount(row.prs)} pull ${row.prs === 1 ? 'request' : 'requests'}; ` +
    `median ${formatWorkHours(row.p50)}, three in four within ${formatWorkHours(row.p75)}, ` +
    `nine in ten within ${formatWorkHours(row.p90)}. ${budget}`
  );
}

// ── The scatter ──────────────────────────────────────────────────────────────────────────────

/** Log scale floor: a pull request with under six working minutes sits on the floor, drawn there. */
export const SCATTER_FLOOR_HOURS = 0.1;

export function scatterYRange(prs: readonly FlowPrRow[]): { min: number; max: number } {
  const top = Math.max(8, ...prs.map((p) => p.leadWorkHours));
  // Round the ceiling up to a tick so the top dot is never on the frame.
  const ceil = [16, 40, 80, 160, 400, 800, 1600].find((t) => t >= top * 1.1) ?? top * 1.2;
  return { min: SCATTER_FLOOR_HOURS, max: ceil };
}

/** Ticks for the log axis, labelled in hours, with the working day marked separately. */
export function scatterTicks(max: number): { hours: number; label: string }[] {
  const all = [0.1, 0.5, 1, 4, 16, 40, 80, 160, 400, 800, 1600];
  return all
    .filter((h) => h <= max)
    .map((h) => ({ hours: h, label: h < 1 ? `${Math.round(h * 60)}m` : `${h}h` }));
}

/** Dot radius from lines changed — area, not radius, grows with size. Unknown size is the smallest. */
export function dotRadius(lines: number | null): number {
  if (lines == null || lines <= 0) return 3;
  return Math.min(10, 3 + Math.sqrt(lines) / 8);
}

/** The slowest pull requests, for the table that is the scatter's keyboard and screen-reader view. */
export function slowestPrs(prs: readonly FlowPrRow[], n: number): FlowPrRow[] {
  return [...prs]
    .sort((a, b) => b.leadWorkHours - a.leadWorkHours || a.prId - b.prId)
    .slice(0, n);
}

/** The share of all working-hour waiting the slowest tenth holds — for `prFiguresOf`'s fallback. */
export function slowestTenthShare(prs: readonly FlowPrRow[]): { count: number; share: number } {
  const sorted = [...prs].map((p) => p.leadWorkHours).sort((a, b) => b - a);
  const count = Math.ceil(sorted.length / 10);
  const total = sorted.reduce((s, v) => s + v, 0);
  const top = sorted.slice(0, count).reduce((s, v) => s + v, 0);
  return { count, share: total > 0 ? top / total : 0 };
}

// ── The triangle ─────────────────────────────────────────────────────────────────────────────
//
// ⚠ CONTEXT, NOT A TARGET. Balance between the three courts is not health: a pull request approved
// on its first review never visits its author, which is the best outcome and sits on an EDGE of
// this triangle. Its "i" says so, and the budget chart is the headline.

/** Below this many working minutes of waiting, a PR has no meaningful position and is left off. */
export const TRIANGLE_MIN_HOURS = 0.05;

export interface TrianglePoint {
  /** Barycentric weights, summing to 1. */
  reviewer: number;
  author: number;
  landing: number;
}

export function trianglePoint(work: Record<PrCourt, number>): TrianglePoint | null {
  const total = work.reviewer + work.author + work.landing;
  if (!(total >= TRIANGLE_MIN_HOURS)) return null;
  return { reviewer: work.reviewer / total, author: work.author / total, landing: work.landing / total };
}

/** How many pull requests never went back to their author — the edge the caption names. */
export function neverWentBack(prs: readonly FlowPrRow[]): number {
  return prs.filter((p) => p.rounds === 0).length;
}

// ── The headline figures over every measured pull request ────────────────────────────────────

/**
 * The scatter's and the triangle's headline figures.
 *
 * ⚠ THE SERVER'S, WHENEVER IT SENT THEM. `prs` is capped at 1,000 rows — every slow pull request,
 * then an even sample of the rest — so a count folded over it inflates exactly when it capped
 * (all the slow ones are kept). An older server sends no `prFigures`: the list is then recounted
 * only when it is COMPLETE, and when it is a sample there is no honest figure to print — null, and
 * the Figures row is not drawn.
 */
export function prFiguresOf(resp: FlowResponse): FlowPrFigures | null {
  if (resp.prFigures != null) return resp.prFigures;
  if (resp.prsCapped || resp.prs == null || resp.settings == null) return null;
  const dayHours = (resp.settings.endMinute - resp.settings.startMinute) / 60;
  const tenth = slowestTenthShare(resp.prs);
  return {
    overWorkingDay: resp.prs.filter((p) => p.leadWorkHours > dayHours).length,
    slowestTenthCount: tenth.count,
    slowestTenthShare: tenth.share,
    neverWentBack: neverWentBack(resp.prs),
  };
}

// ── Asking for a review: the two disclosure lines under the table ──────────────────────────────

/** "Who was asked is known for 40 of 52 pull requests so far." — only while some are unknown. */
export function requestCoverageLine(stats: FlowRequestStats): string | null {
  if (stats.known >= stats.measured) return null;
  return `Who was asked is known for ${formatCount(stats.known)} of ${formatCount(stats.measured)} pull requests so far.`;
}

/** The pull requests left out of the request figures because somebody looked before anyone asked. */
export function lookedBeforeAskedLine(stats: FlowRequestStats): string | null {
  const n = stats.lookedBeforeAsked;
  if (n <= 0) return null;
  return `${formatCount(n)} had a first look before anyone was asked and ${n === 1 ? 'is' : 'are'} left out of the request figures.`;
}

// ── What the working-hours half needs to render at all ────────────────────────────────────────

/** An older server sends none of these fields; the panel then renders only its court half. */
export function hasWorkingHours(resp: FlowResponse | undefined): boolean {
  return resp?.settings != null && Array.isArray(resp.budgets);
}
