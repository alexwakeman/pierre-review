// RELEASE SETTINGS (docs/RELEASES.md § Terms and settings) — the ONE reader and writer of
// `workspaces.release_suffix` / `workspaces.hotfix_suffix` (migration 0195). Per workspace, no
// inheritance, NO default: null until the reader sets one. A set suffix always starts with the fixed
// hyphen (shared `normaliseReleaseSuffix`; migration 0199 prefixed older values). Callers validate with
// shared `validateReleaseSettings` first (the route does; the Settings form runs the same function).
// The response also lists the workspace's repositories with their "Released from this workspace" tick
// (db/release-repos.ts).
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  normaliseReleaseSuffix,
  releaseBasisOf,
  releaseSettingsConfigured,
  type ReleaseSettings,
  type ReleaseSettingsRepo,
  type ReleaseSettingsResponse,
} from '@pierre-review/shared';
import { db, schema } from './client.js';
import { externalRepoIds } from './external-repos.js';
import { getReleaseRepos, workspaceMemberRepoIds } from './release-repos.js';

const { workspaces, repos, repoTags, releases } = schema;

/** The workspace's settings, RAW (null = not set); null when the workspace is not this account's. */
export async function getReleaseSettings(accountId: number, workspaceId: number): Promise<ReleaseSettings | null> {
  const row = (
    await db
      .select({ releaseSuffix: workspaces.releaseSuffix, hotfixSuffix: workspaces.hotfixSuffix })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
      .limit(1)
      .execute()
  )[0];
  if (!row) return null;
  return {
    releaseSuffix: normaliseReleaseSuffix(row.releaseSuffix),
    hotfixSuffix: normaliseReleaseSuffix(row.hotfixSuffix),
  };
}

/**
 * Replace both suffixes (an empty string stores NULL). Returns false when the workspace is not this
 * account's. Does NOT validate — the caller already ran `validateReleaseSettings`.
 */
export async function setReleaseSettings(
  accountId: number,
  workspaceId: number,
  settings: ReleaseSettings,
): Promise<boolean> {
  const rows = await db
    .update(workspaces)
    .set({
      releaseSuffix: normaliseReleaseSuffix(settings.releaseSuffix),
      hotfixSuffix: normaliseReleaseSuffix(settings.hotfixSuffix),
    })
    .where(and(eq(workspaces.id, workspaceId), eq(workspaces.accountId, accountId)))
    .returning({ id: workspaces.id })
    .execute();
  return rows.length > 0;
}

/**
 * A release already exists for this workspace: a release row, or a stored tag in one of its RELEASABLE
 * repos that ends in the CURRENT release suffix (a team may have tagged by hand before Ensemble). The Settings
 * form warns before a change. DB only.
 */
export async function workspaceHasReleases(
  accountId: number,
  workspaceId: number,
  releaseSuffix: string | null,
): Promise<boolean> {
  const made = await db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.accountId, accountId), eq(releases.workspaceId, workspaceId)))
    .limit(1)
    .execute();
  if (made.length > 0) return true;
  if (releaseSuffix == null) return false;
  const repoIds = [...(await getReleaseRepos(accountId, workspaceId)).keys()];
  if (repoIds.length === 0) return false;
  const names = await db
    .select({ name: repoTags.name })
    .from(repoTags)
    .where(and(eq(repoTags.accountId, accountId), inArray(repoTags.repoId, repoIds)))
    .execute();
  return names.some((n) => n.name.length > releaseSuffix.length && n.name.endsWith(releaseSuffix));
}

/** The wire shape for GET / PUT /api/workspaces/:id/release-settings; null = not this account's. */
export async function getReleaseSettingsResponse(
  accountId: number,
  workspaceId: number,
): Promise<ReleaseSettingsResponse | null> {
  const settings = await getReleaseSettings(accountId, workspaceId);
  if (!settings) return null;
  return {
    workspaceId,
    ...settings,
    configured: releaseSettingsConfigured(settings),
    hasReleases: await workspaceHasReleases(accountId, workspaceId, settings.releaseSuffix),
    repos: await releaseSettingsRepos(accountId, workspaceId),
  };
}

/** Every member repo (home + External), by full name, with its "Released from this workspace" tick. */
export async function releaseSettingsRepos(accountId: number, workspaceId: number): Promise<ReleaseSettingsRepo[]> {
  const ids = await workspaceMemberRepoIds(accountId, workspaceId);
  if (ids.length === 0) return [];
  const [rows, ticked, external] = await Promise.all([
    db
      .select({ id: repos.id, owner: repos.owner, name: repos.name })
      .from(repos)
      .where(and(eq(repos.accountId, accountId), inArray(repos.id, ids)))
      .orderBy(asc(repos.owner), asc(repos.name))
      .execute(),
    getReleaseRepos(accountId, workspaceId),
    externalRepoIds(accountId, workspaceId),
  ]);
  const settings = await getReleaseSettings(accountId, workspaceId);
  const tagRows =
    settings == null
      ? []
      : await db
          .select({ repoId: repoTags.repoId, name: repoTags.name })
          .from(repoTags)
          .where(and(eq(repoTags.accountId, accountId), inArray(repoTags.repoId, ids)))
          .execute();
  return rows.map((r) => {
    const basis = ticked.get(r.id)?.basis ?? 'auto';
    const names = tagRows.filter((t) => t.repoId === r.id).map((t) => t.name);
    return {
      repoId: r.id,
      fullName: `${r.owner}/${r.name}`,
      external: external.has(r.id),
      releasable: ticked.has(r.id),
      basis,
      effectiveBasis: releaseBasisOf(basis, names, settings ?? { releaseSuffix: null, hotfixSuffix: null }),
    };
  });
}
