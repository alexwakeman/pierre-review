// ── CHRONOLOGY OVER TIME: 26 weeks of the court ledger, with the events that might explain it ────
//
// `GET /api/flow-trend` (Pro on `periodReports`, like the panel). docs/BOTTLENECKS.md § Over time.
//
// One point per week, each week keyed by the MERGE week in the workspace's working time zone
// (Monday 00:00 local, `working-hours.ts` `localWeeksEndingAt`). Per week: the working-hour split,
// the four budget waits (p50/p75 working hours, a verdict against the CURRENT budgets) and the
// median whole-PR time — every one of them from `flowCoreFigures`, the SAME function the panel's
// headline figures come from, over the SAME population (`loadFlowPopulation`, the panel's loader and
// state machine). A week's numbers therefore match the panel's for the same span by construction.
//
// ⚠ THE 26 WEEKS ARE A LABELLED EXCEPTION TO THE 90-DAY CAP (`FLOW_MAX_WINDOW_DAYS`). The cap exists
// because retroactive history is COVERAGE-BIASED — a workspace that onboarded repos across the span
// shows a "trend" that is entirely onboarding. This view keeps the bias VISIBLE instead of hiding it:
// every week carries how many repositories contributed and how many were members, every repo that
// joined is a marker, thin weeks are drawn faint and left out of every baseline and shift sum, and
// the page says "Last 26 weeks".
//
// ⚠ EVENT MARKERS NAME FIRST APPEARANCES, AND NOTHING ELSE. A new contributor is named by login
// (the user asked for it) — that is the ONE narrow exception to Chronology's "no person is named"
// rule. No wait is attributed to anyone: the weekly figures carry no actor, and the markers carry
// no figure.
//
// ⚠ A FIRST APPEARANCE AT THE EDGE OF OUR RECORDS IS NOT AN ARRIVAL. A repository's stored history
// starts where its backfill (or the retention sweep) starts, so everybody active then "first
// appears" at that edge. A first appearance within `FLOW_TREND.historyEdgeDays` of the repository's
// history floor is not marked.
import { and, eq, inArray, min } from 'drizzle-orm';
import {
  FLOW_BUDGET_LABEL,
  FLOW_BUDGET_MEASURES,
  FLOW_TREND,
  FLOW_TREND_MEASURES,
  automationVendorKind,
  reviewBotKind,
  type FlowBudgetMeasure,
  type FlowTrendBudgetCell,
  type FlowTrendEvent,
  type FlowTrendLens,
  type FlowTrendLensRow,
  type FlowTrendMeasure,
  type FlowTrendResponse,
  type FlowTrendWeek,
  type ResolvedFlowSettings,
} from '@pierre-review/shared';
import { config } from '../config.js';
import { db, schema } from './client.js';
import { resolveActorLanes, type ActorLanes } from './actor-lanes.js';
import { detectChangepoints, MIN_BASELINE_POINTS } from './changepoint.js';
import { flowCoreFigures, type FlowPrFacts } from './flow-detail.js';
import { getResolvedFlowSettings } from './flow-settings.js';
import { loadFlowPopulation, type MeasuredPr } from './pr-intervals.js';
import type { BotScope } from './queries.js';
import { buildWorkingCalendar, localWeeksEndingAt, type LocalWeek } from './working-hours.js';
import { firstSettingEventMs, listWorkspaceSettingEvents } from './workspace-setting-events.js';

const { events, pullRequests, repos, reviewComments, reviews, users, workspaceRepos } = schema;

const DAY_MS = 86_400_000;
/** Weeks loaded per population scan, so each scan stays well inside the ledger's PR cap. */
const WEEKS_PER_SCAN = 4;
/** Completed weeks are cached this long — a newly backfilled repo or a reclassified bot lands
 *  within the hour. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 5_000;
/** The smallest step the shift test may treat as real, per unit: half a working hour, 3 points. */
const MIN_SCALE_HOURS = 0.5;
const MIN_SCALE_SHARE = 0.03;

// ── Small pure helpers ───────────────────────────────────────────────────────────────────────

/** A true median (the mean of the middle two on an even count) — the changepoint test's own. */
export function medianOf(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function oneDp(n: number): string {
  return n.toFixed(1).replace(/\.0$/, '');
}

const isShare = (m: FlowTrendMeasure): boolean => m.endsWith('Share');

/** The value a week contributes to one measure's series, or null when the week has none. */
export function weekValue(w: FlowTrendWeek, m: FlowTrendMeasure): number | null {
  if (w.measuredPrs === 0) return null;
  if (isShare(m)) {
    const court = m.replace('Share', '') as 'reviewer' | 'author' | 'landing';
    return w.courtsWork.find((c) => c.court === court)?.share ?? null;
  }
  return w.budgets.find((b) => b.measure === m)?.p75 ?? null;
}

/** A week the maths may use: not thin, not the unfinished current week. */
export function usableWeek(w: FlowTrendWeek): boolean {
  return !w.thin && !w.partial;
}

/** The series for one measure, with unusable weeks as null (skipped, never imputed). */
export function seriesOf(weeks: FlowTrendWeek[], m: FlowTrendMeasure): (number | null)[] {
  return weeks.map((w) => (usableWeek(w) ? weekValue(w, m) : null));
}

// ── The before/after lens ────────────────────────────────────────────────────────────────────

/**
 * For each measure: the median of up to `FLOW_TREND.lensWeeks` usable weeks BEFORE `week`, against
 * up to as many usable weeks FROM `week` on (the event week counts as after — the change point
 * test splits the same way), and whether the change point test, anchored at the event week over
 * exactly those weeks, calls it a real step (`shift`) or ordinary variation (`normal`). Fewer than
 * `MIN_BASELINE_POINTS` usable weeks on a side is `too_few` — no claim, never a guess.
 */
/** The lens's two windows at `week`: up to `FLOW_TREND.lensWeeks` usable values each side. ONE
 *  definition, read by the lens AND the shift detector, so a "Detected shift" marker can never open
 *  a lens that calls the same week ordinary variation. */
function lensWindow(series: (number | null)[], week: number): { before: number[]; after: number[] } {
  const before: number[] = [];
  for (let i = week - 1; i >= 0 && before.length < FLOW_TREND.lensWeeks; i -= 1) {
    const v = series[i];
    if (v != null) before.unshift(v);
  }
  const after: number[] = [];
  for (let i = week; i < series.length && after.length < FLOW_TREND.lensWeeks; i += 1) {
    const v = series[i];
    if (v != null) after.push(v);
  }
  return { before, after };
}

export function lensFor(weeks: FlowTrendWeek[], week: number): FlowTrendLens {
  const rows: FlowTrendLensRow[] = FLOW_TREND_MEASURES.map((m) => {
    const { before, after } = lensWindow(seriesOf(weeks, m), week);
    const tooFew = before.length < MIN_BASELINE_POINTS || after.length < MIN_BASELINE_POINTS;
    const shift =
      !tooFew &&
      detectChangepoints([...before, ...after], {
        anchors: [before.length],
        minScale: isShare(m) ? MIN_SCALE_SHARE : MIN_SCALE_HOURS,
      }).length > 0;
    const b = medianOf(before);
    const a = medianOf(after);
    return {
      measure: m,
      before: b == null ? null : isShare(m) ? Math.round(b * 1000) / 1000 : r2(b),
      after: a == null ? null : isShare(m) ? Math.round(a * 1000) / 1000 : r2(a),
      beforeWeeks: before.length,
      afterWeeks: after.length,
      verdict: tooFew ? 'too_few' : shift ? 'shift' : 'normal',
    };
  });
  return { week, rows };
}

// ── Auto-detected shifts ─────────────────────────────────────────────────────────────────────

const SHARE_LABEL: Record<'reviewerShare' | 'authorShare' | 'landingShare', string> = {
  reviewerShare: 'Waiting for a reviewer',
  authorShare: 'Waiting for the author',
  landingShare: 'Approved, waiting to merge',
};

function hours(v: number): string {
  return v < 10 ? oneDp(v) : String(Math.round(v));
}

/** One templated line for a detected step: the series, then before → after in its own unit. */
export function shiftLabel(m: FlowTrendMeasure, before: number, after: number): string {
  if (m === 'reviewerShare' || m === 'authorShare' || m === 'landingShare') {
    return `${SHARE_LABEL[m]}: ${Math.round(before * 100)}% → ${Math.round(after * 100)}% of working hours`;
  }
  const a = hours(after);
  return `${FLOW_BUDGET_LABEL[m]}: three in four within ${hours(before)} → ${a} working ${a === '1' ? 'hour' : 'hours'}`;
}

/**
 * At most one shift per measure: the strongest split, each candidate judged over the LENS's own
 * windows (`lensWindow`, anchored at the candidate) — so the marker and the lens it opens agree.
 * Only a USABLE week is a candidate, so the marker lands on the first measured week after the step,
 * never on a thin or empty week between the two segments. Ties keep the earliest week.
 */
export function shiftEvents(weeks: FlowTrendWeek[]): FlowTrendEvent[] {
  const out: FlowTrendEvent[] = [];
  for (const m of FLOW_TREND_MEASURES) {
    const series = seriesOf(weeks, m);
    const minScale = isShare(m) ? MIN_SCALE_SHARE : MIN_SCALE_HOURS;
    let cp: { index: number; beforeMedian: number; afterMedian: number; direction: 'up' | 'down'; z: number } | null =
      null;
    for (let i = 1; i < series.length; i += 1) {
      if (series[i] == null) continue;
      const { before, after } = lensWindow(series, i);
      if (before.length < MIN_BASELINE_POINTS || after.length < MIN_BASELINE_POINTS) continue;
      const [hit] = detectChangepoints([...before, ...after], { anchors: [before.length], minScale });
      if (hit && (cp == null || hit.z > cp.z)) cp = { ...hit, index: i };
    }
    if (!cp) continue;
    const w = weeks[cp.index];
    if (!w) continue;
    out.push({
      id: `shift:${m}`,
      kind: 'shift',
      at: w.from,
      week: cp.index,
      label: shiftLabel(m, cp.beforeMedian, cp.afterMedian),
      measure: m,
      direction: cp.direction,
    });
  }
  return out;
}

// ── First appearances ────────────────────────────────────────────────────────────────────────

export interface Appearance {
  userId: number;
  repoId: number;
  atMs: number;
}

/**
 * Each actor's FIRST appearance across the workspace's repositories, kept only when it falls in
 * `[fromMs, toMs)` and is not at the edge of the stored history: an appearance less than
 * `edgeMs` after its repository's history floor is the start of our records, not an arrival.
 * A repository with no floor (never synced) is treated as having its floor at the appearance.
 */
export function firstAppearances(
  rows: Appearance[],
  floors: Map<number, number>,
  edgeMs: number,
  fromMs: number,
  toMs: number,
): Appearance[] {
  const first = new Map<number, Appearance>();
  for (const r of rows) {
    const prev = first.get(r.userId);
    if (!prev || r.atMs < prev.atMs) first.set(r.userId, r);
  }
  const out: Appearance[] = [];
  for (const a of first.values()) {
    if (a.atMs < fromMs || a.atMs >= toMs) continue;
    const floor = floors.get(a.repoId) ?? a.atMs;
    if (a.atMs < floor + edgeMs) continue;
    out.push(a);
  }
  return out.sort((x, y) => x.atMs - y.atMs || x.userId - y.userId);
}

/** The index of the week holding `ms`, or -1. */
export function weekIndexOf(weeks: { startMs: number; endMs: number }[], ms: number): number {
  return weeks.findIndex((w) => ms >= w.startMs && ms < w.endMs);
}

// `min()` comes back as a raw driver value (epoch seconds on sqlite, a Date on pg) — the
// `mode:'timestamp'` mapping applies to selected COLUMNS, not aggregates (db/person-period.ts).
function aggMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && Number.isNaN(Number(v))) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? (n < 10_000_000_000 ? n * 1000 : n) : null;
}

// ── Weekly figures ───────────────────────────────────────────────────────────────────────────

/** The facts `flowCoreFigures` reads. The panel-only fields are neutral: nothing in the split,
 *  the medians or the budgets depends on them. */
function factsOf(m: MeasuredPr): FlowPrFacts {
  return {
    prId: m.pr.id,
    repoId: m.pr.repoId,
    repoFullName: '',
    number: m.pr.number,
    title: '',
    githubUrl: '',
    openedMs: m.pr.openedMs,
    mergedMs: m.pr.mergedMs,
    spells: m.walk.spells,
    rounds: m.walk.rounds,
    firstLookMs: m.walk.firstLookMs,
    approvedAtMs: m.walk.approvedAtMs,
    firstReviewerId: null,
    lines: null,
    files: null,
    reachAreas: [],
    ciRedHours: 0,
    ticketKey: null,
    selfMerged: false,
    requestKind: null,
    firstRequestMs: null,
  };
}

interface WeekInput {
  week: LocalWeek;
  partial: boolean;
  toMs: number;
  measured: MeasuredPr[];
  reposWithData: number;
}

/** One week's figures — pure, so the bucketing and the thin-week floor are tested directly. */
export function weekFigures(
  input: WeekInput,
  settings: ResolvedFlowSettings,
  reposInWorkspace: number,
): FlowTrendWeek {
  const facts = input.measured.map(factsOf);
  const calFrom = facts.reduce((lo, f) => Math.min(lo, f.openedMs), input.toMs);
  const cal = buildWorkingCalendar(settings, calFrom, input.toMs);
  const core = flowCoreFigures(facts, cal, settings);
  const n = facts.length;
  const budgets: FlowTrendBudgetCell[] = core.budgets.map((b) => ({
    measure: b.measure,
    prs: b.prs,
    p50: b.prs === 0 ? null : b.p50,
    p75: b.prs === 0 ? null : b.p75,
    verdict: b.verdict,
  }));
  return {
    weekStart: input.week.key,
    from: new Date(input.week.startMs).toISOString(),
    to: new Date(input.week.endMs).toISOString(),
    partial: input.partial,
    measuredPrs: n,
    thin: n < FLOW_TREND.thinWeekPrs,
    reposWithData: input.reposWithData,
    reposInWorkspace,
    courtsWork: core.courtsWork.map((c) => ({ ...c, share: Math.round(c.share * 1000) / 1000 })),
    medianLeadWorkHours: n === 0 ? null : r2(core.medianLeadWorkHours),
    budgets,
  };
}

/** Bucket measured pull requests by the week their MERGE fell in (half-open weeks). */
export function bucketByMergeWeek<T extends { pr: { mergedMs: number } }>(
  weeks: { startMs: number; endMs: number }[],
  rows: T[],
): T[][] {
  const out: T[][] = weeks.map(() => []);
  for (const r of rows) {
    const i = weekIndexOf(weeks, r.pr.mergedMs);
    if (i >= 0) out[i]?.push(r);
  }
  return out;
}

// ── The cache (completed weeks only) ─────────────────────────────────────────────────────────

const weekCache = new Map<
  string,
  { at: number; week: Omit<FlowTrendWeek, 'reposInWorkspace'>; dataRepoIds: number[]; truncated: boolean }
>();

function cacheKey(accountId: number, scope: BotScope, settings: ResolvedFlowSettings, weekKey: string): string {
  const repoKey = [...scope.repoIds].sort((a, b) => a - b).join(',');
  const s = JSON.stringify([settings.timeZone, settings.days, settings.startMinute, settings.endMinute, settings.budgets]);
  return `${accountId}|${scope.workspaceId}|${repoKey}|${s}|${weekKey}`;
}

/** For tests. */
export function clearFlowTrendCache(): void {
  weekCache.clear();
}

// ── The fold ─────────────────────────────────────────────────────────────────────────────────

export async function getFlowTrend(
  accountId: number,
  scope: BotScope,
  opts: { nowMs?: number } = {},
): Promise<FlowTrendResponse> {
  const nowMs = opts.nowMs ?? Date.now();
  const settings = await getResolvedFlowSettings(accountId, scope.workspaceId);
  const localWeeks = localWeeksEndingAt(nowMs, settings.timeZone, FLOW_TREND.weeks);
  const spanFrom = localWeeks[0]?.startMs ?? nowMs;
  // Markers are read to the END of the current week, so a change made a moment after `nowMs` (the
  // request's own clock) is not dropped.
  const spanTo = localWeeks[localWeeks.length - 1]?.endMs ?? nowMs;
  const budgets = Object.fromEntries(
    FLOW_BUDGET_MEASURES.map((m) => [m, { ...settings.budgets[m] }]),
  ) as Record<FlowBudgetMeasure, { good: number; ok: number }>;
  const historyFrom = await firstSettingEventMs(accountId, scope.workspaceId);
  const retentionDays =
    config.retentionDays > 0 && config.retentionDays * DAY_MS < nowMs - spanFrom ? config.retentionDays : null;

  // Membership dates: how many repos were in the workspace by each week's end, and who joined.
  const memberRows =
    scope.repoIds.length === 0
      ? []
      : await db
          .select({
            repoId: workspaceRepos.repoId,
            joinedAt: workspaceRepos.createdAt,
            owner: repos.owner,
            name: repos.name,
            addedAt: repos.createdAt,
          })
          .from(workspaceRepos)
          .innerJoin(repos, eq(repos.id, workspaceRepos.repoId))
          .where(
            and(
              eq(workspaceRepos.accountId, accountId),
              eq(workspaceRepos.workspaceId, scope.workspaceId),
              inArray(workspaceRepos.repoId, scope.repoIds),
              eq(repos.accountId, accountId),
            ),
          )
          .execute();
  // Members by the week's end — plus any member that had merges that week before it formally joined
  // (a repo's history is backfilled from before the day it was added), so "N of M repositories had
  // merges" never reads "2 of 0".
  const reposBy = (endMs: number, withData: readonly number[]): number =>
    memberRows.filter((r) => r.joinedAt.getTime() < endMs || withData.includes(r.repoId)).length;

  // ── Weeks: cached completed weeks, one population scan per run of uncached ones ─────────────
  const weeks: (FlowTrendWeek | null)[] = localWeeks.map(() => null);
  let truncated = false;
  const nowCached = Date.now();
  localWeeks.forEach((w, i) => {
    if (w.endMs > nowMs) return; // the current week is always live
    const hit = weekCache.get(cacheKey(accountId, scope, settings, w.key));
    if (hit && nowCached - hit.at < CACHE_TTL_MS) {
      weeks[i] = { ...hit.week, reposInWorkspace: reposBy(w.endMs, hit.dataRepoIds) };
      truncated = truncated || hit.truncated;
    }
  });

  let lanes: ActorLanes | null = null;
  if (scope.repoIds.length > 0) {
    const missing = weeks.map((w, i) => (w == null ? i : -1)).filter((i) => i >= 0);
    // Contiguous runs, scanned WEEKS_PER_SCAN at a time so each scan stays inside the PR cap.
    const runs: number[][] = [];
    for (const i of missing) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === i - 1 && last.length < WEEKS_PER_SCAN) last.push(i);
      else runs.push([i]);
    }
    if (runs.length > 0) lanes = await resolveActorLanes(accountId, scope);
    for (const run of runs) {
      const first = localWeeks[run[0] as number] as LocalWeek;
      const last = localWeeks[run[run.length - 1] as number] as LocalWeek;
      const toMs = Math.min(last.endMs, nowMs);
      const pop = await loadFlowPopulation(accountId, scope, new Date(first.startMs), new Date(toMs), {
        detail: false,
        lanes: lanes as ActorLanes,
      });
      truncated = truncated || pop.truncated;
      const runWeeks = run.map((i) => localWeeks[i] as LocalWeek);
      const measuredBy = bucketByMergeWeek(runWeeks, pop.measured);
      const dataReposBy = bucketByMergeWeek(
        runWeeks,
        pop.prs.map((pr) => ({ pr })),
      ).map((rows) => [...new Set(rows.map((r) => r.pr.repoId))]);
      run.forEach((idx, k) => {
        const w = runWeeks[k] as LocalWeek;
        const partial = w.endMs > nowMs;
        const fig = weekFigures(
          {
            week: w,
            partial,
            toMs: Math.min(w.endMs, nowMs),
            measured: measuredBy[k] ?? [],
            reposWithData: dataReposBy[k]?.length ?? 0,
          },
          settings,
          reposBy(w.endMs, dataReposBy[k] ?? []),
        );
        weeks[idx] = fig;
        if (!partial) {
          if (weekCache.size >= CACHE_MAX) {
            const oldest = weekCache.keys().next().value;
            if (oldest != null) weekCache.delete(oldest);
          }
          const { reposInWorkspace: _drop, ...rest } = fig;
          void _drop;
          weekCache.set(cacheKey(accountId, scope, settings, w.key), {
            at: nowCached,
            week: rest,
            dataRepoIds: dataReposBy[k] ?? [],
            truncated: pop.truncated,
          });
        }
      });
    }
  }
  const allWeeks: FlowTrendWeek[] = weeks.map(
    (w, i) =>
      w ??
      weekFigures(
        {
          week: localWeeks[i] as LocalWeek,
          partial: (localWeeks[i] as LocalWeek).endMs > nowMs,
          toMs: Math.min((localWeeks[i] as LocalWeek).endMs, nowMs),
          measured: [],
          reposWithData: 0,
        },
        settings,
        reposBy((localWeeks[i] as LocalWeek).endMs, []),
      ),
  );

  // ── Events ─────────────────────────────────────────────────────────────────────────────────
  const evts: FlowTrendEvent[] = [];
  const at = (ms: number): number => weekIndexOf(localWeeks, ms);

  for (const r of memberRows) {
    const ms = r.joinedAt.getTime();
    const w = at(ms);
    if (w < 0) continue;
    evts.push({
      id: `repo:${r.repoId}`,
      kind: 'repo',
      at: new Date(ms).toISOString(),
      week: w,
      label: `${r.owner}/${r.name} joined the workspace`,
      repoFullName: `${r.owner}/${r.name}`,
    });
  }

  for (const e of await listWorkspaceSettingEvents(accountId, scope.workspaceId, spanFrom, spanTo)) {
    const w = at(e.occurredAtMs);
    if (w < 0) continue;
    evts.push({
      id: `setting:${e.id}`,
      kind: 'setting',
      at: new Date(e.occurredAtMs).toISOString(),
      week: w,
      label: e.summary,
      settingKind: e.kind,
    });
  }

  if (scope.repoIds.length > 0) {
    lanes ??= await resolveActorLanes(accountId, scope);
    const floors = historyFloors(memberRows, nowMs);
    const edgeMs = FLOW_TREND.historyEdgeDays * DAY_MS;
    const [botRows, contribRows] = await Promise.all([
      botAppearanceRows(accountId, scope.repoIds),
      contributorAppearanceRows(accountId, scope.repoIds),
    ]);
    const l = lanes;
    const bots = firstAppearances(
      botRows.filter((r) => l.laneOf(r.userId) !== 'human'),
      floors,
      edgeMs,
      spanFrom,
      spanTo,
    ).slice(-FLOW_TREND.maxMarkersPerKind);
    const people = firstAppearances(
      contribRows.filter((r) => l.laneOf(r.userId) === 'human'),
      floors,
      edgeMs,
      spanFrom,
      spanTo,
    ).slice(-FLOW_TREND.maxMarkersPerKind);
    const logins = await loginsOf([...bots, ...people].map((a) => a.userId));
    for (const a of bots) {
      const login = logins.get(a.userId);
      if (login == null) continue;
      evts.push({
        id: `bot:${a.userId}`,
        kind: 'bot',
        at: new Date(a.atMs).toISOString(),
        week: at(a.atMs),
        label: `@${login} first seen`,
        login,
        vendorKind: reviewBotKind(login) ?? automationVendorKind(login),
      });
    }
    for (const a of people) {
      const login = logins.get(a.userId);
      // A user row flagged as a bot never reaches here (the lane union includes `users.isBot`).
      if (login == null) continue;
      evts.push({
        id: `contributor:${a.userId}`,
        kind: 'contributor',
        at: new Date(a.atMs).toISOString(),
        week: at(a.atMs),
        label: `@${login} first contributed`,
        login,
      });
    }
  }

  evts.push(...shiftEvents(allWeeks));
  evts.sort((a, b) => a.week - b.week || a.at.localeCompare(b.at) || a.id.localeCompare(b.id));

  const lensWeeks = [...new Set(evts.map((e) => e.week))].sort((a, b) => a - b);
  return {
    workspaceId: scope.workspaceId,
    weeks: allWeeks,
    events: evts,
    lenses: lensWeeks.map((w) => lensFor(allWeeks, w)),
    timeZone: settings.timeZone,
    budgets,
    settingsHistoryFrom: historyFrom == null ? null : new Date(historyFrom).toISOString(),
    truncated,
    retentionDays,
  };
}

/**
 * Where each repository's stored history begins: the later of its backfill horizon (added to Limn
 * minus `BACKFILL_DAYS`) and the retention sweep's cutoff.
 */
function historyFloors(
  rows: { repoId: number; addedAt: Date }[],
  nowMs: number,
): Map<number, number> {
  const retentionFloor = config.retentionDays > 0 ? nowMs - config.retentionDays * DAY_MS : -Infinity;
  const out = new Map<number, number>();
  for (const r of rows) {
    out.set(r.repoId, Math.max(r.addedAt.getTime() - config.backfillDays * DAY_MS, retentionFloor));
  }
  return out;
}

/** Each actor's earliest event per repository — any event type. The lane decides who is a bot. */
async function botAppearanceRows(accountId: number, repoIds: number[]): Promise<Appearance[]> {
  const rows = await db
    .select({ userId: events.actorId, repoId: events.repoId, m: min(events.occurredAt) })
    .from(events)
    .where(and(eq(events.accountId, accountId), inArray(events.repoId, repoIds)))
    .groupBy(events.actorId, events.repoId)
    .execute();
  return toAppearances(rows);
}

/** Each person's earliest authored (merged) pull request, review and review comment, per repository. */
async function contributorAppearanceRows(accountId: number, repoIds: number[]): Promise<Appearance[]> {
  const inScope = and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, repoIds));
  const [authored, reviewed, commented] = await Promise.all([
    db
      .select({ userId: pullRequests.authorId, repoId: pullRequests.repoId, m: min(pullRequests.openedAt) })
      .from(pullRequests)
      // MERGED work only: on a public repository most opened-and-abandoned pull requests are
      // drive-by, and a marker per drive-by would bury the arrivals that matter.
      .where(and(inScope, eq(pullRequests.state, 'merged')))
      .groupBy(pullRequests.authorId, pullRequests.repoId)
      .execute(),
    db
      .select({ userId: reviews.authorId, repoId: pullRequests.repoId, m: min(reviews.submittedAt) })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(inScope)
      .groupBy(reviews.authorId, pullRequests.repoId)
      .execute(),
    db
      .select({ userId: reviewComments.authorId, repoId: pullRequests.repoId, m: min(reviewComments.createdAt) })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(inScope)
      .groupBy(reviewComments.authorId, pullRequests.repoId)
      .execute(),
  ]);
  return [...toAppearances(authored), ...toAppearances(reviewed), ...toAppearances(commented)];
}

function toAppearances(rows: { userId: number | null; repoId: number; m: unknown }[]): Appearance[] {
  const out: Appearance[] = [];
  for (const r of rows) {
    const ms = aggMs(r.m);
    if (r.userId == null || ms == null) continue;
    out.push({ userId: r.userId, repoId: r.repoId, atMs: ms });
  }
  return out;
}

/** Logins BY ID — `users` is a global table and is never handed to a tenant as a listing. */
async function loginsOf(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 900) {
    const rows = await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, uniq.slice(i, i + 900)))
      .execute();
    for (const r of rows) out.set(r.id, r.login.replace(/\[bot\]$/i, ''));
  }
  return out;
}

