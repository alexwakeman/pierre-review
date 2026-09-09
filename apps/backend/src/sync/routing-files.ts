import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { BranchSyncLogger } from './branch-status.js';
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

/** How many missing file lists one repo may backfill in a single sync. */
const FILES_BACKFILL_PER_RUN = 25;

/**
 * Backfill `pull_requests.files` for this repo's OPEN pull requests that have none.
 *
 * ---- WHY THIS EXISTS SEPARATELY FROM THE SYNC ITSELF ------------------------
 *
 * The walk stores `files` for the pull requests it touches, but a repo carries older open ones it
 * never revisits — and a pull request with no stored file list has NO BLAST RADIUS AT ALL:
 * `codeLocFor` returns null, `blastSignalsFor` returns null, and every surface correctly renders
 * nothing. Measured on a real corpus: **154 of 1,564 open pull requests, 9.8%**, showed no chip
 * for this reason alone.
 *
 * ⚠ THIS IS A DIFFERENT FETCH FROM THE CHANGE-SHAPE READ, AND IT IS THE CHEAPER, MORE VALUABLE
 * ONE. `sync/classify-change-shape.ts` reads a DIFF to refine a level that already exists; this
 * fetches the FILE LIST so a level can exist at all. Fetching the diff for these pull requests
 * would not help — with no `files` there is nothing for the diff to refine.
 *
 * Bounded exactly like its sibling: capped per run, once per pull request (the `[]`-on-failure
 * sentinel `ensureRoutingPrFiles` already writes means a pull request GitHub will not serve is
 * never retried), and strictly non-fatal.
 */
export async function backfillMissingPrFiles(
  accountId: number,
  repoId: number,
  log?: BranchSyncLogger,
): Promise<number> {
  const rows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.repoId, repoId),
        eq(pullRequests.state, 'open'),
        // ⚠ `IS NULL` only. A row already holding `[]` is the "we tried and GitHub refused"
        // sentinel; re-querying it every sync forever is the cost this predicate avoids.
        isNull(pullRequests.files),
      ),
    )
    .limit(FILES_BACKFILL_PER_RUN)
    .execute();
  if (rows.length === 0) return 0;

  const resolved = await ensureRoutingPrFiles(
    accountId,
    rows.map((r) => r.id),
  );
  if (resolved.size > 0) log?.info(`files backfill: filled ${resolved.size} pull request(s)`);
  return resolved.size;
}
