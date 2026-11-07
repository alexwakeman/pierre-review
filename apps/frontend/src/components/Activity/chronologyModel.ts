import {
  FLOW_BUDGET_LABEL,
  REPORTING_DEFAULT_DAYS,
  reportingWindowShortTitle,
  type ReportingWindowInfo,
  type CourtShare,
  type FlowBudgetRow,
  type FlowPrFigures,
  type FlowPrRow,
  type FlowRequestStats,
  type FlowResponse,
  type FlowTrendWeek,
  type PrCourt,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';

// The render model for Chronology's WORKING-HOURS half — the balance target, the budget chart, the
// scatter and the per-PR tables. Pure, so `apps/frontend/test/chronologyModel.test.ts` can pin it
// without a renderer. The court-ledger half keeps `bottlenecksModel.ts`.
//
// ⚠ EVERY FIGURE HERE IS WORKING HOURS unless its name says otherwise. The repo rows further down
// the panel stay in CLOCK hours, because the rule that names a repository was calibrated on clock
// hours; the panel labels the two apart, and so must anything built from this file.
//
// ⚠ NO PERSON. The server sends no actor on any of these rows, and nothing here may add one.

/** The windows the panel offers. ⚠ THE DEFAULT IS THE WORKSPACE'S REPORTING WINDOW ('reporting':
 *  this sprint so far, or the last 7/14 days), the window every other Reports figure is tied to —
 *  resolved server-side by the one resolver. 30/60/90 days are the longer views (the server clamps
 *  a `?days=` to [7, 90]). */
export const CHRONOLOGY_WINDOWS = ['reporting', 30, 60, 90] as const;
export type ChronologyWindow = (typeof CHRONOLOGY_WINDOWS)[number];

/** Anything that is not one of the four reads as the default, the reporting window. */
export function effectiveChronologyWindow(
  raw: number | string | null | undefined,
): ChronologyWindow {
  return (CHRONOLOGY_WINDOWS as readonly (number | string)[]).includes(raw ?? -1)
    ? (raw as ChronologyWindow)
    : 'reporting';
}

/** The picker's words for one option. The reporting window is named by what it IS for this
 *  workspace ("This sprint" / "Last 14 days"), never by an abstraction like "reporting window". */
export function chronologyWindowLabel(
  w: ChronologyWindow,
  reporting: ReportingWindowInfo | null | undefined,
): string {
  if (w !== 'reporting') return `${w} days`;
  return reportingWindowShortTitle(reporting ?? { mode: 'rolling_14', days: REPORTING_DEFAULT_DAYS });
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
  slow: 'Past limit',
};

/** What each wait measures, in words — the popover's second line and the "i" modal's list. */
export const BUDGET_SUB: Record<FlowBudgetRow['measure'], string> = {
  firstLook: 'Opened to the first human review or comment',
  reply: 'Review to the author’s answer, on pull requests that went back to their author (each counted by its longest reply)',
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

// ── The balance target ───────────────────────────────────────────────────────────────────────
//
// The window's working hours as ONE point between the three courts, hours-weighted, with the
// centre (equal thirds) drawn as the target. Distance from the centre is 0 there and 1 at a
// corner; the verdict is read off that distance with the thresholds below, and the chart draws its
// rings at the SAME two numbers, so the picture and the words cannot disagree.
//
// ⚠ UNKNOWN IS NOT ZERO. No measured working hours ⇒ null ⇒ no marker, and the page says so.

export const BALANCE_RULES = {
  /** Within this distance of the centre: "Balanced" (the inner ring). */
  balanced: 0.15,
  /** Within this: it leans (the outer ring). Past it: "Mostly …" / "Almost no time …". */
  leans: 0.35,
  /** The largest share must beat the next by this much to be named as the pull; otherwise the
   *  smallest share is named as the gap ("Little time waiting for the author"). */
  clearLead: 0.1,
} as const;

export type BalanceVerdict = 'balanced' | 'leans' | 'strong';

export interface CourtBalance {
  /** Hours-weighted shares, summing to 1. */
  shares: Record<PrCourt, number>;
  /** 0 at equal thirds, 1 at a corner. */
  distance: number;
  verdict: BalanceVerdict;
  /** The court pulling the point, or null when the gap is named instead (or it is balanced). */
  toward: PrCourt | null;
  /** The court short of its third, when no single court clearly leads. */
  away: PrCourt | null;
  /** The verdict line, plain English. */
  text: string;
}

const BALANCE_PHRASE: Record<PrCourt, string> = {
  reviewer: 'waiting for a reviewer',
  author: 'waiting for the author',
  landing: 'waiting to merge',
};

const BALANCE_COURTS: readonly PrCourt[] = ['reviewer', 'author', 'landing'];

export function courtBalance(courts: readonly CourtShare[]): CourtBalance | null {
  const hours: Record<PrCourt, number> = { reviewer: 0, author: 0, landing: 0 };
  for (const c of courts) if (Number.isFinite(c.hours) && c.hours > 0) hours[c.court] += c.hours;
  const total = hours.reviewer + hours.author + hours.landing;
  if (!(total > 0)) return null;
  const shares: Record<PrCourt, number> = {
    reviewer: hours.reviewer / total,
    author: hours.author / total,
    landing: hours.landing / total,
  };
  const third = 1 / 3;
  const distance = Math.min(
    1,
    Math.sqrt(BALANCE_COURTS.reduce((s, c) => s + (shares[c] - third) ** 2, 0) / (2 / 3)),
  );
  if (distance < BALANCE_RULES.balanced) {
    return { shares, distance, verdict: 'balanced', toward: null, away: null, text: 'Balanced' };
  }
  const verdict: BalanceVerdict = distance < BALANCE_RULES.leans ? 'leans' : 'strong';
  const ranked = [...BALANCE_COURTS].sort((a, b) => shares[b] - shares[a]);
  const [first, second, last] = ranked as [PrCourt, PrCourt, PrCourt];
  if (shares[first] - shares[second] >= BALANCE_RULES.clearLead) {
    const phrase = BALANCE_PHRASE[first];
    return {
      shares,
      distance,
      verdict,
      toward: first,
      away: null,
      text: verdict === 'leans' ? `Leans to ${phrase}` : `Mostly ${phrase}`,
    };
  }
  const phrase = BALANCE_PHRASE[last];
  return {
    shares,
    distance,
    verdict,
    toward: null,
    away: last,
    text: verdict === 'leans' ? `Little time ${phrase}` : `Almost no time ${phrase}`,
  };
}

// ── Passed the first review, week by week ─────────────────────────────────────────────────────

/** Weeks the "passed the first review" line covers — the tail of the 26-week trend fetch. */
export const FIRST_REVIEW_TREND_WEEKS = 12;

export interface FirstReviewPoint {
  weekStart: string;
  /** Null when the server did not send the figure (an older server) — never drawn as zero. */
  count: number | null;
  measuredPrs: number;
  /** The current week, counted so far. */
  partial: boolean;
}

/** The last `FIRST_REVIEW_TREND_WEEKS` weeks of the trend, oldest first. */
export function firstReviewSeries(
  weeks: readonly FlowTrendWeek[],
  n: number = FIRST_REVIEW_TREND_WEEKS,
): FirstReviewPoint[] {
  return weeks.slice(-n).map((w) => ({
    weekStart: w.weekStart,
    count: w.passedFirstReview ?? null,
    measuredPrs: w.measuredPrs,
    partial: w.partial,
  }));
}

/** How many pull requests never went back to their author for changes. */
export function neverWentBack(prs: readonly FlowPrRow[]): number {
  return prs.filter((p) => p.rounds === 0).length;
}

// ── The headline figures over every measured pull request ────────────────────────────────────

/**
 * The scatter's headline figures.
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
