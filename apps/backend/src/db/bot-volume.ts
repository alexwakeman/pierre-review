// ── Bot comment VOLUME per PR (CORE, free, deterministic — no model, no new table) ──────────
//
// Answers two questions the ROI tab could not: "how much does this bot say on a PR" and "does it
// scale with the diff". Three getters over ONE shared base scan:
//   getBotVolume        → the per-bot column + workspace totals (Bots ROI tab)
//   getPrBotVolume      → the paginated PR drill-down behind that column
//   getBotVolumeScatter → the LOC-vs-volume chart series (Bots BEHAVIOUR tab)
//
// ⚠ ALL THREE FOLD THE SAME `loadVolumeBase` RESULT. That is the point: a column, the list behind
// it and the chart beside it are three renderings of one count, so they cannot drift the way a
// tile and its drill-down drift when each runs its own scan (the failure db/bot-flagging.test.ts
// exists to prevent). Nothing client-side re-derives a count from items — the server's number is
// the number.
//
// ⚠ THE POPULATION IS **MERGED** PRs AND THE WINDOW APPLIES TO `pullRequests.mergedAt`. An open PR
// has not finished collecting bot comments, so including it drags every mean down by an amount
// that depends only on how recently the window opened; and `mergedAt` is already the anchor
// `BotVendorAnalytics.mergedPastPrs` uses, so the ROI tab keeps ONE time grain across its columns.
// Measured at 180d on the dev corpus, erxes/erxes holds 997 PRs by `openedAt` and 686 by
// `mergedAt` — the choice moves every number materially and every caption must state it.
//
// ⚠ SIZE IS SUBLINEAR IN COMMENTS, WHICH IS WHY `expected` EXISTS. Measured (erxes, 180d, mean
// bot comments per PR by bucket): 6.80 → 9.49 → 16.18 → 23.45 → 35.32 across <50 / 50-200 /
// 200-600 / 600-2k / 2k+ LOC, i.e. comments per 100 LOC FALLING monotonically — 32.91 → 8.33 →
// 4.32 → 2.08 → 0.30 aggregated (Σcomments/Σloc, the form `BotVolumeSizeBucketStat` returns), or
// 57.65 → 8.99 → 4.46 → 2.23 → 0.83 as a mean of per-PR densities. go-redis says the same thing
// louder: 0.32 → 2.08 → 3.00 → 13.00 → 28.40. So ranking PRs by raw comment count mostly ranks
// them BY SIZE (correlation of log10(LOC+1) against count: go-redis 0.615, erxes 0.539 — and
// ~nothing where bots are quiet: three.js 0.125).
//
// The product question is "where did a bot tear a PR apart", and the answer is the BUCKET-RELATIVE
// ratio. THE PROOF, on this corpus: erxes #7802 is 17 LOC across 1 file and drew 25 bot comments —
// 3.68× its bucket's expectation of 6.80. Under the default `sort=comments` it ranks **123rd of
// 686**, below every large PR; under `sort=ratio` it ranks **8th**. That is the entire reason the
// second sort exists, and why a UI that only ever shows the first has shipped a size ranking.
//
// ⚠ AND `expected` IS NOT A DENSITY. `comments per 100 LOC` was the obvious first form and it is
// unusable as a ranking: it explodes on tiny PRs by construction (#7802's is 147.06). It ships as
// `commentsPer100Loc`, never as the sort, and the aggregated per-bucket version is the only place
// it reads honestly.
//
// ⚠ KNOWN LIMIT OF THE RATIO — A NEAR-ZERO EXPECTATION INFLATES IT. In a repo where bots are
// almost silent the bucket mean can be a fraction, and a PR with 3 comments then reads 42.86×
// (measured: bevyengine/bevy #24971, 3 comments against an expectation of 0.07 over 61 PRs). That
// is arithmetically correct and genuinely notable, but it is not the same claim as erxes #7802 and
// must not be presented as one — which is why `expected` and `baselinePrs` ride every row and are
// meant to be rendered BESIDE the multiplier, never behind a tooltip. The floor below fixes small
// SAMPLES; nothing can fix a small MEAN except showing it.
//
// ⚑ ITS OWN FILE, NOT queries.ts: that file is 13k lines and CONTAINS LITERAL NUL BYTES around
// offset 132k, so every search tool silently under-reports matches inside it. Nothing imports
// this file back, so importing queries.ts here creates no cycle (the db/bot-overlap.ts
// precedent).
//
// Nothing here may feed `botVerdict` — display only (bot-analytics-verdict.test.ts pins that
// verdict's inputs).
import { and, count, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type {
  AutomatedReviewerKind,
  BotVolumeBaselineKind,
  BotVolumeBot,
  BotVolumePrBotShare,
  BotVolumePrRow,
  BotVolumePrSort,
  BotVolumePrsResponse,
  BotVolumeRefine,
  BotVolumeResponse,
  BotVolumeScatterPoint,
  BotVolumeScatterResponse,
  BotVolumeSizeBucket,
  BotVolumeSizeBucketStat,
  BotVolumeTotals,
  BotWindowKind,
  ReviewerRole,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { botWindowMs } from './bot-window.js';
import { labelFor as labelForKind } from '../sync/reviewer-classify.js';
import {
  automatedReviewerUserIds,
  classificationKindForUser,
  classificationLabelMap,
  reviewerRoleForUser,
  type BotScope,
} from './queries.js';

const { prComments, pullRequests, repos, reviewComments, reviews, users } = schema;

// The merged-PR scan bound. Generous because a PR row is small and the fold is O(n): the busiest
// repo in the dev corpus contributes 997 merged PRs over 180 days, so a workspace has to be very
// large before this bites. Newest-merged-first, and `truncated` says so when it does — the
// ROLLUP_SCAN_CAP honesty rule (a capped scan reports a most-recent sample, never a total).
const VOLUME_PR_SCAN_CAP = 5000;

// The chart's own, tighter bound. This is a scatter, not a listing: 2000 points already paint a
// solid cloud, and each one is ~60 bytes of JSON. Set independently of the scan cap so the UI can
// say "the most recent 2000" without implying the aggregates were sampled too.
const SCATTER_POINT_CAP = 2000;

// Drill-down page bound (the flagging route's FLAGGING_PAGE_MAX precedent).
const VOLUME_PAGE_MAX = 50;

// ── THE SMALL-SAMPLE FLOOR ──────────────────────────────────────────────────────────────────
// A (repo × bucket) cell needs at least this many SIZED PRs before its mean may be called an
// expectation. Below it the cell degrades to the repo mean, and a repo under the floor answers
// no baseline at all. "3.7× expectation" computed off two PRs is noise dressed as a finding, and
// it is exactly the kind of number a user acts on — so the wire carries `baseline` and
// `baselinePrs` and never leaves the UI to infer sample size from a null.
const BASELINE_MIN_PRS = 5;

// ── THE EXPECTATION FLOOR (a SEPARATE guard from BASELINE_MIN_PRS above) ────────────────────
// A cell may hold plenty of PRs and still be useless as a comparison, because the floor that
// matters is the EXPECTED COUNT, not the sample size. Measured on erxes/30d: the `<50` cell held
// 43 merged PRs — comfortably past BASELINE_MIN_PRS — at a mean of 0.9 comments. A single PR
// drawing 4 comments there reads 4.4×, and four of the top eleven "most vs expected" rows were
// 3-4 raw comments against that 0.9. With λ≈0.9, P(X≥4) ≈ 1.3% per PR, so across 43 PRs you
// EXPECT about one such row from Poisson noise alone — indistinguishable, in the same list, from
// erxes #9013 (36 comments against an expectation of 6.2), which is a real finding.
//
// So below this floor the row reports its `expected` and `baselinePrs` but NO ratio: there is
// nothing here a multiplier can honestly say. Suppressing the number is the point — a greyed
// "—" that explains itself beats a confident 4.4× that is noise.
const BASELINE_MIN_EXPECTED = 3;

// ── THE BASELINE SPAN ───────────────────────────────────────────────────────────────────────
// The expectation is ALWAYS computed over this many days, regardless of the window being VIEWED.
// Two reasons, both learned from the 30d screenshots:
//   1. STABILITY. A baseline tied to the display window moves under the reader — the same PR
//      reads 3.3× at 30d and something else at 7d, with nothing on screen having changed about
//      the PR. A comparison that shifts when you change the view is not a comparison.
//   2. SAMPLE. At 7d most (repo × bucket) cells fall under BASELINE_MIN_PRS and degrade to the
//      repo mean or to no baseline at all, so the column empties out exactly when the user
//      narrows to look closely.
// The LIST is still the selected window; only what it is COMPARED AGAINST is fixed. When the
// selected window is already longer, it wins (`min(from, to − 90d)`) — never a narrower baseline
// than the rows it judges.
const BASELINE_DAYS = 90;
const BASELINE_SPAN_MS = BASELINE_DAYS * 86_400_000;

// The ONE runtime table of LOC bucket edges. Half-open [minLoc, maxLoc); `maxLoc: null` is the
// open-ended top. These are the buckets the corpus measurement was taken on — changing an edge
// invalidates every measured figure quoted in the comments above and in the shared types.
// Kept HERE and shipped on the wire (BotVolumeSizeBucketStat.minLoc/maxLoc + `label`) rather than
// duplicated into the SPA: `packages/shared` is types-only, so a client copy could only be a
// second spelling waiting to drift.
const SIZE_BUCKETS: {
  bucket: BotVolumeSizeBucket;
  label: string;
  minLoc: number;
  maxLoc: number | null;
}[] = [
  { bucket: 'xs', label: '<50', minLoc: 0, maxLoc: 50 },
  { bucket: 's', label: '50–200', minLoc: 50, maxLoc: 200 },
  { bucket: 'm', label: '200–600', minLoc: 200, maxLoc: 600 },
  { bucket: 'l', label: '600–2k', minLoc: 600, maxLoc: 2000 },
  { bucket: 'xl', label: '2k+', minLoc: 2000, maxLoc: null },
];

function bucketFor(loc: number): BotVolumeSizeBucket {
  for (const b of SIZE_BUCKETS) {
    if (b.maxLoc == null || loc < b.maxLoc) return b.bucket;
  }
  // Unreachable — the last bucket is open-ended. Non-null return keeps the caller honest.
  return 'xl';
}

/** 2dp, or null. Money-style rounding is deliberate: these are display figures, and an
 *  unrounded 16.888888888888889 in a table cell is worse than useless. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function avg2(sum: number, n: number): number | null {
  return n > 0 ? round2(sum / n) : null;
}

// ── The shared base ─────────────────────────────────────────────────────────────────────────

export interface VolumePr {
  id: number;
  repoId: number;
  number: number;
  title: string;
  openedAt: Date;
  mergedAt: Date;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** null = size NEVER OBSERVED. See the `loc` contract on BotVolumePrRow: under lean storage the
   *  three size columns default to 0, so an unhydrated PR is indistinguishable from an empty one
   *  and must be read as unknown rather than fabricated into the `xs` bucket. */
  loc: number | null;
  bucket: BotVolumeSizeBucket | null;
  /**
   * TRUE when this PR merged inside the SELECTED window, FALSE when it was loaded only to widen
   * the baseline to BASELINE_DAYS.
   *
   * ⚠ EVERY CONSUMER THAT REPORTS A NUMBER TO THE USER MUST FILTER ON THIS. The scan deliberately
   * reaches back further than the window so the expectation has a stable sample, which means
   * `base.prs` is NOT the window — folding it whole would silently report 90 days of PRs under a
   * "30d" heading. Only `buildBaselines` is entitled to the unfiltered set.
   */
  inWindow: boolean;
  /** authorUserId → comments on this PR. Only automated reviewers are ever inserted. */
  byBot: Map<number, number>;
  /** Σ byBot — the UNREFINED total, cached because the aggregate path folds it for every PR. */
  total: number;
}

interface VolumeBase {
  windowKind: BotWindowKind;
  from: Date;
  to: Date;
  generatedAt: string;
  /** Newest-merged first — the order both the scan cap and the scatter cap slice from. */
  prs: VolumePr[];
  truncated: boolean;
  automatedIds: number[];
  repoFullName: Map<number, string>;
}

function emptyBase(
  windowKind: BotWindowKind,
  from: Date,
  to: Date,
  generatedAt: string,
): VolumeBase {
  return {
    windowKind,
    from,
    to,
    generatedAt,
    prs: [],
    truncated: false,
    automatedIds: [],
    repoFullName: new Map(),
  };
}

/**
 * The merged-PR population plus its per-(PR, bot) comment counts.
 *
 * ⚠ THE BOT SET IS ROLE `'all'`, NOT `'review'` — the ROI / flagging convention. Quality checks
 * (SonarQube, Codecov …) post exactly the kind of text this counts, and a drill-down that
 * narrowed the bot set would list fewer comments than the column it was opened from. The response
 * carries each bot's `role` so the UI can split them the way `BotAnalyticsResponse` splits
 * `vendors` from `qualityChecks`; it does NOT pre-split, because the chart wants the whole cloud.
 * (The Behaviour tab's own panels use `'review'` — this file deliberately does not follow them.)
 */
async function loadVolumeBase(
  accountId: number,
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  scope: BotScope,
): Promise<VolumeBase> {
  const nowMs = Date.now();
  const windowKind = typeof window === 'string' ? window : window.kind;
  // The one shared window→duration mapping (db/bot-window.ts), unless the caller supplied real
  // bounds — the `getBotAnalytics` window contract verbatim, so the Pro Insights chat's ranges
  // and a verification script can both reach a span the enum cannot spell.
  const to = new Date(typeof window === 'string' ? nowMs : window.toMs);
  const from = new Date(
    typeof window === 'string' ? nowMs - botWindowMs(window) : window.fromMs,
  );
  const generatedAt = new Date(nowMs).toISOString();
  // The SCAN reaches back to whichever is earlier: the window's own start, or BASELINE_DAYS
  // before its end. Everything loaded feeds the expectation; only `inWindow` rows are reported.
  // One scan, not two — a second query for the baseline would double the cost of every call to
  // buy nothing, since the wider span is a strict superset.
  const scanFrom = new Date(Math.min(from.getTime(), to.getTime() - BASELINE_SPAN_MS));

  // `repoIds: []` is a real empty workspace, never "widen to the account".
  if (scope.repoIds.length === 0) return emptyBase(windowKind, from, to, generatedAt);
  const automatedIds = await automatedReviewerUserIds(accountId, scope.workspaceId, 'all');
  if (automatedIds.length === 0) {
    // No bots ⇒ no comments, but the PR population is still real and `totals.prs` must report it
    // (a workspace with 800 merged PRs and no bots reads "0 of 800", not "no data").
    const bare = await loadMergedPrs(accountId, scope, scanFrom, to, from);
    return { windowKind, from, to, generatedAt, ...bare, automatedIds: [] };
  }

  const bare = await loadMergedPrs(accountId, scope, scanFrom, to, from);
  const byId = new Map(bare.prs.map((p) => [p.id, p]));

  // The three text kinds, one grouped count each. Deliberately NOT one clever aggregate:
  // `count(*) FILTER (WHERE …)` is not portable across the two dialects (the listDetectedReviewers
  // precedent), and three indexed group-bys are cheap.
  //
  // ⚠ EACH RE-APPLIES THE FULL WINDOW + SCOPE PREDICATE against `pullRequests` rather than an
  // `inArray` over the scanned PR ids: the id list can reach VOLUME_PR_SCAN_CAP, which is far past
  // sqlite's bound-parameter ceiling. Rows whose PR fell outside the (capped) scan simply find no
  // entry in `byId` and are dropped.
  const prPred = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
    gte(pullRequests.mergedAt, scanFrom),
    lte(pullRequests.mergedAt, to),
  );

  const [rcRows, pcRows, rvRows] = await Promise.all([
    // Inline review comments. Joined on `reviewComments.prId` — provably identical to routing
    // through `reviewThreads.prId` (sync writes both from the same thread, and 0 of 21,475 rows
    // in the dev corpus disagree), and `rc_pr_node` makes `pr_id` a leading indexed column while
    // the thread hop would be an extra join per row.
    db
      .select({ prId: reviewComments.prId, authorId: reviewComments.authorId, c: count() })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(and(prPred, inArray(reviewComments.authorId, automatedIds)))
      .groupBy(reviewComments.prId, reviewComments.authorId)
      .execute(),
    db
      .select({ prId: prComments.prId, authorId: prComments.authorId, c: count() })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(and(prPred, inArray(prComments.authorId, automatedIds)))
      .groupBy(prComments.prId, prComments.authorId)
      .execute(),
    // Submitted review BODIES (the walkthrough / summary post).
    //
    // ⚠ A BODILESS REVIEW COUNTS. A bare approval with no text is one row here, and that is the
    // definition the corpus measurement these surfaces were specced against used. The measured
    // cost of the choice: erxes/erxes 16.89 vs 15.98 avg, go-redis 4.91 vs 4.32 — and the
    // zero-comment PR counts are IDENTICAL under both, so no product signal turns on it. To flip
    // it, add a non-empty-body predicate HERE and nowhere else, and restate the numbers quoted at
    // the top of this file.
    //
    // `pending` reviews are drafts, invisible on GitHub, and are excluded — the same predicate
    // getBotAnalytics uses for review activity.
    db
      .select({ prId: reviews.prId, authorId: reviews.authorId, c: count() })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(prPred, inArray(reviews.authorId, automatedIds), ne(reviews.state, 'pending')))
      .groupBy(reviews.prId, reviews.authorId)
      .execute(),
  ]);

  for (const rows of [rcRows, pcRows, rvRows]) {
    for (const r of rows) {
      if (r.authorId == null) continue;
      const pr = byId.get(r.prId);
      if (!pr) continue; // outside the capped scan
      pr.byBot.set(r.authorId, (pr.byBot.get(r.authorId) ?? 0) + r.c);
      pr.total += r.c;
    }
  }

  return { windowKind, from, to, generatedAt, ...bare, automatedIds };
}

/** The PR half of the base — split out so the no-bots early return can reuse it verbatim. */
async function loadMergedPrs(
  accountId: number,
  scope: BotScope,
  // The SCAN span — reaches back to the baseline horizon, which is at or before `windowFrom`.
  from: Date,
  to: Date,
  // The SELECTED window's start. Rows merged before it are loaded to condition the expectation
  // and are flagged `inWindow: false`; every user-facing fold must drop them.
  windowFrom: Date,
): Promise<{ prs: VolumePr[]; truncated: boolean; repoFullName: Map<number, string> }> {
  const rows = await db
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      title: pullRequests.title,
      openedAt: pullRequests.openedAt,
      mergedAt: pullRequests.mergedAt,
      additions: pullRequests.additions,
      deletions: pullRequests.deletions,
      changedFiles: pullRequests.changedFiles,
      owner: repos.owner,
      name: repos.name,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, scope.repoIds),
        gte(pullRequests.mergedAt, from),
        lte(pullRequests.mergedAt, to),
      ),
    )
    // Newest-merged first: both caps slice from the front, so a truncated scan is a RECENT
    // sample rather than an arbitrary one. `pullRequests.id` breaks ties so the cap is
    // deterministic across requests (two PRs can share a merge second).
    .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
    .limit(VOLUME_PR_SCAN_CAP)
    .execute();

  const repoFullName = new Map<number, string>();
  const prs: VolumePr[] = [];
  for (const r of rows) {
    // `mergedAt` cannot be null here (the gte/lte predicate excludes nulls in both dialects), but
    // the column IS nullable, so the narrowing is explicit rather than a `!`.
    if (!r.mergedAt) continue;
    repoFullName.set(r.repoId, `${r.owner}/${r.name}`);
    // ⚠ UNKNOWN SIZE, NOT ZERO SIZE. Under lean storage these three columns default to 0, so a PR
    // whose detail never hydrated looks exactly like an empty one. 135 of three.js's 796 merged
    // PRs are in this state in the dev corpus — fabricating a 0 would drop every one of them into
    // the `xs` bucket, where the smallest expectation lives, and manufacture spectacular ratios.
    const observed = r.changedFiles > 0 || r.additions > 0 || r.deletions > 0;
    const loc = observed ? r.additions + r.deletions : null;
    prs.push({
      id: r.id,
      repoId: r.repoId,
      number: r.number,
      title: r.title,
      openedAt: r.openedAt,
      mergedAt: r.mergedAt,
      additions: r.additions,
      deletions: r.deletions,
      changedFiles: r.changedFiles,
      loc,
      bucket: loc == null ? null : bucketFor(loc),
      inWindow: r.mergedAt.getTime() >= windowFrom.getTime(),
      byBot: new Map(),
      total: 0,
    });
  }
  return { prs, truncated: rows.length >= VOLUME_PR_SCAN_CAP, repoFullName };
}

// ── Bot identity (the reviewerLabel precedence, one bot = one name everywhere) ───────────────

export interface BotIdentity {
  label: string;
  login: string | null;
  kind: AutomatedReviewerKind;
  role: ReviewerRole;
}

export async function loadBotIdentities(
  accountId: number,
  scope: BotScope,
  automatedIds: number[],
): Promise<Map<number, BotIdentity>> {
  const out = new Map<number, BotIdentity>();
  if (automatedIds.length === 0) return out;
  const [kindMap, roleMap, classLabel, userRows] = await Promise.all([
    classificationKindForUser(accountId, scope.workspaceId),
    reviewerRoleForUser(accountId, scope.workspaceId),
    classificationLabelMap(accountId, scope.workspaceId),
    db
      .select({ id: users.id, login: users.githubLogin, name: users.displayName })
      .from(users)
      .where(inArray(users.id, automatedIds))
      .execute(),
  ]);
  const display = new Map<number, string>();
  const login = new Map<number, string | null>();
  for (const u of userRows) {
    display.set(u.id, u.name?.trim() || u.login || `#${u.id}`);
    login.set(u.id, u.login || null);
  }
  for (const id of automatedIds) {
    const kind: AutomatedReviewerKind = kindMap.get(id) ?? 'in_house';
    // getBotAnalytics' `reviewerLabel` precedence verbatim — custom workspace label → vendor
    // pretty name → display name/login — so one bot reads with one name across the Bots interface.
    const custom = classLabel.get(id);
    const label =
      custom ??
      (kind !== 'in_house' && kind !== 'pierre' && kind !== 'vendor'
        ? labelForKind(kind)
        : (display.get(id) ?? labelForKind(kind)));
    out.set(id, {
      label,
      login: login.get(id) ?? null,
      kind,
      role: roleMap.get(id) ?? 'review',
    });
  }
  return out;
}

// ── (1) The per-bot column + workspace totals ───────────────────────────────────────────────

export async function getBotVolume(
  accountId: number,
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  scope: BotScope,
): Promise<BotVolumeResponse> {
  const base = await loadVolumeBase(accountId, window, scope);
  const win = {
    kind: base.windowKind,
    from: base.from.toISOString(),
    to: base.to.toISOString(),
  };

  type Acc = { comments: number; prs: Set<number>; max: number };
  const byBot = new Map<number, Acc>();
  let comments = 0;
  let sizedPrs = 0;
  let prsWithBotComments = 0;
  let maxOnOnePr = 0;
  // ⚠ WINDOW ONLY. `base.prs` reaches back to the baseline horizon (BASELINE_DAYS) so the
  // expectation has a stable sample; every number below is reported to the user under the
  // SELECTED window's heading, so it must fold `windowPrs`, never `base.prs`.
  const windowPrs = base.prs.filter((p) => p.inWindow);
  for (const pr of windowPrs) {
    if (pr.loc != null) sizedPrs += 1;
    if (pr.total > 0) prsWithBotComments += 1;
    if (pr.total > maxOnOnePr) maxOnOnePr = pr.total;
    comments += pr.total;
    for (const [userId, n] of pr.byBot) {
      let a = byBot.get(userId);
      if (!a) {
        a = { comments: 0, prs: new Set(), max: 0 };
        byBot.set(userId, a);
      }
      a.comments += n;
      a.prs.add(pr.id);
      if (n > a.max) a.max = n;
    }
  }

  const identities = await loadBotIdentities(accountId, scope, [...byBot.keys()]);
  const prs = windowPrs.length;
  const bots: BotVolumeBot[] = [...byBot.entries()]
    .map(([userId, a]) => {
      const id = identities.get(userId);
      return {
        key: `u${userId}`,
        authorUserId: userId,
        label: id?.label ?? `#${userId}`,
        login: id?.login ?? null,
        kind: id?.kind ?? 'in_house',
        role: id?.role ?? 'review',
        comments: a.comments,
        prsCommentedOn: a.prs.size,
        // ⚠ TWO DENOMINATORS, NAMED APART ON PURPOSE — see the shared type. On three.js the same
        // bot reads ~6× higher per-commented-PR than per-scope-PR (656 of 796 merged PRs draw
        // nothing), and nothing in the number itself tells them apart.
        avgCommentsPerCommentedPr: avg2(a.comments, a.prs.size),
        avgCommentsPerScopePr: avg2(a.comments, prs),
        maxCommentsOnOnePr: a.max,
      } satisfies BotVolumeBot;
    })
    // Most comments first; label as a stable tiebreak so two equal bots keep a fixed order
    // across requests (a table that reshuffles on refresh reads as data changing).
    .sort((x, y) => y.comments - x.comments || x.label.localeCompare(y.label));

  const totals: BotVolumeTotals = {
    prs,
    sizedPrs,
    comments,
    prsWithBotComments,
    prsWithNoBotComments: prs - prsWithBotComments,
    avgCommentsPerCommentedPr: avg2(comments, prsWithBotComments),
    avgCommentsPerScopePr: avg2(comments, prs),
    maxCommentsOnOnePr: maxOnOnePr,
  };

  return {
    workspaceId: scope.workspaceId,
    window: win,
    bots,
    totals,
    truncated: base.truncated,
    generatedAt: base.generatedAt,
  };
}

// ── The baseline ────────────────────────────────────────────────────────────────────────────

interface Baselines {
  /** `${repoId}:${bucket}` → running mean over SIZED PRs. */
  byRepoBucket: Map<string, { n: number; sum: number }>;
  /** repoId → running mean over EVERY merged PR of that repo (sized or not). A repo mean is
   *  explicitly NOT size-conditioned — that is what `baseline: 'repo'` discloses — so it uses the
   *  widest population available rather than half-matching the bucket rule. */
  byRepo: Map<number, { n: number; sum: number }>;
}

/**
 * Build both baselines from a per-PR count function.
 *
 * ⚠ IT TAKES `countOf` RATHER THAN READING `pr.total` because `refine.authorUserIds` MOVES THE
 * BASELINE. Comparing one bot's 12 comments against every bot's combined expectation would make
 * every single-bot ratio read low, and uniformly so — the most convincing kind of wrong number.
 */
function buildBaselines(prs: VolumePr[], countOf: (pr: VolumePr) => number): Baselines {
  const byRepoBucket = new Map<string, { n: number; sum: number }>();
  const byRepo = new Map<number, { n: number; sum: number }>();
  for (const pr of prs) {
    const n = countOf(pr);
    const repo = byRepo.get(pr.repoId) ?? { n: 0, sum: 0 };
    repo.n += 1;
    repo.sum += n;
    byRepo.set(pr.repoId, repo);
    if (pr.bucket == null) continue; // unsized PRs condition nothing
    const key = `${pr.repoId}:${pr.bucket}`;
    const cell = byRepoBucket.get(key) ?? { n: 0, sum: 0 };
    cell.n += 1;
    cell.sum += n;
    byRepoBucket.set(key, cell);
  }
  return { byRepoBucket, byRepo };
}

function expectationFor(
  pr: VolumePr,
  baselines: Baselines,
): { expected: number | null; baseline: BotVolumeBaselineKind; baselinePrs: number } {
  // No observed size ⇒ no size-conditioned claim, and the repo mean would be answering a question
  // nobody asked (it is a FALLBACK for a thin bucket, not a size-free expectation).
  if (pr.bucket == null) return { expected: null, baseline: 'none', baselinePrs: 0 };
  const cell = baselines.byRepoBucket.get(`${pr.repoId}:${pr.bucket}`);
  if (cell && cell.n >= BASELINE_MIN_PRS) {
    const expected = round2(cell.sum / cell.n);
    // ⚠ SAMPLE SIZE PASSED; THE EXPECTATION ITSELF IS TOO SMALL TO DIVIDE BY. Reported as its own
    // kind rather than folded into 'none' so the row can still SHOW what it was measured against
    // (`expected` + `baselinePrs` stay populated) while withholding the multiplier. The two
    // failures read identically as a null ratio and are not the same fact: 'none' means "we could
    // not find comparable PRs", this means "we found plenty and they are all near zero".
    if (expected < BASELINE_MIN_EXPECTED) {
      return { expected, baseline: 'low_expectation', baselinePrs: cell.n };
    }
    return { expected, baseline: 'bucket', baselinePrs: cell.n };
  }
  const repo = baselines.byRepo.get(pr.repoId);
  if (repo && repo.n >= BASELINE_MIN_PRS) {
    const expected = round2(repo.sum / repo.n);
    if (expected < BASELINE_MIN_EXPECTED) {
      return { expected, baseline: 'low_expectation', baselinePrs: repo.n };
    }
    return { expected, baseline: 'repo', baselinePrs: repo.n };
  }
  return { expected: null, baseline: 'none', baselinePrs: 0 };
}

function ratioFor(
  botComments: number,
  expected: number | null,
  baseline: BotVolumeBaselineKind,
): number | null {
  // The expectation floor is enforced HERE, at the one place a multiplier is produced, so no
  // caller can route around it by reading `expected` and dividing for itself.
  if (baseline === 'low_expectation') return null;
  // `expected === 0` cannot hide a finding: the PR is a member of its own baseline population, so
  // a mean of 0 forces this PR's own count to 0 too. Reporting null beats reporting Infinity or a
  // fabricated 0 — both of which would sort.
  if (expected == null || expected === 0) return null;
  return round2(botComments / expected);
}

// ── (2) The paginated PR drill-down ─────────────────────────────────────────────────────────

/** One scored drill-down row, pre-hydration. Exported for the synthesis input (§8.3). */
export interface VolumeScoredPr {
  pr: VolumePr;
  botComments: number;
  expected: number | null;
  ratio: number | null;
  baseline: BotVolumeBaselineKind;
  baselinePrs: number;
}

// The shared drill-down POPULATION fold (§8.3: one predicate, three consumers). The route's LIST
// (`getPrBotVolume` below), its COUNTS (`total`/`filteredTotal`) and the SYNTHESIS INPUT
// (`db/synthesis-input.ts`) all read THIS function — never a second predicate.
export interface PrBotVolumePopulation {
  win: { kind: BotWindowKind; from: string; to: string };
  generatedAt: string;
  /** Scored + SORTED — `filteredTotal` is its length; the page/cap is a slice over it. */
  scored: VolumeScoredPr[];
  /** The whole merged in-window population (`total`) — the caption's denominator. */
  windowPrCount: number;
  truncated: boolean;
  repoFullName: Map<number, string>;
  /** The refined bot set (null = every bot) — page assembly filters `byBot` through it. */
  only: Set<number> | null;
}

export async function foldPrBotVolumePopulation(
  accountId: number,
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  scope: BotScope,
  refine: BotVolumeRefine,
  sort: BotVolumePrSort,
): Promise<PrBotVolumePopulation> {
  const base = await loadVolumeBase(accountId, window, scope);
  const win = {
    kind: base.windowKind,
    from: base.from.toISOString(),
    to: base.to.toISOString(),
  };

  // ⚠ `[]` MEANS "NO BOTS", NEVER "EVERY BOT" — the `repoIds` rule (`if (ids)`, never
  // `ids.length > 0`), and the BotFlaggingRefine contract restated. Only `null` widens.
  const only = refine.authorUserIds == null ? null : new Set(refine.authorUserIds);
  const countOf = (pr: VolumePr): number => {
    if (!only) return pr.total;
    let n = 0;
    for (const [userId, c] of pr.byBot) if (only.has(userId)) n += c;
    return n;
  };

  // ⚠ THE BASELINE IS THE ONE FOLD ENTITLED TO THE UNFILTERED SET. It spans BASELINE_DAYS on
  // purpose (see BASELINE_SPAN_MS): an expectation tied to the display window moves under the
  // reader and empties out at 7d. Rebuilt over the SAME narrowed bot set — see buildBaselines.
  const baselines = buildBaselines(base.prs, countOf);
  // …and the LIST is the selected window, nothing wider.
  const windowPrs = base.prs.filter((p) => p.inWindow);

  // Only PRs the refined bot set actually touched are enumerated. `total` stays the whole merged
  // population so the caption can say "140 of 796 merged PRs drew bot comments" — the zero rows
  // are the point of that sentence, not rows to page through (three.js: 656 of them).
  const scored: VolumeScoredPr[] = [];
  for (const pr of windowPrs) {
    const botComments = countOf(pr);
    if (botComments === 0) continue;
    const { expected, baseline, baselinePrs } = expectationFor(pr, baselines);
    scored.push({
      pr,
      botComments,
      expected,
      ratio: ratioFor(botComments, expected, baseline),
      baseline,
      baselinePrs,
    });
  }

  // ⚠ EVERY COMPARATOR IS TOTAL. The offset is a slice over this fold, so two rows that compare
  // equal must still hold a fixed order or a cursor walk silently duplicates and drops rows.
  // `prId` ascending is the final tiebreak in both sorts.
  //
  // Under `'ratio'`, rows with NO baseline sort LAST rather than as 0: an unmeasurable PR is not
  // a below-average one, and burying the null rows is the only reading that keeps the top of the
  // list meaningful.
  scored.sort((a, b) => {
    if (sort === 'ratio') {
      const ar = a.ratio;
      const br = b.ratio;
      if (ar == null && br != null) return 1;
      if (br == null && ar != null) return -1;
      if (ar != null && br != null && ar !== br) return br - ar;
    }
    if (b.botComments !== a.botComments) return b.botComments - a.botComments;
    const at = a.pr.mergedAt.getTime();
    const bt = b.pr.mergedAt.getTime();
    if (bt !== at) return bt - at;
    return a.pr.id - b.pr.id;
  });

  return {
    win,
    generatedAt: base.generatedAt,
    scored,
    windowPrCount: windowPrs.length,
    truncated: base.truncated,
    repoFullName: base.repoFullName,
    only,
  };
}

export async function getPrBotVolume(
  accountId: number,
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  scope: BotScope,
  refine: BotVolumeRefine,
  page: { offset: number; limit: number; sort: BotVolumePrSort },
): Promise<BotVolumePrsResponse> {
  const offset = Math.max(0, Math.trunc(page.offset));
  const limit = Math.max(1, Math.min(Math.trunc(page.limit), VOLUME_PAGE_MAX));

  // The ONE population fold (shared with the synthesis input — §8.3).
  const pop = await foldPrBotVolumePopulation(accountId, window, scope, refine, page.sort);
  const { scored, only } = pop;

  const pageRows = scored.slice(offset, offset + limit);
  const consumed = offset + pageRows.length;

  // Identities only for the bots that actually appear on THIS page — the drill-down spans many
  // PRs, so a per-row lookup is out, but so is resolving every bot in the workspace.
  const pageBotIds = new Set<number>();
  for (const s of pageRows) {
    for (const [userId] of s.pr.byBot) {
      if (!only || only.has(userId)) pageBotIds.add(userId);
    }
  }
  const identities = await loadBotIdentities(accountId, scope, [...pageBotIds]);

  const items: BotVolumePrRow[] = pageRows.map((s) => {
    const byBot: BotVolumePrBotShare[] = [...s.pr.byBot.entries()]
      .filter(([userId]) => !only || only.has(userId))
      .map(([userId, comments]) => ({
        key: `u${userId}`,
        authorUserId: userId,
        label: identities.get(userId)?.label ?? `#${userId}`,
        comments,
      }))
      .sort((x, y) => y.comments - x.comments || x.label.localeCompare(y.label));
    const repoFullName = pop.repoFullName.get(s.pr.repoId) ?? `#${s.pr.repoId}`;
    return {
      prId: s.pr.id,
      prNumber: s.pr.number,
      prTitle: s.pr.title,
      prUrl: `https://github.com/${repoFullName}/pull/${s.pr.number}`,
      repoId: s.pr.repoId,
      repoFullName,
      createdAt: s.pr.openedAt.toISOString(),
      mergedAt: s.pr.mergedAt.toISOString(),
      additions: s.pr.additions,
      deletions: s.pr.deletions,
      loc: s.pr.loc,
      // Null in lockstep with `loc`: the two are unknown together (they come from the same
      // unhydrated row), and a lone `changedFiles: 0` beside a null LOC reads as a real zero.
      changedFiles: s.pr.loc == null ? null : s.pr.changedFiles,
      botComments: s.botComments,
      byBot,
      sizeBucket: s.pr.bucket,
      expected: s.expected,
      ratio: s.ratio,
      baseline: s.baseline,
      baselinePrs: s.baselinePrs,
      // The raw density, shipped but never ranked on — it explodes on small PRs by construction
      // (see the file header). `max(loc, 1)` keeps a rename-only PR finite.
      commentsPer100Loc:
        s.pr.loc == null ? null : round2((s.botComments / Math.max(s.pr.loc, 1)) * 100),
    } satisfies BotVolumePrRow;
  });

  return {
    workspaceId: scope.workspaceId,
    window: pop.win,
    refine,
    sort: page.sort,
    total: pop.windowPrCount,
    filteredTotal: scored.length,
    items,
    // Opaque on the wire; `o:<n>` is today's encoding of "offset into the sorted fold".
    nextCursor: consumed < scored.length ? `o:${consumed}` : null,
    truncated: pop.truncated,
    generatedAt: pop.generatedAt,
  };
}

// ── (3) The LOC-vs-volume chart series ──────────────────────────────────────────────────────

export async function getBotVolumeScatter(
  accountId: number,
  window: BotWindowKind | { kind: BotWindowKind; fromMs: number; toMs: number },
  scope: BotScope,
): Promise<BotVolumeScatterResponse> {
  const base = await loadVolumeBase(accountId, window, scope);
  const win = {
    kind: base.windowKind,
    from: base.from.toISOString(),
    to: base.to.toISOString(),
  };

  // Bucket aggregates cover EVERY sized PR the SCAN returned, independently of the point cap — the
  // expectation curve must describe the whole corpus even when the cloud beneath it is a sample.
  //
  // ⚠ "the scan returned", not "the scope holds": when `base.truncated` is set the scan itself
  // stopped at VOLUME_PR_SCAN_CAP, so these means describe the most-recent 5000 merged PRs and not
  // the window. That is reported as `scanTruncated` — a field DISTINCT from `truncated` (the point
  // cap), because the two weaken different claims: `truncated` means "not every dot is drawn",
  // `scanTruncated` means "the curve those dots are judged against is itself a sample". Folding
  // them into one flag would leave a reader unable to tell which, and a sampled baseline presented
  // as the scope's baseline is precisely the sin the post-merge autopsy was deleted for.
  const agg = new Map<BotVolumeSizeBucket, { prs: number; comments: number; loc: number }>();
  const points: BotVolumeScatterPoint[] = [];
  let sizedPrs = 0;
  let unsizedPrs = 0;
  // ⚠ WINDOW ONLY — this card is captioned with the selected window, so its bars must describe
  // that window. The wider scan exists for the drill-down's expectation, not for this chart.
  const windowPrs = base.prs.filter((p) => p.inWindow);
  for (const pr of windowPrs) {
    if (pr.loc == null || pr.bucket == null) {
      unsizedPrs += 1;
      continue;
    }
    sizedPrs += 1;
    const a = agg.get(pr.bucket) ?? { prs: 0, comments: 0, loc: 0 };
    a.prs += 1;
    a.comments += pr.total;
    a.loc += Math.max(pr.loc, 1);
    agg.set(pr.bucket, a);
    // `base.prs` is newest-merged first, so the cap keeps the most recent points.
    if (points.length < SCATTER_POINT_CAP) {
      points.push({
        prId: pr.id,
        repoId: pr.repoId,
        loc: pr.loc,
        changedFiles: pr.changedFiles,
        botComments: pr.total,
      });
    }
  }

  // Dense: every bucket present even at zero, so a gap in the curve is a gap in the DATA and not
  // an omitted key the chart has to guess about.
  const buckets: BotVolumeSizeBucketStat[] = SIZE_BUCKETS.map((b) => {
    const a = agg.get(b.bucket) ?? { prs: 0, comments: 0, loc: 0 };
    return {
      bucket: b.bucket,
      label: b.label,
      minLoc: b.minLoc,
      maxLoc: b.maxLoc,
      prs: a.prs,
      comments: a.comments,
      avgComments: avg2(a.comments, a.prs),
      // The ONE place a density belongs: aggregated per bucket it is stable and it is exactly the
      // sublinearity readout (measured on erxes: 32.91 → 8.33 → 4.32 → 2.08 → 0.30).
      commentsPer100Loc: a.loc > 0 ? round2((a.comments / a.loc) * 100) : null,
    };
  });

  return {
    workspaceId: scope.workspaceId,
    window: win,
    points,
    buckets,
    sizedPrs,
    unsizedPrs,
    // The POINT cap, not the scan cap — reported separately so "showing the most recent 2000"
    // does not imply the aggregates beside it were sampled too.
    truncated: sizedPrs > points.length,
    // The SCAN cap, straight off the shared loader — the same bit `/volume` and `/volume/prs`
    // surface, so all three routes agree about whether the window was fully walked.
    scanTruncated: base.truncated,
    generatedAt: base.generatedAt,
  };
}
