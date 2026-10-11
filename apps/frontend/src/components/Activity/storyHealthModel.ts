// Reports → Stories → Story health — the render model behind StoryHealth.tsx. Pure: no renderer, no
// fetch. docs/FRONTEND.md § Story health.
//
// ⚠ THE SERVER DECIDES EVERY NUMBER. Weekly values, the rolling 4-week line, thinness, the shifts and
// their before/after medians and verdicts all arrive on the wire (`GET /api/story-health`). Nothing
// here recomputes a median or re-judges a direction: this file only groups, formats and words them.
// ⚠ GREEN/RED COMES FROM `shift.verdict` ALONE — a series with no better direction is never coloured.
import {
  STORY_HEALTH_SERIES,
  STORY_HEALTH_SERIES_BY_ID,
  STORY_SIZE_BANDS,
  STORY_SPEC_GAP_TYPE_LABEL,
  STORY_SPEC_GAP_TYPES,
  type StoryHealthOmitted,
  type StoryHealthPanel,
  type StoryHealthPoint,
  type StoryHealthResponse,
  type StoryHealthSeries,
  type StoryHealthSeriesId,
  type StoryHealthSeriesMeta,
  type StoryHealthShift,
  type StoryHealthUnit,
  type StoryHealthWeek,
} from '@pierre-review/shared';
import { hoursShort, weekLabel } from './chronologyTrendModel.js';

const storiesWord = (n: number): string => `${n} ${n === 1 ? 'story' : 'stories'}`;
const criteriaWord = (n: number): string => `${n} ${n === 1 ? 'criterion' : 'criteria'}`;

/** Stroke colour per series (non-text: lines, dots, legend swatches). */
export const STORY_SERIES_COLOR: Record<StoryHealthSeriesId, string> = {
  unclearDone: '#2563eb',
  blocked: '#db2777',
  specGaps: '#d97706',
  workingTimeS: '#14b8a6',
  workingTimeM: '#3b82f6',
  workingTimeL: '#6366f1',
  prsPerStory: '#64748b',
  criteriaMet: '#16a34a',
};

/** A value in its series' unit: "48%", "6.2 h", "1.5". */
export function formatStoryValue(unit: StoryHealthUnit, v: number): string {
  if (unit === 'pct') return `${Math.round(v)}%`;
  if (unit === 'hours') return hoursShort(v);
  const r = Math.round(v * 10) / 10;
  return r.toFixed(1).replace(/\.0$/, '');
}

/** A signed change in the series' unit: "+12 points", "−3.5 h", "+0.5". The minus is a real minus. */
export function formatStoryChange(unit: StoryHealthUnit, before: number, after: number): string {
  const d = after - before;
  const sign = d > 0 ? '+' : d < 0 ? '−' : '';
  const a = Math.abs(d);
  if (unit === 'pct') {
    const p = Math.round(a);
    return p === 0 ? 'no change' : `${sign}${p} ${p === 1 ? 'point' : 'points'}`;
  }
  if (unit === 'hours') return a === 0 ? 'no change' : `${sign}${hoursShort(a)}`;
  const r = Math.round(a * 10) / 10;
  return r === 0 ? 'no change' : `${sign}${r.toFixed(1).replace(/\.0$/, '')}`;
}

/** The series of one panel that the response carries, in legend order, with their metadata. */
export function panelSeries(
  data: Pick<StoryHealthResponse, 'series'>,
  panel: StoryHealthPanel,
): { meta: StoryHealthSeriesMeta; series: StoryHealthSeries }[] {
  const byId = new Map(data.series.map((s) => [s.id, s]));
  const out: { meta: StoryHealthSeriesMeta; series: StoryHealthSeries }[] = [];
  for (const meta of STORY_HEALTH_SERIES) {
    if (meta.panel !== panel) continue;
    const series = byId.get(meta.id);
    if (series != null) out.push({ meta, series });
  }
  return out;
}

/** The delivery panel draws three strips, one per UNIT, so no two scales ever share an axis. */
export interface DeliveryStrip {
  key: 'time' | 'prs' | 'met';
  title: string;
  ids: StoryHealthSeriesId[];
}

export const DELIVERY_STRIPS: readonly DeliveryStrip[] = [
  { key: 'time', title: 'Working time by story size', ids: ['workingTimeS', 'workingTimeM', 'workingTimeL'] },
  { key: 'prs', title: 'Pull requests per story', ids: ['prsPerStory'] },
  { key: 'met', title: 'Criteria met', ids: ['criteriaMet'] },
];

/** Top of the y-axis: 100 for a percentage, else a rounded-up max over what is drawn (≥ 1). */
export function axisTop(unit: StoryHealthUnit, values: (number | null)[]): number {
  if (unit === 'pct') return 100;
  const max = Math.max(0, ...values.filter((v): v is number => v != null && Number.isFinite(v)));
  if (max <= 1) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * exp >= max) return step * exp;
  }
  return 10 * exp;
}

/** Every value a strip will draw — weekly points AND the rolling line — so nothing clips. */
export function drawnValues(points: StoryHealthPoint[]): (number | null)[] {
  return points.flatMap((p) => [p.value, p.rolling]);
}

/** Head of a week's hover box. */
export function storyWeekHead(w: StoryHealthWeek): string {
  return `Week of ${weekLabel(w.weekStart)}${w.partial ? ' (so far)' : ''}`;
}

/** "12 of 15 stories labelled" — the week's label coverage. */
export function coverageLine(w: StoryHealthWeek): string {
  return `${w.labelled} of ${w.labellable} ${w.labellable === 1 ? 'story' : 'stories'} labelled`;
}

/** "15 stories written" (+ how many were dated by their first pull request, + how many have no criteria). */
export function createdLine(w: StoryHealthWeek): string {
  const base = `${w.storiesCreated} ${w.storiesCreated === 1 ? 'story' : 'stories'} written`;
  const dated = w.createdFallback > 0 ? `${base} (${w.createdFallback} dated by first pull request)` : base;
  return w.noCriteria > 0 ? `${dated} · ${w.noCriteria} with no criteria` : dated;
}

/** "9 stories merged" (+ unknown size, reviewed). */
export function mergedLine(w: StoryHealthWeek): string {
  const parts = [`${w.storiesMerged} ${w.storiesMerged === 1 ? 'story' : 'stories'} merged`];
  if (w.unsizedStories > 0) parts.push(`${w.unsizedStories} of unknown size`);
  if (w.reviewedStories > 0) parts.push(`${w.reviewedStories} reviewed`);
  return parts.join(' · ');
}

/** What one series says about one week, for the hover box. */
export function pointLine(meta: StoryHealthSeriesMeta, p: StoryHealthPoint): string {
  const nWord =
    meta.over === 'criteria' && p.criteria != null
      ? `${criteriaWord(p.criteria.den)} in ${storiesWord(p.n)}`
      : `${p.n} ${meta.over === 'reviewed' ? (p.n === 1 ? 'reviewed story' : 'reviewed stories') : p.n === 1 ? 'story' : 'stories'}`;
  if (p.value == null) return p.n === 0 ? 'none' : `not measured (${nWord})`;
  const head = `${formatStoryValue(meta.unit, p.value)} (${nWord})`;
  if (p.thin) return `${head}: too few to compare`;
  return p.rolling != null ? `${head} · 4 weeks ${formatStoryValue(meta.unit, p.rolling)}` : head;
}

// ── Shifts ─────────────────────────────────────────────────────────────────────────────────

export interface ShiftCluster {
  /** Index into `weeks`. */
  week: number;
  shifts: StoryHealthShift[];
}

/** Shifts of the given (visible) series, grouped by the week the after-segment starts. Oldest first. */
export function clusterShifts(shifts: StoryHealthShift[], visible: ReadonlySet<StoryHealthSeriesId>): ShiftCluster[] {
  const byWeek = new Map<number, StoryHealthShift[]>();
  for (const s of shifts) {
    if (!visible.has(s.series)) continue;
    const list = byWeek.get(s.week) ?? [];
    list.push(s);
    byWeek.set(s.week, list);
  }
  const order = new Map(STORY_HEALTH_SERIES.map((m, i) => [m.id, i]));
  return [...byWeek.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, list]) => ({
      week,
      shifts: [...list].sort((a, b) => (order.get(a.series) ?? 0) - (order.get(b.series) ?? 0)),
    }));
}

/** One line per shift, for a marker's hover box: "Spec gaps: 52% → 31%". */
export function shiftLine(s: StoryHealthShift): string {
  const meta = STORY_HEALTH_SERIES_BY_ID[s.series];
  return `${meta.label}: ${formatStoryValue(meta.unit, s.before)} → ${formatStoryValue(meta.unit, s.after)}`;
}

/** The lens word for a shift: only a declared better direction earns one. */
export function shiftVerdictWord(s: StoryHealthShift): string | null {
  if (s.verdict === 'better') return 'Better';
  if (s.verdict === 'worse') return 'Worse';
  return null;
}

/** A week picked by `weekStart` (held across a week roll-over), as an index; null when gone. */
export function weekIndex(weeks: StoryHealthWeek[], weekStart: string | null): number | null {
  if (weekStart == null) return null;
  const i = weeks.findIndex((w) => w.weekStart === weekStart);
  return i < 0 ? null : i;
}

/** Stories a press of "Label N stories" would label. */
export function labelPressCount(unlabelled: number, cap: number): number {
  return Math.max(0, Math.min(unlabelled, cap));
}

// ── Small multiples (the refinement panel) ────────────────────────────────────────────────

/** Container width at which the small charts sit two to a row. */
export const SMALL_MULTIPLE_TWO_COLUMNS_FROM = 560;

/** Columns of small charts for a container width: 2 from `SMALL_MULTIPLE_TWO_COLUMNS_FROM`, else 1. */
export function smallMultipleColumns(width: number): 1 | 2 {
  return width >= SMALL_MULTIPLE_TWO_COLUMNS_FROM ? 2 : 1;
}

/** A small chart's header figures, read off the SERVER's rolling line: the latest rolling value and the
 *  first one in the span (null when the series has no rolling value at all). */
export function rollingHeadline(points: StoryHealthPoint[]): { current: number; first: number; firstWeek: number } | null {
  let firstWeek = -1;
  let current: number | null = null;
  points.forEach((p, i) => {
    if (p.rolling == null) return;
    if (firstWeek < 0) firstWeek = i;
    current = p.rolling;
  });
  if (firstWeek < 0 || current == null) return null;
  return { current, first: points[firstWeek]!.rolling!, firstWeek };
}

/** The colour word for a small chart's change line: the shift's verdict, and only when the change since
 *  the first rolling value moves the same way as the detected shift. No shift (or no direction) → null. */
export function headlineVerdict(
  shift: StoryHealthShift | undefined,
  first: number,
  current: number,
): 'better' | 'worse' | null {
  if (shift == null || shift.verdict == null) return null;
  const up = current > first;
  const down = current < first;
  if ((shift.direction === 'up' && up) || (shift.direction === 'down' && down)) return shift.verdict;
  return null;
}

/** The units behind one side of a shift: "301 criteria", "31 stories", "4 weeks". */
export function shiftUnits(n: number, of: StoryHealthShift['nOf']): string {
  if (of === 'criteria') return `${n} ${n === 1 ? 'criterion' : 'criteria'}`;
  if (of === 'stories') return `${n} ${n === 1 ? 'story' : 'stories'}`;
  return `${n} ${n === 1 ? 'week' : 'weeks'}`;
}

// ── The per-chart ⓘ: COMPUTED, three lines at most ──────────────────────────────────────────────
//
// (1) what counts, one sentence; (2) this week's figure; (3) the detected shift, when there is one.
// Nothing generic: a chart with no shift says nothing about shifts.

/** (1) What one series counts, one sentence. */
export function seriesCountsSentence(id: StoryHealthSeriesId): string {
  switch (id) {
    case 'unclearDone':
      return 'Criteria in the stories Claude has read that can’t be checked as written.';
    case 'blocked':
      return 'A story counts when your tracker links it to work it waits on, finished or not.';
    case 'specGaps':
      return 'A story counts when a developer would have to ask about a missing detail.';
    case 'workingTimeS':
      return `Median working time from first pull request to last merge, for stories under ${STORY_SIZE_BANDS.mediumFrom} lines changed.`;
    case 'workingTimeM':
      return `Median working time from first pull request to last merge, for stories of ${STORY_SIZE_BANDS.mediumFrom} to ${STORY_SIZE_BANDS.largeFrom - 1} lines changed.`;
    case 'workingTimeL':
      return `Median working time from first pull request to last merge, for stories of ${STORY_SIZE_BANDS.largeFrom} lines changed or more.`;
    case 'prsPerStory':
      return 'Median pull requests per story, open, merged or closed.';
    case 'criteriaMet':
      return 'Share of criteria a ticket review found met, over reviewed stories.';
  }
}


/** The week's NUMERATOR for a refinement series: the server's list + "more" when sent, else derived
 *  from the value and n. */
export function pointNumerator(p: Pick<StoryHealthPoint, 'value' | 'n' | 'stories' | 'storiesMore'>): number | null {
  if (p.stories != null) return p.stories.length + (p.storiesMore ?? 0);
  if (p.value == null) return null;
  return Math.round((p.value / 100) * p.n);
}

/** (2) The latest week's figure: "4 of 9 stories" (+ " so far" on the partial week); a delivery series
 *  reads "6.2 h · 9 stories". null when there are no weeks. */
export function latestFigureLine(
  meta: StoryHealthSeriesMeta,
  points: readonly StoryHealthPoint[],
  weeks: readonly StoryHealthWeek[],
): string | null {
  const i = points.length - 1;
  const p = points[i];
  const w = weeks[i];
  if (p == null || w == null) return null;
  const when = w.partial ? 'This week so far' : 'This week';
  if (p.n === 0 || p.value == null) return `${when}: no stories`;
  if (meta.panel === 'refinement') {
    if (meta.over === 'criteria' && p.criteria != null) return `${when}: ${p.criteria.num} of ${criteriaWord(p.criteria.den)}`;
    return `${when}: ${pointNumerator(p) ?? 0} of ${storiesWord(p.n)}`;
  }
  const over = meta.over === 'reviewed' ? `${p.n} reviewed ${p.n === 1 ? 'story' : 'stories'}` : storiesWord(p.n);
  return `${when}: ${formatStoryValue(meta.unit, p.value)} · ${over}`;
}

/** (3) The detected shift as one sentence: "Rose from 19% to 44% on 17 Aug, 32 vs 28 stories"; a criteria
 *  series counts criteria ("…, 210 vs 240 criteria"). */
export function shiftSentence(s: StoryHealthShift): string {
  const meta = STORY_HEALTH_SERIES_BY_ID[s.series];
  const verb = s.direction === 'up' ? 'Rose' : 'Fell';
  const units = `${s.beforeN} vs ${shiftUnits(s.afterN, s.nOf)}`;
  return `${verb} from ${formatStoryValue(meta.unit, s.before)} to ${formatStoryValue(meta.unit, s.after)} on ${weekLabel(s.weekStart)}, ${units}`;
}

/** The chart's ⓘ lines, in order (2 or 3). */
export function seriesInfoLines(
  meta: StoryHealthSeriesMeta,
  points: readonly StoryHealthPoint[],
  weeks: readonly StoryHealthWeek[],
  shift: StoryHealthShift | undefined,
): string[] {
  const out = [seriesCountsSentence(meta.id)];
  const fig = latestFigureLine(meta, points, weeks);
  if (fig != null) out.push(fig);
  if (shift != null) out.push(shiftSentence(shift));
  return out;
}

// ── A refinement week's extra hover lines ────────────────────────────────────────────────────────

/** Spec gaps: "Edge case 4 · Business rule 2", most first (ties in type order). null when none. */
export function gapTypesLine(p: Pick<StoryHealthPoint, 'gapTypes'>): string | null {
  const g = p.gapTypes;
  if (g == null) return null;
  const rows = STORY_SPEC_GAP_TYPES.map((t, i) => ({ t, i, n: g[t] ?? 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i);
  return rows.length === 0 ? null : rows.map((r) => `${STORY_SPEC_GAP_TYPE_LABEL[r.t]} ${r.n}`).join(' · ');
}

/** "and 3 more" under a capped story list; null when nothing was cut. */
export function moreStoriesLine(p: Pick<StoryHealthPoint, 'storiesMore'>): string | null {
  const n = p.storiesMore ?? 0;
  return n > 0 ? `and ${n} more` : null;
}

// ── Omitted refinement series ────────────────────────────────────────────────────────────────────

/** One short sentence per refinement series the server left out (the reasoning sits behind the
 *  panel's ⓘ). */
export function omittedSentence(o: StoryHealthOmitted): string {
  if (o.reason === 'no_links') return `No blocking links in your tracker in these ${STORY_HEALTH_SPAN_DAYS} days.`;
  return `${STORY_HEALTH_SERIES_BY_ID[o.series].label} is not charted: two readings of the same tickets disagree too often.`;
}

/** The span's day count as the heading says it ("Last 90 days"). */
const STORY_HEALTH_SPAN_DAYS = 90;
