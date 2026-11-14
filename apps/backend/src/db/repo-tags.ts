// RELEASES' READS of the synced tags and tag ranges (docs/RELEASES.md) — DB only, account-scoped.
// The release check (a pure fold, next to the Releases routes) builds on these two:
//   getRepoTags(accountId, repoIds)       every stored tag of those repos
//   getTagRanges(accountId, repoIds)      every stored range increment, PR NUMBERS resolved to local
//                                         PR ids within (account, repo) — a number not stored yet is
//                                         kept in `unresolvedPrNumbers`, never dropped.
// The writers are sync/repo-tags.ts and sync/tag-ranges.ts.
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';

const { repoTags, repoTagRanges, pullRequests } = schema;

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

export interface StoredTagRange {
  repoId: number;
  tagName: string;
  sha: string;
  baseTagName: string | null;
  baseSha: string | null;
  method: 'compare' | 'history';
  prIds: number[];
  unresolvedPrNumbers: number[];
  commitCount: number;
  unmatchedCommits: number;
  truncated: boolean;
  movedFromSha: string | null;
  computedAt: Date;
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

export async function getTagRanges(accountId: number, repoIds: readonly number[]): Promise<StoredTagRange[]> {
  if (repoIds.length === 0) return [];
  const rows = await db
    .select()
    .from(repoTagRanges)
    .where(and(eq(repoTagRanges.accountId, accountId), inArray(repoTagRanges.repoId, [...repoIds])))
    .execute();
  if (rows.length === 0) return [];
  // number → id, per repo. ONE read of the repos' PR numbers (indexed on account, repo, number).
  const wanted = [...new Set(rows.flatMap((r) => r.prNumbers ?? []))];
  const idByKey = new Map<string, number>();
  for (let i = 0; i < wanted.length; i += 400) {
    const part = wanted.slice(i, i + 400);
    const prs = await db
      .select({ id: pullRequests.id, repoId: pullRequests.repoId, number: pullRequests.number })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(pullRequests.repoId, [...repoIds]),
          inArray(pullRequests.number, part),
        ),
      )
      .execute();
    for (const p of prs) idByKey.set(`${p.repoId}#${p.number}`, p.id);
  }
  return rows.map((r) => {
    const prIds: number[] = [];
    const unresolvedPrNumbers: number[] = [];
    for (const n of r.prNumbers ?? []) {
      const id = idByKey.get(`${r.repoId}#${n}`);
      if (id != null) prIds.push(id);
      else unresolvedPrNumbers.push(n);
    }
    return {
      repoId: r.repoId,
      tagName: r.tagName,
      sha: r.sha,
      baseTagName: r.baseTagName,
      baseSha: r.baseSha,
      method: r.method,
      prIds,
      unresolvedPrNumbers,
      commitCount: r.commitCount,
      unmatchedCommits: r.unmatchedCommits,
      truncated: r.truncated,
      movedFromSha: r.movedFromSha,
      computedAt: r.computedAt,
    };
  });
}
