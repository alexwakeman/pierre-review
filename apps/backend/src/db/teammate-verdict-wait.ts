// THE AUTHOR'S SIDE OF A TEAMMATE'S VERDICT (docs/TEAM-REVIEW.md § 4, "A teammate's verdict"). On the
// reader's OWN open PR, their Limn's review is on GitHub at the head, but an author cannot approve
// their own PR: a teammate's Limn has to give the verdict. Until one has reviewed that head, the AI
// Review tab and the Pending "Waiting on others" row say "Waiting for a teammate's Limn to review".
//
// ⚠ ONLY WITH EVIDENCE. Limn cannot see a teammate's settings, so it says this only when a teammate's
// Limn posted an AUTOMATIC review in the same workspace within TEAMMATE_AUTO_SEEN_MS. Otherwise it says
// nothing rather than promise a review nobody's Limn will start.
//
// DB-only, account-scoped. ⚠ Opens NO database at import (every reader takes an executor).
import { and, eq, gte, inArray, isNotNull, ne } from 'drizzle-orm';
import type { ClaudeTeammateVerdictWait, TeammateReviewRecord } from '@pierre-review/shared';
import type { Executor } from './client.js';
import * as schema from './schema.sqlite.js';
import { TEAMMATE_KIND } from './teammate-reviews.js';

const { pullRequests, workspaceRepos } = schema;
const cr = schema.claudeReviews;

/** A teammate's Limn auto review seen this recently counts as "a teammate's Limn has auto review on". */
export const TEAMMATE_AUTO_SEEN_MS = 14 * 24 * 60 * 60 * 1000;

/** Pure: the wait on one PR, from its rows. null = not waiting. */
export function teammateVerdictWaitOf(input: {
  headSha: string | null;
  ownPostedAtHead: readonly Date[];
  teammateAtHead: number;
  teammateAutoSeen: boolean;
}): ClaudeTeammateVerdictWait | null {
  if (!input.headSha || input.ownPostedAtHead.length === 0) return null;
  if (input.teammateAtHead > 0 || !input.teammateAutoSeen) return null;
  const since = Math.min(...input.ownPostedAtHead.map((d) => d.getTime()));
  return { headSha: input.headSha, since: new Date(since).toISOString() };
}

/**
 * The reader's own open PRs among `prIds` that wait for a teammate's Limn verdict. `readerUserId` is the
 * reader's `users` row (null ⇒ none). Never throws on an empty list.
 */
export async function teammateVerdictWaits(
  exec: Executor,
  accountId: number,
  readerUserId: number | null,
  prIds: readonly number[],
  nowMs: number = Date.now(),
): Promise<Map<number, ClaudeTeammateVerdictWait>> {
  const out = new Map<number, ClaudeTeammateVerdictWait>();
  if (readerUserId == null || prIds.length === 0) return out;
  const prs = await exec
    .select({
      id: pullRequests.id,
      repoId: pullRequests.repoId,
      headSha: pullRequests.headSha,
      authorId: pullRequests.authorId,
      openedFor: pullRequests.limnOpenedForUserId,
    })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.id, [...prIds]),
        eq(pullRequests.state, 'open'),
        eq(pullRequests.isDraft, false),
      ),
    )
    .execute();
  const mine = prs.filter((p) => (p.openedFor ?? p.authorId) === readerUserId && p.headSha);
  if (mine.length === 0) return out;
  const runs = await exec
    .select({ prId: cr.prId, headSha: cr.headSha, kind: cr.kind, postedAt: cr.postedAt, sourceUserId: cr.sourceUserId })
    .from(cr)
    .where(and(eq(cr.accountId, accountId), inArray(cr.prId, mine.map((p) => p.id)), isNotNull(cr.postedAt)))
    .execute();
  // The workspaces these PRs sit in, and whether a teammate's Limn ran an AUTO review in each lately.
  const wsRows = await exec
    .select({ repoId: workspaceRepos.repoId, workspaceId: workspaceRepos.workspaceId })
    .from(workspaceRepos)
    .where(and(eq(workspaceRepos.accountId, accountId), inArray(workspaceRepos.repoId, [...new Set(mine.map((p) => p.repoId))])))
    .execute();
  const wsOfRepo = new Map(wsRows.map((r) => [r.repoId, r.workspaceId]));
  const wsIds = [...new Set(wsRows.map((r) => r.workspaceId))];
  const autoSeen = new Set<number>();
  if (wsIds.length > 0) {
    const recent = await exec
      .select({ workspaceId: workspaceRepos.workspaceId, teammate: cr.teammate })
      .from(cr)
      .innerJoin(pullRequests, eq(pullRequests.id, cr.prId))
      .innerJoin(workspaceRepos, and(eq(workspaceRepos.repoId, pullRequests.repoId), eq(workspaceRepos.accountId, accountId)))
      .where(
        and(
          eq(cr.accountId, accountId),
          eq(cr.kind, TEAMMATE_KIND),
          ne(cr.sourceUserId, readerUserId),
          gte(cr.postedAt, new Date(nowMs - TEAMMATE_AUTO_SEEN_MS)),
          inArray(workspaceRepos.workspaceId, wsIds),
        ),
      )
      .execute();
    for (const r of recent) {
      if ((r.teammate as TeammateReviewRecord | null)?.run === 'auto') autoSeen.add(r.workspaceId);
    }
  }
  for (const p of mine) {
    const here = runs.filter((r) => r.prId === p.id && r.headSha === p.headSha);
    const ws = wsOfRepo.get(p.repoId);
    const wait = teammateVerdictWaitOf({
      headSha: p.headSha,
      ownPostedAtHead: here.filter((r) => r.kind == null).map((r) => r.postedAt!),
      teammateAtHead: here.filter((r) => r.kind === TEAMMATE_KIND && r.sourceUserId !== readerUserId).length,
      teammateAutoSeen: ws != null && autoSeen.has(ws),
    });
    if (wait) out.set(p.id, wait);
  }
  return out;
}

