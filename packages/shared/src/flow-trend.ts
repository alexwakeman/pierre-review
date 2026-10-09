// CHRONOLOGY OVER TIME — the wire contract for `GET /api/flow-trend` (Reports → Chronology, Pro on
// `periodReports`). docs/BOTTLENECKS.md § Over time.
//
// Twenty-six weeks, one point per week, each week keyed by the MERGE week in the workspace's own
// working time zone (Monday 00:00 local). Every weekly figure is computed by the SAME code the
// Chronology panel uses for its window (`db/flow-detail.ts` `flowCoreFigures`), so a week's numbers
// match the panel's for the same span.
//
// ⚠ THE 26 WEEKS ARE A LABELLED EXCEPTION TO THE 90-DAY CAP. The panel stays capped at 90 days
// because retroactive history is coverage-biased; this view keeps the bias visible instead — every
// week carries how many repositories contributed, repo-joined weeks are marked, and thin weeks are
// drawn faint and left out of every baseline and shift calculation.
import type { FlowBudgetMeasure } from './flow-settings.js';
import type { CourtShare } from './types.js';

/** The floors and spans the trend folds with — the ONE spelling the page's copy quotes. */
export const FLOW_TREND = {
  /** Weeks on the chart, the current (partial) week included. */
  weeks: 26,
  /** A week with fewer measured pull requests than this is THIN: drawn faint, left out of every
   *  baseline, before/after median and shift calculation. */
  thinWeekPrs: 5,
  /** Weeks each side of an event the before/after lens compares (non-thin weeks only). */
  lensWeeks: 8,
  /** Weeks the running-gain baseline is the median of. */
  baselineWeeks: 8,
  /** A first appearance this close to the start of a repository's stored history is the start of
   *  our records, not a new arrival, and is not marked. */
  historyEdgeDays: 14,
  /** Markers per kind on the wire (newest kept). */
  maxMarkersPerKind: 40,
} as const;

/** Settings whose changes are recorded in `workspace_setting_events` (migration 0096 / pg 0083). */
export type WorkspaceSettingEventKind =
  | 'auto_review'
  | 'auto_fix'
  | 'auto_post'
  | 'flow_settings'
  | 'dependency_auto_merge'
  | 'tracker';

/** What a weekly series measures. The four budget waits are p75 working hours; the shares are the
 *  working-hour split ("Where the working hours went"). */
export type FlowTrendMeasure = FlowBudgetMeasure | 'reviewerShare' | 'authorShare' | 'landingShare';

export const FLOW_TREND_MEASURES: readonly FlowTrendMeasure[] = [
  'firstLook',
  'reply',
  'land',
  'lead',
  'reviewerShare',
  'authorShare',
  'landingShare',
];

export interface FlowTrendBudgetCell {
  measure: FlowBudgetMeasure;
  /** Pull requests behind the percentile. */
  prs: number;
  /** Working hours; null when nothing was measured. */
  p50: number | null;
  p75: number | null;
  /** Against the workspace's CURRENT budgets. null = too few to judge (`FLOW_RULES.budgetMinPrs`). */
  verdict: 'good' | 'ok' | 'slow' | null;
}

export interface FlowTrendWeek {
  /** Local Monday, `YYYY-MM-DD`, in the workspace's working time zone. */
  weekStart: string;
  /** ISO instants of the week's half-open span `[from, to)`. */
  from: string;
  to: string;
  /** The current week: measured so far, never cached. */
  partial: boolean;
  /** Merged, human-authored, human-touched pull requests — the panel's population. */
  measuredPrs: number;
  /** Fewer than `FLOW_TREND.thinWeekPrs` measured. */
  thin: boolean;
  /** Repositories with at least one merged pull request this week. */
  reposWithData: number;
  /** Repositories that were members of the workspace by the week's end. */
  reposInWorkspace: number;
  /** The working-hour split for the week. All zero when nothing was measured. */
  courtsWork: CourtShare[];
  /** Median whole-PR time, working hours; null when nothing was measured. */
  medianLeadWorkHours: number | null;
  budgets: FlowTrendBudgetCell[];
}

export type FlowTrendEventKind = 'bot' | 'contributor' | 'repo' | 'setting' | 'shift';

export interface FlowTrendEvent {
  /** Stable within a response, e.g. `bot:12`, `contributor:40`, `repo:7`, `setting:3`, `shift:lead`. */
  id: string;
  kind: FlowTrendEventKind;
  /** ISO instant. For a shift, the start of the week it begins. */
  at: string;
  /** Index into `weeks`. */
  week: number;
  /** One short templated line, e.g. "@octocat first contributed", "CodeRabbit first seen". */
  label: string;
  /** contributor / bot: the GitHub login. ⚠ A marker names a FIRST APPEARANCE and nothing else —
   *  no wait is ever attributed to a person (docs/BOTTLENECKS.md). */
  login?: string;
  /** bot: the vendor kind when the login is a known product (the SPA names it from its vendor table). */
  vendorKind?: string | null;
  /** repo: the repository that joined. */
  repoFullName?: string;
  /** setting: which setting changed. */
  settingKind?: WorkspaceSettingEventKind;
  /** shift: the series that shifted, and which way. */
  measure?: FlowTrendMeasure;
  direction?: 'up' | 'down';
}

/** One row of the before/after lens. */
export interface FlowTrendLensRow {
  measure: FlowTrendMeasure;
  /** Median of up to `FLOW_TREND.lensWeeks` non-thin weeks before the event week; null when none. */
  before: number | null;
  /** Median of up to `FLOW_TREND.lensWeeks` non-thin weeks from the event week on. */
  after: number | null;
  beforeWeeks: number;
  afterWeeks: number;
  /** `shift`: a real step change at this week (the change-point test, robust z ≥ 3).
   *  `normal`: within normal week-to-week variation. `too_few`: under 4 usable weeks on a side. */
  verdict: 'shift' | 'normal' | 'too_few';
}

export interface FlowTrendLens {
  week: number;
  rows: FlowTrendLensRow[];
}

export interface FlowTrendResponse {
  workspaceId: number;
  /** Oldest first; the last is the current, partial week. */
  weeks: FlowTrendWeek[];
  events: FlowTrendEvent[];
  /** A lens for every week that carries at least one event. */
  lenses: FlowTrendLens[];
  /** The working time zone the weeks are keyed in. */
  timeZone: string;
  /** The CURRENT budgets every week is coloured against (working hours). */
  budgets: Record<FlowBudgetMeasure, { good: number; ok: number }>;
  /** When settings history starts (the first `workspace_setting_events` row), or null if none yet. */
  settingsHistoryFrom: string | null;
  /** A scan cap was hit somewhere in the 26 weeks — some pull requests were not counted. */
  truncated: boolean;
  /** Days of history the server keeps (RETENTION_DAYS), when that is shorter than the span. */
  retentionDays: number | null;
}
