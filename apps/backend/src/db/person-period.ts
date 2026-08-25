// ── The 1:1-PREP PERSON VECTOR (CORE, deterministic — plan P4.2 / N4) ────────────────────────
//
// A small fixed vector describing ONE PERSON's period in ONE workspace: what an EM walks into a
// 1:1 already knowing. The storage-free sibling of db/period-metrics.ts — computed on read, no
// table, no migration (plan D5) — and it copies that file's discipline wholesale:
//
// ⚠ EVERY WINDOWED METRIC IS **WINDOW-PURE** with a TWO-SIDED `>= from AND < to` predicate. The
// three live-state keys (`their_pr_threads_addressed` / `awaiting_their_review` /
// `open_prs_authored`) are the deliberate exception and are MARKED so on the wire
// (`basis: 'live'`): "has the feedback on their PRs been addressed" and "what is waiting on them"
// are now-questions, and pretending a current thread state or an outstanding request set is
// reproducible for last March would be a lie with a timestamp on it. A consumer re-asking about a
// past period must expect those three to have moved.
//
// ⚠ PREP, NOT SCORING (the plan's non-negotiable): this fold takes ONE userId and returns ONE
// person. There is deliberately no batch variant, no ranking input and no cross-person shape —
// a leaderboard cannot be built out of this function without writing the loop that this comment
// tells you not to write.
//
// ⚠ `users` IS A GLOBAL TABLE (the listUsers precedent). The subject is admitted only after an
// activity/membership probe INSIDE the workspace scope — a userId with no observed footprint in
// this workspace's repos returns null (which also covers every foreign/unknown id, so the route
// above this is not an existence oracle) — and the only identity fields that ever leave are the
// login and display name.
//
// ⚠ HUMANS RESOLVE THROUGH THE ONE LANE RESOLVER (db/actor-lanes.ts), never a login heuristic:
// an actor the resolver puts in any automation lane returns null — a 1:1 with Dependabot is not
// a meeting, and rendering one would put the bot-blend defect this repo just fixed back on the
// screen at the person grain.
//
// ⚠ THE FIRST-HUMAN-REVIEW FIGURE REUSES `loadFirstHumanReviewHours` (the ONE-fold rule).
// `median_first_human_review_hours_their_prs` is the SAME measurement as the period vector's
// `median_time_to_first_human_review_hours` — open → first review BY A PERSON, attributed on the
// review event, all-time lookback so a previously-reviewed PR is never counted fresh — narrowed
// to PRs THIS person authored via the fold's own `authorUserId` parameter. Two folds of that
// number once shipped 18.16h and 18.27h on one screen; this file does not write a third.
// (`median_review_response_hours` is a DIFFERENT question — request → THEIR review — with its own
// fold below, anchored on `pull_requests.first_review_requested_at`, and its meta note says so.)
import { and, count, desc, eq, gte, inArray, lt, min, ne } from 'drizzle-orm';
import type {
  PersonMetricBasis,
  PersonMetricKey,
  PersonMetricValue,
  PersonPeriod,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import {
  getPeriodCoverage,
  loadFirstHumanReviewHours,
  median,
  round2,
  type PeriodWindow,
} from './period-metrics.js';
import { resolveWorkspaceScope, type BotScope } from './queries.js';

const { pullRequests, reviewComments, reviewRequests, reviewThreads, reviews, users } = schema;

// MIRRORED from @pierre-review/shared (PERSON_METRICS_SCHEMA_VERSION / PERSON_METRIC_KEYS) —
// inlined for the same reason the period keys are (shared is types-only and not shipped; a real
// runtime import fails the release build). `person-period.test.ts` imports the shared originals
// and asserts the two spellings are identical, so drift fails CI rather than a reader.
export const PERSON_METRICS_SCHEMA_VERSION = 1;

export const PERSON_METRIC_KEYS: PersonMetricKey[] = [
  'merged_prs_authored',
  'opened_prs_authored',
  'reviews_given',
  'review_comments_written',
  'median_review_response_hours',
  'median_first_human_review_hours_their_prs',
  'review_threads_on_their_prs',
  'their_pr_threads_addressed',
  'awaiting_their_review',
  'open_prs_authored',
];

export interface PersonMetricMeta {
  basis: PersonMetricBasis;
  /** Minimum items behind the statistic before the figure is shown without a thin-sample flag.
   *  Counts floor at 0 — a count IS its own sample and a 0 is a real, sturdy observation
   *  (`lowSample` on it would read as doubt about a zero we are sure of); medians floor at 3
   *  (the period vector's smallest floors, at the person grain). */
  sampleFloor: number;
  /** Rendered beside the label by consumers that want it; kept HERE so the definition and its
   *  caveat cannot drift apart. */
  note: string;
}

// `Record<PersonMetricKey, …>` on purpose: adding a key to the union without a row here is a
// COMPILE error — the only mechanism that keeps a schema-version bump honest.
export const PERSON_METRIC_META: Record<PersonMetricKey, PersonMetricMeta> = {
  merged_prs_authored: {
    basis: 'window',
    sampleFloor: 0,
    note: 'PRs they authored, merged in the period',
  },
  opened_prs_authored: {
    basis: 'window',
    sampleFloor: 0,
    note: 'PRs they opened in the period',
  },
  reviews_given: {
    basis: 'window',
    sampleFloor: 0,
    note: 'reviews they submitted in the period (drafts excluded)',
  },
  review_comments_written: {
    basis: 'window',
    sampleFloor: 0,
    note: 'inline review comments they wrote in the period',
  },
  median_review_response_hours: {
    basis: 'window',
    sampleFloor: 3,
    note: 'first review request on a PR → their first review of it, over PRs they first reviewed in the period (only PRs with a recorded request)',
  },
  median_first_human_review_hours_their_prs: {
    basis: 'window',
    sampleFloor: 3,
    note: 'how long THEIR PRs waited for a first review by a person — same fold as the period report, narrowed to their PRs',
  },
  review_threads_on_their_prs: {
    basis: 'window',
    sampleFloor: 0,
    note: 'review threads opened on their PRs in the period',
  },
  their_pr_threads_addressed: {
    basis: 'live',
    sampleFloor: 0,
    note: 'of those threads, resolved or likely addressed AS OF NOW — the population is windowed, the state is today’s',
  },
  awaiting_their_review: {
    basis: 'live',
    sampleFloor: 0,
    note: 'open PRs with an outstanding review request naming them, right now',
  },
  open_prs_authored: {
    basis: 'live',
    sampleFloor: 0,
    note: 'PRs they authored that are open right now (drafts included)',
  },
};

// One person's PRs in one sprint — far past anything real, and BIND-PARAMETER SAFE (the ids
// travel in an `IN (…)`; the PERIOD_FIRST_REVIEW_PR_CAP reasoning at a smaller grain).
const PERSON_PR_CAP = 2_000;

type Cell = { value: number | null; sampleSize: number };

const nullCell: Cell = { value: null, sampleSize: 0 };
/** A count is a real observation: 0 is `0`, never "no data" (the period-vector rule). */
const countCell = (n: number): Cell => ({ value: n, sampleSize: n });
const medCell = (xs: number[]): Cell => {
  const m = median(xs);
  return m == null ? nullCell : { value: round2(m), sampleSize: xs.length };
};

// ── request → THEIR review (the response-time fold) ──────────────────────────────────────────
//
// Window anchoring copies `loadFirstHumanReviewHours`'s shape deliberately: the population is
// "PRs whose FIRST review by this person landed in the window", which needs an all-time lookback
// of their reviews on the candidate PRs — a PR they reviewed in January and revisited today must
// not report a months-old pickup as fresh latency.
//
// The clock STARTS at `pull_requests.first_review_requested_at` — the PR's earliest
// ReviewRequestedEvent, the only request timestamp the sync stores (`review_requests` rows are
// presence-only: GitHub removes a request once the reviewer submits). Two consequences, both
// stated in the metric's meta note rather than papered over: a PR with no recorded request
// contributes NOTHING (open-anchoring it would silently blend two different clocks), and the
// first request may have named someone else — this is "how fast they respond once a PR is out
// for review", not proof they personally were asked first.
async function loadReviewResponseHours(
  accountId: number,
  scope: BotScope,
  userId: number,
  from: Date,
  to: Date,
): Promise<number[]> {
  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );
  // (1) Candidate PRs: ones THIS person reviewed in the window (non-pending). Newest-first so
  // the cap keeps the recent slice.
  const candidateRows = await db
    .select({ prId: reviews.prId })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        inScope,
        eq(reviews.authorId, userId),
        gte(reviews.submittedAt, from),
        lt(reviews.submittedAt, to),
        ne(reviews.state, 'pending'),
      ),
    )
    .orderBy(desc(reviews.submittedAt), desc(reviews.id))
    .limit(PERSON_PR_CAP * 4)
    .execute();
  const candidateIds: number[] = [];
  const seen = new Set<number>();
  for (const r of candidateRows) {
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    candidateIds.push(r.prId);
    if (candidateIds.length >= PERSON_PR_CAP) break;
  }
  if (candidateIds.length === 0) return [];

  // (2) THEIR earliest review per candidate PR, across ALL TIME (see the header). ASCENDING so
  // the earliest survives; the cap is generous (one person, ≤2k PRs).
  const rows = await db
    .select({
      prId: reviews.prId,
      submittedAt: reviews.submittedAt,
      requestedAt: pullRequests.firstReviewRequestedAt,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        inArray(reviews.prId, candidateIds),
        eq(reviews.authorId, userId),
        ne(reviews.state, 'pending'),
      ),
    )
    .orderBy(reviews.submittedAt, reviews.id)
    .limit(PERSON_PR_CAP * 8)
    .execute();

  const firstByPr = new Map<number, { at: number; requestedAt: number | null }>();
  for (const r of rows) {
    if (firstByPr.has(r.prId)) continue;
    firstByPr.set(r.prId, {
      at: r.submittedAt.getTime(),
      requestedAt: r.requestedAt?.getTime() ?? null,
    });
  }
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const out: number[] = [];
  for (const { at, requestedAt } of firstByPr.values()) {
    if (at < fromMs || at >= toMs) continue; // their first review fell in some OTHER period
    if (requestedAt == null) continue; // no recorded request ⇒ no clock to start
    const hours = (at - requestedAt) / 3_600_000;
    // A review before the request is not a negative response time — they reviewed unprompted
    // (or clock skew); either way the request→review question does not apply to that PR.
    if (hours >= 0) out.push(hours);
  }
  return out;
}

/**
 * The 1:1-prep vector for one person in one workspace, or null when there is no person to
 * report: an id this workspace has never seen act, or an actor the lane resolver classifies as
 * automation. `workspaceId` resolves through `resolveWorkspaceScope` (a foreign/unknown id
 * degrades to the account's Default — the house rule, no oracle), and every read below is
 * scoped `accountId` + the resolved membership.
 */
export async function getPersonPeriod(
  accountId: number,
  workspaceId: number,
  userId: number,
  window: PeriodWindow,
): Promise<PersonPeriod | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const scope = await resolveWorkspaceScope(accountId, workspaceId, null);
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);

  // The lane check ALSO drives the reused first-review fold, so resolve once.
  const lanes = await resolveActorLanes(accountId, scope);
  if (lanes.laneOf(userId) !== 'human') return null;

  // An empty workspace can admit nobody (and the membership probe below would read the whole
  // account without this guard — `inArray(…, [])` is false, but be explicit about the state).
  if (scope.repoIds.length === 0) return null;

  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );

  // ── The admission probe + first-seen read, in one pass ─────────────────────────────────────
  // Earliest observed activity per channel, ALL TIME, inside the scope. A user with no activity
  // anywhere is not admitted (global-table rule) — with ONE exception: an outstanding review
  // request names them as a participant someone chose, so a purely-awaited person still renders
  // (their vector is zeros/nulls + a live waiting count, which is exactly the 1:1 fact).
  const [authoredMin, reviewMin, commentMin, awaitingRow] = await Promise.all([
    db
      .select({ m: min(pullRequests.openedAt) })
      .from(pullRequests)
      .where(and(inScope, eq(pullRequests.authorId, userId)))
      .execute(),
    db
      .select({ m: min(reviews.submittedAt) })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(inScope, eq(reviews.authorId, userId), ne(reviews.state, 'pending')))
      .execute(),
    db
      .select({ m: min(reviewComments.createdAt) })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(and(inScope, eq(reviewComments.authorId, userId)))
      .execute(),
    db
      .select({ c: count() })
      .from(reviewRequests)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewRequests.prId))
      .where(and(inScope, eq(reviewRequests.userId, userId), eq(pullRequests.state, 'open')))
      .execute(),
  ]);
  // `min()` comes back as a raw driver value (epoch integer on sqlite, Date on pg — the
  // drizzle `mode:'timestamp'` mapping applies to selected COLUMNS, not aggregates), so
  // normalise by hand.
  const toMs2 = (v: unknown): number | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.getTime();
    const n = Number(v);
    return Number.isFinite(n) ? (n < 10_000_000_000 ? n * 1000 : n) : null;
  };
  const firstSeenMs = [toMs2(authoredMin[0]?.m), toMs2(reviewMin[0]?.m), toMs2(commentMin[0]?.m)]
    .filter((v): v is number => v != null)
    .reduce<number | null>((a, b) => (a == null || b < a ? b : a), null);
  const awaitingNow = awaitingRow[0]?.c ?? 0;
  if (firstSeenMs == null && awaitingNow === 0) return null;

  // Identity — login + display name ONLY (the global-table rule; no avatar, no profile fields).
  const userRow = (
    await db
      .select({ login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .execute()
  )[0];
  if (!userRow) return null;

  // ── The windowed scans ─────────────────────────────────────────────────────────────────────
  const [
    mergedRow,
    openedRow,
    reviewsRow,
    commentsRow,
    responseHours,
    theirPrWaitHours,
    threadRows,
    openNowRow,
    coverage,
  ] = await Promise.all([
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(
        and(
          inScope,
          eq(pullRequests.authorId, userId),
          gte(pullRequests.mergedAt, from),
          lt(pullRequests.mergedAt, to),
        ),
      )
      .execute(),
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(
        and(
          inScope,
          eq(pullRequests.authorId, userId),
          gte(pullRequests.openedAt, from),
          lt(pullRequests.openedAt, to),
        ),
      )
      .execute(),
    db
      .select({ c: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          inScope,
          eq(reviews.authorId, userId),
          gte(reviews.submittedAt, from),
          lt(reviews.submittedAt, to),
          ne(reviews.state, 'pending'),
        ),
      )
      .execute(),
    db
      .select({ c: count() })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          inScope,
          eq(reviewComments.authorId, userId),
          gte(reviewComments.createdAt, from),
          lt(reviewComments.createdAt, to),
        ),
      )
      .execute(),
    loadReviewResponseHours(accountId, scope, userId, from, to),
    // THE ONE-FOLD REUSE: the period vector's first-human-review measurement, narrowed to PRs
    // this person authored. See the header — never re-implement this scan.
    loadFirstHumanReviewHours(accountId, scope, from, to, lanes, userId),
    // Threads whose ROOT lands in the window, on PRs they authored. `derivedState` is read for
    // the LIVE addressed split (the state is today's; the population is the window's).
    db
      .select({ state: reviewThreads.derivedState })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          inScope,
          eq(pullRequests.authorId, userId),
          gte(reviewThreads.createdAt, from),
          lt(reviewThreads.createdAt, to),
        ),
      )
      .execute(),
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(and(inScope, eq(pullRequests.authorId, userId), eq(pullRequests.state, 'open')))
      .execute(),
    getPeriodCoverage(accountId, scope.repoIds, window.fromMs),
  ]);

  const threadsOpened = threadRows.length;
  const threadsAddressed = threadRows.filter(
    (t) => t.state === 'resolved' || t.state === 'likely_addressed',
  ).length;

  const cells: Record<PersonMetricKey, Cell> = {
    merged_prs_authored: countCell(mergedRow[0]?.c ?? 0),
    opened_prs_authored: countCell(openedRow[0]?.c ?? 0),
    reviews_given: countCell(reviewsRow[0]?.c ?? 0),
    review_comments_written: countCell(commentsRow[0]?.c ?? 0),
    median_review_response_hours: medCell(responseHours),
    median_first_human_review_hours_their_prs: medCell(theirPrWaitHours),
    review_threads_on_their_prs: countCell(threadsOpened),
    // A share of nothing is not zero — no threads means the addressed question has no
    // population, and 0 would read as "nothing was addressed".
    their_pr_threads_addressed:
      threadsOpened === 0 ? nullCell : { value: threadsAddressed, sampleSize: threadsOpened },
    awaiting_their_review: countCell(awaitingNow),
    open_prs_authored: countCell(openNowRow[0]?.c ?? 0),
  };

  return {
    userId,
    login: userRow.login,
    name: userRow.name,
    metrics: PERSON_METRIC_KEYS.map(
      (key): PersonMetricValue => ({
        key,
        ...cells[key],
        basis: PERSON_METRIC_META[key].basis,
        lowSample: cells[key].sampleSize < PERSON_METRIC_META[key].sampleFloor,
      }),
    ),
    coverage: {
      trackedRepos: coverage.trackedRepoIds.length,
      totalRepos: scope.repoIds.length,
      complete: coverage.trackedRepoIds.length === scope.repoIds.length,
    },
    firstSeenAt: firstSeenMs == null ? null : new Date(firstSeenMs).toISOString(),
    // Strictly AFTER the window opened — covers both the mid-window joiner and the
    // joined-after-this-period case; either way the window under-saw them and must say so.
    firstObservedMidWindow: firstSeenMs != null && firstSeenMs > window.fromMs,
    metricsSchemaVersion: PERSON_METRICS_SCHEMA_VERSION,
  };
}
