import { and, eq, inArray, ne, or } from 'drizzle-orm';
import { RELATED_REPOS_MAX_PER_REPO, type RelatedRepoPair } from '@pierre-review/shared';
import { db, runTransaction, schema, type Executor } from './client.js';

// RELATED REPOS (docs/CLAUDE-REVIEW.md § Related repos) — repos of ONE workspace the reader reviews
// together. A deep review of a PR in one reads the companion change in the other, read-only
// (review/claude-review/related-repos.ts picks it).
//
// ⚠ SYMMETRIC, STORED BOTH WAYS: a pair is two rows, (a → b) and (b → a), written and deleted
// together, so "what is related to this repo" is one indexed lookup and can never be one-sided.
//
// ⚠ BOTH REPOS MUST BE MEMBERS OF THE ROW'S WORKSPACE NOW. A repo that moves out (or is deleted)
// loses its relations (`dropRepoRelations`, called by every membership writer in queries.ts), and
// every reader below joins membership anyway — a row some path forgot to delete is never read.

const { repoRelations, workspaceRepos, workspaces } = schema;

async function memberIds(accountId: number, workspaceId: number): Promise<Set<number>> {
  const rows = await db
    .select({ repoId: workspaceRepos.repoId })
    .from(workspaceRepos)
    .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, workspaceId)))
    .execute();
  return new Set(rows.map((r) => r.repoId));
}

async function workspaceOwned(accountId: number, workspaceId: number): Promise<boolean> {
  const rows = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .limit(1)
    .execute();
  return rows.length > 0;
}

/**
 * The workspace's related pairs, each once (`repoId < relatedRepoId`), both repos members NOW.
 * null when the workspace is not this account's (the route answers 404).
 */
export async function getRelatedRepoPairs(
  accountId: number,
  workspaceId: number,
): Promise<RelatedRepoPair[] | null> {
  if (!(await workspaceOwned(accountId, workspaceId))) return null;
  const members = await memberIds(accountId, workspaceId);
  const rows = await db
    .select({ repoId: repoRelations.repoId, relatedRepoId: repoRelations.relatedRepoId })
    .from(repoRelations)
    .where(and(eq(repoRelations.accountId, accountId), eq(repoRelations.workspaceId, workspaceId)))
    .execute();
  const seen = new Set<string>();
  const out: RelatedRepoPair[] = [];
  for (const r of rows) {
    if (!members.has(r.repoId) || !members.has(r.relatedRepoId) || r.repoId === r.relatedRepoId) continue;
    const a = Math.min(r.repoId, r.relatedRepoId);
    const b = Math.max(r.repoId, r.relatedRepoId);
    const k = `${a}:${b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ repoId: a, relatedRepoId: b });
  }
  out.sort((x, y) => x.repoId - y.repoId || x.relatedRepoId - y.relatedRepoId);
  return out;
}

/**
 * REPLACE one repo's relations in its workspace: afterwards the repo is related to exactly the
 * given repos (both ways). Ids that are not members of the workspace, the repo itself, anything
 * past RELATED_REPOS_MAX_PER_REPO and a partner that already has RELATED_REPOS_MAX_PER_REPO
 * relations of its own are dropped. Returns false when the workspace is not this
 * account's or the repo is not in it (the route answers 404).
 */
export async function setRelatedRepos(
  accountId: number,
  workspaceId: number,
  repoId: number,
  relatedRepoIds: readonly number[],
): Promise<boolean> {
  if (!(await workspaceOwned(accountId, workspaceId))) return false;
  const members = await memberIds(accountId, workspaceId);
  if (!members.has(repoId)) return false;
  const wanted = [...new Set(relatedRepoIds)]
    .filter((id) => id !== repoId && members.has(id))
    .slice(0, RELATED_REPOS_MAX_PER_REPO);
  await runTransaction(async (tx) => {
    // Both directions of every current relation of this repo, in this workspace.
    await tx
      .delete(repoRelations)
      .where(
        and(
          eq(repoRelations.accountId, accountId),
          eq(repoRelations.workspaceId, workspaceId),
          or(eq(repoRelations.repoId, repoId), eq(repoRelations.relatedRepoId, repoId)),
        ),
      )
      .execute();
    for (const other of wanted) {
      // ⚠ THE CAP HOLDS ON BOTH SIDES: a partner already related to RELATED_REPOS_MAX_PER_REPO other
      // repos is skipped (Settings disables its box), or nine repos each saving [A] would give A nine.
      // This repo's own rows were deleted above, so the count is the partner's OTHER relations.
      const partnerRows = await tx
        .select({ relatedRepoId: repoRelations.relatedRepoId })
        .from(repoRelations)
        .where(
          and(
            eq(repoRelations.accountId, accountId),
            eq(repoRelations.workspaceId, workspaceId),
            eq(repoRelations.repoId, other),
          ),
        )
        .execute();
      const partnerCount = new Set(partnerRows.map((r) => r.relatedRepoId).filter((id) => id !== other && members.has(id))).size;
      if (partnerCount >= RELATED_REPOS_MAX_PER_REPO) continue;
      for (const [a, b] of [
        [repoId, other],
        [other, repoId],
      ] as const) {
        await tx
          .insert(repoRelations)
          .values({ accountId, workspaceId, repoId: a, relatedRepoId: b })
          .onConflictDoNothing({
            target: [repoRelations.accountId, repoRelations.workspaceId, repoRelations.repoId, repoRelations.relatedRepoId],
          })
          .execute();
      }
    }
  });
  return true;
}

/**
 * Forget every relation of these repos, both directions — a repo that leaves its workspace (a move,
 * a re-home, a deleted workspace) or is deleted. `exceptWorkspaceId`: keep the rows of that
 * workspace (a "move" into the workspace the repo is already in is not a move).
 */
export async function dropRepoRelations(
  tx: Executor,
  accountId: number,
  repoIds: readonly number[],
  exceptWorkspaceId: number | null = null,
): Promise<void> {
  if (repoIds.length === 0) return;
  const ids = [...repoIds];
  const touching = or(inArray(repoRelations.repoId, ids), inArray(repoRelations.relatedRepoId, ids));
  await tx
    .delete(repoRelations)
    .where(
      exceptWorkspaceId == null
        ? and(eq(repoRelations.accountId, accountId), touching)
        : and(eq(repoRelations.accountId, accountId), touching, ne(repoRelations.workspaceId, exceptWorkspaceId)),
    )
    .execute();
}
