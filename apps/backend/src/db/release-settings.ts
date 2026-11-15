// RELEASE SETTINGS (docs/RELEASES.md § Terms and settings) — the ONE reader and writer of
// `workspaces.release_suffix` / `workspaces.hotfix_suffix` (migration 0195). Per workspace, no
// inheritance, NO default: null until the reader sets one. Callers validate with shared
// `validateReleaseSettings` first (the route does; the Settings form runs the same function).
import { and, eq, inArray } from 'drizzle-orm';
import {
  normaliseReleaseSuffix,
  releaseSettingsConfigured,
  type ReleaseSettings,
  type ReleaseSettingsResponse,
} from '@pierre-review/shared';
import { db, schema } from './client.js';

const { workspaces, workspaceRepos, repoTags, releases } = schema;

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

/** Every workspace's settings of this account that has BOTH suffixes set (the range planner keeps
 *  every range after the oldest baseline any of them gives). */
export async function configuredReleaseSettings(accountId: number): Promise<ReleaseSettings[]> {
  const rows = await db
    .select({ releaseSuffix: workspaces.releaseSuffix, hotfixSuffix: workspaces.hotfixSuffix })
    .from(workspaces)
    .where(eq(workspaces.accountId, accountId))
    .execute();
  return rows
    .map((r) => ({ releaseSuffix: normaliseReleaseSuffix(r.releaseSuffix), hotfixSuffix: normaliseReleaseSuffix(r.hotfixSuffix) }))
    .filter(releaseSettingsConfigured);
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
 * A release already exists for this workspace: a release row, or a stored tag in one of its repos
 * that ends in the CURRENT release suffix (a team may have tagged by hand before Ensemble). The Settings
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
  const repoIds = (
    await db
      .select({ repoId: workspaceRepos.repoId })
      .from(workspaceRepos)
      .where(and(eq(workspaceRepos.accountId, accountId), eq(workspaceRepos.workspaceId, workspaceId)))
      .execute()
  ).map((r) => r.repoId);
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
  };
}
