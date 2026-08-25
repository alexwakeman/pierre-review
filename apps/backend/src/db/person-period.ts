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
// ⚠ PREP, NOT SCORING (the plan's non-negotiable, restated for the multi-person report):
// this fold takes ONE userId and returns ONE person, and that shape is deliberate and
// permanent — the People report renders several sections by LOOPING this fold one person
// at a time (client-side, one request each), which is sanctioned. What remains forbidden
// is any cross-person SHAPE: no batch variant, no ranking input, no comparison rows —
// report sections are alphabetical, and a leaderboard still cannot be built out of this
// function without writing the aggregation this comment tells you not to write.
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
  BotVendorComment,
  DigestPrRef,
  MlLabel,
  PersonEvidenceThreadRef,
  PersonMetricBasis,
  PersonMetricKey,
  PersonMetricValue,
  PersonPathArea,
  PersonPeriod,
  PersonPeriodEvidence,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import { toWireLabel } from './ml-labels.js';
import {
  getPeriodCoverage,
  loadFirstHumanReviewHours,
  median,
  round2,
  type PeriodWindow,
  type ReviewSampleRef,
} from './period-metrics.js';
import { resolveWorkspaceScope, type BotScope } from './queries.js';

const {
  commitFiles,
  commits,
  mlCommentLabels,
  prComments,
  pullRequests,
  repos,
  reviewComments,
  reviewRequests,
  reviewThreads,
  reviews,
  users,
} = schema;

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

// MIRRORED from @pierre-review/shared (PERSON_EVIDENCE_CAP) for the same types-only reason as
// the key list above; person-period.test.ts asserts the two spellings agree.
export const PERSON_EVIDENCE_CAP = 8;

/** Excerpt budget for thread-root evidence rows (whitespace-collapsed first). */
const PERSON_EXCERPT_CAP = 200;

function collapseExcerpt(raw: string | null | undefined): string {
  if (!raw) return '';
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > PERSON_EXCERPT_CAP ? `${s.slice(0, PERSON_EXCERPT_CAP).trimEnd()}…` : s;
}

/** First two path segments, `apps/backend/**` style — deeper paths glob, a ≤2-segment path IS
 *  its own bucket (a root README should not pretend to be a directory). */
function pathBucket(path: string): string {
  const segs = path.split('/').filter((s) => s.length > 0);
  const head = segs.slice(0, 2).join('/');
  if (head === '') return path;
  return segs.length > 2 ? `${head}/**` : head;
}

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
  // Evidence sink (the People report): when given, receives {prId, atMs} for EXACTLY the PRs
  // whose hours entered the median — the sample population, never a second predicate.
  samplesOut?: ReviewSampleRef[],
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
  for (const [prId, { at, requestedAt }] of firstByPr) {
    if (at < fromMs || at >= toMs) continue; // their first review fell in some OTHER period
    if (requestedAt == null) continue; // no recorded request ⇒ no clock to start
    const hours = (at - requestedAt) / 3_600_000;
    // A review before the request is not a negative response time — they reviewed unprompted
    // (or clock skew); either way the request→review question does not apply to that PR.
    if (hours >= 0) {
      out.push(hours);
      samplesOut?.push({ prId, atMs: at });
    }
  }
  return out;
}

/**
 * The 1:1-prep vector for one person in one workspace, or null when there is no person to
 * report: an id this workspace has never seen act, or an actor the lane resolver classifies as
 * automation. `workspaceId` resolves through `resolveWorkspaceScope` (a foreign/unknown id
 * degrades to the account's Default — the house rule, no oracle), and every read below is
 * scoped `accountId` + the resolved membership.
 *
 * `opts.evidence` (ADDITIVE — the People report) widens the fold's windowed scans from
 * `count()` to capped row selects over the SAME predicates (one extra `ORDER BY … LIMIT`
 * variant per metric; the medians hand back their sample PRs via the folds' own sinks) and
 * sets `person.evidence`. It NEVER changes a metric cell, and every guardrail above — scope
 * resolve, lane admission, membership probe, the global-`users` identity rule — runs exactly
 * once for both halves, which is why this is an option on the one fold and not a sibling.
 */
export async function getPersonPeriod(
  accountId: number,
  workspaceId: number,
  userId: number,
  window: PeriodWindow,
  opts?: { evidence?: boolean },
): Promise<PersonPeriod | null> {
  if (!Number.isInteger(userId) || userId <= 0) return null;
  const wantEvidence = opts?.evidence === true;
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
  // Evidence sinks: allocated only when asked, filled by the two median folds with EXACTLY the
  // sample population each median was computed over (never a second predicate).
  const responseSamples: ReviewSampleRef[] | undefined = wantEvidence ? [] : undefined;
  const waitSamples: ReviewSampleRef[] | undefined = wantEvidence ? [] : undefined;
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
    loadReviewResponseHours(accountId, scope, userId, from, to, responseSamples),
    // THE ONE-FOLD REUSE: the period vector's first-human-review measurement, narrowed to PRs
    // this person authored. See the header — never re-implement this scan.
    loadFirstHumanReviewHours(accountId, scope, from, to, lanes, userId, waitSamples),
    // Threads whose ROOT lands in the window, on PRs they authored. `derivedState` is read for
    // the LIVE addressed split (the state is today's; the population is the window's). The id /
    // prId / path / createdAt columns ride the SAME rows for the evidence list — one query is
    // what guarantees the cards and the cell describe one population.
    db
      .select({
        id: reviewThreads.id,
        prId: reviewThreads.prId,
        state: reviewThreads.derivedState,
        path: reviewThreads.path,
        createdAt: reviewThreads.createdAt,
      })
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

  // ── Evidence (opt-in; the receipt rows under the vector — never a cell change) ─────────────
  const evidence = wantEvidence
    ? await loadPersonEvidence({
        accountId,
        scope,
        userId,
        from,
        to,
        counts: {
          merged: mergedRow[0]?.c ?? 0,
          opened: openedRow[0]?.c ?? 0,
          comments: commentsRow[0]?.c ?? 0,
          awaiting: awaitingNow,
          openNow: openNowRow[0]?.c ?? 0,
        },
        responseSamples: responseSamples ?? [],
        waitSamples: waitSamples ?? [],
        threadRows,
      })
    : undefined;

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
    ...(evidence ? { evidence } : {}),
  };
}

// ── The evidence fold (the People report's receipt rows) ─────────────────────────────────────
//
// Per PR-backed metric a capped DigestPrRef list (newest-first, the undisplayed remainder in
// `more`); the subject's own windowed comments (inline review comments + issue-level PR
// comments) as BotVendorComment rows with bodies + any stored ML label INLINE; the thread roots
// on their PRs as ONE list (the addressed split is a state chip on the same rows, never a second
// population); and the top directory areas of their windowed authored commits. Window-pure
// exactly where the metric is — the live metrics' evidence is live and inherits their `now`
// labelling.
//
// ⚠ ONE PREDICATE PER GROUP: each select repeats its counting query's WHERE verbatim (or reads
// the very rows/samples the cell was folded from — the medians' sinks, the threads' own rows),
// plus an `ORDER BY … LIMIT`. `commitFiles` is GLOBAL and is joined only through the
// tenant-scoped commit shas (the queries.ts addressing-commit precedent); author logins resolve
// only for authors of PRs this account owns (the pr-refs precedent — login, nothing else).

interface PersonEvidenceArgs {
  accountId: number;
  scope: BotScope;
  userId: number;
  from: Date;
  to: Date;
  /** The already-computed cell counts — `more` is total − shown, never a recount. */
  counts: { merged: number; opened: number; comments: number; awaiting: number; openNow: number };
  responseSamples: ReviewSampleRef[];
  waitSamples: ReviewSampleRef[];
  /** The thread cell's OWN rows (one query serves cell + cards). */
  threadRows: {
    id: number;
    prId: number;
    state: 'resolved' | 'likely_addressed' | 'replied_unresolved' | 'untouched';
    path: string;
    createdAt: Date;
  }[];
}

async function loadPersonEvidence(a: PersonEvidenceArgs): Promise<PersonPeriodEvidence> {
  const { accountId, scope, userId, from, to } = a;
  // The main fold's scope predicate, spelled identically (same account + membership pair).
  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );

  // (1) Per-metric row selects — each counting predicate verbatim, ordered + capped.
  const [mergedEv, openedEv, awaitingEv, openNowEv, rcRows, pcRows, pcCountRow] =
    await Promise.all([
      db
        .select({ prId: pullRequests.id })
        .from(pullRequests)
        .where(
          and(
            inScope,
            eq(pullRequests.authorId, userId),
            gte(pullRequests.mergedAt, from),
            lt(pullRequests.mergedAt, to),
          ),
        )
        .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      db
        .select({ prId: pullRequests.id })
        .from(pullRequests)
        .where(
          and(
            inScope,
            eq(pullRequests.authorId, userId),
            gte(pullRequests.openedAt, from),
            lt(pullRequests.openedAt, to),
          ),
        )
        .orderBy(desc(pullRequests.openedAt), desc(pullRequests.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      db
        .select({ prId: pullRequests.id })
        .from(reviewRequests)
        .innerJoin(pullRequests, eq(pullRequests.id, reviewRequests.prId))
        .where(and(inScope, eq(reviewRequests.userId, userId), eq(pullRequests.state, 'open')))
        .orderBy(desc(pullRequests.openedAt), desc(pullRequests.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      db
        .select({ prId: pullRequests.id })
        .from(pullRequests)
        .where(and(inScope, eq(pullRequests.authorId, userId), eq(pullRequests.state, 'open')))
        .orderBy(desc(pullRequests.openedAt), desc(pullRequests.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      // Their inline review comments — the review_comments_written predicate verbatim, the
      // thread's path/state joined in for the card chrome (one request per report section, the
      // BotVendorComments one-request rule).
      db
        .select({
          targetId: reviewComments.id,
          prId: reviewComments.prId,
          prNumber: pullRequests.number,
          prTitle: pullRequests.title,
          prAuthorId: pullRequests.authorId,
          repoId: pullRequests.repoId,
          owner: repos.owner,
          name: repos.name,
          threadId: reviewComments.threadId,
          path: reviewThreads.path,
          derivedState: reviewThreads.derivedState,
          body: reviewComments.body,
          createdAt: reviewComments.createdAt,
        })
        .from(reviewComments)
        .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .leftJoin(reviewThreads, eq(reviewThreads.id, reviewComments.threadId))
        .where(
          and(
            inScope,
            eq(reviewComments.authorId, userId),
            gte(reviewComments.createdAt, from),
            lt(reviewComments.createdAt, to),
          ),
        )
        .orderBy(desc(reviewComments.createdAt), desc(reviewComments.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      // Their issue-level PR comments — the conversational half of the same card group (the
      // metric itself stays inline-only; `more` accounts for both channels).
      db
        .select({
          targetId: prComments.id,
          prId: prComments.prId,
          prNumber: pullRequests.number,
          prTitle: pullRequests.title,
          prAuthorId: pullRequests.authorId,
          repoId: pullRequests.repoId,
          owner: repos.owner,
          name: repos.name,
          body: prComments.body,
          createdAt: prComments.createdAt,
        })
        .from(prComments)
        .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(
          and(
            inScope,
            eq(prComments.authorId, userId),
            gte(prComments.createdAt, from),
            lt(prComments.createdAt, to),
          ),
        )
        .orderBy(desc(prComments.createdAt), desc(prComments.id))
        .limit(PERSON_EVIDENCE_CAP)
        .execute(),
      db
        .select({ c: count() })
        .from(prComments)
        .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
        .where(
          and(
            inScope,
            eq(prComments.authorId, userId),
            gte(prComments.createdAt, from),
            lt(prComments.createdAt, to),
          ),
        )
        .execute(),
    ]);

  // (2) The medians' sample PRs, newest contributing review first (the fold order is scan
  // order, not display order). `more` counts against the SAMPLE size, never a recount.
  const bySampleDesc = (xs: ReviewSampleRef[]): number[] =>
    [...xs]
      .sort((x, y) => y.atMs - x.atMs || y.prId - x.prId)
      .slice(0, PERSON_EVIDENCE_CAP)
      .map((s) => s.prId);
  const respIds = bySampleDesc(a.responseSamples);
  const waitIds = bySampleDesc(a.waitSamples);

  // (3) Thread evidence: the CELL's own rows, newest root first, capped; root excerpts fetched
  // by thread id (the feed's first-comment idiom — `excerpt` is short and always populated).
  const threadEv = [...a.threadRows]
    .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || y.id - x.id)
    .slice(0, PERSON_EVIDENCE_CAP);
  const rootByThread = new Map<number, { excerpt: string; authorId: number | null }>();
  if (threadEv.length > 0) {
    for (const c of await db
      .select({
        threadId: reviewComments.threadId,
        excerpt: reviewComments.excerpt,
        body: reviewComments.body,
        // The root's author decides `selfAuthoredRoot`: a subject's own "flagging this for
        // reviewers" note must not travel downstream framed as feedback they received.
        authorId: reviewComments.authorId,
      })
      .from(reviewComments)
      .where(
        inArray(
          reviewComments.threadId,
          threadEv.map((t) => t.id),
        ),
      )
      .orderBy(reviewComments.createdAt, reviewComments.id)
      .execute()) {
      if (!rootByThread.has(c.threadId))
        rootByThread.set(c.threadId, {
          excerpt: collapseExcerpt(c.excerpt ?? c.body),
          authorId: c.authorId,
        });
    }
  }

  // (4) Stored ML labels for the capped comment rows — whatever is stored (normally nothing for
  // a human); two tiny IN() lookups, never a per-card query.
  const labelsByTarget = new Map<string, MlLabel>();
  for (const { kind, ids } of [
    { kind: 'review_comment' as const, ids: rcRows.map((r) => r.targetId) },
    { kind: 'pr_comment' as const, ids: pcRows.map((r) => r.targetId) },
  ]) {
    if (ids.length === 0) continue;
    for (const row of await db
      .select()
      .from(mlCommentLabels)
      .where(
        and(
          eq(mlCommentLabels.accountId, accountId),
          eq(mlCommentLabels.targetKind, kind),
          inArray(mlCommentLabels.targetId, ids),
        ),
      )
      .execute()) {
      const wire = toWireLabel(row);
      if (wire) labelsByTarget.set(`${kind}:${row.targetId}`, wire);
    }
  }

  // (5) Path areas over the authored evidence set — the SAME capped PRs the cards list, which
  // is what keeps the commit scan bounded. `commitFiles` (GLOBAL) is reached only through the
  // tenant-scoped shas of that set.
  const authoredIds = [...new Set([...mergedEv, ...openedEv].map((r) => r.prId))];
  const pathAreas: PersonPathArea[] = [];
  if (authoredIds.length > 0) {
    const commitRows = await db
      .select({ sha: commits.sha })
      .from(commits)
      .innerJoin(pullRequests, eq(pullRequests.id, commits.prId))
      .where(and(inScope, inArray(commits.prId, authoredIds)))
      .orderBy(desc(commits.committedAt), desc(commits.id))
      .limit(PERSON_PR_CAP)
      .execute();
    const shas = [...new Set(commitRows.map((c) => c.sha))];
    if (shas.length > 0) {
      const byBucket = new Map<string, { files: Set<string>; commits: Set<string> }>();
      for (const f of await db
        .select({ sha: commitFiles.sha, paths: commitFiles.paths })
        .from(commitFiles)
        .where(inArray(commitFiles.sha, shas))
        .execute()) {
        for (const p of f.paths) {
          const bucket = pathBucket(p);
          const agg = byBucket.get(bucket) ?? { files: new Set<string>(), commits: new Set<string>() };
          agg.files.add(p);
          agg.commits.add(f.sha);
          byBucket.set(bucket, agg);
        }
      }
      pathAreas.push(
        ...[...byBucket.entries()]
          .map(([bucket, agg]) => ({ bucket, files: agg.files.size, commits: agg.commits.size }))
          .sort((x, y) => y.files - x.files || x.bucket.localeCompare(y.bucket))
          .slice(0, PERSON_EVIDENCE_CAP),
      );
    }
  }

  // (6) One DigestPrRef hydration for every PR id an evidence group names (order preserved by
  // the groups' own id lists; comments carry their PR fields inline from their joins).
  const refIds = new Set<number>();
  for (const r of [...mergedEv, ...openedEv, ...awaitingEv, ...openNowEv]) refIds.add(r.prId);
  for (const id of [...respIds, ...waitIds]) refIds.add(id);
  for (const t of threadEv) refIds.add(t.prId);
  const refMap = await loadPersonPrRefs(accountId, [...refIds]);

  const prGroup = (ids: number[], total: number) => ({
    rows: ids.map((id) => refMap.get(id)).filter((r): r is DigestPrRef => r != null),
    more: Math.max(0, total - ids.length),
  });
  // A group with a zero population is OMITTED (nothing to evidence — `Partial` is the shape).
  const prs: PersonPeriodEvidence['prs'] = {};
  if (a.counts.merged > 0)
    prs.merged_prs_authored = prGroup(mergedEv.map((r) => r.prId), a.counts.merged);
  if (a.counts.opened > 0)
    prs.opened_prs_authored = prGroup(openedEv.map((r) => r.prId), a.counts.opened);
  if (a.responseSamples.length > 0)
    prs.median_review_response_hours = prGroup(respIds, a.responseSamples.length);
  if (a.waitSamples.length > 0)
    prs.median_first_human_review_hours_their_prs = prGroup(waitIds, a.waitSamples.length);
  if (a.counts.awaiting > 0)
    prs.awaiting_their_review = prGroup(awaitingEv.map((r) => r.prId), a.counts.awaiting);
  if (a.counts.openNow > 0)
    prs.open_prs_authored = prGroup(openNowEv.map((r) => r.prId), a.counts.openNow);

  const rcCards: BotVendorComment[] = rcRows.map((r) => ({
    targetKind: 'review_comment' as const,
    targetId: r.targetId,
    prId: r.prId,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    prAuthorId: r.prAuthorId,
    repoId: r.repoId,
    repoFullName: `${r.owner}/${r.name}`,
    path: r.path ?? null,
    threadId: r.threadId,
    derivedState: r.derivedState ?? null,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    mlLabel: labelsByTarget.get(`review_comment:${r.targetId}`) ?? null,
  }));
  const pcCards: BotVendorComment[] = pcRows.map((r) => ({
    targetKind: 'pr_comment' as const,
    targetId: r.targetId,
    prId: r.prId,
    prNumber: r.prNumber,
    prTitle: r.prTitle,
    prAuthorId: r.prAuthorId,
    repoId: r.repoId,
    repoFullName: `${r.owner}/${r.name}`,
    path: null,
    threadId: null,
    derivedState: null,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    mlLabel: labelsByTarget.get(`pr_comment:${r.targetId}`) ?? null,
  }));
  const commentCards = [...rcCards, ...pcCards]
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt) || y.targetId - x.targetId)
    .slice(0, PERSON_EVIDENCE_CAP);
  const commentsTotal = a.counts.comments + (pcCountRow[0]?.c ?? 0);

  const threadRefs: PersonEvidenceThreadRef[] = threadEv.map((t) => {
    const ref = refMap.get(t.prId);
    return {
      prId: t.prId,
      prNumber: ref?.prNumber ?? 0,
      repoFullName: ref?.repoFullName ?? '',
      threadId: t.id,
      path: t.path,
      excerpt: rootByThread.get(t.id)?.excerpt ?? '',
      selfAuthoredRoot: rootByThread.get(t.id)?.authorId === a.userId,
      derivedState: t.state,
      createdAt: t.createdAt.toISOString(),
    };
  });

  return {
    prs,
    comments: {
      rows: commentCards,
      more: Math.max(0, commentsTotal - commentCards.length),
    },
    threads: {
      rows: threadRefs,
      more: Math.max(0, a.threadRows.length - threadRefs.length),
    },
    pathAreas,
  };
}

/** DigestPrRef rows for tenant-owned PR ids (the plugin pr-refs shape, served from persisted
 *  columns only — no hydration, no descriptions). The `users` read is scoped by construction:
 *  only authors of PRs this account owns, and only the login travels. */
async function loadPersonPrRefs(
  accountId: number,
  prIds: number[],
): Promise<Map<number, DigestPrRef>> {
  const map = new Map<number, DigestPrRef>();
  if (prIds.length === 0) return map;
  const rows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      authorId: pullRequests.authorId,
      ciStatus: pullRequests.ciStatus,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      openedAt: pullRequests.openedAt,
      owner: repos.owner,
      name: repos.name,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, prIds)))
    .execute();
  const authorIds = [
    ...new Set(rows.map((r) => r.authorId).filter((v): v is number => v != null)),
  ];
  const loginById = new Map<number, string>();
  if (authorIds.length > 0) {
    for (const u of await db
      .select({ id: users.id, login: users.githubLogin })
      .from(users)
      .where(inArray(users.id, authorIds))
      .execute()) {
      loginById.set(u.id, u.login);
    }
  }
  for (const r of rows) {
    map.set(r.id, {
      prNumber: r.number,
      prId: r.id,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      title: r.title,
      authorLogin: r.authorId != null ? (loginById.get(r.authorId) ?? null) : null,
      authorId: r.authorId,
      state: r.state,
      ciStatus: r.ciStatus ?? null,
      additions: r.additions,
      deletions: r.deletions,
      changedFiles: r.changedFiles,
      openedAt: r.openedAt.toISOString(),
    });
  }
  return map;
}
