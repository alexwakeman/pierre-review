// ── THE AUTHORING-AUTOMATION OUTPUT VECTOR (CORE, deterministic) ─────────────────────────────
//
// What a bot that WRITES PRs produced in one period, in one workspace. The sibling of
// db/person-period.ts, and it copies that file's discipline wholesale (window-pure two-sided
// predicates, computed on read, no table, no migration) — but it is deliberately NOT the same
// vector, because the question is different. A person's numbers answer "how is this teammate
// doing"; an automation's answer "what is this thing costing us", which is why
// `prs_merged_without_human_review` and `human_review_comments_received` are here and response
// times are not.
//
// WHY IT EXISTS: the People report's bot sections read `getBotAnalytics`, whose columns are all
// REVIEW output (threads, comments, acted-on). That is the whole story for the `review` and
// `quality_check` roles only. For `dependency` / `code_agent` / `release` / `housekeeping`
// automation every one of those columns is legitimately zero, and a wall of zeros reads as "it
// did nothing" when the truth is "it did a different thing". The section used to say so in prose
// and chart nothing; this fold is what it charts instead.
//
// ⚠ EVERY WINDOWED METRIC IS WINDOW-PURE with a TWO-SIDED `>= from AND < to` predicate, so a
// stored/forwarded period stays reproducible. There is deliberately no live-basis escape hatch
// here (PersonPeriod has three, marked on the wire): every question this vector asks is about
// what HAPPENED in the window, so a "currently open" count would be the only unreproducible
// figure on the page and it would not earn its place.
//
// ⚠ `prs_merged_without_human_review` looks like it breaks window purity — it asks "did any human
// ever review this PR?", which is not itself a windowed question. It does not: the population is
// PRs MERGED INSIDE the window, and a review of a merged PR necessarily predates its merge, so
// the answer is fixed the moment the PR lands and can never move afterwards. Restricting the
// review probe to the window would be the bug — a PR opened and reviewed in March and merged in
// April would count as "merged without review".
//
// ⚠ `users` IS A GLOBAL TABLE (the listUsers precedent). The subject is admitted only after an
// authored-PR probe INSIDE the workspace scope, and only the login and display name ever leave.
//
// ⚠ MIRROR IMAGE OF THE PERSON FOLD'S LANE CHECK: person-period refuses anything the lane
// resolver calls automation; this refuses anything it calls `'human'`. Neither is a login
// heuristic — both go through db/actor-lanes.ts, so a manual "this account is a person"
// judgement moves an actor between the two folds in one place.
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import type {
  AutomationMetricKey,
  AutomationMetricValue,
  AutomationOutput,
  AutomationOutputEvidence,
  CiStatus,
  DigestPrRef,
  PrState,
  ReviewerRole,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { resolveActorLanes } from './actor-lanes.js';
import { median, round2, type PeriodWindow } from './period-metrics.js';
import { PERSON_EVIDENCE_CAP } from './person-period.js';
import { reviewerRoleForUser, type BotScope } from './queries.js';

const { pullRequests, repos, reviewComments, reviews, users } = schema;

// MIRRORED from @pierre-review/shared (AUTOMATION_METRIC_KEYS) for the same types-only reason the
// person keys are inlined: `shared` ships no runtime. `automation-output.test.ts` imports the
// shared original and asserts the two spellings are identical, so drift fails CI, not a reader.
export const AUTOMATION_METRIC_KEYS: AutomationMetricKey[] = [
  'prs_opened',
  'prs_merged',
  'prs_closed_unmerged',
  'merge_rate_pct',
  'median_hours_to_merge',
  'median_pr_size_lines',
  'prs_merged_without_human_review',
  'human_review_comments_received',
  'repos_touched',
];

/** Repos listed under the vector. Rendering cap only — the `repos_touched` METRIC counts them
 *  all, so a workspace with 40 repos reports 40 and lists the busiest few. */
const REPO_LIST_CAP = 8;

/** The merged-PR scan that feeds the medians and the no-human-review probe. Bounded for the same
 *  reason PERIOD_FIRST_REVIEW_PR_CAP is: the ids travel onward as BIND PARAMETERS. A dependency
 *  bot can merge hundreds of PRs in a fortnight, so this is the one fold here that can get big. */
const AUTOMATION_MERGED_PR_CAP = 2000;

function cell(key: AutomationMetricKey, value: number | null, sampleSize: number): AutomationMetricValue {
  return { key, value, sampleSize };
}

/** A count is never null — zero merges IS zero, not "no sample". Medians and rates are the ones
 *  that go null (the period-metrics rule: a null renders "—", never 0). */
function countCell(key: AutomationMetricKey, n: number): AutomationMetricValue {
  return cell(key, n, n);
}

export async function getAutomationOutput(
  accountId: number,
  scope: BotScope,
  userId: number,
  window: PeriodWindow,
  opts: { evidence?: boolean } = {},
): Promise<AutomationOutput | null> {
  const from = new Date(window.fromMs);
  const to = new Date(window.toMs);

  // An empty workspace admits nobody — and without this guard the probe below would read the
  // whole account (`inArray(…, [])` is false, but be explicit about the state).
  if (scope.repoIds.length === 0) return null;

  const lanes = await resolveActorLanes(accountId, scope);
  if (lanes.laneOf(userId) === 'human') return null;

  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );
  const authored = and(inScope, eq(pullRequests.authorId, userId));

  // ── Admission probe (ALL TIME, inside the scope) ────────────────────────────────────────────
  // An automation that has never authored a PR in this workspace is not this fold's subject —
  // it is a reviewer, and `getBotAnalytics` already describes it. Returning null here is what
  // lets the caller decide which of the two sections to render, and it is also why the route is
  // not an existence oracle: an unknown id degrades identically.
  const [probe] = await db
    .select({ c: count() })
    .from(pullRequests)
    .where(authored)
    .execute();
  if ((probe?.c ?? 0) === 0) return null;

  const [identity] = await db
    .select({ login: users.githubLogin, name: users.displayName })
    .from(users)
    .where(eq(users.id, userId))
    .execute();

  // ── The windowed counts ────────────────────────────────────────────────────────────────────
  const [openedRow, mergedRow, closedRow, humanCommentsRow, repoRows, mergedPrs] = await Promise.all([
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(and(authored, gte(pullRequests.openedAt, from), lt(pullRequests.openedAt, to)))
      .execute(),
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(and(authored, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
      .execute(),
    // Closed WITHOUT merging, inside the window. `mergedAt IS NULL` is the discriminator —
    // GitHub stamps closedAt on a merge too, so a bare closedAt window would double-count every
    // merged PR as wasted churn.
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(
        and(
          authored,
          isNull(pullRequests.mergedAt),
          gte(pullRequests.closedAt, from),
          lt(pullRequests.closedAt, to),
        ),
      )
      .execute(),
    // Human review comments left ON its PRs in the window — the time it cost people. Bot-authored
    // comments are excluded through the lane resolver, not a login test, so one bot reviewing
    // another bot's PRs never reads as human attention.
    db
      .select({ authorId: reviewComments.authorId, c: count() })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          authored,
          gte(reviewComments.createdAt, from),
          lt(reviewComments.createdAt, to),
        ),
      )
      .groupBy(reviewComments.authorId)
      .execute(),
    // Repos touched: PRs it OPENED or MERGED in the window, by repo. One two-sided predicate per
    // column, OR-ed — a PR opened before the window and merged inside it still counts the repo.
    db
      .select({ repoId: pullRequests.repoId, owner: repos.owner, name: repos.name, c: count() })
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          authored,
          // Portable `or(and(…), and(…))`, never a raw `sql` template: drizzle binds a template's
          // `${date}` straight through, and better-sqlite3 refuses a Date — the same expression
          // that type-checks fine throws at the first call. Two-sided on both columns.
          or(
            and(gte(pullRequests.openedAt, from), lt(pullRequests.openedAt, to)),
            and(gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)),
          ),
        ),
      )
      .groupBy(pullRequests.repoId, repos.owner, repos.name)
      .orderBy(desc(count()))
      .execute(),
    // The merged-in-window population, carrying everything the medians need in one read.
    db
      .select({
        id: pullRequests.id,
        openedAt: pullRequests.openedAt,
        mergedAt: pullRequests.mergedAt,
        additions: pullRequests.additions,
        deletions: pullRequests.deletions,
      })
      .from(pullRequests)
      .where(and(authored, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
      .orderBy(desc(pullRequests.mergedAt))
      .limit(AUTOMATION_MERGED_PR_CAP)
      .execute(),
  ]);

  const opened = openedRow[0]?.c ?? 0;
  const merged = mergedRow[0]?.c ?? 0;
  const closedUnmerged = closedRow[0]?.c ?? 0;

  const humanComments = humanCommentsRow
    .filter((r) => lanes.laneOf(r.authorId) === 'human')
    .reduce((sum, r) => sum + r.c, 0);

  // Merge rate over the RESOLVED population (merged + closed-unmerged, both windowed). Not over
  // `opened`: a PR opened on the last day of the window has not had its chance yet, and dividing
  // by it would make a busy final week look like a failing bot.
  const resolved = merged + closedUnmerged;
  const mergeRate = resolved > 0 ? round2((merged / resolved) * 100) : null;

  const hoursToMerge = mergedPrs
    .map((p) =>
      p.mergedAt != null && p.openedAt != null
        ? (p.mergedAt.getTime() - p.openedAt.getTime()) / 3_600_000
        : null,
    )
    .filter((v): v is number => v != null && Number.isFinite(v) && v >= 0);
  const sizes = mergedPrs.map((p) => p.additions + p.deletions);

  // ── "Merged with no human in the loop" ─────────────────────────────────────────────────────
  // Over the merged-in-window ids, ALL-TIME (see the header note on why that is still
  // window-pure). A PR counts as human-touched if any human submitted a review OR left a review
  // comment on it, ever.
  const mergedIds = mergedPrs.map((p) => p.id);
  let mergedNoHuman: number | null = null;
  if (mergedIds.length > 0) {
    const [reviewRows, commentRows] = await Promise.all([
      db
        .select({ prId: reviews.prId, authorId: reviews.authorId })
        .from(reviews)
        .where(and(inArray(reviews.prId, mergedIds), ne(reviews.state, 'pending')))
        .execute(),
      db
        .select({ prId: reviewComments.prId, authorId: reviewComments.authorId })
        .from(reviewComments)
        .where(inArray(reviewComments.prId, mergedIds))
        .execute(),
    ]);
    const touched = new Set<number>();
    for (const r of [...reviewRows, ...commentRows]) {
      if (lanes.laneOf(r.authorId) === 'human') touched.add(r.prId);
    }
    mergedNoHuman = mergedIds.filter((id) => !touched.has(id)).length;
  }

  const metrics: AutomationMetricValue[] = [
    countCell('prs_opened', opened),
    countCell('prs_merged', merged),
    countCell('prs_closed_unmerged', closedUnmerged),
    cell('merge_rate_pct', mergeRate, resolved),
    cell('median_hours_to_merge', hoursToMerge.length > 0 ? round2(median(hoursToMerge)!) : null, hoursToMerge.length),
    cell('median_pr_size_lines', sizes.length > 0 ? Math.round(median(sizes)!) : null, sizes.length),
    cell('prs_merged_without_human_review', mergedNoHuman, mergedIds.length),
    countCell('human_review_comments_received', humanComments),
    countCell('repos_touched', repoRows.length),
  ];

  const roleByUser = await reviewerRoleForUser(accountId, scope.workspaceId);
  const role: ReviewerRole | null = roleByUser.get(userId) ?? null;

  const out: AutomationOutput = {
    userId,
    login: identity?.login ?? null,
    displayName: identity?.name ?? null,
    role,
    repos: repoRows.slice(0, REPO_LIST_CAP).map((r) => ({
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      prs: r.c,
    })),
    metrics,
  };

  if (opts.evidence === true) {
    out.evidence = await loadAutomationEvidence(accountId, scope, userId, out.login, from, to, lanes);
  }
  return out;
}

/** The receipt rows. Each group is capped at PERSON_EVIDENCE_CAP with an honest remainder, and
 *  each is the SAME population as the metric it sits under — a card a reader can check the
 *  figure against, never a differently-filtered list that happens to look related. */
async function loadAutomationEvidence(
  accountId: number,
  scope: BotScope,
  userId: number,
  subjectLogin: string | null,
  from: Date,
  to: Date,
  lanes: Awaited<ReturnType<typeof resolveActorLanes>>,
): Promise<AutomationOutputEvidence> {
  const inScope = and(
    eq(pullRequests.accountId, accountId),
    inArray(pullRequests.repoId, scope.repoIds),
  );
  const authored = and(inScope, eq(pullRequests.authorId, userId));

  // Everything DigestPrRef renders, selected once. The table draws PR | CI | age | author | diff,
  // so omitting `ciStatus`/`openedAt`/`changedFiles` leaves two columns as bare dashes on every
  // row — the shape looks finished and reads as "no data" rather than "not selected".
  const selectPr = {
    prId: pullRequests.id,
    prNumber: pullRequests.number,
    repoId: pullRequests.repoId,
    repoOwner: repos.owner,
    repoName: repos.name,
    title: pullRequests.title,
    state: pullRequests.state,
    ciStatus: pullRequests.ciStatus,
    openedAt: pullRequests.openedAt,
    additions: pullRequests.additions,
    deletions: pullRequests.deletions,
    changedFiles: pullRequests.changedFiles,
  };

  const [mergedRows, mergedTotal, closedRows, closedTotal, commentedRows] = await Promise.all([
    db
      .select(selectPr)
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(and(authored, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
      .orderBy(desc(pullRequests.mergedAt))
      .limit(PERSON_EVIDENCE_CAP)
      .execute(),
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(and(authored, gte(pullRequests.mergedAt, from), lt(pullRequests.mergedAt, to)))
      .execute(),
    db
      .select(selectPr)
      .from(pullRequests)
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(
          authored,
          isNull(pullRequests.mergedAt),
          gte(pullRequests.closedAt, from),
          lt(pullRequests.closedAt, to),
        ),
      )
      .orderBy(desc(pullRequests.closedAt))
      .limit(PERSON_EVIDENCE_CAP)
      .execute(),
    db
      .select({ c: count() })
      .from(pullRequests)
      .where(
        and(
          authored,
          isNull(pullRequests.mergedAt),
          gte(pullRequests.closedAt, from),
          lt(pullRequests.closedAt, to),
        ),
      )
      .execute(),
    // PRs of its that drew review comments in the window, with the commenter so the human filter
    // runs through the lane resolver rather than in SQL. Capped generously before folding, since
    // the fold collapses many comments onto few PRs.
    db
      .select({
        ...selectPr,
        commenterId: reviewComments.authorId,
        commentedAt: reviewComments.createdAt,
      })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .innerJoin(repos, eq(repos.id, pullRequests.repoId))
      .where(
        and(authored, gte(reviewComments.createdAt, from), lt(reviewComments.createdAt, to)),
      )
      .orderBy(desc(reviewComments.createdAt))
      .limit(PERSON_EVIDENCE_CAP * 20)
      .execute(),
  ]);

  // No cast: every DigestPrRef field is spelled out, so dropping one from `selectPr` becomes a
  // compile error rather than a silently blank column.
  const toRef = (r: {
    prId: number;
    prNumber: number;
    repoId: number;
    repoOwner: string;
    repoName: string;
    title: string | null;
    state: PrState;
    ciStatus: CiStatus | null;
    openedAt: Date | null;
    additions: number;
    deletions: number;
    changedFiles: number;
  }): DigestPrRef => ({
    prId: r.prId,
    prNumber: r.prNumber,
    repoId: r.repoId,
    repoFullName: `${r.repoOwner}/${r.repoName}`,
    title: r.title,
    // The author is the subject of this whole vector, so the login is resolved once by the caller
    // rather than re-joined per row; `authorId` is what the table renders an avatar from.
    authorLogin: subjectLogin,
    authorId: userId,
    state: r.state,
    ciStatus: r.ciStatus,
    additions: r.additions,
    deletions: r.deletions,
    changedFiles: r.changedFiles,
    openedAt: r.openedAt?.toISOString() ?? null,
  });

  // One row per PR, newest comment first, humans only.
  const seen = new Set<number>();
  const humanReviewed: DigestPrRef[] = [];
  let humanReviewedSeen = 0;
  for (const r of commentedRows) {
    if (lanes.laneOf(r.commenterId) !== 'human') continue;
    if (seen.has(r.prId)) continue;
    seen.add(r.prId);
    humanReviewedSeen += 1;
    if (humanReviewed.length < PERSON_EVIDENCE_CAP) humanReviewed.push(toRef(r));
  }

  const mergedCount = mergedTotal[0]?.c ?? 0;
  const closedCount = closedTotal[0]?.c ?? 0;
  return {
    merged: mergedRows.map(toRef),
    mergedMore: Math.max(0, mergedCount - mergedRows.length),
    closedUnmerged: closedRows.map(toRef),
    closedUnmergedMore: Math.max(0, closedCount - closedRows.length),
    humanReviewed,
    // The remainder here is over what the capped scan SAW, so it can under-report on a very
    // chatty period. That is why the caption says "at least" — it must never claim to be the
    // population figure the way the two above do.
    humanReviewedMore: Math.max(0, humanReviewedSeen - humanReviewed.length),
  };
}
