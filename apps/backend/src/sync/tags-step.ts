// THE TAGS STEP of the default-branch snapshot (docs/RELEASES.md § Invariants): the tag sync
// (sync/repo-tags.ts) then the tag ranges (sync/tag-ranges.ts). STRICTLY NON-FATAL — neither half
// throws, and the caller (sync/sync-repo.ts, after `syncBranchStatus`) wraps it once more.
//
// The settle sweep reaches it too (`scheduleTagSync`): a tag push is updatedAt-silent, so the sweep
// compares GitHub's tag signature with `repos.tags_signature` and, on a difference, starts this step
// in the background — ONE per repo at a time, a synchronous claim released in a `finally`.
//
// RELEASABLE REPOS FIRST (docs/RELEASES.md § Releasable repos and start tag). Only a repo some workspace
// releases ("Released from this workspace", db/release-repos.ts `releaseRangeViews`) gets ancestry checks
// and ranges — with raised caps (every tag read; the whole range window per run). Any other repo's tags
// still sync (the hotfix bases read them), with no ancestry and no range. An EXTERNAL repo (pinned cold,
// no trunk snapshot) runs the step only when it is releasable. A releasable repo whose work is not done
// (ranges or ancestry left, the budget ran low) is marked for CATCH-UP: the settle sweep starts the step
// again after CATCH_UP_DELAY_MS (`takeTagCatchUp`), so "Reading changes…" does not wait for the next
// walk. Ticking a repo or setting its start tag marks it too (`markTagCatchUp`, no GitHub call there).
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { ReleaseRangeView } from '@pierre-review/shared';
import { releaseRangeViews } from '../db/release-repos.js';
import { isPinnedCold } from './adaptive.js';
import { ANCESTRY_CHECKS_RELEASABLE, syncRepoTagsSafe, type RepoTagSyncResult, type TagSyncLogger } from './repo-tags.js';
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
  /** An EXTERNAL repo (pinned cold): the step runs only when some workspace releases it. */
  external?: boolean;
}

/** How often a walk's tail re-reads the tags (1 point) when the settle sweep saw no tag change. */
export const TAG_READ_MIN_INTERVAL_MS = 15 * 60_000;

const inFlight = new Set<number>();

/** How soon the settle sweep runs the step again for a releasable repo with work left. */
export const CATCH_UP_DELAY_MS = 60_000;
/** repoId → when the catch-up is due (ms). Bounded by the number of releasable repos. */
const catchUp = new Map<number, number>();

/** Ask the settle sweep to run the tags step for this repo once `at` has passed (default: now). */
export function markTagCatchUp(repoId: number, at: number = Date.now()): void {
  const cur = catchUp.get(repoId);
  if (cur == null || at < cur) catchUp.set(repoId, at);
}

/** The settle sweep's check: a catch-up is due for this repo (and is taken). */
export function takeTagCatchUp(repoId: number, now: number = Date.now()): boolean {
  const at = catchUp.get(repoId);
  if (at == null || at > now) return false;
  catchUp.delete(repoId);
  return true;
}

async function viewsOf(opts: TagsStepOptions): Promise<ReleaseRangeView[]> {
  try {
    return await releaseRangeViews(opts.accountId, opts.repoId);
  } catch (err) {
    opts.log?.warn(`tags ${opts.owner}/${opts.name}: could not read the releasing workspaces (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

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
    const views = await viewsOf(opts);
    const releasable = views.length > 0;
    if (opts.external === true && !releasable) return { tags: null, ranges: null };
    const rangeDeps = { views: () => views };
    const done = (tags: RepoTagSyncResult | null, ranges: TagRangesResult | null) => {
      // Work left on a releasable repo: run again soon rather than at the next walk.
      if (releasable && ((ranges?.pending ?? 0) > 0 || (tags?.ancestryLeft ?? 0) > 0)) {
        markTagCatchUp(opts.repoId, Date.now() + CATCH_UP_DELAY_MS);
      }
      return { tags, ranges };
    };
    if (opts.minIntervalMs != null) {
      const row = (
        await db
          .select({ at: repos.tagsSyncedAt })
          .from(repos)
          .where(and(eq(repos.id, opts.repoId), eq(repos.accountId, opts.accountId)))
          .execute()
      )[0];
      if (row?.at != null && Date.now() - row.at.getTime() < opts.minIntervalMs) {
        return done(null, await computeTagRanges({ ...opts, deps: rangeDeps }));
      }
    }
    const tags = await syncRepoTagsSafe({ ...opts, ancestryCap: releasable ? ANCESTRY_CHECKS_RELEASABLE : 0 });
    if (tags == null || !tags.read) {
      if (releasable) markTagCatchUp(opts.repoId, Date.now() + CATCH_UP_DELAY_MS);
      return { tags, ranges: null };
    }
    const ranges = await computeTagRanges({ ...opts, defaultBranchName: tags.defaultBranchName, deps: rangeDeps });
    return done(tags, ranges);
  } finally {
    inFlight.delete(opts.repoId);
  }
}

/**
 * Start the tags step for one repo in the background (the settle sweep's tag-push and catch-up path).
 * A repo already running it is skipped; an EXTERNAL repo runs only when releasable (`runTagsStep`).
 * Fire-and-forget, never throws. Returns whether it started.
 */
export function scheduleTagSync(accountId: number, repoId: number, log?: TagSyncLogger): boolean {
  if (inFlight.has(repoId)) return false;
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
      await runTagsStep({ ...repo, repoId, accountId, token, log, external: isPinnedCold(repoId) });
    } catch (err) {
      log?.warn(`tags: background tag sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
  return true;
}

/** Test-only. */
export function __resetTagSync(): void {
  inFlight.clear();
  catchUp.clear();
}
