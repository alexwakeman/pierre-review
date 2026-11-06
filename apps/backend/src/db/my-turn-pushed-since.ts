import { and, eq, inArray } from 'drizzle-orm';
import {
  PUSHED_SINCE_LIST_MAX,
  type PushedCommit,
  type PushedSinceCommitsResponse,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { lastActionClocks } from './queries.js';
import { myTurnFloorOf } from './my-turn-floor.js';
import { getAccountUserId } from '../auth/account.js';

const { commits, pullRequests, repos } = schema;

// ── "N COMMITS SINCE YOU …" — THE EXPANDED LIST ON A "PUSHED SINCE" MY TURN CARD ───────────────
//
// The card carries the count (`NewPrBall.humanCommitsAfter`) and the newest `PUSHED_COMMITS_SHOWN`.
// When the reader opens the card's disclosure, this lists EVERY commit that count names. It runs
// the SAME fold (`lastActionClocks`) on the one PR, so the list and the count cannot disagree:
// human commits by someone other than you, strictly after your last review (any state), review
// comment, PR comment or push, and AT or after the repo's onboarding floor (`myTurnFloorOf`, the
// fold's own narrowing). NOT "since you last looked" — viewing is not acting (`pr_views` is
// never read here, as in the fold). DB only; ⚠ fetched only on expand, never on the board's mount.

/** null ⇔ the PR is not this account's, or not in the workspace's repos (→ 404). */
export async function getPushedSinceCommits(
  accountId: number,
  prId: number,
  workspaceId: number,
  repoIds: readonly number[],
  listMax: number = PUSHED_SINCE_LIST_MAX,
): Promise<PushedSinceCommitsResponse | null> {
  if (repoIds.length === 0) return null;
  const pr = await db
    .select({ id: pullRequests.id, createdAt: repos.createdAt, firstOnboarding: repos.firstOnboarding })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.id, prId),
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.repoId, [...repoIds]),
      ),
    )
    .limit(1)
    .execute();
  if (pr.length === 0) return null;

  const empty: PushedSinceCommitsResponse = {
    workspaceId,
    prId,
    yourLastAction: null,
    anchorAt: null,
    total: 0,
    commits: [],
  };
  const viewerId = await getAccountUserId(accountId);
  if (viewerId == null) return empty;
  const c = (await lastActionClocks(viewerId, [prId])).get(prId);
  if (!c || c.mineLast == null) return empty;

  const floor = myTurnFloorOf(pr[0]!).getTime();
  const counted = c.humanCommitIdsAfterMine.filter((x) => x.at.getTime() >= floor).sort(
    (a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id,
  );
  const shownIds = counted.slice(0, Math.max(0, listMax)).map((x) => x.id);
  let list: PushedCommit[] = [];
  if (shownIds.length > 0) {
    const rows = await db
      .select({
        id: commits.id,
        sha: commits.sha,
        headline: commits.messageHeadline,
        authorId: commits.authorId,
        at: commits.committedAt,
      })
      .from(commits)
      .where(and(eq(commits.prId, prId), inArray(commits.id, shownIds)))
      .execute();
    list = rows
      .sort((a, b) => b.at.getTime() - a.at.getTime() || b.id - a.id)
      .map((r) => ({
        sha: r.sha,
        headline: r.headline ?? null,
        authorId: r.authorId,
        at: r.at.toISOString(),
      }));
  }
  return {
    workspaceId,
    prId,
    yourLastAction: c.mineLastAction,
    anchorAt: c.mineLast.toISOString(),
    total: counted.length,
    commits: list,
  };
}
