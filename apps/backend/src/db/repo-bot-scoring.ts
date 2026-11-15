// A REPO LEFT OUT OF BOT COMMENT SCORING (Repos & workspaces; `repos.bot_scoring_excluded`, migration 0199).
// The scoring worker (sync/ml-enrichment.ts) skips these repos' bot comments; labels already stored stay.
// Account-scoped: a repo id from a request body only ever matches the caller's own row.

import { and, eq } from 'drizzle-orm';
import { db, schema } from './client.js';

/** Set the switch. Returns false when the repo is not this account's. */
export async function setRepoBotScoringExcluded(accountId: number, repoId: number, excluded: boolean): Promise<boolean> {
  const { repos } = schema;
  const rows = await db
    .update(repos)
    .set({ botScoringExcluded: excluded })
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .returning({ id: repos.id })
    .execute();
  return rows.length > 0;
}

/** The account's repos left out of bot comment scoring. */
export async function botScoringExcludedRepoIds(accountId: number): Promise<Set<number>> {
  const { repos } = schema;
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), eq(repos.botScoringExcluded, true)))
    .execute();
  return new Set(rows.map((r) => r.id));
}
