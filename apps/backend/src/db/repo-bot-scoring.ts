// BOT COMMENT SCORING, OPT-IN PER REPO (Repos & workspaces → the repo's panel → Bot scoring;
// `repos.bot_scoring_enabled`, migration 0201). The scoring worker (sync/ml-enrichment.ts) scores only
// these repos' bot comments, and the backlog the sync UI shows (db/ml-labels.ts) counts only them.
// Switching a repo off stops new scoring; labels already stored stay.
// Account-scoped: a repo id from a request only ever matches the caller's own row.

import { and, eq } from 'drizzle-orm';
import { db, schema } from './client.js';

/** Switch scoring on or off for one repo. Returns false when the repo is not this account's. */
export async function setRepoBotScoring(accountId: number, repoId: number, enabled: boolean): Promise<boolean> {
  const { repos } = schema;
  const rows = await db
    .update(repos)
    .set({ botScoringEnabled: enabled })
    .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
    .returning({ id: repos.id })
    .execute();
  return rows.length > 0;
}

/** The account's repos whose bot comments are scored. */
export async function botScoringEnabledRepoIds(accountId: number): Promise<Set<number>> {
  const { repos } = schema;
  const rows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), eq(repos.botScoringEnabled, true)))
    .execute();
  return new Set(rows.map((r) => r.id));
}

/**
 * The workspace repos whose bot comments are scored: switched ON in Repos & workspaces, and not
 * EXTERNAL (db/external-repos.ts: their bot comments are not watched). The ONE rule, read by the
 * worker and by the backlog count, so "pending" is exactly what the worker will pick up.
 */
export function scoreableRepoIds(
  workspace: { repoIds: number[]; externalRepoIds?: number[] },
  enabled: ReadonlySet<number>,
): number[] {
  const external = new Set(workspace.externalRepoIds ?? []);
  return workspace.repoIds.filter((id) => enabled.has(id) && !external.has(id));
}
