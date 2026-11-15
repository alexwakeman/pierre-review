// RELEASABLE REPOSITORIES (docs/RELEASES.md § Implementation → Releasable repos; § Automatic candidate)
// — the ONE reader and writer of `workspace_release_repos` (migration 0199).
//
//   • A row = the reader ticked "Released from this workspace" (Settings → Releases). Default: none.
//     EVERYTHING in Releases reads only these repos: the check's rows and fold, the tickets, the dialog,
//     the writes, the tag sync's ranges and raised caps, and the hotfix bases (an unticked repo is read
//     only in a hotfix build). Unticked repos are ignored entirely.
//   • Every read is INTERSECTED with the workspace's CURRENT membership (home + External,
//     `getWorkspaceRepoIds(…, 'all')`): a row of a repo that left the workspace is inert.
//   • The `start_tag_*` columns are DORMANT (the start tag was removed 2026-11-15: the check finds its
//     starting point itself). Never read, never written, never dropped.
import { and, eq, inArray } from 'drizzle-orm';
import { normaliseReleaseSuffix, releaseSettingsConfigured, type ReleaseRangeView } from '@pierre-review/shared';
import { db, runTransaction, schema } from './client.js';
import { getWorkspaceRepoIds } from './queries.js';

const { workspaceReleaseRepos, workspaces } = schema;

export interface ReleaseRepoRow {
  repoId: number;
}

/** The workspace's member repos (home + External). */
export async function workspaceMemberRepoIds(accountId: number, workspaceId: number): Promise<number[]> {
  return getWorkspaceRepoIds(workspaceId, accountId, 'all');
}

/** The ticked repos of a workspace (∩ its current membership), repoId → row. */
export async function getReleaseRepos(accountId: number, workspaceId: number): Promise<Map<number, ReleaseRepoRow>> {
  const members = new Set(await workspaceMemberRepoIds(accountId, workspaceId));
  const rows = await db
    .select({ repoId: workspaceReleaseRepos.repoId })
    .from(workspaceReleaseRepos)
    .where(and(eq(workspaceReleaseRepos.accountId, accountId), eq(workspaceReleaseRepos.workspaceId, workspaceId)))
    .execute();
  const out = new Map<number, ReleaseRepoRow>();
  for (const r of rows) {
    if (!members.has(r.repoId)) continue;
    out.set(r.repoId, { repoId: r.repoId });
  }
  return out;
}

/**
 * Replace the ticked set. `repoIds` must all be workspace members (else `{refused}` names them and
 * nothing changes). An unticked repo loses its row.
 * Returns null when the workspace is not this account's.
 */
export async function setReleaseRepos(
  accountId: number,
  workspaceId: number,
  repoIds: readonly number[],
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; refused: number[] } | null> {
  const owned = (
    await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (owned == null) return null;
  const members = new Set(await workspaceMemberRepoIds(accountId, workspaceId));
  const want = [...new Set(repoIds)];
  const refused = want.filter((id) => !members.has(id));
  if (refused.length > 0) return { ok: false, refused };
  await runTransaction(async (tx) => {
    const have = await tx
      .select({ repoId: workspaceReleaseRepos.repoId })
      .from(workspaceReleaseRepos)
      .where(and(eq(workspaceReleaseRepos.accountId, accountId), eq(workspaceReleaseRepos.workspaceId, workspaceId)))
      .execute();
    const drop = have.map((h) => h.repoId).filter((id) => !want.includes(id));
    if (drop.length > 0) {
      await tx
        .delete(workspaceReleaseRepos)
        .where(
          and(
            eq(workspaceReleaseRepos.accountId, accountId),
            eq(workspaceReleaseRepos.workspaceId, workspaceId),
            inArray(workspaceReleaseRepos.repoId, drop),
          ),
        )
        .execute();
    }
    for (const repoId of want) {
      await tx
        .insert(workspaceReleaseRepos)
        .values({ accountId, workspaceId, repoId, createdAt: now })
        .onConflictDoNothing({ target: [workspaceReleaseRepos.accountId, workspaceReleaseRepos.workspaceId, workspaceReleaseRepos.repoId] })
        .execute();
    }
  });
  return { ok: true };
}

/**
 * Every view the TAG SYNC serves for one repo: each workspace that ticks it (and still holds it) with
 * BOTH suffixes set. Empty = not releasable anywhere: the tags may
 * still sync, but no ancestry check or range is computed for it.
 */
export async function releaseRangeViews(accountId: number, repoId: number): Promise<ReleaseRangeView[]> {
  const rows = await db
    .select({
      workspaceId: workspaceReleaseRepos.workspaceId,
      releaseSuffix: workspaces.releaseSuffix,
      hotfixSuffix: workspaces.hotfixSuffix,
    })
    .from(workspaceReleaseRepos)
    .innerJoin(workspaces, and(eq(workspaces.id, workspaceReleaseRepos.workspaceId), eq(workspaces.accountId, workspaceReleaseRepos.accountId)))
    .where(and(eq(workspaceReleaseRepos.accountId, accountId), eq(workspaceReleaseRepos.repoId, repoId)))
    .execute();
  const out: ReleaseRangeView[] = [];
  for (const r of rows) {
    const settings = { releaseSuffix: normaliseReleaseSuffix(r.releaseSuffix), hotfixSuffix: normaliseReleaseSuffix(r.hotfixSuffix) };
    if (!releaseSettingsConfigured(settings)) continue;
    if (!(await workspaceMemberRepoIds(accountId, r.workspaceId)).includes(repoId)) continue;
    out.push({ workspaceId: r.workspaceId, settings });
  }
  return out;
}
