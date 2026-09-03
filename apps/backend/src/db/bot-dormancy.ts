// ── "Is this bot dormant?" — ONE predicate, ONE window, CORE ─────────────────────────────────
//
// The Bots → ROI table has always been able to say a reviewer is DORMANT: it is still classified,
// still (perhaps) paid for, and it did nothing inside the window being read. Two OTHER surfaces —
// the Bots → Benchmark tab and the Bot Tuning Advisor — used to keep rendering those reviewers, so
// one screen said "dormant" while the next two placed the same bot against a peer cohort and
// offered tuning advice for it. This module is the one fact both of those surfaces now hide on.
//
// ⚠ THE WINDOW IS FIXED AT 30 DAYS AND MUST STAY FIXED. The three surfaces disagreed about time
// before this existed: ROI defaults to a trailing 14 days that the USER FLIPS with a chip, the
// Advisor is pinned to `rolling_30`, and the benchmark fold has no time window at all. Adopting the
// ROI chip's value would make a workspace's peer placement appear and disappear because somebody
// flipped a selector on a different tab — a fact about a bot must not be a function of another
// screen's view state. 30 days is the Advisor's existing pin, so no surface changed its own window
// to gain this gate.
//
// ⚠ CONSEQUENCE, STATED RATHER THAN HIDDEN: a bot with nothing in the last 14 days but something in
// the last 30 reads "dormant" on the ROI table (relative to the view) and still appears on the
// Benchmark and the Advisor (it is not dormant as a fact). That is deliberate. The ROI table's
// window chip and its "widen the window to see them counted" affordance are about the CURRENT VIEW;
// this predicate is about the BOT.
//
// ⚠ THE GRAIN IS THE WORKSPACE, NEVER A REPO. The Advisor cannot narrow by repository at all (the
// SPA sends only `?workspace=`), and a `?repoIds=`-narrowed benchmark request deliberately builds no
// rollup — so a repo-grained gate has nowhere to land on two of the three surfaces. The repository
// set below is therefore the workspace's MEMBERSHIP and never a caller's `repoIds` narrowing, the
// same rule `workspaceHumanSeatCount` follows for the same reason: the answer must not shrink
// because a reader filtered a chart.
//
// ⚠ THE EVIDENCE IS EXACTLY THE ROI TABLE'S, DELIBERATELY. `getBotAnalytics` calls a reviewer
// dormant when it has NO window activity, where activity is: a review THREAD it opened, a review
// COMMENT it left, or a submitted REVIEW (body-only "nothing to flag" passes included — that is a
// bot doing its job and saying so). Three tables, unioned. The Advisor's own emission gate is
// narrower (threads-or-ML-labels), so a bot can already be absent from the Advisor while ROI calls
// it live; widening THIS predicate to match the Advisor instead would hide bots the ROI table shows
// as working, which is the opposite of what a reader asked for. The union is the safe direction:
// any observed work at all keeps a reviewer visible.
//
// The predicate is CORE because both consumers must not be able to disagree: the Advisor filter
// lives in `getAdvisorFindings` (`db/queries.ts`), and the benchmark reaches this through the
// OPTIONAL `ProHostQueries.dormantBotUserIds` seam (apiVersion stays 21 — the `getWorkPlan` /
// `workspaceHumanSeatCount` precedent; an older host simply hides nothing).
//
// ⚠ IT DELIBERATELY IMPORTS NOTHING FROM `queries.ts`. That file imports this one (the Advisor
// filter lives inside `getAdvisorFindings`), and a cycle between the two would be a hazard nobody
// wants in the app's largest module. The membership read below is the two lines of
// `getWorkspaceRepoIds` this needs, minus the render ordering a set does not care about; the
// candidate ids are the CALLER's, which is also what stops this module owning a second opinion
// about who is a bot.
import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { db, schema } from './client.js';

/** The ONE dormancy window, in days. See the header: fixed on purpose, and equal to the Advisor's
 *  existing `rolling_30` pin so no surface moved its own window to gain this gate. */
export const DORMANCY_WINDOW_DAYS = 30;

const { pullRequests, reviewComments, reviewThreads, reviews, workspaceRepos } = schema;

/**
 * The automated reviewers that produced NO observable work in this workspace over the fixed
 * dormancy window.
 *
 * `candidateUserIds` IS THE CALLER'S OWN LINEUP and is required: the Advisor passes the automated
 * set it already resolved, the benchmark passes the review vendors it is about. Nothing here
 * re-decides who is a bot — a second classifier is how a benchmark ends up disagreeing with the
 * Timeline about a login. The result is always a SUBSET of the candidates, so a caller can treat it
 * as a plain "hide these" set.
 *
 * ⚠ An empty workspace (no repos) yields NO dormant ids rather than "all of them". Dormancy is a
 * claim about observed silence, and a workspace whose data we hold none of has observed nothing —
 * hiding every bot there would be an absence rendered as a judgement.
 */
export async function dormantBotUserIds(
  accountId: number,
  workspaceId: number,
  candidateUserIds: readonly number[],
): Promise<number[]> {
  const candidates = [...new Set(candidateUserIds)];
  if (candidates.length === 0) return [];
  // ⚠ MEMBERSHIP, NOT A NARROWING — see the header. Account-scoped on both columns, so a foreign or
  // unknown workspace id yields no repos and therefore no dormant ids (never another tenant's).
  const memberRows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(
      and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, workspaceId)),
    )
    .execute();
  const repoIds = memberRows.map((r) => r.repoId);
  if (repoIds.length === 0) return [];

  const since = new Date(Date.now() - DORMANCY_WINDOW_DAYS * 86_400_000);
  const repoScope = inArray(pullRequests.repoId, repoIds);
  const [threadRows, commentRows, reviewRows] = await Promise.all([
    db
      .selectDistinct({ userId: reviewThreads.originalCommenterId })
      .from(reviewThreads)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewThreads.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewThreads.originalCommenterId, candidates),
          gte(reviewThreads.createdAt, since),
          repoScope,
        ),
      )
      .execute(),
    db
      .selectDistinct({ userId: reviewComments.authorId })
      .from(reviewComments)
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewComments.authorId, candidates),
          gte(reviewComments.createdAt, since),
          repoScope,
        ),
      )
      .execute(),
    // A body-only review IS activity — the ROI table counts it for exactly this decision, and a
    // reviewer that reads a PR and says "nothing to flag" is working.
    db
      .selectDistinct({ userId: reviews.authorId })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviews.authorId, candidates),
          ne(reviews.state, 'pending'),
          gte(reviews.submittedAt, since),
          repoScope,
        ),
      )
      .execute(),
  ]);

  const active = new Set<number>();
  for (const rows of [threadRows, commentRows, reviewRows])
    for (const r of rows) if (r.userId != null) active.add(r.userId);
  return candidates.filter((id) => !active.has(id));
}
