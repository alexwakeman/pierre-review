// HOTFIX BASES (docs/STORY-BUILD.md § Hotfix builds, docs/RELEASES.md § Hotfix) — DB only, account-scoped.
// Per RELEASABLE workspace repository (ticked "Released from this workspace", db/release-repos.ts) its LATEST
// RELEASE (the newest release OR hotfix tag, shared `latestReleaseTag`); every other repository is read
// only. From the synced tags (`repo_tags`), through the ONE pure fold `hotfixBasesOf`. The Start panel's base list
// (`GET /api/story-builds/hotfix-bases`) and the session's bases (sandbox/session/manager.ts) both read it, so
// what the reader saw at Start is what the build starts from. Never a GitHub or tracker call.
import { and, eq, inArray } from 'drizzle-orm';
import { hotfixBasesOf, type StoryBuildHotfixBasesResponse } from '@pierre-review/shared';
import { db, schema } from './client.js';
import { getReleaseRepos } from './release-repos.js';
import { getReleaseSettings } from './release-settings.js';
import { getRepoTags } from './repo-tags.js';

const { repos } = schema;

/** The hotfix bases of `repoIds` (the workspace's members, external included) under the workspace's suffixes. */
export async function getHotfixBases(accountId: number, workspaceId: number, repoIds: readonly number[]): Promise<StoryBuildHotfixBasesResponse> {
  const settings = (await getReleaseSettings(accountId, workspaceId)) ?? { releaseSuffix: null, hotfixSuffix: null };
  const rows =
    repoIds.length === 0
      ? []
      : await db
          .select({ id: repos.id, owner: repos.owner, name: repos.name, defaultBranch: repos.defaultBranch, defaultBranchName: repos.defaultBranchName })
          .from(repos)
          .where(and(eq(repos.accountId, accountId), inArray(repos.id, [...repoIds])))
          .execute();
  const ticked = await getReleaseRepos(accountId, workspaceId);
  const tags = await getRepoTags(
    accountId,
    rows.map((r) => r.id),
  );
  const folded = hotfixBasesOf(
    rows.map((r) => ({
      repoId: r.id,
      fullName: `${r.owner}/${r.name}`,
      defaultBranch: r.defaultBranch ?? r.defaultBranchName ?? null,
      releasable: ticked.has(r.id),
      tags: tags.filter((t) => t.repoId === r.id).map((t) => ({ name: t.name, sha: t.sha, committedAt: t.committedAt, taggedAt: t.taggedAt })),
    })),
    settings,
  );
  return { workspaceId, ...folded };
}
