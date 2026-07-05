import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { StoredPrFile } from '@pierre-review/shared';
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { fetchPrFilesWithPatch } from '../github/mutations.js';

const { pullRequests, repos } = schema;

// Best-effort, BOUNDED backfill of `pull_requests.files` for reviewer-routing
// candidates that predate the files column (old open PRs never re-synced). Only PRs
// whose `files` IS NULL are fetched; the result — even `[]` on failure — is persisted
// so the same PR isn't refetched on every insights refresh (an [] sentinel means "we
// tried"). The sprint window's PRs already carry files from sync, so this only ever
// touches a handful of stale orphans. Returns the resolved paths by prId.
export async function ensureRoutingPrFiles(
  accountId: number,
  prIds: number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (prIds.length === 0) return out;

  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      owner: repos.owner,
      name: repos.name,
    })
    .from(pullRequests)
    .innerJoin(repos, eq(repos.id, pullRequests.repoId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inArray(pullRequests.id, prIds),
        isNull(pullRequests.files),
      ),
    )
    .execute();
  if (rows.length === 0) return out;

  let token: string;
  try {
    token = await getAccessToken(accountId);
  } catch {
    return out; // no token (e.g. offline) → leave the fallback rationale in place
  }

  for (const r of rows) {
    let stored: StoredPrFile[] = [];
    try {
      const { files } = await fetchPrFilesWithPatch(token, r.owner, r.name, r.number, 100);
      stored = files.map((f) => ({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
      }));
    } catch {
      stored = []; // sentinel — persist [] so we don't refetch this PR every refresh
    }
    await db
      .update(pullRequests)
      .set({ files: stored })
      .where(and(eq(pullRequests.id, r.id), eq(pullRequests.accountId, accountId)))
      .execute();
    out.set(
      r.id,
      stored.map((s) => s.path),
    );
  }
  return out;
}
