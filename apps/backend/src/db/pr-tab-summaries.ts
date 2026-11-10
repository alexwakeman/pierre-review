// THE OPEN-TABS HOVER CARD'S READ (CORE, DB-only; shared `pr-tab-summary.ts`, docs/API.md
// § POST /api/prs/tab-summaries). One batch for every PR tab the sidebar holds: the stored row, its
// repo's name, its author and its thread counts by derived state. No GitHub call, no hydration.
//
// ⚠ Every predicate carries `accountId`: another account's PR is ABSENT, exactly like one never synced.
import { and, count, eq, inArray } from 'drizzle-orm';
import type {
  CiStatus,
  Mergeable,
  MergeStateStatus,
  PrTabSummary,
  ThreadStateCounts,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { pullRequests, repos, users, reviewThreads } = schema;

export async function getPrTabSummaries(accountId: number, prIds: readonly number[]): Promise<PrTabSummary[]> {
  const ids = [...new Set(prIds)];
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      title: pullRequests.title,
      state: pullRequests.state,
      isDraft: pullRequests.isDraft,
      ciStatus: pullRequests.ciStatus,
      mergeable: pullRequests.mergeable,
      mergeStateStatus: pullRequests.mergeStateStatus,
      reviewDecision: pullRequests.reviewDecision,
      inMergeQueue: pullRequests.inMergeQueue,
      owner: repos.owner,
      name: repos.name,
      authorLogin: users.githubLogin,
      authorDisplayName: users.displayName,
    })
    .from(pullRequests)
    .innerJoin(repos, and(eq(repos.id, pullRequests.repoId), eq(repos.accountId, accountId)))
    .leftJoin(users, eq(users.id, pullRequests.authorId))
    .where(and(eq(pullRequests.accountId, accountId), inArray(pullRequests.id, ids)))
    .execute();
  if (rows.length === 0) return [];

  const counts = new Map<number, ThreadStateCounts>();
  const countRows = await db
    .select({ prId: reviewThreads.prId, state: reviewThreads.derivedState, c: count() })
    .from(reviewThreads)
    .where(inArray(reviewThreads.prId, rows.map((r) => r.id)))
    .groupBy(reviewThreads.prId, reviewThreads.derivedState)
    .execute();
  for (const r of countRows) {
    const entry = counts.get(r.prId) ?? { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 };
    entry[r.state] = r.c;
    counts.set(r.prId, entry);
  }

  return rows.map((r) => ({
    id: r.id,
    repoFullName: `${r.owner}/${r.name}`,
    number: r.number,
    title: r.title,
    authorLogin: r.authorLogin ?? null,
    authorDisplayName: r.authorDisplayName ?? null,
    state: r.state,
    isDraft: r.isDraft,
    ciStatus: (r.ciStatus ?? 'unknown') as CiStatus,
    mergeable: (r.mergeable ?? 'unknown') as Mergeable,
    mergeStateStatus: (r.mergeStateStatus ?? 'unknown') as MergeStateStatus,
    reviewDecision: r.reviewDecision ?? null,
    inMergeQueue: r.inMergeQueue === true,
    threadCounts: counts.get(r.id) ?? { resolved: 0, likely_addressed: 0, replied_unresolved: 0, untouched: 0 },
  }));
}
