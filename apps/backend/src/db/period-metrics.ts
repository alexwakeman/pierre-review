// ── The PERIOD METRIC VECTOR (CORE, deterministic — no model, no new table) ──────────────────
//
// The numbers behind the Insights "Reports" sub-tab: twelve figures describing ONE completed
// period ("18 Aug – 1 Sep"), plus the coverage read that keeps a comparison between two of them
// honest. The storage, the narration and the routes are plugin-owned; everything here is free,
// deterministic and reproducible.
//
// ⚠ IT WRITES ITS OWN SQL AND REUSES NONE OF THE EXISTING GETTERS. Measured against the live
// dev DB before this file existed: `getWorkspaceMetrics`' stat tiles honour an arbitrary window
// but its weekly series are a FIXED 12 weeks ending NOW, `openPrs`/`ciFailingNow` are
// current-state snapshots and `ciFailureReasons` has no upper bound at all;
// `getWorkspaceMetricsDetail` ignores `window.toMs` outright. None of them can answer "what did
// July look like", and bending them into it would move every existing tile. So this file is a
// second, narrower reader over the same tables — deliberately, and not by oversight.
//
// ⚠ EVERY METRIC IS **WINDOW-PURE**: a function of events timestamped in `[fromMs, toMs)` and
// nothing else. A stored historical period has to stay reproducible, and a snapshot is not — so
// `openPrs`, `ciFailingNow`, open-PR age and current thread state are all ABSENT from the vector
// even though the DORA header carries them. (Trunk red share is absent for a different reason:
// `trunk_ci_status_events` has no backfill — a known gap — so it is not computable for a past
// period AT ALL, and a metric that silently reads 0% green for every period before the feature
// shipped is worse than an omitted one.)
//
// ⚠ EVERY PREDICATE IS **TWO-SIDED**: `>= from AND < to`. A one-sided `gte` is precisely what
// makes the three existing getters unusable here, and the half-open upper bound is what stops
// two adjacent periods double-counting the event that lands on their shared boundary.
// `period-metrics.test.ts` pins both edges on four different columns.
//
// ⚠ RETROACTIVE HISTORY IS BIASED UNLESS COVERAGE IS RESPECTED, and that is what
// `getPeriodCoverage` is for. Measured: merged-PR counts by 14-day period over the last six
// months read 570, 572, 557, 494, 491, 537, 464, 292, 354, 232, 230, 177, 39 — which looks like
// explosive growth. The number of repos CONTRIBUTING to those same periods is 18, 19, 18, 18,
// 19, 18, 18, 13, 12, 10, 9, 6, 4. The "trend" is repo onboarding, not team output. A forecast
// fitted on that would predict growth that is purely a data artifact.
//
// ⚑ ITS OWN FILE, NOT queries.ts: that file is 13k lines and CONTAINS LITERAL NUL BYTES around
// offset 132k, so every search tool silently under-reports matches inside it. Nothing imports
// this file back, so importing queries.ts here creates no cycle (the db/bot-volume.ts and
// db/bot-overlap.ts precedent).
import { createHash } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, lt, lte, ne } from 'drizzle-orm';
import type {
  ActorLane,
  PeriodMetricDirection,
  PeriodMetricKey,
  PeriodMetricValue,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes, type ActorLanes } from './actor-lanes.js';
import { listWorkspaces, type BotScope } from './queries.js';

// MIRRORED from @pierre-review/shared `ACTOR_LANES`, for the same release-guard reason the metric
// keys are (see below). Render order: people first, then the automation that AUTHORS code (the
// lanes that distort throughput), then the automation that RESPONDS to it (the lanes that distort
// review counts).
const ACTOR_LANE_ORDER: ActorLane[] = [
  'human',
  'code_agent',
  'dependency',
  'ai_review',
  'quality_gate',
  'release',
  'housekeeping',
];

const { prComments, pullRequests, repos, reviewComments, reviews, reviewThreads } = schema;

// MIRRORED from @pierre-review/shared (PERIOD_METRICS_SCHEMA_VERSION / PERIOD_METRIC_KEYS).
// Inlined rather than imported for the same reason `AI_CREDITS_PER_USD` is inlined in
// db/credits.ts: the shared package is TYPES ONLY and is not shipped, so `build-release.mjs`
// greps `release/dist` and FAILS the build on a real runtime import of it. Two spellings, kept
// in lockstep — and `period-metrics.test.ts` imports the shared originals (a test is not in
// release/dist) and asserts the two arrays are identical, so the drift is caught in CI rather
// than by a reader.
export const PERIOD_METRICS_SCHEMA_VERSION = 2;

/** CLOSED + ORDERED at schema version 2. This order IS the render order and is part of the
 *  contract. Each human-only twin sits immediately after the blended figure it corrects — read
 *  adjacently they state the automation gap without narration. */
export const PERIOD_METRIC_KEYS: PeriodMetricKey[] = [
  'merged_prs',
  'human_merged_prs',
  'opened_prs',
  'automation_merge_share_pct',
  'median_lead_time_hours',
  'median_time_to_first_human_review_hours',
  'merge_ci_success_pct',
  'median_pr_size_lines',
  'median_human_pr_size_lines',
  'review_threads_opened',
  'threads_replied_within_36h_pct',
  'bot_review_comments',
  'human_review_comments',
  'bot_comments_per_merged_pr',
  'reviewer_concentration_pct',
];

// ── The per-metric metadata the SIGNIFICANCE rule runs on ────────────────────────────────────
// A delta is `significant` only when BOTH periods clear the metric's `sampleFloor`, the absolute
// change clears its `absoluteFloor`, AND the two periods are coverage-comparable. A percentage
// change off a tiny base is noise wearing a suit — this codebase has learned that twice (the
// bot-volume BASELINE_MIN_EXPECTED floor is the same lesson at a different grain), so the floors
// live HERE, beside the definitions they belong to, rather than being re-invented by whichever
// consumer renders the delta.
//
// `Record<PeriodMetricKey, …>` on purpose: adding a key to the union without a row here is a
// COMPILE error, which is the only mechanism that keeps a version bump honest.
export interface PeriodMetricMeta {
  direction: PeriodMetricDirection;
  /** Minimum items behind the statistic before a change may be called significant. */
  sampleFloor: number;
  /** Minimum |change|, in the metric's OWN units (hours, points, lines, count, ratio). */
  absoluteFloor: number;
}

export const PERIOD_METRIC_META: Record<PeriodMetricKey, PeriodMetricMeta> = {
  merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  human_merged_prs: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 3 },
  opened_prs: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 3 },
  // NEUTRAL, and that is a product decision rather than a hedge. More automation is not
  // self-evidently good (a team drowning in bumps) or bad (a team shipping with agents) — the
  // lane split below is what makes the number readable, and an arrow claiming a direction would
  // assert a judgement the figure cannot support.
  automation_merge_share_pct: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 5 },
  median_lead_time_hours: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 2 },
  median_time_to_first_human_review_hours: {
    direction: 'down_good',
    sampleFloor: 5,
    absoluteFloor: 1,
  },
  merge_ci_success_pct: { direction: 'up_good', sampleFloor: 5, absoluteFloor: 5 },
  median_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  median_human_pr_size_lines: { direction: 'down_good', sampleFloor: 5, absoluteFloor: 20 },
  review_threads_opened: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  threads_replied_within_36h_pct: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_review_comments: { direction: 'neutral', sampleFloor: 10, absoluteFloor: 5 },
  human_review_comments: { direction: 'up_good', sampleFloor: 10, absoluteFloor: 5 },
  bot_comments_per_merged_pr: { direction: 'neutral', sampleFloor: 5, absoluteFloor: 0.5 },
  reviewer_concentration_pct: { direction: 'down_good', sampleFloor: 10, absoluteFloor: 5 },
};

// The reply grace for `threads_replied_within_36h_pct`. MIRRORED from `OVERDUE_GRACE_MS` in
// queries.ts (file-private there, and that file is the NUL-byte one — importing across it for a
// constant is not worth the coupling). Same 36h the bot verdict already treats as "a working day
// and a bit", so the two surfaces agree about what "responded promptly" means.
const REPLY_GRACE_MS = 36 * 60 * 60 * 1000;

// ── Scan caps (the ROLLUP_SCAN_CAP honesty rule) ─────────────────────────────────────────────
// A period is a sprint, not a year, so these are far past anything real: the busiest repo in the
// dev corpus contributes ~1000 merged PRs per 180 days. They exist so a pathological account
// cannot pull an unbounded result set into memory. Every capped scan is ordered so that what it
// keeps is the MOST RECENT slice rather than an arbitrary one.
const PERIOD_PR_SCAN_CAP = 20_000;
const PERIOD_THREAD_SCAN_CAP = 50_000;
const PERIOD_COMMENT_SCAN_CAP = 200_000;

// ⚠ A DIFFERENT KIND OF CAP FROM THE THREE ABOVE, and much smaller for a reason that is not
// memory. The first-human-review fold has to look up every review on a candidate PR — including
// ones OUTSIDE the window, since a PR first reviewed by a person in January must not be counted
// as newly reviewed now — so the candidate ids travel as BIND PARAMETERS in an `IN (…)`. SQLite
// caps those at 32,766 and Postgres at 65,535, so reusing `PERIOD_PR_SCAN_CAP` (20,000) would sit
// one busy quarter away from a hard driver error rather than a truncated result. A period is a
// sprint: 5,000 human-reviewed PRs in one is far beyond anything real.
const PERIOD_FIRST_REVIEW_PR_CAP = 5_000;

export interface PeriodWindow {
  fromMs: number;
  toMs: number;
}

export interface PeriodMetricsResult {
  /** All 12, in PERIOD_METRIC_KEYS order, ALWAYS present — a missing key and a null value are
   *  different facts and only one of them is legal here. */
  metrics: PeriodMetricValue[];
  /** sha256 over the raw counts + the exact scope and window. Recomputed on the free GET to
   *  decide `stale`; see the note on `fingerprintOf`. */
  fingerprint: string;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 2dp — display figures. An unrounded 16.888888888888889 in a report cell is worse than
 *  useless, and an unrounded float also churns the fingerprint on re-computation.
 *  (Both exported for db/person-period.ts — the person vector rounds and medians identically.) */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type MetricCell = { value: number | null; sampleSize: number };

/** A count is a real observation: 0 merged PRs in a period is `0`, not "no data". Only an EMPTY
 *  SCOPE and a statistic with nothing behind it (a median of nothing, a percentage of nothing)
 *  are null. `null` is NOT `0` and must never render as `0`. */
const countCell = (n: number): MetricCell => ({ value: n, sampleSize: n });

// ── The shared base scan ─────────────────────────────────────────────────────────────────────
// ONE loader feeding all twelve metrics, the bot-volume.ts shape: a metric, the comparison drawn
// from it and the forecast fitted on it are three renderings of one count, so they cannot drift
// the way a tile and its drill-down drift when each runs its own scan.

interface MergedPr {
  leadMs: number;
  /** null = size NEVER OBSERVED. See the note in `loadPeriodBase`. */
  loc: number | null;
  /** Only the DETERMINATE outcomes — see the note on `merge_ci_success_pct`. */
  ciDeterminate: boolean;
  ciSuccess: boolean;
  /** The AUTHOR's lane. `human` covers a null author (a deleted GitHub account is unattributable,
   *  and calling it automation would be a claim we cannot support). */
  lane: ActorLane;
}

/** One PR of a median's sample population — what the evidence sinks below carry: the PR id plus
 *  the review timestamp that anchored it in the window (the newest-first evidence sort key). */
export interface ReviewSampleRef {
  prId: number;
  atMs: number;
}

// ── The ONE definition of "time until a person reviewed it" ──────────────────────────────────
//
// Extracted because it is read by TWO surfaces — the vector's
// `median_time_to_first_human_review_hours` and the lane panel's
// `medianTimeToFirstHumanReviewHours` — that sit one above the other on the same screen, and they
// disagreed on the live database the first time this shipped: 18.16h in the table against 18.27h
// in the panel below it.
//
// The cause was not rounding. The lane fold read only reviews INSIDE the window and took each
// PR's earliest of those, so a PR a person had reviewed in a previous period counted as freshly
// reviewed. The vector fold looked at all of time and required the first human review to fall in
// the window, which is the correct question. Two folds, one screen, two answers — and the panel's
// caption asserted they were the same measurement.
//
// So there is now one fold. Anything that wants this number calls this.
//
// EXPORTED (P4.2): the 1:1 person vector's "median hours THEIR PRs waited for a first human
// review" is this same measurement narrowed to one author — `authorUserId` narrows the candidate
// PR population (query 1; query 2 runs over those candidates, so one predicate covers both) and
// changes nothing else. A second fold of this number is the named shipped bug this comment block
// opens with; the narrowing parameter exists precisely so no one writes one.
export async function loadFirstHumanReviewHours(
  accountId: number,
  scope: BotScope,
  from: Date,
  to: Date,
  lanes: ActorLanes,
  authorUserId?: number,
  // Evidence sink (the People report's person-period evidence): when given, receives
  // {prId, atMs} for EXACTLY the PRs whose hours entered the median — the sample population off
  // this one fold, so no caller ever writes a sibling predicate to name it. Optional + append-
  // only: both period-vector call sites pass nothing and are byte-identical to before.
  samplesOut?: ReviewSampleRef[],
): Promise<number[]> {
  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
    ...(authorUserId != null ? [eq(pullRequests.authorId, authorUserId)] : []),
  );

  // (1) CANDIDATES: every PR with a non-pending review submitted in the window. A superset of
  // what we want — a PR whose first HUMAN review is in-window necessarily has a review in-window
  // — narrowed by step (2). Newest-first so the dedupe keeps the most recent on hitting the cap.
  const reviewedPrRows = await db
    .select({ prId: reviews.prId })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        inScope,
        gte(reviews.submittedAt, from),
        lt(reviews.submittedAt, to),
        ne(reviews.state, 'pending'),
      ),
    )
    .orderBy(desc(reviews.submittedAt), desc(reviews.id))
    .limit(PERIOD_COMMENT_SCAN_CAP)
    .execute();

  // Deduped in TS rather than with a `groupBy`, which keeps the query free of an aggregate:
  // `min(submitted_at)` comes back as an epoch integer on SQLite and a Date on Postgres
  // (drizzle's `mode: 'timestamp'` mapping applies to selected COLUMNS, not to `sql` fragments),
  // and that is a dialect divergence this file has no reason to acquire for a trivial fold.
  const candidatePrIds: number[] = [];
  const seenPr = new Set<number>();
  for (const r of reviewedPrRows) {
    if (seenPr.has(r.prId)) continue;
    seenPr.add(r.prId);
    candidatePrIds.push(r.prId);
    if (candidatePrIds.length >= PERIOD_FIRST_REVIEW_PR_CAP) break;
  }
  if (candidatePrIds.length === 0) return [];

  // (2) EVERY non-pending review on a candidate PR, across ALL TIME — deliberately NOT restricted
  // to the window.
  //
  // ⚠ THE UNBOUNDED TIME RANGE IS THE WHOLE POINT and must not be "optimised" back to
  // `[from, to)`. That optimisation is precisely the bug described above. A PR a person reviewed
  // in January and revisited today would answer "first reviewed today", reporting a months-old
  // review as fresh latency. Seeing the earlier review is the only way to rule it out.
  //
  // ASCENDING so each PR's earliest review survives the cap; a newest-first cap would drop
  // exactly the rows the fold is looking for.
  const rows = await db
    .select({
      prId: reviews.prId,
      authorId: reviews.authorId,
      submittedAt: reviews.submittedAt,
      openedAt: pullRequests.openedAt,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(and(inArray(reviews.prId, candidatePrIds), ne(reviews.state, 'pending')))
    .orderBy(reviews.submittedAt, reviews.id)
    .limit(PERIOD_COMMENT_SCAN_CAP)
    .execute();

  const firstHumanByPr = new Map<number, { at: number; openedAt: number }>();
  for (const r of rows) {
    if (firstHumanByPr.has(r.prId)) continue;
    if (lanes.laneOf(r.authorId) !== 'human') continue;
    firstHumanByPr.set(r.prId, { at: r.submittedAt.getTime(), openedAt: r.openedAt.getTime() });
  }

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: number[] = [];
  for (const [prId, { at, openedAt }] of firstHumanByPr) {
    if (at < fromMs || at >= toMs) continue; // first human review was in some OTHER period
    const hours = (at - openedAt) / 3_600_000;
    // A review timestamped before its own PR opened is clock skew, not a negative latency.
    // Excluding it is cheap and it is exactly the direction of error this metric exists to fix.
    if (hours >= 0) {
      out.push(hours);
      samplesOut?.push({ prId, atMs: at });
    }
  }
  return out;
}

interface PeriodBase {
  mergedPrs: MergedPr[];
  openedPrs: number;
  /** openedAt → first HUMAN review, in hours, for PRs whose first human review landed in the
   *  window. See the fold in `loadPeriodBase` for why this is not the `first_review_at` column. */
  humanFirstReviewHours: number[];
  threadsOpened: number;
  threadsRepliedWithin: number;
  botComments: number;
  humanComments: number;
  /** Non-automated reviewer id → in-window submitted reviews. */
  reviewsByHuman: Map<number, number>;
}

/** A function, not a shared constant — the struct carries a Map, and one mutable module-level
 *  instance handed to every empty-scope call is a trap waiting for the first consumer that
 *  writes to it (the bot-volume `emptyBase` precedent). */
function emptyBase(): PeriodBase {
  return {
    mergedPrs: [],
    openedPrs: 0,
    humanFirstReviewHours: [],
    threadsOpened: 0,
    threadsRepliedWithin: 0,
    botComments: 0,
    humanComments: 0,
    reviewsByHuman: new Map(),
  };
}

async function loadPeriodBase(
  accountId: number,
  scope: BotScope,
  from: Date,
  to: Date,
): Promise<PeriodBase> {
  const repoIds = scope.repoIds;
  // ⚠ THE AUTOMATION SET IS THE LANE RESOLVER'S UNION, NOT `automatedReviewerUserIds` ALONE.
  //
  // The workspace verdict still decides who counts as a bot, but on its own it MISSES the second
  // row of a duplicated identity: `dependabot` and `dependabot[bot]` are separate `users` rows on
  // real accounts and one of each pair sat at `automated = 0`, i.e. was counted as a person. That
  // is what put bot text in `human_review_comments` and bot reviewers in the concentration
  // figure. `resolveActorLanes` unions the verdict with `users.isBot` and the login vocabularies
  // and subtracts anyone a human vouched for, which is the same set the lane panel renders — so
  // the metric table and the lane breakdown under it can no longer disagree about who is a person.
  //
  // Role stays `'all'` inside that resolver by the ROI/flagging convention: a quality check posts
  // exactly the kind of text `bot_review_comments` counts, and narrowing to reviewers would make
  // the bot and human halves fail to sum to the total.
  const lanes = await resolveActorLanes(accountId, scope);
  const automatedIds = [...lanes.automatedIds];
  const inScope = and(eq(pullRequests.accountId, accountId), inArray(pullRequests.repoId, repoIds));

  const [mergedRows, openedRow, humanFirstReviewHours, threadRows, commentRows, reviewRows, botCommentRow] =
    await Promise.all([
      // (1) PRs MERGED in the window — the population behind metrics 1, 3, 5, 6 and the
      // denominator of 11. Newest-merged first so the cap keeps a recent sample.
      db
        .select({
          authorId: pullRequests.authorId,
          openedAt: pullRequests.openedAt,
          mergedAt: pullRequests.mergedAt,
          additions: pullRequests.additions,
          deletions: pullRequests.deletions,
          changedFiles: pullRequests.changedFiles,
          ciStatus: pullRequests.ciStatus,
        })
        .from(pullRequests)
        .where(and(inScope, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
        .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
        .limit(PERIOD_PR_SCAN_CAP)
        .execute(),
      // (2) PRs OPENED in the window. A bare count — no row is needed, and an exact aggregate
      // cannot be truncated. Deliberately NOT restricted to merged PRs: a period's intake is
      // intake whether or not it landed.
      db
        .select({ c: count() })
        .from(pullRequests)
        .where(and(inScope, gte(pullRequests.openedAt, from), lt(pullRequests.openedAt, to)))
        .execute(),
      // (4) Hours from open to the FIRST HUMAN REVIEW, for PRs whose first human review landed
      // in this window. ONE shared fold — see `loadFirstHumanReviewHours` for why it is not
      // inlined here and why it must look outside the window to answer correctly.
      loadFirstHumanReviewHours(accountId, scope, from, to, lanes),
      // (7) Review threads whose ROOT COMMENT lands in the window. `reviewThreads.createdAt` IS
      // the root comment's timestamp (sync writes it from `comments.nodes[0].createdAt`), so no
      // second lookup is needed to bucket a thread.
      db
        .select({ id: reviewThreads.id, createdAt: reviewThreads.createdAt })
        .from(reviewThreads)
        .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
        .where(and(inScope, gte(reviewThreads.createdAt, from), lt(reviewThreads.createdAt, to)))
        .orderBy(desc(reviewThreads.createdAt), desc(reviewThreads.id))
        .limit(PERIOD_THREAD_SCAN_CAP)
        .execute(),
      // (8) The comments on those threads, for the reply test.
      //
      // The comment window is `[from, to + 36h)`: a reply that qualifies must be within the
      // grace of a root that itself started in-window, so nothing outside that span can change
      // the answer — and bounding it keeps the scan proportional to the period rather than to
      // the age of the longest-lived thread.
      //
      // ⚠ ORDERED **ASCENDING**, the opposite of every other capped scan here, and that
      // inversion is load-bearing: this fold needs each thread's EARLIEST two comments. A
      // newest-first cap would drop the ROOTS first and silently turn late replies into roots.
      db
        .select({ threadId: reviewComments.threadId, createdAt: reviewComments.createdAt })
        .from(reviewComments)
        .innerJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
        .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
        .where(
          and(
            inScope,
            gte(reviewThreads.createdAt, from),
            lt(reviewThreads.createdAt, to),
            gte(reviewComments.createdAt, from),
            lt(reviewComments.createdAt, new Date(to.getTime() + REPLY_GRACE_MS)),
          ),
        )
        .orderBy(reviewComments.createdAt, reviewComments.id)
        .limit(PERIOD_COMMENT_SCAN_CAP)
        .execute(),
      // (12) Submitted reviews in the window, per author. `pending` reviews are drafts,
      // invisible on GitHub — the same predicate every other review-activity reader uses.
      // Exact aggregate, no cap.
      db
        .select({ authorId: reviews.authorId, c: count() })
        .from(reviews)
        .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
        .where(
          and(
            inScope,
            gte(reviews.submittedAt, from),
            lt(reviews.submittedAt, to),
            ne(reviews.state, 'pending'),
          ),
        )
        .groupBy(reviews.authorId)
        .execute(),
      // (9) Bot-authored review comments in the window. Counted as its own exact aggregate and
      // subtracted from the total below, rather than as a `notInArray` twin: `notInArray` drops
      // NULL authors in both dialects (SQL three-valued logic), which would silently lose every
      // comment by a since-deleted GitHub account from the human half.
      automatedIds.length === 0
        ? Promise.resolve([{ c: 0 }])
        : db
            .select({ c: count() })
            .from(reviewComments)
            .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
            .where(
              and(
                inScope,
                gte(reviewComments.createdAt, from),
                lt(reviewComments.createdAt, to),
                inArray(reviewComments.authorId, automatedIds),
              ),
            )
            .execute(),
    ]);

  // (9 + 10) The total, so `human = total − bot` and the two halves always sum. A comment whose
  // author is NULL (deleted account) lands in the HUMAN half — by the definition's own words
  // ("NOT authored by an automated reviewer") and because the alternative is a third bucket
  // nothing renders.
  const [totalCommentRow] = await db
    .select({ c: count() })
    .from(reviewComments)
    .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
    .where(and(inScope, gte(reviewComments.createdAt, from), lt(reviewComments.createdAt, to)))
    .execute();

  const mergedPrs: MergedPr[] = [];
  for (const r of mergedRows) {
    // `mergedAt` cannot be null here (the two-sided predicate excludes nulls in both dialects),
    // but the COLUMN is nullable, so the narrowing is explicit rather than a `!`.
    if (!r.mergedAt) continue;
    // ⚠ UNKNOWN SIZE, NOT ZERO SIZE — the bot-volume.ts rule. Under lean storage these three
    // columns default to 0, so a PR whose detail never hydrated looks exactly like an empty one
    // (135 of three.js's 796 merged PRs are in that state in the dev corpus). Feeding a
    // fabricated 0 into a MEDIAN drags it towards zero by however many rows never hydrated,
    // which is the most convincing kind of wrong number.
    const observed = r.changedFiles > 0 || r.additions > 0 || r.deletions > 0;
    // ⚠ `ciStatus` IS A HEAD-COMMIT SNAPSHOT, and it is window-pure ONLY because the population
    // is MERGED PRs: a merged PR's head never moves again, so the value is frozen at merge time
    // and the metric stays reproducible. It would NOT be for open PRs — one more reason the
    // population is what it is.
    //
    // Only the DETERMINATE outcomes are in the denominator. `null` means never observed (no CI
    // configured, or a row that predates the column), and 'pending'/'expected'/'unknown' mean we
    // genuinely do not know — counting any of them as a CI failure would report a repo with no
    // CI at all as 0% green, which is a lie with a number attached.
    const ci = r.ciStatus;
    mergedPrs.push({
      leadMs: r.mergedAt.getTime() - r.openedAt.getTime(),
      loc: observed ? r.additions + r.deletions : null,
      ciDeterminate: ci === 'success' || ci === 'failure' || ci === 'error',
      ciSuccess: ci === 'success',
      lane: lanes.laneOf(r.authorId),
    });
  }

  // The reply fold. Per thread, the two earliest comment timestamps: `t[0]` is the root and
  // `t[1]` is the first reply, so "replied within 36h" is `t[1] - t[0] <= REPLY_GRACE_MS`.
  //
  // Reading the ROOT off the comment set rather than off `reviewThreads.createdAt` is deliberate
  // and costs nothing: it is immune to a same-second sibling (sqlite stores timestamps as epoch
  // SECONDS, so a bot posting twice in one second would defeat a strict `createdAt > root`
  // comparison) and to the degenerate thread whose `createdAt` fell back to the PR's.
  //
  // ⚠ KNOWN SOFTNESS, and it is the definition's ("any reply"), not an oversight: the author of
  // the follow-up is not checked, so a bot that appends to its OWN thread counts as a reply.
  // Narrowing it to "a different author" would be a different metric and would need its own
  // schema version.
  const firstTwo = new Map<number, number[]>();
  for (const c of commentRows) {
    const seen = firstTwo.get(c.threadId);
    if (seen == null) firstTwo.set(c.threadId, [c.createdAt.getTime()]);
    else if (seen.length < 2) seen.push(c.createdAt.getTime());
  }
  let threadsRepliedWithin = 0;
  for (const t of threadRows) {
    const seen = firstTwo.get(t.id);
    // No comment rows at all ⇒ nothing to reply to and nothing that replied. Not an error: a
    // thread outside the (capped) scan lands here too, which is why the cap is set where it is.
    if (!seen || seen.length < 2) continue;
    if (seen[1]! - seen[0]! <= REPLY_GRACE_MS) threadsRepliedWithin += 1;
  }

  // ⚠ REVIEWER CONCENTRATION IS OVER **HUMAN** REVIEWERS. Included, a bot that reviews every PR
  // pins the metric near 100% forever and it stops moving — a dead row on the report, in exactly
  // the bot-heavy workspaces this product is for. The question the metric answers ("is review
  // load resting on one person?") is a bus-factor question, and an always-on bot is not a bus
  // factor. Any caption for it must say "among human reviewers".
  const automated = new Set(automatedIds);
  const reviewsByHuman = new Map<number, number>();
  for (const r of reviewRows) {
    // A null author is a deleted account: unattributable, so it cannot be anyone's share.
    if (r.authorId == null || automated.has(r.authorId)) continue;
    reviewsByHuman.set(r.authorId, (reviewsByHuman.get(r.authorId) ?? 0) + r.c);
  }

  const botComments = botCommentRow[0]?.c ?? 0;
  const totalComments = totalCommentRow?.c ?? 0;
  return {
    mergedPrs,
    openedPrs: openedRow[0]?.c ?? 0,
    humanFirstReviewHours,
    threadsOpened: threadRows.length,
    threadsRepliedWithin,
    botComments,
    humanComments: Math.max(0, totalComments - botComments),
    reviewsByHuman,
  };
}

// ── The fingerprint ──────────────────────────────────────────────────────────────────────────
/**
 * sha256 over the raw per-metric figures plus the exact scope and window that produced them.
 *
 * ⚠ NOTHING `Date.now()`-DERIVED MAY ENTER IT. This is the payload-hash trap this codebase has
 * hit repeatedly (the digest cost trap, the annotation hunk): a hash that folds in a moving
 * value differs on every recomputation, so a stored report would read `stale` forever and the
 * UI would invite a re-generation that changes nothing and costs money. Everything below is a
 * function of stored rows and the caller's fixed window.
 *
 * The scope and the window are IN the hash on purpose. §6.4's membership drift is a real reason
 * for a stored report to go stale: adding a repo to the workspace changes what "this period"
 * means even when not one existing row moved.
 */
function fingerprintOf(
  scope: BotScope,
  window: PeriodWindow,
  cells: Record<PeriodMetricKey, MetricCell>,
): string {
  const parts = [
    `v${PERIOD_METRICS_SCHEMA_VERSION}`,
    `ws:${scope.workspaceId}`,
    `repos:${[...scope.repoIds].sort((a, b) => a - b).join(',')}`,
    `win:${window.fromMs}-${window.toMs}`,
  ];
  for (const key of PERIOD_METRIC_KEYS) {
    const cell = cells[key];
    parts.push(`${key}=${cell.value ?? '~'}/${cell.sampleSize}`);
  }
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

// ── (1) The vector ───────────────────────────────────────────────────────────────────────────

export async function getPeriodMetrics(
  accountId: number,
  // `workspaceId` decides who counts as a bot; `repoIds` narrows what is measured. A BotScope is
  // only ever built by `resolveWorkspaceScope`, so `repoIds ⊆ the workspace's membership`.
  scope: BotScope,
  window: PeriodWindow,
): Promise<PeriodMetricsResult> {
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);
  // `repoIds: []` is a real empty workspace — every metric is `null` with sampleSize 0, and it
  // is NOT an error and NOT a widening to the account. (`from >= to` is degenerate but legal:
  // the two-sided predicates simply match nothing, so it falls out as an all-empty base rather
  // than needing a guard that would have to decide what to throw.)
  const empty = scope.repoIds.length === 0;
  const base = empty ? emptyBase() : await loadPeriodBase(accountId, scope, from, to);

  const merged = base.mergedPrs.length;
  const sized = base.mergedPrs.filter((p) => p.loc != null);
  const ciKnown = base.mergedPrs.filter((p) => p.ciDeterminate);
  const ciGreen = ciKnown.filter((p) => p.ciSuccess).length;
  const humanReviews = [...base.reviewsByHuman.values()];
  const totalHumanReviews = humanReviews.reduce((n, c) => n + c, 0);
  const busiestReviewer = humanReviews.reduce((m, c) => (c > m ? c : m), 0);

  const leadHours = base.mergedPrs.map((p) => p.leadMs / 3_600_000);
  const reviewHours = base.humanFirstReviewHours;
  const sizes = sized.map((p) => p.loc!);
  // The human-only twins. `human` here is the AUTHOR's lane, so a PR opened by a person and
  // merged by a merge queue is still human work — "who merged it" is never a proxy for "who did
  // the work", which is exactly why `release` is its own lane rather than folded into throughput.
  const humanMerged = base.mergedPrs.filter((p) => p.lane === 'human');
  const humanSizes = humanMerged.filter((p) => p.loc != null).map((p) => p.loc!);
  const automationMerged = merged - humanMerged.length;

  const nullCell: MetricCell = { value: null, sampleSize: 0 };
  const pct = (numerator: number, denominator: number): MetricCell =>
    denominator === 0
      ? nullCell
      : { value: round2((numerator / denominator) * 100), sampleSize: denominator };
  const med = (xs: number[]): MetricCell => {
    const m = median(xs);
    return m == null ? nullCell : { value: round2(m), sampleSize: xs.length };
  };

  // `Record<PeriodMetricKey, …>` — a metric missing from EITHER branch is a COMPILE error, which
  // is the only thing guaranteeing the response always carries all twelve and is why the empty
  // branch is spelled out rather than built by a loop (a loop would need a cast, and the cast is
  // exactly what would let a future 13th metric go missing here in silence).
  //
  // ⚠ THE EMPTY BRANCH NULLS THE **COUNTS** TOO. It is not the same answer as a populated scope
  // that happened to see nothing: "this workspace has no repos" is not "this workspace merged
  // nothing", and a 0 in that slot renders as a real observation.
  const cells: Record<PeriodMetricKey, MetricCell> = empty
    ? {
        merged_prs: nullCell,
        human_merged_prs: nullCell,
        opened_prs: nullCell,
        automation_merge_share_pct: nullCell,
        median_lead_time_hours: nullCell,
        median_time_to_first_human_review_hours: nullCell,
        merge_ci_success_pct: nullCell,
        median_pr_size_lines: nullCell,
        median_human_pr_size_lines: nullCell,
        review_threads_opened: nullCell,
        threads_replied_within_36h_pct: nullCell,
        bot_review_comments: nullCell,
        human_review_comments: nullCell,
        bot_comments_per_merged_pr: nullCell,
        reviewer_concentration_pct: nullCell,
      }
    : {
        merged_prs: countCell(merged),
        human_merged_prs: countCell(humanMerged.length),
        opened_prs: countCell(base.openedPrs),
        // A SHARE OF NOTHING IS NOT ZERO. With no merges the question has no denominator, and a
        // 0% here would read as "all of it was people" — the opposite failure to the one the
        // metric exists to prevent.
        automation_merge_share_pct: pct(automationMerged, merged),
        median_lead_time_hours: med(leadHours),
        median_time_to_first_human_review_hours: med(reviewHours),
        merge_ci_success_pct: pct(ciGreen, ciKnown.length),
        median_pr_size_lines: med(sizes),
        median_human_pr_size_lines: med(humanSizes),
        review_threads_opened: countCell(base.threadsOpened),
        threads_replied_within_36h_pct: pct(base.threadsRepliedWithin, base.threadsOpened),
        bot_review_comments: countCell(base.botComments),
        human_review_comments: countCell(base.humanComments),
        // A ratio, not a count: no merged PRs means the question has no denominator, so it is
        // null rather than the 0 that "the bots said nothing" would also produce.
        bot_comments_per_merged_pr:
          merged === 0
            ? nullCell
            : { value: round2(base.botComments / merged), sampleSize: merged },
        reviewer_concentration_pct: pct(busiestReviewer, totalHumanReviews),
      };

  return {
    // `lowSample` is stamped HERE, beside the floors, and travels on the wire. The alternative —
    // shipping `sampleSize` and letting the SPA compare it against its own copy of the floors —
    // puts the same constants in two repos, and the first time one of them is tuned the marker
    // silently disagrees with the significance rule computed from the other.
    //
    // It answers a DIFFERENT question from `PeriodMetricDelta.significant`: this says the FIGURE
    // is thin, that says the CHANGE is not worth asserting. A metric can easily be one and not the
    // other, and "0h from 2 reviews" needs saying even when nothing moved.
    metrics: PERIOD_METRIC_KEYS.map(
      (key) =>
        ({
          key,
          ...cells[key],
          lowSample: cells[key].sampleSize < PERIOD_METRIC_META[key].sampleFloor,
        }) satisfies PeriodMetricValue,
    ),
    fingerprint: fingerprintOf(scope, window, cells),
  };
}

// ── (2) Coverage ─────────────────────────────────────────────────────────────────────────────

/**
 * Which of `repoIds` were already being TRACKED at `atMs` — i.e. `repos.createdAt <= atMs`.
 *
 * ⚠ THIS IS THE RULE THAT KEEPS THE FORECAST HONEST, and it is not optional. See the header:
 * a naive period-over-period sweep over this dataset shows a merged-PR count climbing from 39 to
 * 570 over six months, which is entirely repo onboarding. A comparison is drawn over the
 * INTERSECTION of two periods' tracked sets so it is like-for-like, and a forecast series uses
 * only periods whose coverage is complete for that subset.
 *
 * `repos.createdAt` is when the repo was added to THIS account, not when it was created on
 * GitHub — the same column My Turn's "New PRs" cutoff rides, and it is load-bearing for the same
 * reason: it is the earliest instant we could possibly know anything about the repo.
 *
 * The bound is INCLUSIVE (`<=`), unlike the metric window's half-open upper edge: a repo added
 * at the exact instant a period starts contributed to the whole of it.
 */
export async function getPeriodCoverage(
  accountId: number,
  repoIds: number[],
  atMs: number,
): Promise<{ trackedRepoIds: number[] }> {
  if (repoIds.length === 0) return { trackedRepoIds: [] };
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.accountId, accountId),
        inArray(repos.id, repoIds),
        // ⚠ A REAL `lte`, never `lt(…, atMs + 1)`. SQLite stores `mode: 'timestamp'` as epoch
        // SECONDS, so a one-millisecond nudge lands in the SAME stored value and would silently
        // flip the boundary from inclusive to exclusive — in one dialect only.
        lte(repos.createdAt, new Date(atMs)),
      ),
    )
    .execute();
  // Ascending so a stored `repo_ids_json` and a recomputed one compare byte-for-byte.
  return { trackedRepoIds: rows.map((r) => r.id).sort((a, b) => a - b) };
}

// ── (3) The lane breakdown — effort vs automation ────────────────────────────────────────────
//
// ADDITIVE, and deliberately NOT part of the twelve-key vector. The vector is the comparable
// artifact: adding keys to it invalidates every stored period against the new ones, and the whole
// point of `PERIOD_METRICS_SCHEMA_VERSION` is that we only pay that price when a definition was
// actually wrong. "How much of this was a person" is a NEW question, so it gets its own block and
// costs the existing periods nothing.
//
// ⚠ THE COMMENT CHANNEL IS ALL THREE SURFACES HERE, and that is the correction that motivated
// this work. The vector's comment metrics count INLINE review comments only, so on the measured
// workspace they reported zero bot activity while SonarQube had posted 786 PR comments — the
// single loudest automated actor, invisible, because quality gates post issue comments rather
// than inline ones. A lane breakdown that inherited that blind spot would be worse than useless:
// it would put a confident 0% next to a workspace saturated with automation.
//
//   review comments  — inline, on a diff line
//   PR comments      — the issue-comment timeline, where every quality gate posts
//   review bodies    — the text attached to an approve / request-changes / comment review
//
// Approvals are counted separately from comments because they are a different act: on the same
// workspace `github-actions` submitted 384 automated approvals, which is a governance fact and
// not a review-volume one.

export interface PeriodLaneStats {
  lane: ActorLane;
  /** PRs merged in the window, authored by this lane. */
  mergedPrs: number;
  /** PRs opened in the window, authored by this lane. */
  openedPrs: number;
  /** Median (additions + deletions) over this lane's merged PRs; null when none are SIZED —
   *  lean storage leaves the size columns at 0, and a fabricated 0 drags a median down. */
  medianPrSizeLines: number | null;
  /** Median hours open → merge over this lane's merged PRs. */
  medianLeadTimeHours: number | null;
  /** Comments across ALL THREE channels (see the header). */
  comments: number;
  /** Submitted reviews in state `approved`. */
  approvals: number;
}

export interface PeriodLanesResult {
  lanes: PeriodLaneStats[];
  /** Share of merged PRs authored by automation, 0–100; null when nothing merged. THE headline:
   *  one number that reframes every throughput figure above it. */
  automationMergeSharePct: number | null;
  /**
   * Median hours from a PR opening to its first review BY A PERSON, over PRs whose first human
   * review landed in the window.
   *
   * ⚠ THIS IS THE MOST DISTORTED FIGURE ON THE WHOLE REPORT and the reason it is computed
   * separately. The vector's `median_time_to_first_review_hours` attributes to whoever reviewed
   * FIRST — and on the measured workspace `github-actions[bot]` auto-approved 61 of 115 PRs at an
   * average of ZERO minutes, so the reported median was `0h`. A team lead reading that concludes
   * review latency is instant. The human medians behind it were ~21h and ~34h.
   *
   * It is a lane figure rather than a vector metric on purpose: the vector is frozen and
   * comparable across stored periods, and this is a new question rather than a correction to an
   * old one. Null when no human reviewed anything in the window.
   */
  medianTimeToFirstHumanReviewHours: number | null;
  /** Actors classified into an automation lane that produced NOTHING in the window. A configured
   *  AI reviewer sitting at zero is a finding — on the measured workspace Copilot's reviewer was
   *  installed and had posted nothing in 90 days — and it is invisible in any aggregate. */
  silentAutomation: { userId: number; lane: ActorLane }[];
}

export async function getPeriodLanes(
  accountId: number,
  scope: BotScope,
  window: PeriodWindow,
): Promise<PeriodLanesResult> {
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);
  const empty = (): PeriodLanesResult => ({
    lanes: ACTOR_LANE_ORDER.map((lane) => ({
      lane,
      mergedPrs: 0,
      openedPrs: 0,
      medianPrSizeLines: null,
      medianLeadTimeHours: null,
      comments: 0,
      approvals: 0,
    })),
    automationMergeSharePct: null,
    medianTimeToFirstHumanReviewHours: null,
    silentAutomation: [],
  });
  if (scope.repoIds.length === 0) return empty();

  const lanes = await resolveActorLanes(accountId, scope);
  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );

  // ⚠ THE FIRST-HUMAN-REVIEW FIGURE COMES FROM THE SHARED FOLD, not from a per-review query here.
  //
  // It used to have its own, over reviews INSIDE the window only — which meant a PR a person had
  // reviewed in a previous period counted as freshly reviewed. On the live database that reported
  // 18.27h in this panel against the vector's 18.16h, one directly above the other, with a caption
  // claiming they were the same measurement. They are the same measurement now because they are
  // the same code.
  const [merged, opened, inlineRows, issueRows, reviewRows, humanFirstReviewHours] =
    await Promise.all([
    db
      .select({
        authorId: pullRequests.authorId,
        openedAt: pullRequests.openedAt,
        mergedAt: pullRequests.mergedAt,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
        changedFiles: pullRequests.changedFiles,
      })
      .from(pullRequests)
      .where(and(inScope, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
      .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
      .limit(PERIOD_PR_SCAN_CAP)
      .execute(),
    db
      .select({ authorId: pullRequests.authorId, c: count() })
      .from(pullRequests)
      .where(and(inScope, gte(pullRequests.openedAt, from), lt(pullRequests.openedAt, to)))
      .groupBy(pullRequests.authorId)
      .execute(),
    db
      .select({ authorId: reviewComments.authorId, c: count() })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(and(inScope, gte(reviewComments.createdAt, from), lt(reviewComments.createdAt, to)))
      .groupBy(reviewComments.authorId)
      .execute(),
    db
      .select({ authorId: prComments.authorId, c: count() })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(inScope, gte(prComments.createdAt, from), lt(prComments.createdAt, to)))
      .groupBy(prComments.authorId)
      .execute(),
    // Bodies and approvals in ONE pass, split by state on the fold. `pending` is a draft nobody
    // can see — the same exclusion every other review reader applies.
    db
      .select({ authorId: reviews.authorId, state: reviews.state, body: reviews.body, c: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          inScope,
          gte(reviews.submittedAt, from),
          lt(reviews.submittedAt, to),
          ne(reviews.state, 'pending'),
        ),
      )
      .groupBy(reviews.authorId, reviews.state, reviews.body)
      .execute(),
    loadFirstHumanReviewHours(accountId, scope, from, to, lanes),
  ]);

  const blank = () => ({ mergedPrs: 0, openedPrs: 0, sizes: [] as number[], leads: [] as number[], comments: 0, approvals: 0 });
  const acc = new Map<ActorLane, ReturnType<typeof blank>>(
    ACTOR_LANE_ORDER.map((l) => [l, blank()]),
  );
  const bump = (lane: ActorLane) => acc.get(lane) ?? acc.set(lane, blank()).get(lane)!;
  const active = new Set<number>();

  for (const r of merged) {
    const lane = lanes.laneOf(r.authorId);
    const a = bump(lane);
    a.mergedPrs += 1;
    if (r.authorId != null) active.add(r.authorId);
    // The SIZED rule, identical to the vector's: an unhydrated PR is indistinguishable from an
    // empty one, so it contributes a lead time but not a size.
    if ((r.changedFiles ?? 0) > 0 || (r.additions ?? 0) > 0 || (r.deletions ?? 0) > 0) {
      a.sizes.push((r.additions ?? 0) + (r.deletions ?? 0));
    }
    if (r.mergedAt != null && r.openedAt != null) {
      a.leads.push((r.mergedAt.getTime() - r.openedAt.getTime()) / 3_600_000);
    }
  }
  for (const r of opened) {
    bump(lanes.laneOf(r.authorId)).openedPrs += r.c;
    if (r.authorId != null && r.c > 0) active.add(r.authorId);
  }
  for (const rows of [inlineRows, issueRows]) {
    for (const r of rows) {
      bump(lanes.laneOf(r.authorId)).comments += r.c;
      if (r.authorId != null && r.c > 0) active.add(r.authorId);
    }
  }
  for (const r of reviewRows) {
    const a = bump(lanes.laneOf(r.authorId));
    if (r.state === 'approved') a.approvals += r.c;
    // A review BODY is a comment; an empty-bodied approval is not.
    if (r.body != null && r.body.trim().length > 0) a.comments += r.c;
    if (r.authorId != null && r.c > 0) active.add(r.authorId);
  }

  const out: PeriodLaneStats[] = ACTOR_LANE_ORDER.map((lane) => {
    const a = acc.get(lane) ?? blank();
    return {
      lane,
      mergedPrs: a.mergedPrs,
      openedPrs: a.openedPrs,
      medianPrSizeLines: median(a.sizes),
      medianLeadTimeHours: median(a.leads),
      comments: a.comments,
      approvals: a.approvals,
    };
  });

  const totalMerged = out.reduce((n, l) => n + l.mergedPrs, 0);
  const automatedMerged = out
    .filter((l) => l.lane !== 'human')
    .reduce((n, l) => n + l.mergedPrs, 0);

  return {
    lanes: out,
    automationMergeSharePct: totalMerged === 0 ? null : round2((automatedMerged / totalMerged) * 100),
    medianTimeToFirstHumanReviewHours: median(humanFirstReviewHours),
    silentAutomation: [...lanes.lane.entries()]
      .filter(([userId]) => !active.has(userId))
      .map(([userId, lane]) => ({ userId, lane })),
  };
}

// ── (4) The per-workspace axis (apiVersion 21 — the Reports "By workspace" axis) ─────────────
//
// One period vector PER WORKSPACE the account owns, over ONE shared window — pure composition
// over two reads that already exist (`listWorkspaces` + `getPeriodMetrics`), the
// db/workspace-comparison.ts shape. WINDOW-PURE by construction: every predicate is
// getPeriodMetrics' own two-sided `[fromMs, toMs)` pair, so a historical period stays
// reproducible per workspace exactly as it does for the headline.
//
// ⚠ NO COST FIELDS TRAVEL HERE, AND NONE MAY BE ADDED. `monthly_cents` is a per-workspace fact:
// six workspaces each listing a $120 CodeRabbit is either six subscriptions or one seen six
// ways, and the app must not assert which — the same rule the comparison matrix carries. This
// row shape has no money in it on purpose.
//
// Isolation is by construction (the shape the deleted getWorkspaceComparisonRows had, checked in
// verify-isolation.ts): the only input is `listWorkspaces(accountId)` (whose `repoIds` come from
// workspace_repos filtered by accountId), and getPeriodMetrics additionally filters
// `pullRequests.accountId`. There is no
// workspace-id parameter, so no 404 oracle and nothing to leak. The per-workspace scope is the
// workspace's FULL membership — trivially `⊆ membership`, the resolveWorkspaceScope guarantee.

export interface WorkspacePeriodMetricsRow {
  workspaceId: number;
  name: string;
  isDefault: boolean;
  /** Repos tracked at the window's start vs the workspace's membership now — the same
   *  coverage-honesty disclosure the headline report carries, per workspace. A workspace whose
   *  repos onboarded mid-window must be ANNOTATED, never silently under-counted. (`totalRepos`
   *  is a now-fact, exactly like PeriodReport.coverage — disclosure, not part of the vector.) */
  coverage: { trackedRepos: number; totalRepos: number; complete: boolean };
  /** The full 15-key vector in PERIOD_METRIC_KEYS order — an empty workspace yields the
   *  all-null vector (not an error, not a row omission: the axis must still name it). */
  metrics: PeriodMetricValue[];
}

/**
 * COST: N × `getPeriodMetrics`, one per workspace — the same multiplication that put the
 * comparison route on the `search` rate tier. The consuming route's tier must account for it.
 * Rows come back in `listWorkspaces` order (Default first, then by name) so the axis columns
 * are stable across reloads.
 */
export async function getPeriodMetricsForWorkspaces(
  accountId: number,
  window: PeriodWindow,
): Promise<WorkspacePeriodMetricsRow[]> {
  const all = await listWorkspaces(accountId);
  if (all.length === 0) return [];
  return Promise.all(
    all.map(async (w) => {
      const [{ metrics }, { trackedRepoIds }] = await Promise.all([
        getPeriodMetrics(accountId, { workspaceId: w.id, repoIds: w.repoIds }, window),
        // Coverage at the WINDOW's start — the same inclusive bound the headline coverage uses.
        getPeriodCoverage(accountId, w.repoIds, window.fromMs),
      ]);
      return {
        workspaceId: w.id,
        name: w.name,
        isDefault: w.isDefault,
        coverage: {
          trackedRepos: trackedRepoIds.length,
          totalRepos: w.repoIds.length,
          complete: trackedRepoIds.length === w.repoIds.length,
        },
        metrics,
      };
    }),
  );
}
