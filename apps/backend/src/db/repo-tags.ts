// RELEASES' READ of the synced tags (docs/RELEASES.md) — DB only, account-scoped:
//   getRepoTags(accountId, repoIds)       every stored tag of those repos
// The writer is sync/repo-tags.ts. (`repo_tag_ranges` is DORMANT since the one history pass: the
// increments are derived from `release_history_commits` in db/release-check.ts.)
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';

const { repoTags } = schema;

export interface StoredRepoTag {
  repoId: number;
  name: string;
  sha: string;
  annotated: boolean;
  committedAt: Date | null;
  taggedAt: Date | null;
  /** null = not known yet. */
  onDefaultBranch: boolean | null;
  previousSha: string | null;
  movedAt: Date | null;
  firstSeenAt: Date;
}

export async function getRepoTags(accountId: number, repoIds: readonly number[]): Promise<StoredRepoTag[]> {
  if (repoIds.length === 0) return [];
  const rows = await db
    .select({
      repoId: repoTags.repoId,
      name: repoTags.name,
      sha: repoTags.sha,
      tagObjectOid: repoTags.tagObjectOid,
      committedAt: repoTags.committedAt,
      taggedAt: repoTags.taggedAt,
      onDefaultBranch: repoTags.onDefaultBranch,
      previousSha: repoTags.previousSha,
      movedAt: repoTags.movedAt,
      firstSeenAt: repoTags.firstSeenAt,
    })
    .from(repoTags)
    .where(and(eq(repoTags.accountId, accountId), inArray(repoTags.repoId, [...repoIds])))
    .execute();
  return rows.map(({ tagObjectOid, ...r }) => ({ ...r, annotated: tagObjectOid != null }));
}
