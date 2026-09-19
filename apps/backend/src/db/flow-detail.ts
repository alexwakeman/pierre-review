// ── CHRONOLOGY, PR BY PR: working hours, budgets, and what the slow ones have in common ──────
//
// `db/pr-intervals.ts` replays each merged pull request's life and charges every interval to a
// court. This module takes those replays — one `FlowPrFacts` per measured pull request — and
// answers the questions the share bar could not:
//
//   · how long each wait took in WORKING hours, against a budget (`budgets`);
//   · which pull requests carry the weight (`prs`, for the scatter);
//   · what the slowest quarter has that the fastest does not (`contrast`, `sizeBands`, `weekdays`);
//   · which approved pull requests sat waiting, and whether a ticket explains it (`landingTail`);
//   · how much of each repository's first reviewing rests on one person (`concentration`).
//
// ⚠ PURE AND DETERMINISTIC. No database, no clock, no model: everything arrives in the facts and
// the calendar, so the unit tests drive it directly and every sentence is templated here.
//
// ⚠ NO PERSON LEAVES THIS MODULE. `firstReviewerId` is read to COUNT, never copied onto the wire:
// the concentration rows carry shares and medians, and the per-PR rows carry no actor at all. A
// repository with one first reviewer can still be deduced by a colleague; that is the accepted
// cost of saying "one person does all the first reviews here", which is the finding.
//
// ⚠ WORKING HOURS HERE, CLOCK HOURS IN THE REPO ROWS. The rule that names a repository ("lopsided
// AND slow", FLOW_SLOW_P75_HOURS) was calibrated on clock hours over 66,088 public pull requests.
// It stays on clock hours, and the screen labels those rows as such.
import {
  FLOW_BUDGET_MEASURES,
  FLOW_RULES,
  type BlastSurface,
  type CourtShare,
  type FlowBudgetMeasure,
  type FlowBudgetRow,
  type FlowConcentrationRow,
  type FlowContrast,
  type FlowContrastRow,
  type FlowContrastSignal,
  type FlowLandingRow,
  type FlowLandingTail,
  type FlowPrFigures,
  type FlowPrLink,
  type FlowPrRow,
  type FlowRequestKind,
  type FlowRequestRow,
  type FlowRequestStats,
  type FlowSizeBand,
  type FlowWeekdayRow,
  type PrCourt,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';
import type { WorkingCalendar } from './working-hours.js';

const HOUR_MS = 3_600_000;

// ── Floors and caps ─────────────────────────────────────────────────────────────────────────
// ⚠ Every floor the page QUOTES is assigned from `FLOW_RULES` (packages/shared/src/flow-settings.ts),
// so the explanation behind each "i" and the fold cannot drift apart. The caps below it are not
// quoted anywhere and stay local.
/** A budget verdict needs this many pull requests behind its percentile. */
const FLOW_BUDGET_MIN_PRS = FLOW_RULES.budgetMinPrs;
/** The contrast compares quarters, so it needs this many in each. */
const FLOW_CONTRAST_MIN_QUARTILE = FLOW_RULES.contrastMinQuartile;
/** A size band or weekday needs this many before its median is shown. */
const FLOW_CUT_MIN_PRS = FLOW_RULES.cutMinPrs;
/** Per-PR rows on the wire. Past it: every slow PR, and an even sample of the rest. */
const FLOW_PR_ROWS_CAP = 1_000;
const FLOW_PR_ROWS_SLOW_KEEP = 250;
const FLOW_LANDING_ROWS_CAP = FLOW_RULES.landingRows;
const FLOW_SIBLINGS_CAP = 5;
/** A sibling merging this long after the PR itself still counts — they often land together. */
const SIBLING_AFTER_MS = 24 * HOUR_MS;
/** Concentration: each side of the comparison needs this many first looks. */
const FLOW_CONCENTRATION_MIN_SIDE = FLOW_RULES.concentrationMinSide;
/** "Slower" means at least this much slower than everyone else, and by at least half an hour. */
const FLOW_CONCENTRATION_SLOWER_RATIO = FLOW_RULES.slowerRatio;
const FLOW_CONCENTRATION_SLOWER_MIN_HOURS = FLOW_RULES.slowerMinHours;
/** A contrast row "separates" at 2×, is "weak" from 1.3×. */
const FLOW_SEPARATES_RATIO = FLOW_RULES.separatesRatio;
const FLOW_WEAK_RATIO = FLOW_RULES.weakRatio;

/** Size bands in lines added plus removed — fixed edges, this workspace's own medians. */
const SIZE_BANDS: { label: string; min: number; max: number | null }[] = [
  { label: 'Up to 100 lines', min: 0, max: 100 },
  { label: '101–400 lines', min: 101, max: 400 },
  { label: '401–1,000 lines', min: 401, max: 1000 },
  { label: 'Over 1,000 lines', min: 1001, max: null },
];

// ── The input ───────────────────────────────────────────────────────────────────────────────

/** One continuous stretch in one court. Adjacent intervals in the same court are merged. */
export interface CourtSpell {
  court: PrCourt;
  fromMs: number;
  toMs: number;
}

/** Everything this module knows about one measured pull request. */
export interface FlowPrFacts {
  prId: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  githubUrl: string;
  openedMs: number;
  mergedMs: number;
  spells: CourtSpell[];
  rounds: number;
  firstLookMs: number | null;
  approvedAtMs: number | null;
  /** READ TO COUNT, NEVER SENT. See the header. */
  firstReviewerId: number | null;
  lines: number | null;
  files: number | null;
  reachAreas: BlastSurface[];
  ciRedHours: number;
  ticketKey: string | null;
  selfMerged: boolean;
  /** Who was asked first — null when the request history has not been received. */
  requestKind: FlowRequestKind | null;
  /** When that first request was made (clamped to the PR's own life). */
  firstRequestMs: number | null;
}

export interface FlowDetail {
  courtsWork: CourtShare[];
  medianLeadWorkHours: number;
  p75LeadWorkHours: number;
  workHeadline: string | null;
  budgets: FlowBudgetRow[];
  prs: FlowPrRow[];
  prsCapped: boolean;
  contrast: FlowContrast | null;
  sizeBands: FlowSizeBand[];
  weekdays: FlowWeekdayRow[];
  landingTail: FlowLandingTail | null;
  concentration: FlowConcentrationRow[];
  requests: FlowRequestStats | null;
  prFigures: FlowPrFigures;
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────

/** Nearest-rank percentile, the same definition `db/pr-intervals.ts` uses. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[i] ?? 0;
}

function median(xs: number[]): number {
  return percentile(xs, 0.5);
}

function medianOrNull(xs: number[], floor: number): number | null {
  return xs.length >= floor ? median(xs) : null;
}

/** Two decimals on the wire — enough for a chart, and it halves the payload. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A working duration in prose. Past two working days it reads in working days. */
export function fmtWork(h: number, dayHours: number): string {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (dayHours > 0 && h >= 2 * dayHours) return `${oneDp(h / dayHours)} working days`;
  const n = h < 10 ? oneDp(h) : String(Math.round(h));
  return `${n} working ${n === '1' ? 'hour' : 'hours'}`;
}

function budgetHours(h: number): string {
  return `${oneDp(h)}-hour`;
}

// ── Per-PR working figures ──────────────────────────────────────────────────────────────────

interface Worked {
  f: FlowPrFacts;
  work: Record<PrCourt, number>;
  clock: Record<PrCourt, number>;
  leadWork: number;
  leadClock: number;
  firstLookWork: number | null;
  /** The longest single stretch in the author's court — "every reply within". */
  longestReplyWork: number | null;
  landWork: number;
  landClock: number;
  weekday: number;
  dominant: PrCourt;
  /** Null unless a first request preceded the first look. */
  requestToLookWork: number | null;
  /** The first look came before anyone was asked. */
  lookedBeforeAsked: boolean;
}

function workOf(f: FlowPrFacts, cal: WorkingCalendar): Worked {
  const work: Record<PrCourt, number> = { reviewer: 0, author: 0, landing: 0 };
  const clock: Record<PrCourt, number> = { reviewer: 0, author: 0, landing: 0 };
  let longestReply: number | null = null;
  for (const s of f.spells) {
    const w = cal.between(s.fromMs, s.toMs);
    work[s.court] += w;
    clock[s.court] += (s.toMs - s.fromMs) / HOUR_MS;
    if (s.court === 'author') longestReply = Math.max(longestReply ?? 0, w);
  }
  const leadWork = work.reviewer + work.author + work.landing;
  const courts: PrCourt[] = ['reviewer', 'author', 'landing'];
  const basis = leadWork > 0 ? work : clock;
  const dominant = courts.reduce((m, c) => (basis[c] > basis[m] ? c : m), 'reviewer' as PrCourt);
  return {
    f,
    work,
    clock,
    leadWork,
    leadClock: (f.mergedMs - f.openedMs) / HOUR_MS,
    firstLookWork: f.firstLookMs == null ? null : cal.between(f.openedMs, f.firstLookMs),
    longestReplyWork: f.rounds > 0 ? (longestReply ?? 0) : null,
    landWork: work.landing,
    landClock: clock.landing,
    weekday: cal.weekday(f.openedMs),
    dominant,
    requestToLookWork:
      f.firstRequestMs != null && f.firstLookMs != null && f.firstRequestMs <= f.firstLookMs
        ? cal.between(f.firstRequestMs, f.firstLookMs)
        : null,
    lookedBeforeAsked:
      f.firstRequestMs != null && f.firstLookMs != null && f.firstLookMs < f.firstRequestMs,
  };
}

// ── Budgets ─────────────────────────────────────────────────────────────────────────────────

const BUDGET_SUBJECT: Record<FlowBudgetMeasure, (p75: string) => string> = {
  firstLook: (p) => `Three in four pull requests had a first look within ${p}`,
  reply: (p) => `Three in four pull requests that went back to their author had every reply within ${p}`,
  land: (p) => `Three in four approved pull requests merged within ${p} of approval`,
  lead: (p) => `Three in four pull requests merged within ${p} of opening`,
};

const BUDGET_EMPTY: Record<FlowBudgetMeasure, string> = {
  firstLook: 'No pull request had a first look before it merged.',
  reply: 'No pull request went back to its author.',
  land: 'No pull request was approved before it merged.',
  lead: 'No pull request to measure.',
};

function budgetRow(
  measure: FlowBudgetMeasure,
  values: number[],
  settings: ResolvedFlowSettings,
): FlowBudgetRow {
  const { good, ok } = settings.budgets[measure];
  const n = values.length;
  const p50 = percentile(values, 0.5);
  const p75 = percentile(values, 0.75);
  const p90 = percentile(values, 0.9);
  let verdict: FlowBudgetRow['verdict'] = null;
  let sentence: string;
  if (n === 0) {
    sentence = BUDGET_EMPTY[measure];
  } else if (n < FLOW_BUDGET_MIN_PRS) {
    sentence = `Only ${n} pull ${plural(n, 'request', 'requests')} to measure — too few to hold against the budget.`;
  } else {
    verdict = p75 <= good ? 'good' : p75 <= ok ? 'ok' : 'slow';
    // In HOURS, never working days: the budget beside it is in hours, and a reader comparing
    // "2.2 working days" with a "16-hour limit" has to do the conversion we should have done.
    const base = BUDGET_SUBJECT[measure](fmtWork(p75, 0));
    const tail =
      verdict === 'good'
        ? ` — inside the ${budgetHours(good)} budget.`
        : verdict === 'ok'
          ? ` — over the ${budgetHours(good)} budget, inside the ${budgetHours(ok)} limit.`
          : ` — past the ${budgetHours(ok)} limit.`;
    sentence = base + tail;
  }
  return { measure, good, ok, prs: n, p50: r2(p50), p75: r2(p75), p90: r2(p90), verdict, sentence };
}

// ── The contrast ────────────────────────────────────────────────────────────────────────────

interface SignalSpec {
  signal: FlowContrastSignal;
  label: string;
  unit: FlowContrastRow['unit'];
  /** The phrase in "The slowest quarter had …". */
  phrase: string;
  /** The smallest difference worth calling a difference, in the row's own unit. */
  floor: number;
  value: (rows: Worked[], lastDay: number) => number;
}

const share = (rows: Worked[], pred: (w: Worked) => boolean): number =>
  rows.length === 0 ? 0 : rows.filter(pred).length / rows.length;

const SIGNALS: SignalSpec[] = [
  {
    signal: 'firstLook',
    label: 'Wait for a first look',
    unit: 'workHours',
    phrase: 'a longer wait for a first look',
    floor: 0.5,
    value: (rows) => median(rows.map((w) => w.firstLookWork).filter((v): v is number => v != null)),
  },
  {
    signal: 'lines',
    label: 'Lines changed',
    unit: 'count',
    phrase: 'more lines changed',
    floor: 20,
    value: (rows) => median(rows.map((w) => w.f.lines).filter((v): v is number => v != null)),
  },
  {
    signal: 'files',
    label: 'Files changed',
    unit: 'count',
    phrase: 'more files changed',
    floor: 2,
    value: (rows) => median(rows.map((w) => w.f.files).filter((v): v is number => v != null)),
  },
  {
    signal: 'wentBack',
    label: 'Went back to the author',
    unit: 'percent',
    phrase: 'more trips back to the author',
    floor: 0.1,
    value: (rows) => share(rows, (w) => w.f.rounds > 0),
  },
  {
    signal: 'ciRed',
    label: 'Checks went red',
    unit: 'percent',
    phrase: 'more red checks',
    floor: 0.1,
    value: (rows) => share(rows, (w) => w.f.ciRedHours > 0),
  },
  {
    signal: 'land',
    label: 'Approved to merged',
    unit: 'workHours',
    phrase: 'a longer wait to merge after approval',
    floor: 0.5,
    value: (rows) => median(rows.filter((w) => w.f.approvedAtMs != null).map((w) => w.landWork)),
  },
  {
    signal: 'lastDay',
    label: 'Opened on the last working day of the week',
    unit: 'percent',
    phrase: 'more opened on the last working day of the week',
    floor: 0.1,
    value: (rows, lastDay) => share(rows, (w) => w.weekday === lastDay),
  },
  {
    signal: 'reach',
    label: 'Touches a high-reach area',
    unit: 'percent',
    phrase: 'more changes to high-reach areas (dependencies, CI, auth, database schema)',
    floor: 0.1,
    value: (rows) => share(rows, (w) => w.f.reachAreas.length > 0),
  },
];

function verdictOf(fast: number, slow: number, floor: number): FlowContrastRow['verdict'] {
  if (slow - fast < floor) return 'none';
  if (fast <= 0) return 'separates';
  const ratio = slow / fast;
  if (ratio >= FLOW_SEPARATES_RATIO) return 'separates';
  if (ratio >= FLOW_WEAK_RATIO) return 'weak';
  return 'none';
}

function joinPhrases(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function contrastOf(worked: Worked[], lastDay: number): FlowContrast | null {
  const q = Math.floor(worked.length / 4);
  if (q < FLOW_CONTRAST_MIN_QUARTILE) return null;
  const sorted = [...worked].sort((a, b) => a.leadWork - b.leadWork || a.f.prId - b.f.prId);
  const fast = sorted.slice(0, q);
  const slow = sorted.slice(-q);
  const rows: FlowContrastRow[] = SIGNALS.map((s) => {
    const f = s.value(fast, lastDay);
    const sl = s.value(slow, lastDay);
    return {
      signal: s.signal,
      label: s.label,
      unit: s.unit,
      fast: r2(f),
      slow: r2(sl),
      verdict: verdictOf(f, sl, s.floor),
    };
  });
  const sep = new Set(rows.filter((r) => r.verdict === 'separates').map((r) => r.signal));
  // "more lines and files changed" reads as one fact; two phrases for it read as padding.
  const both = sep.has('lines') && sep.has('files');
  const separating = SIGNALS.filter((s) => sep.has(s.signal) && !(both && s.signal === 'files')).map(
    (s) => (both && s.signal === 'lines' ? 'more lines and files changed' : s.phrase),
  );
  const sentence =
    separating.length > 0
      ? `Against the fastest quarter, the slowest quarter had ${joinPhrases(separating)}.`
      : 'Nothing measured here separates the slowest quarter from the fastest.';
  return { quartilePrs: q, rows, sentence };
}

// ── Landing tail ────────────────────────────────────────────────────────────────────────────

function linkOf(f: FlowPrFacts): FlowPrLink {
  return {
    prId: f.prId,
    repoFullName: f.repoFullName,
    prNumber: f.number,
    prTitle: f.title,
    githubUrl: f.githubUrl,
  };
}

function landingTailOf(worked: Worked[], dayHours: number): FlowLandingTail | null {
  const approved = worked.filter((w) => w.f.approvedAtMs != null);
  if (approved.length === 0) return null;
  const threshold = dayHours;
  const over = approved
    .filter((w) => w.landWork > threshold)
    .sort((a, b) => b.landWork - a.landWork || a.f.prId - b.f.prId);
  const total = approved.reduce((s, w) => s + w.landWork, 0);
  const held = over.reduce((s, w) => s + w.landWork, 0);
  const shareOfLanding = total > 0 ? held / total : 0;
  const selfMergedOver = over.filter((w) => w.f.selfMerged).length;

  // Siblings: other measured PRs under the same ticket, in ANOTHER repository, that merged while
  // this one sat approved (or within a day after it) — a PR held for a coordinated change is
  // waiting on its sibling, not on the merge step. A sibling that landed before the approval
  // cannot have held it, so it is not offered as the reason.
  const siblingsOf = (w: Worked): Worked[] => {
    if (!w.f.ticketKey || w.f.approvedAtMs == null) return [];
    const from = w.f.approvedAtMs;
    const to = w.f.mergedMs + SIBLING_AFTER_MS;
    return (byTicket.get(w.f.ticketKey) ?? []).filter(
      (o) => o.f.repoId !== w.f.repoId && o.f.mergedMs >= from && o.f.mergedMs <= to,
    );
  };
  const byTicket = new Map<string, Worked[]>();
  for (const w of worked) {
    if (!w.f.ticketKey) continue;
    const list = byTicket.get(w.f.ticketKey);
    if (list) list.push(w);
    else byTicket.set(w.f.ticketKey, [w]);
  }
  const rows: FlowLandingRow[] = over.slice(0, FLOW_LANDING_ROWS_CAP).map((w) => ({
    ...linkOf(w.f),
    landWorkHours: r2(w.landWork),
    landHours: r2(w.landClock),
    selfMerged: w.f.selfMerged,
    ticketKey: w.f.ticketKey,
    siblings: siblingsOf(w)
      .sort((a, b) => a.f.mergedMs - b.f.mergedMs || a.f.prId - b.f.prId)
      .slice(0, FLOW_SIBLINGS_CAP)
      .map((o) => linkOf(o.f)),
  }));
  const withSiblings = over.filter((w) => siblingsOf(w).length > 0).length;

  let sentence: string;
  if (over.length === 0) {
    sentence = 'No pull request sat approved for more than a working day.';
  } else {
    sentence =
      `${over.length} pull ${plural(over.length, 'request', 'requests')} sat approved for more than a ` +
      `working day, holding ${pct(shareOfLanding)} of all the time spent approved and waiting to merge.`;
    if (selfMergedOver > 0) {
      sentence += ` ${selfMergedOver} of them ${plural(selfMergedOver, 'was', 'were')} merged by ${plural(selfMergedOver, 'its', 'their')} own author.`;
    }
    if (withSiblings > 0) {
      sentence += ` ${withSiblings} ${plural(withSiblings, 'shares', 'share')} a ticket with a pull request in another repository that merged while ${plural(withSiblings, 'it', 'they')} waited.`;
    }
  }
  return {
    thresholdWorkHours: r2(threshold),
    prsOver: over.length,
    shareOfLanding: r2(shareOfLanding),
    selfMergedOver,
    siblingsOver: withSiblings,
    rows,
    sentence,
  };
}

// ── Concentration ───────────────────────────────────────────────────────────────────────────

function concentrationOf(worked: Worked[], minRepoPrs: number): FlowConcentrationRow[] {
  const byRepo = new Map<number, Worked[]>();
  for (const w of worked) {
    if (w.f.firstReviewerId == null || w.firstLookWork == null) continue;
    const list = byRepo.get(w.f.repoId);
    if (list) list.push(w);
    else byRepo.set(w.f.repoId, [w]);
  }
  const out: FlowConcentrationRow[] = [];
  for (const [repoId, rows] of byRepo) {
    if (rows.length < minRepoPrs) continue;
    const counts = new Map<number, number>();
    for (const w of rows) {
      const id = w.f.firstReviewerId as number;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // Busiest first; ties broken by id so the row is stable between polls. The id stays here.
    const [topId, topCount] = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] as [number, number];
    const mine = rows.filter((w) => w.f.firstReviewerId === topId).map((w) => w.firstLookWork as number);
    const rest = rows.filter((w) => w.f.firstReviewerId !== topId).map((w) => w.firstLookWork as number);
    const topMed = medianOrNull(mine, FLOW_CONCENTRATION_MIN_SIDE);
    const restMed = medianOrNull(rest, FLOW_CONCENTRATION_MIN_SIDE);
    const slower =
      topMed != null &&
      restMed != null &&
      topMed - restMed >= FLOW_CONCENTRATION_SLOWER_MIN_HOURS &&
      topMed >= restMed * FLOW_CONCENTRATION_SLOWER_RATIO;
    out.push({
      repoId,
      repoFullName: rows[0]?.f.repoFullName ?? '',
      prs: rows.length,
      firstReviewers: counts.size,
      topShare: r2(topCount / rows.length),
      topFirstLookWorkHours: topMed == null ? null : r2(topMed),
      othersFirstLookWorkHours: restMed == null ? null : r2(restMed),
      slower,
    });
  }
  return out.sort((a, b) => b.topShare - a.topShare || a.repoFullName.localeCompare(b.repoFullName));
}

// ── Asking for a review: a person, a team, or nobody ──────────────────────────────────────────

const REQUEST_LABEL: Record<FlowRequestKind, string> = {
  person: 'a named person',
  team: 'a team',
  none: 'nobody',
};

function requestsOf(worked: Worked[], dayHours: number): FlowRequestStats | null {
  const known = worked.filter((w) => w.f.requestKind != null);
  if (known.length === 0) return null;
  const rows: FlowRequestRow[] = (['person', 'team', 'none'] as FlowRequestKind[]).map((kind) => {
    const inKind = known.filter((w) => w.f.requestKind === kind);
    const toLook = medianOrNull(
      inKind.map((w) => w.requestToLookWork).filter((v): v is number => v != null),
      FLOW_CUT_MIN_PRS,
    );
    const look = medianOrNull(
      inKind.map((w) => w.firstLookWork).filter((v): v is number => v != null),
      FLOW_CUT_MIN_PRS,
    );
    return {
      kind,
      prs: inKind.length,
      medianRequestToLookWorkHours: kind === 'none' || toLook == null ? null : r2(toLook),
      medianFirstLookWorkHours: look == null ? null : r2(look),
    };
  });
  const lookedBeforeAsked = known.filter((w) => w.lookedBeforeAsked).length;
  const by = new Map(rows.map((r) => [r.kind, r]));
  const parts: string[] = [];
  const person = by.get('person');
  const team = by.get('team');
  if (person?.medianRequestToLookWorkHours != null && team?.medianRequestToLookWorkHours != null) {
    parts.push(
      `Asking a named person got a first look a median ${fmtWork(person.medianRequestToLookWorkHours, 0)} ` +
        `after the request; asking a team, ${fmtWork(team.medianRequestToLookWorkHours, 0)}.`,
    );
  } else {
    for (const r of [person, team]) {
      if (r == null || r.prs === 0) continue;
      parts.push(
        r.medianRequestToLookWorkHours != null
          ? `Asking ${REQUEST_LABEL[r.kind]} got a first look a median ${fmtWork(r.medianRequestToLookWorkHours, 0)} after the request.`
          : `${r.prs} pull ${plural(r.prs, 'request', 'requests')} asked ${REQUEST_LABEL[r.kind]} — too few for a median.`,
      );
    }
  }
  const none = by.get('none');
  if (none != null && none.prs > 0) {
    parts.push(
      `${none.prs} pull ${plural(none.prs, 'request was', 'requests were')} never assigned a reviewer` +
        (none.medianFirstLookWorkHours != null
          ? `; their first look came a median ${fmtWork(none.medianFirstLookWorkHours, 0)} after opening.`
          : '.'),
    );
  }
  if (known.length < worked.length) {
    parts.unshift(
      `Request history is in for ${known.length} of ${worked.length} pull requests so far; the rest arrive over the next few syncs.`,
    );
  }
  void dayHours;
  return { known: known.length, measured: worked.length, lookedBeforeAsked, rows, sentence: parts.join(' ') };
}

// ── The per-PR rows ─────────────────────────────────────────────────────────────────────────

function prRowOf(w: Worked): FlowPrRow {
  return {
    prId: w.f.prId,
    repoFullName: w.f.repoFullName,
    prNumber: w.f.number,
    prTitle: w.f.title,
    githubUrl: w.f.githubUrl,
    openedAt: new Date(w.f.openedMs).toISOString(),
    mergedAt: new Date(w.f.mergedMs).toISOString(),
    openedWeekday: w.weekday,
    leadHours: r2(w.leadClock),
    leadWorkHours: r2(w.leadWork),
    workHours: { reviewer: r2(w.work.reviewer), author: r2(w.work.author), landing: r2(w.work.landing) },
    firstLookWorkHours: w.firstLookWork == null ? null : r2(w.firstLookWork),
    rounds: w.f.rounds,
    lines: w.f.lines,
    files: w.f.files,
    reachAreas: w.f.reachAreas,
    ciRedHours: r2(w.f.ciRedHours),
    ticketKey: w.f.ticketKey,
    selfMerged: w.f.selfMerged,
    dominant: w.dominant,
    requestKind: w.f.requestKind,
    requestToLookWorkHours: w.requestToLookWork == null ? null : r2(w.requestToLookWork),
  };
}

/** Every slow PR, then an even stride over the rest — never a sample that hides an outlier. */
function capRows(worked: Worked[]): { rows: Worked[]; capped: boolean } {
  if (worked.length <= FLOW_PR_ROWS_CAP) return { rows: worked, capped: false };
  const bySlow = [...worked].sort((a, b) => b.leadWork - a.leadWork || a.f.prId - b.f.prId);
  const keep = bySlow.slice(0, FLOW_PR_ROWS_SLOW_KEEP);
  const rest = bySlow.slice(FLOW_PR_ROWS_SLOW_KEEP);
  const room = FLOW_PR_ROWS_CAP - keep.length;
  const stride = rest.length / room;
  for (let i = 0; i < room; i += 1) {
    const pick = rest[Math.floor(i * stride)];
    if (pick) keep.push(pick);
  }
  return { rows: keep, capped: true };
}

// ── The per-PR headline figures ─────────────────────────────────────────────────────────────

/**
 * The scatter's and the triangle's headline figures, over EVERY measured pull request.
 *
 * ⚠ NEVER OVER `prs`. The per-PR rows are capped at FLOW_PR_ROWS_CAP (every slow PR, then an even
 * stride), so a count folded over them is wrong exactly when `prsCapped` — and wrong in the
 * inflating direction, because the slow ones are all kept. The same definitions the SPA used to
 * apply to the capped list: over a working day, the slowest tenth's share, never went back.
 */
function prFiguresOf(worked: Worked[], dayHours: number): FlowPrFigures {
  const leads = worked.map((w) => w.leadWork).sort((a, b) => b - a);
  const slowestTenthCount = Math.ceil(leads.length / 10);
  const total = leads.reduce((s, v) => s + v, 0);
  const top = leads.slice(0, slowestTenthCount).reduce((s, v) => s + v, 0);
  return {
    overWorkingDay: worked.filter((w) => w.leadWork > dayHours).length,
    slowestTenthCount,
    slowestTenthShare: total > 0 ? top / total : 0,
    neverWentBack: worked.filter((w) => w.f.rounds === 0).length,
  };
}

// ── The fold ────────────────────────────────────────────────────────────────────────────────

const COURT_PHRASE: Record<PrCourt, string> = {
  reviewer: 'waiting for a reviewer',
  author: 'waiting for the author',
  landing: 'approved and waiting to land',
};

export function buildFlowDetail(
  facts: FlowPrFacts[],
  cal: WorkingCalendar,
  settings: ResolvedFlowSettings,
  minRepoPrs: number,
): FlowDetail {
  const worked = facts.map((f) => workOf(f, cal));
  const dayHours = cal.dayHours;

  const totals: Record<PrCourt, number> = { reviewer: 0, author: 0, landing: 0 };
  for (const w of worked) {
    totals.reviewer += w.work.reviewer;
    totals.author += w.work.author;
    totals.landing += w.work.landing;
  }
  const sum = totals.reviewer + totals.author + totals.landing;
  const courtsWork: CourtShare[] = (['reviewer', 'author', 'landing'] as PrCourt[]).map((court) => ({
    court,
    hours: r2(totals[court]),
    share: sum > 0 ? totals[court] / sum : 0,
  }));
  const leads = worked.map((w) => w.leadWork);
  const medianLeadWorkHours = median(leads);
  const p75LeadWorkHours = percentile(leads, 0.75);

  const workHeadline =
    worked.length === 0
      ? null
      : `Counting working hours only, time split ` +
        courtsWork.map((c) => `${pct(c.share)} ${COURT_PHRASE[c.court]}`).join(', ').replace(/, ([^,]*)$/, ', and $1') +
        // In hours, like the budget rows beneath it — the same p75 spelled "2.2 working days" here
        // and "20 working hours" one row down is one figure in two spellings.
        `. Half of pull requests merged within ${fmtWork(medianLeadWorkHours, 0)} of opening; ` +
        `the slowest quarter took ${fmtWork(p75LeadWorkHours, 0)} or more.`;

  const measures: Record<FlowBudgetMeasure, number[]> = {
    firstLook: worked.map((w) => w.firstLookWork).filter((v): v is number => v != null),
    reply: worked.map((w) => w.longestReplyWork).filter((v): v is number => v != null),
    land: worked.filter((w) => w.f.approvedAtMs != null).map((w) => w.landWork),
    lead: leads,
  };
  const budgets = FLOW_BUDGET_MEASURES.map((m) => budgetRow(m, measures[m], settings));

  const lastDay = Math.max(...settings.days);

  const sizeBands: FlowSizeBand[] = SIZE_BANDS.map((b) => {
    const rows = worked.filter(
      (w) => w.f.lines != null && w.f.lines >= b.min && (b.max == null || w.f.lines <= b.max),
    );
    const lead = medianOrNull(rows.map((w) => w.leadWork), FLOW_CUT_MIN_PRS);
    const look = medianOrNull(
      rows.map((w) => w.firstLookWork).filter((v): v is number => v != null),
      FLOW_CUT_MIN_PRS,
    );
    return {
      label: b.label,
      minLines: b.min,
      maxLines: b.max,
      prs: rows.length,
      medianLeadWorkHours: lead == null ? null : r2(lead),
      medianFirstLookWorkHours: look == null ? null : r2(look),
    };
  });

  const weekdays: FlowWeekdayRow[] = [1, 2, 3, 4, 5, 6, 7].map((d) => {
    const rows = worked.filter((w) => w.weekday === d);
    const clock = medianOrNull(rows.map((w) => w.leadClock), FLOW_CUT_MIN_PRS);
    const work = medianOrNull(rows.map((w) => w.leadWork), FLOW_CUT_MIN_PRS);
    return {
      weekday: d,
      working: settings.days.includes(d),
      prs: rows.length,
      medianLeadHours: clock == null ? null : r2(clock),
      medianLeadWorkHours: work == null ? null : r2(work),
    };
  });

  const { rows: shown, capped } = capRows(worked);
  return {
    courtsWork,
    medianLeadWorkHours: r2(medianLeadWorkHours),
    p75LeadWorkHours: r2(p75LeadWorkHours),
    workHeadline,
    budgets,
    prs: shown.map(prRowOf),
    prsCapped: capped,
    contrast: contrastOf(worked, lastDay),
    sizeBands,
    weekdays,
    landingTail: landingTailOf(worked, dayHours),
    concentration: concentrationOf(worked, minRepoPrs),
    requests: requestsOf(worked, dayHours),
    prFigures: prFiguresOf(worked, dayHours),
  };
}

// ── Ticket keys ─────────────────────────────────────────────────────────────────────────────
//
// A Jira/Linear key (PROJ-123) from the title, then the branch name. The Pro issue-links
// extractor (packages/pro/src/issue-links/extract.ts) is the full version, with per-workspace
// allow-lists; core cannot import the plugin, so this is its NO-ALLOWLIST fallback only — the same
// boundary rules and the same deny-list floor. It is used for ONE thing: noticing that two PRs in
// DIFFERENT repositories share a ticket. A false positive costs a wrong "may have been held for
// it" beside a PR the reader can open, which is why nothing else leans on it.
const KEY_RE = /(?<![A-Za-z0-9._-])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})(?![A-Za-z0-9_]|\.\d|-\d)/g;
const NON_TICKET_PREFIXES = new Set([
  'UTF', 'UTF8', 'UTF16', 'SHA', 'SHA1', 'SHA256', 'SHA512', 'MD5', 'CRC', 'CRC32', 'AES', 'RSA',
  'BASE64', 'EC', 'ISO', 'RFC', 'CVE', 'CWE', 'WCAG', 'IEEE', 'ANSI', 'ASCII', 'PEP', 'SOC', 'PCI',
  'FIPS', 'NIST', 'HTTP', 'HTTPS', 'HTTP2', 'IPV4', 'IPV6', 'TLS', 'SSL', 'OAUTH', 'GPT', 'GPT3',
  'GPT4', 'LLAMA', 'RTX', 'GTX', 'X86', 'ARM', 'K8S', 'CUDA', 'JPEG', 'MP3', 'MP4', 'H264', 'H265',
  'COVID', 'ES', 'ES2015', 'UTC', 'P50', 'P90', 'P95', 'P99', 'Q1', 'Q2', 'Q3', 'Q4', 'H1', 'H2',
  'FY', 'NODE', 'PYTHON', 'JAVA', 'GO', 'V1', 'V2', 'V3',
]);

export function ticketKeyOf(title: string, branch: string | null): string | null {
  const pick = (text: string | null, requireUpper: boolean): string | null => {
    if (!text) return null;
    for (const m of text.matchAll(KEY_RE)) {
      const raw = m[1] as string;
      if (requireUpper && raw !== raw.toUpperCase()) continue;
      const prefix = raw.toUpperCase();
      if (NON_TICKET_PREFIXES.has(prefix) || /^V\d+$/.test(prefix)) continue;
      if (!/[A-Z]/.test(prefix)) continue;
      return `${prefix}-${m[2] as string}`;
    }
    return null;
  };
  // A title is typed by a person, so only an upper-case key counts there; a branch name is
  // conventionally lower-case (`feature/proj-123-fix`), so any case counts.
  return pick(title, true) ?? pick(branch, false);
}

/** Exposed for the unit test. */
export const __flowDetailTesting = {
  FLOW_BUDGET_MIN_PRS,
  FLOW_CONTRAST_MIN_QUARTILE,
  FLOW_CUT_MIN_PRS,
  FLOW_LANDING_ROWS_CAP,
  FLOW_CONCENTRATION_MIN_SIDE,
  FLOW_CONCENTRATION_SLOWER_RATIO,
  FLOW_CONCENTRATION_SLOWER_MIN_HOURS,
  FLOW_SEPARATES_RATIO,
  FLOW_WEAK_RATIO,
  FLOW_PR_ROWS_CAP,
  FLOW_PR_ROWS_SLOW_KEEP,
  verdictOf,
  capRows,
};
