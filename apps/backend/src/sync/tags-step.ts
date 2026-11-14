// THE TAGS STEP of the default-branch snapshot (docs/RELEASES.md § Invariants): the tag sync
// (sync/repo-tags.ts) then the tag ranges (sync/tag-ranges.ts). STRICTLY NON-FATAL — neither half
// throws, and the caller (sync/sync-repo.ts, after `syncBranchStatus`) wraps it once more.
//
// The settle sweep reaches it too (`scheduleTagSync`): a tag push is updatedAt-silent, so the sweep
// compares GitHub's tag signature with `repos.tags_signature` and, on a difference, starts this step
// in the background — ONE per repo at a time, a synchronous claim released in a `finally`.
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import { isPinnedCold } from './adaptive.js';
import { syncRepoTagsSafe, type RepoTagSyncResult, type TagSyncLogger } from './repo-tags.js';
import { computeTagRanges, type TagRangesResult } from './tag-ranges.js';

const { repos } = schema;

export interface TagsStepOptions {
  owner: string;
  name: string;
  repoId: number;
  accountId: number;
  token: string;
  log?: TagSyncLogger;
  /**
   * Skip the tag READ when the last one is younger than this (the walk's tail passes
   * TAG_READ_MIN_INTERVAL_MS: the settle sweep notices a tag push in between). The ranges still run —
   * they call GitHub only when a range is missing.
   */
  minIntervalMs?: number;
}

/** How often a walk's tail re-reads the tags (1 point) when the settle sweep saw no tag change. */
export const TAG_READ_MIN_INTERVAL_MS = 15 * 60_000;

const inFlight = new Set<number>();

/**
 * Tag sync then ranges. NEVER THROWS. One run per repo at a time: a call while another is running
 * for the repo does nothing (both read the same GitHub state).
 */
export async function runTagsStep(
  opts: TagsStepOptions,
): Promise<{ tags: RepoTagSyncResult | null; ranges: TagRangesResult | null }> {
  if (inFlight.has(opts.repoId)) return { tags: null, ranges: null };
  inFlight.add(opts.repoId);
  try {
    if (opts.minIntervalMs != null) {
      const row = (
        await db
          .select({ at: repos.tagsSyncedAt })
          .from(repos)
          .where(and(eq(repos.id, opts.repoId), eq(repos.accountId, opts.accountId)))
          .execute()
      )[0];
      if (row?.at != null && Date.now() - row.at.getTime() < opts.minIntervalMs) {
        return { tags: null, ranges: await computeTagRanges(opts) };
      }
    }
    const tags = await syncRepoTagsSafe(opts);
    if (tags == null || !tags.read) return { tags, ranges: null };
    const ranges = await computeTagRanges({ ...opts, defaultBranchName: tags.defaultBranchName });
    return { tags, ranges };
  } finally {
    inFlight.delete(opts.repoId);
  }
}

/**
 * Start the tags step for one repo in the background (the settle sweep's tag-push path). A repo
 * already running it, or an EXTERNAL repo (no trunk snapshot), is skipped. Fire-and-forget, never
 * throws. Returns whether it started.
 */
export function scheduleTagSync(accountId: number, repoId: number, log?: TagSyncLogger): boolean {
  if (inFlight.has(repoId) || isPinnedCold(repoId)) return false;
  void (async () => {
    try {
      const repo = (
        await db
          .select({ owner: repos.owner, name: repos.name })
          .from(repos)
          .where(and(eq(repos.id, repoId), eq(repos.accountId, accountId)))
          .execute()
      )[0];
      if (!repo) return;
      const token = await getAccessToken(accountId);
      await runTagsStep({ ...repo, repoId, accountId, token, log });
    } catch (err) {
      log?.warn(`tags: background tag sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return true;
}

/** Test-only. */
export function __resetTagSync(): void {
  inFlight.clear();
}
