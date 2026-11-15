// ONE REPO's panel in Repos & workspaces (GET /api/repos/:id/overview): what was synced (the last 90
// days), by state, and its bot comment scoring. DB only: opening the panel makes no GitHub call.
// Account-scoped: a foreign repo id reads as null (→ 404).

import { and, eq, sql } from 'drizzle-orm';
import type { RepoOverviewResponse } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getMlBacklogForRepo } from './ml-labels.js';

export async function getRepoOverview(accountId: number, repoId: number): Promise<RepoOverviewResponse | null> {
  const { repos, pullRequests } = schema;
  const [repo] = await db
    .select({ id: repos.id, botScoringEnabled: repos.botScoringEnabled })
    .from(repos)
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .execute();
  if (repo == null) return null;

  const rows = await db
    .select({ state: pullRequests.state, n: sql<number>`count(*)` })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId)))
    .groupBy(pullRequests.state)
    .execute();
  const by = (s: string): number => Number(rows.find((r) => r.state === s)?.n ?? 0);
  const prs = { open: by('open'), merged: by('merged'), closed: by('closed'), total: 0 };
  prs.total = prs.open + prs.merged + prs.closed;

  const [authorRow] = await db
    .select({ n: sql<number>`count(distinct ${pullRequests.authorId})` })
    .from(pullRequests)
    .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId)))
    .execute();

  const counts = await getMlBacklogForRepo(accountId, repoId, repo.botScoringEnabled);
  return {
    repoId,
    prs,
    authors: Number(authorRow?.n ?? 0),
    botScoring: { enabled: repo.botScoringEnabled, ...counts },
  };
}
