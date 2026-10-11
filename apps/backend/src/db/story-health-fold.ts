import {
  STORY_HEALTH_HOVER_STORIES,
  STORY_HEALTH_ISSUE_SERIES,
  STORY_HEALTH_ROLLING_WEEKS,
  STORY_HEALTH_SERIES,
  STORY_ISSUE_IDS,
  STORY_HEALTH_THIN_N,
  STORY_SHIFT_MIN_POINTS,
  STORY_SHIFT_MIN_STORIES,
  STORY_SHIFT_Z,
  storyIssueRateUnits,
  storySizeBand,
  type KnownTicket,
  type StoryCriterionLabel,
  type StoryHealthOmitted,
  type StoryHealthPoint,
  type StoryHealthSeries,
  type StoryHealthSeriesId,
  type StoryHealthSeriesMeta,
  type StoryHealthShift,
  type StoryHealthStoryRef,
  type StoryHealthWeek,
  type StoryIssueInput,
  type StorySpecGapType,
  type TicketLinkBlocker,
  type StoryLevelLabels,
  type StorySizeBand,
  type StoryIssueId,
  type StoryRateUnits,
} from '@pierre-review/shared';
import { detectChangepoints } from './changepoint.js';

// REPORTS → STORIES → STORY HEALTH — the PURE fold (no DB, no clock beyond `nowMs`; story-health-
// fold.test.ts). db/story-health.ts reads the inputs; this turns them into the wire's weeks, series
// and shifts (docs/API.md § GET /api/story-health). The rules, each stated once:
//
//   • TWO BUCKETINGS. REFINEMENT puts a story in the week its ticket was CREATED (`createdMs`), else —
//     no created date — the week its first pull request was opened, and counts the fallback. A story
//     created before the span but merged inside it is in DELIVERY only. DELIVERY puts a story in the
//     week of its LAST merge; a story with nothing merged in the span yet (`lastMergedMs: null` —
//     its pull requests are still open) is in REFINEMENT only. The caller hands in BOTH populations as
//     one list (db/story-health.ts).
//   • UNKNOWN IS NEVER ZERO. A week with nothing measurable is `value: null`; a story of unknown size
//     is in no size band and is counted (`unsizedStories`).
//   • REFINEMENT = the STORY ISSUES (shared `story-issues.ts`), one series each, counted by THE ONE
//     RATE RULE `storyIssueRateUnits`:
//       - "Criteria that can't be checked" (unclearDone, label): CRITERIA, pooled like criteria met —
//         each labelled story adds {its unchecked criteria, its criteria}. CURRENT labels only (the
//         caller passes `label: null` for a stale one).
//       - "Stories with a linked blocker" (blocked, CODE): stories whose tracker links were read, with
//         ≥ 1 blocking link, ANY STATUS — a closed blocker must not drop an old story out (the series
//         would rise at the right edge by construction). A dependency named only in the text is NOT
//         counted. ⚠ No story in the span with a link → the series is OMITTED (`omitted`, 'no_links'):
//         a tracker that nobody links in reads 0%, a claim about the tickets the data cannot make.
//       - "Spec gaps" (specGaps, label): HELD (`opts.held` → `omitted`, 'held').
//     ⚠ A known ticket with NO criteria is counted apart (`noCriteria` on the week, code) and never
//     folded into a criteria series. The week's coverage (`labelled` of `labellable`) rides beside the
//     label series. `labels: false` omits every LABEL series (cloud / the kill switch); the code one stays.
//   • HOVER DETAIL (refinement points only, never in a hash or a shift): the week's numerator stories
//     (key order, ≤ STORY_HEALTH_HOVER_STORIES, then `storiesMore`; for criteria, the stories with ≥ 1
//     such criterion); Spec gaps' types (each type once per story).
//   • THIN: n < STORY_HEALTH_THIN_N → faint, and out of the rolling line and the time / count shift test.
//   • ROLLING: the week and the three before it, NON-THIN weeks only, POOLED over their items — a
//     percentage is Σnumerators ÷ Σdenominators, hours and counts the median of the pooled items. Never
//     an average of weekly values (a 3-story week would weigh as much as a 30-story one).
//   • SHIFTS — at most ONE per series, and the bar is set so noise cannot reach it:
//       RATE series (unit 'pct'): POOLED COUNTS, never weekly percentages (`rateShift`). For every split
//       week, Σnum / Σden each side (every week, thin or not: pooling is what makes a thin week safe)
//       and a two-proportion z-test over the UNITS — criteria for the criteria series, else stories.
//       Reported only with ≥ STORY_SHIFT_MIN_STORIES STORIES each side (counted in stories even when
//       the test counts criteria, so a few criteria-heavy stories cannot fake a shift), ≥ STORY_SHIFT_MIN_POINTS points between the pooled shares and
//       |z| ≥ STORY_SHIFT_Z; the split with the largest |z| wins. A weekly-percentage changepoint
//       flagged one story's move on a three-story week; this cannot.
//       TIME / COUNT series: `detectChangepoints` over the ROLLING values of non-thin weeks with the
//       series' `minScale`, and the two sides' medians at least `minShift` apart (`timeShift`).
//     `verdict` applies the series' declared `better`; a series that declares none is never green or red.

/** One story as the fold needs it. */
export interface StoryHealthStoryInput {
  ident: string;
  /** The ticket's own created instant (freshest stored row with one); null = not known. */
  createdMs: number | null;
  firstOpenedMs: number;
  /** Last merge, when the story is in the DELIVERY population (merged in the span); null = refinement only. */
  lastMergedMs: number | null;
  /** Σ additions + deletions over merged members; null = unknown size. */
  linesChanged: number | null;
  workingHours: number;
  prsTotal: number;
  /** The latest succeeded ticket review's counts, when it judged at least one criterion. */
  review: { met: number; total: number } | null;
  /** A stored ticket row with text was read. False = its text is unknown: every refinement series
   *  leaves it out (never "no criteria"). */
  ticketKnown: boolean;
  /** Has criteria text the labeller can be sent (`storyLabelInput` non-null). */
  labellable: boolean;
  /** Today's numbered criteria (the ONE extractor); 0 = none. Meaningful only when `ticketKnown`. */
  criteriaCount: number;
  /** The CURRENT label (this rubric, this text hash), or null. */
  label: { criteria: StoryCriterionLabel[]; story: StoryLevelLabels } | null;
  /** Hover: the ticket key and title (absent → the story is listed by ident). */
  key?: string;
  title?: string | null;
  /** The freshest stored row's tracker links (`blocked_by_json`); null/absent = not read. */
  links?: readonly TicketLinkBlocker[] | null;
  /** Stored tickets a label's named keys point at (shared across stories). */
  knownTickets?: ReadonlyMap<string, KnownTicket> | null;
}

export interface StoryHealthWeekBound {
  /** Local Monday `YYYY-MM-DD`. */
  key: string;
  startMs: number;
  endMs: number;
}

export interface StoryHealthFold {
  weeks: StoryHealthWeek[];
  series: StoryHealthSeries[];
  shifts: StoryHealthShift[];
  createdFallbackTotal: number;
  unsizedTotal: number;
  unlabelled: number;
  omitted: StoryHealthOmitted[];
}

// One item behind a weekly value: a ratio part (pct) or a raw value (hours / count).
export type Item = { num: number; den: number } | { v: number };

const median = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

function valueOf(meta: StoryHealthSeriesMeta, items: readonly Item[]): number | null {
  if (items.length === 0) return null;
  if (meta.unit === 'pct') {
    let num = 0;
    let den = 0;
    for (const it of items) if ('num' in it) {
      num += it.num;
      den += it.den;
    }
    return den > 0 ? (100 * num) / den : null;
  }
  return median(items.flatMap((it) => ('v' in it ? [it.v] : [])));
}

/** Σnum / Σden over a week's ratio items. */
function sumItems(items: readonly Item[]): { num: number; den: number } {
  let num = 0;
  let den = 0;
  for (const it of items) if ('num' in it) {
    num += it.num;
    den += it.den;
  }
  return { num, den };
}

/** The week index holding `ms`, or -1. */
function weekOf(weeks: readonly StoryHealthWeekBound[], ms: number): number {
  for (let i = 0; i < weeks.length; i += 1) if (ms >= weeks[i]!.startMs && ms < weeks[i]!.endMs) return i;
  return -1;
}

/** Which refinement week a story belongs to, and whether that came from the fallback. */
export function refinementWeekOf(
  s: Pick<StoryHealthStoryInput, 'createdMs' | 'firstOpenedMs'>,
  weeks: readonly StoryHealthWeekBound[],
): { week: number; fallback: boolean } {
  if (s.createdMs != null) return { week: weekOf(weeks, s.createdMs), fallback: false };
  return { week: weekOf(weeks, s.firstOpenedMs), fallback: true };
}

/** The stories the label run would label: refinement-bucketed in the span, labellable, no current
 *  label — newest first (created, else first opened). The run takes the first STORY_LABEL_RUN_CAP. */
export function storiesToLabel<T extends StoryHealthStoryInput>(stories: readonly T[], weeks: readonly StoryHealthWeekBound[]): T[] {
  return stories
    .filter((s) => s.labellable && s.label == null && refinementWeekOf(s, weeks).week >= 0)
    .sort((a, b) => (b.createdMs ?? b.firstOpenedMs) - (a.createdMs ?? a.firstOpenedMs) || a.ident.localeCompare(b.ident));
}

const ISSUE_OF_SERIES = new Map<StoryHealthSeriesId, StoryIssueId>(
  STORY_ISSUE_IDS.map((id) => [STORY_HEALTH_ISSUE_SERIES[id], id]),
);

type IssueStory = Pick<StoryHealthStoryInput, 'ticketKnown' | 'criteriaCount' | 'label' | 'links' | 'knownTickets'>;

/** The story-issue input of one story (the criteria text is not needed — only its count). */
function issueInputOf(s: IssueStory): StoryIssueInput {
  return {
    criteria: Array.from({ length: s.criteriaCount }, () => ''),
    label: s.label,
    links: s.links ?? null,
    knownTickets: s.knownTickets ?? null,
  };
}

/** One story's units per issue under THE rate rule (`storyIssueRateUnits`); null = leave it out. An
 *  unknown ticket is out of every series. */
export function storyIssueAnswers(s: IssueStory): Record<StoryIssueId, StoryRateUnits | null> | null {
  if (!s.ticketKnown) return null;
  return storyIssueRateUnits(issueInputOf(s));
}

/** The hover detail of one refinement point: the numerator's stories (≥ 1 unit with the issue) and
 *  Spec gaps' types. Pure. */
export function refinementHover(
  issue: StoryIssueId,
  pop: readonly StoryHealthStoryInput[],
): Pick<StoryHealthPoint, 'stories' | 'storiesMore' | 'gapTypes'> {
  const hits = pop.filter((s) => (storyIssueAnswers(s)?.[issue]?.num ?? 0) > 0);
  const refs: StoryHealthStoryRef[] = hits
    .map((s) => ({ ident: s.ident, key: s.key ?? s.ident, title: s.title ?? null }))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }) || a.ident.localeCompare(b.ident));
  const out: Pick<StoryHealthPoint, 'stories' | 'storiesMore' | 'gapTypes'> = {
    stories: refs.slice(0, STORY_HEALTH_HOVER_STORIES),
    storiesMore: Math.max(0, refs.length - STORY_HEALTH_HOVER_STORIES),
  };
  if (issue === 'spec_gaps') {
    const types: Partial<Record<StorySpecGapType, number>> = {};
    for (const s of hits) {
      for (const t of new Set((s.label?.story.gaps ?? []).map((g) => g.type))) types[t] = (types[t] ?? 0) + 1;
    }
    out.gapTypes = types;
  }
  return out;
}

const BAND_SERIES: Record<StorySizeBand, StoryHealthSeriesId> = { S: 'workingTimeS', M: 'workingTimeM', L: 'workingTimeL' };

/** The items one story contributes to one series in its week (none = it does not count there). */
function itemsFor(id: StoryHealthSeriesId, s: StoryHealthStoryInput): Item[] {
  const issue = ISSUE_OF_SERIES.get(id);
  if (issue != null) {
    const m = storyIssueAnswers(s)?.[issue] ?? null;
    return m == null || m.den <= 0 ? [] : [{ num: m.num, den: m.den }];
  }
  switch (id) {
    case 'workingTimeS':
    case 'workingTimeM':
    case 'workingTimeL': {
      const band = storySizeBand(s.linesChanged);
      return band != null && BAND_SERIES[band] === id ? [{ v: s.workingHours }] : [];
    }
    case 'prsPerStory':
      return [{ v: s.prsTotal }];
    case 'criteriaMet':
      return s.review != null && s.review.total > 0 ? [{ num: s.review.met, den: s.review.total }] : [];
    default:
      return [];
  }
}

const residualOf = (values: readonly (number | null)[], index: number): number => {
  const seg = (xs: readonly (number | null)[]) => xs.filter((v): v is number => v != null);
  const before = seg(values.slice(0, index));
  const after = seg(values.slice(index));
  const mb = median(before) ?? 0;
  const ma = median(after) ?? 0;
  return before.reduce((n, v) => n + Math.abs(v - mb), 0) + after.reduce((n, v) => n + Math.abs(v - ma), 0);
};

/**
 * The ONE strongest split of a series (`detectChangepoints`' robust z) among those `keep` accepts, or
 * none. Every split is scored through the anchors form so a TIE can be broken: a clean step with a
 * near-zero spread scores the same z (the `minScale` floor) at every index inside its flat run, and the
 * detector's own no-anchor scan would keep the EARLIEST — a marker weeks before the step. A tie goes to
 * the split that leaves the least residual (Σ|value − its segment's median|), i.e. the week the level moved.
 */
export function bestSplit(
  values: readonly (number | null)[],
  minScale: number,
  keep: (cp: ReturnType<typeof detectChangepoints>[number]) => boolean = () => true,
): ReturnType<typeof detectChangepoints> {
  const anchors = Array.from({ length: Math.max(0, values.length - 1) }, (_, i) => i + 1);
  const all = detectChangepoints([...values], { anchors, minScale }).filter(keep);
  let best: (typeof all)[number] | null = null;
  for (const cp of all) {
    if (
      best == null ||
      cp.z > best.z + 1e-9 ||
      (Math.abs(cp.z - best.z) <= 1e-9 && residualOf(values, cp.index) < residualOf(values, best.index))
    ) {
      best = cp;
    }
  }
  return best != null ? [best] : [];
}

const verdictOf = (meta: StoryHealthSeriesMeta, direction: 'up' | 'down'): StoryHealthShift['verdict'] =>
  meta.better == null ? null : (meta.better === 'higher') === (direction === 'up') ? 'better' : 'worse';

/** Two-proportion z (pooled standard error); 0 when the pooled share is 0 or 1 (nothing to test). */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 0;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  return se > 0 ? (x2 / n2 - x1 / n1) / se : 0;
}

/** A RATE series' shift on POOLED counts (the header's rule), or null. */
export function rateShift(
  meta: StoryHealthSeriesMeta,
  perWeek: readonly Item[][],
  weeks: readonly StoryHealthWeekBound[],
): StoryHealthShift | null {
  type Side = { num: number; den: number; stories: number; weeks: number };
  const W = perWeek.length;
  const wk = perWeek.map((items) => {
    let num = 0;
    let den = 0;
    for (const it of items) if ('num' in it) {
      num += it.num;
      den += it.den;
    }
    return { num, den, stories: items.length };
  });
  const sum = (from: number, to: number): Side => {
    const out: Side = { num: 0, den: 0, stories: 0, weeks: 0 };
    for (let j = from; j < to; j += 1) {
      const w = wk[j]!;
      out.num += w.num;
      out.den += w.den;
      out.stories += w.stories;
      if (w.stories > 0) out.weeks += 1;
    }
    return out;
  };
  let best: { k: number; z: number; b: Side; a: Side } | null = null;
  for (let k = 1; k < W; k += 1) {
    // A split is named by the first week of the AFTER side that has data: an empty week ties with the
    // next one, and a marker on an empty week points at nothing.
    if (wk[k]!.stories === 0) continue;
    const b = sum(0, k);
    const a = sum(k, W);
    if (b.stories < STORY_SHIFT_MIN_STORIES || a.stories < STORY_SHIFT_MIN_STORIES || b.den <= 0 || a.den <= 0) continue;
    const pb = (100 * b.num) / b.den;
    const pa = (100 * a.num) / a.den;
    if (Math.abs(pa - pb) < STORY_SHIFT_MIN_POINTS) continue;
    const z = twoProportionZ(b.num, b.den, a.num, a.den);
    if (Math.abs(z) < STORY_SHIFT_Z) continue;
    if (best == null || Math.abs(z) > Math.abs(best.z) + 1e-9) best = { k, z, b, a };
  }
  if (best == null) return null;
  const before = (100 * best.b.num) / best.b.den;
  const after = (100 * best.a.num) / best.a.den;
  const direction: 'up' | 'down' = after > before ? 'up' : 'down';
  const byStory = meta.over === 'stories';
  return {
    series: meta.id,
    week: best.k,
    weekStart: weeks[best.k]!.key,
    before,
    after,
    beforeWeeks: best.b.weeks,
    afterWeeks: best.a.weeks,
    beforeN: best.b.den,
    afterN: best.a.den,
    nOf: byStory ? 'stories' : 'criteria',
    beforeStories: best.b.stories,
    afterStories: best.a.stories,
    direction,
    verdict: verdictOf(meta, direction),
  };
}

/** A TIME / COUNT series' shift over its rolling values (thin / no rolling → null), or null. */
export function timeShift(
  meta: StoryHealthSeriesMeta,
  points: readonly StoryHealthPoint[],
  weeks: readonly StoryHealthWeekBound[],
): StoryHealthShift | null {
  const values = points.map((p) => (p.thin ? null : p.rolling));
  const minShift = meta.minShift ?? 0;
  const [cp] = bestSplit(values, meta.minScale ?? 0, (c) => Math.abs(c.afterMedian - c.beforeMedian) >= minShift);
  if (cp == null) return null;
  const count = (xs: readonly (number | null)[]) => xs.filter((v) => v != null).length;
  const nb = count(values.slice(0, cp.index));
  const na = count(values.slice(cp.index));
  return {
    series: meta.id,
    week: cp.index,
    weekStart: weeks[cp.index]!.key,
    before: cp.beforeMedian,
    after: cp.afterMedian,
    beforeWeeks: nb,
    afterWeeks: na,
    beforeN: nb,
    afterN: na,
    nOf: 'weeks',
    direction: cp.direction,
    verdict: verdictOf(meta, cp.direction),
  };
}

export function foldStoryHealth(
  stories: readonly StoryHealthStoryInput[],
  weeks: readonly StoryHealthWeekBound[],
  /** `held`: series left out (the caller passes STORY_HEALTH_HELD; the pure tests pass nothing). */
  opts: { nowMs: number; labels: boolean; held?: Readonly<Partial<Record<StoryHealthSeriesId, string>>> },
): StoryHealthFold {
  const W = weeks.length;
  const refinement: StoryHealthStoryInput[][] = Array.from({ length: W }, () => []);
  const delivery: StoryHealthStoryInput[][] = Array.from({ length: W }, () => []);
  const outWeeks: StoryHealthWeek[] = weeks.map((w) => ({
    weekStart: w.key,
    from: new Date(w.startMs).toISOString(),
    to: new Date(w.endMs).toISOString(),
    partial: w.endMs > opts.nowMs,
    storiesCreated: 0,
    createdFallback: 0,
    noCriteria: 0,
    labellable: 0,
    labelled: 0,
    storiesMerged: 0,
    unsizedStories: 0,
    reviewedStories: 0,
  }));
  let createdFallbackTotal = 0;
  let unsizedTotal = 0;
  let unlabelled = 0;

  for (const s0 of stories) {
    // With labels off, no label may reach a series, a count or the coverage.
    const s = opts.labels ? s0 : { ...s0, label: null };
    const r = refinementWeekOf(s, weeks);
    if (r.week >= 0) {
      const w = outWeeks[r.week]!;
      refinement[r.week]!.push(s);
      w.storiesCreated += 1;
      if (r.fallback) {
        w.createdFallback += 1;
        createdFallbackTotal += 1;
      }
      if (s.ticketKnown && s.criteriaCount === 0) w.noCriteria += 1;
      if (s.labellable) {
        w.labellable += 1;
        if (opts.labels) {
          if (s.label != null) w.labelled += 1;
          else unlabelled += 1;
        }
      }
    }
    const d = s.lastMergedMs == null ? -1 : weekOf(weeks, s.lastMergedMs);
    if (d >= 0) {
      const w = outWeeks[d]!;
      delivery[d]!.push(s);
      w.storiesMerged += 1;
      if (storySizeBand(s.linesChanged) == null) {
        w.unsizedStories += 1;
        unsizedTotal += 1;
      }
      if (s.review != null && s.review.total > 0) w.reviewedStories += 1;
    }
  }

  const series: StoryHealthSeries[] = [];
  const shifts: StoryHealthShift[] = [];
  const omitted: StoryHealthOmitted[] = [];
  for (const meta of STORY_HEALTH_SERIES) {
    if (meta.source === 'label' && !opts.labels) continue;
    if (opts.held?.[meta.id] != null) {
      if (meta.panel === 'refinement') omitted.push({ series: meta.id, reason: 'held' });
      continue;
    }
    const pops = meta.panel === 'refinement' ? refinement : delivery;
    const issue = ISSUE_OF_SERIES.get(meta.id);
    const perWeek: Item[][] = pops.map((pop) => pop.flatMap((s) => itemsFor(meta.id, s)));
    // No story in the span has a tracker-linked blocker → nothing to chart (a flat 0% would read as
    // "nothing was blocked", which the data cannot say).
    if (meta.id === 'blocked' && !perWeek.some((items) => items.some((it) => 'num' in it && it.num > 0))) {
      omitted.push({ series: meta.id, reason: 'no_links' });
      continue;
    }
    const thin = perWeek.map((items) => items.length < STORY_HEALTH_THIN_N);
    const points: StoryHealthPoint[] = perWeek.map((items, i) => {
      let pooled: Item[] = [];
      let rollingWeeks = 0;
      for (let j = Math.max(0, i - STORY_HEALTH_ROLLING_WEEKS + 1); j <= i; j += 1) {
        if (thin[j]) continue;
        pooled = pooled.concat(perWeek[j]!);
        rollingWeeks += 1;
      }
      return {
        value: valueOf(meta, items),
        n: items.length,
        thin: thin[i]!,
        rolling: rollingWeeks > 0 ? valueOf(meta, pooled) : null,
        rollingWeeks,
        ...(meta.panel === 'refinement' && meta.over === 'criteria' ? { criteria: sumItems(items) } : {}),
        ...(issue != null ? refinementHover(issue, pops[i]!) : {}),
      };
    });
    series.push({ id: meta.id, points });

    const shift = meta.unit === 'pct' ? rateShift(meta, perWeek, weeks) : timeShift(meta, points, weeks);
    if (shift != null) shifts.push(shift);
  }

  return { weeks: outWeeks, series, shifts, createdFallbackTotal, unsizedTotal, unlabelled, omitted };
}
