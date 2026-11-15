// THE TAGS STEP of the default-branch snapshot (docs/RELEASES.md § Invariants): the tag sync
// (sync/repo-tags.ts), then — for a RELEASABLE repo — THE RELEASE SCAN: ancestry, ranges
// (sync/tag-ranges.ts), the range PRs not stored yet and their tickets (sync/release-scan.ts).
// STRICTLY NON-FATAL — no half throws, and the caller (sync/sync-repo.ts, after `syncBranchStatus`)
// wraps it once more.
//
// The settle sweep reaches it too (`scheduleTagSync`): a tag push is updatedAt-silent, so the sweep
// compares GitHub's tag signature with `repos.tags_signature` and, on a difference, starts this step
// in the background — ONE per repo at a time, a synchronous claim released in a `finally`.
//
// RELEASABLE REPOS ONLY get the scan (docs/RELEASES.md § Implementation → Automatic candidate): a repo
// some workspace releases ("Released from this workspace", db/release-repos.ts `releaseRangeViews`)
// reads up to REPO_TAGS_READ_CAP_RELEASABLE tags and checks the WHOLE history: every tag's ancestry,
// every range after the baseline (or every tag with none), every range PR, every ticket. No count caps
// but per-run TIME BOXES (the walk's tail WALK_RUN_MS, a background run SCAN_RUN_MS; within one, the
// ranges get RANGES_SHARE of it so the range PRs of the oldest tags are fetched in the same run) and the
// account's rate budget (paused, never an error). Work left after a run that made progress ⇒ the step
// runs again in the background after QUICK_RERUN_MS ("quickly while work remains"); work left with no
// progress (the budget, a failure) ⇒ the settle sweep's CATCH-UP after CATCH_UP_DELAY_MS
// (`takeTagCatchUp`). A re-run within TAG_READ_MIN_INTERVAL_MS skips the tag read and asks about
// ancestry against the head it read last. Any other repo's tags still sync (the hotfix bases read
// them), with no ancestry and no range. An EXTERNAL repo (pinned cold, no trunk snapshot) runs the step
// only when it is releasable. Ticking a repo marks it for catch-up (`markTagCatchUp`, no GitHub call).
import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { ReleaseRangeView } from '@pierre-review/shared';
import { releaseRangeViews } from '../db/release-repos.js';
import { endScanStep, noteScanStep } from '../releases/scan-state.js';
import { isPinnedCold } from './adaptive.js';
import {
  ANCESTRY_CHECKS_RELEASABLE,
  REPO_TAGS_READ_CAP_RELEASABLE,
  runAncestryChecks,
  syncRepoTagsSafe,
  type RepoTagSyncResult,
  type TagSyncLogger,
} from './repo-tags.js';
import { fetchMissingRangePrs, queueRangeTickets, type FetchRangePrsResult } from './release-scan.js';
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
   * Skip the tag READ when the last one is younger than this (the walk's tail and a quick re-run pass
   * TAG_READ_MIN_INTERVAL_MS: the settle sweep notices a tag push in between). The scan still runs.
   */
  minIntervalMs?: number;
  /** An EXTERNAL repo (pinned cold): the step runs only when some workspace releases it. */
  external?: boolean;
  /** This run's time box for the release scan (default WALK_RUN_MS). */
  runMs?: number;
}

/** How often a walk's tail re-reads the tags (1 point a page) when the settle sweep saw no tag change. */
export const TAG_READ_MIN_INTERVAL_MS = 15 * 60_000;
/** The release scan's time box inside a repo walk's tail (the walk waits for it). */
export const WALK_RUN_MS = 20_000;
/** The release scan's time box in a background run. */
export const SCAN_RUN_MS = 45_000;
/** The share of a run the ranges may use before the range PRs are fetched. */
export const RANGES_SHARE = 0.6;
/** Work left after a run that made progress: the next background run starts this soon. */
export const QUICK_RERUN_MS = 3_000;
/** Work left and no progress (the budget, a failure): the settle sweep runs the step after this. */
export const CATCH_UP_DELAY_MS = 60_000;
/** Quick re-runs in a row before the step waits for the sweep (a guard; progress normally ends it). */
export const QUICK_RERUN_MAX = 400;

const inFlight = new Set<number>();
/** repoId → when the catch-up is due (ms). Bounded by the number of releasable repos. */
const catchUp = new Map<number, number>();
/** repoId → the default branch head and name the last tag read saw (a quick re-run's ancestry). */
const lastHead = new Map<number, { headSha: string; branch: string | null }>();
const quickTimers = new Map<number, ReturnType<typeof setTimeout>>();
const quickRuns = new Map<number, number>();

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

export interface TagsStepResult {
  tags: RepoTagSyncResult | null;
  ranges: TagRangesResult | null;
  prs?: FetchRangePrsResult | null;
}

/** What one run of the scan leaves: GitHub work left, and whether the run moved anything. Pure. */
export function scanNext(r: {
  ancestryLeft: number;
  ancestryChecked: number;
  ranges: Pick<TagRangesResult, 'pending' | 'computed' | 'paused'> | null;
  prs: Pick<FetchRangePrsResult, 'left' | 'fetched' | 'failed' | 'paused'> | null;
}): 'done' | 'quick' | 'catch_up' {
  const left = r.ancestryLeft > 0 || (r.ranges?.pending ?? 0) > 0 || (r.prs?.left ?? 0) > 0;
  if (!left) return 'done';
  const moved = r.ancestryChecked > 0 || (r.ranges?.computed ?? 0) > 0 || (r.prs?.fetched ?? 0) + (r.prs?.failed ?? 0) > 0;
  const paused = r.ranges?.paused === true || r.prs?.paused === true;
  return moved && !paused ? 'quick' : 'catch_up';
}

/**
 * Tag sync then (releasable) the scan. NEVER THROWS. One run per repo at a time: a call while another is
 * running for the repo does nothing (both read the same GitHub state).
 */
export async function runTagsStep(opts: TagsStepOptions): Promise<TagsStepResult> {
  if (inFlight.has(opts.repoId)) return { tags: null, ranges: null };
  inFlight.add(opts.repoId);
  let next: 'done' | 'quick' | 'catch_up' = 'done';
  try {
    const views = await viewsOf(opts);
    const releasable = views.length > 0;
    if (opts.external === true && !releasable) return { tags: null, ranges: null };
    const start = Date.now();
    const runMs = opts.runMs ?? WALK_RUN_MS;
    const deadline = start + runMs;
    const rangeDeps = { views: () => views };
    const scanOpts = {
      ancestryCap: releasable ? ANCESTRY_CHECKS_RELEASABLE : 0,
      readCap: releasable ? REPO_TAGS_READ_CAP_RELEASABLE : undefined,
      deadline,
      onAncestry: (p: { done: number; total: number; paused: boolean }) =>
        noteScanStep(opts.repoId, { step: 'ancestry', done: p.done, total: p.total, paused: p.paused }),
    };

    let tags: RepoTagSyncResult | null = null;
    let ancestryLeft = 0;
    let ancestryChecked = 0;
    let branch: string | null = null;
    let skipRead = false;
    if (opts.minIntervalMs != null) {
      const row = (
        await db
          .select({ at: repos.tagsSyncedAt })
          .from(repos)
          .where(and(eq(repos.id, opts.repoId), eq(repos.accountId, opts.accountId)))
          .execute()
      )[0];
      skipRead = row?.at != null && Date.now() - row.at.getTime() < opts.minIntervalMs;
      // A releasable repo with no head in memory (a restart) reads, so its ancestry can go on.
      if (skipRead && releasable && !lastHead.has(opts.repoId)) skipRead = false;
    }
    if (!skipRead) {
      tags = await syncRepoTagsSafe({ ...opts, ...scanOpts });
      if (tags == null || !tags.read) {
        if (releasable) markTagCatchUp(opts.repoId, Date.now() + CATCH_UP_DELAY_MS);
        return { tags, ranges: null };
      }
      if (tags.headSha != null) lastHead.set(opts.repoId, { headSha: tags.headSha, branch: tags.defaultBranchName });
      ancestryLeft = tags.ancestryLeft;
      ancestryChecked = tags.ancestryChecked;
      branch = tags.defaultBranchName;
    } else if (releasable) {
      const head = lastHead.get(opts.repoId);
      if (head != null) {
        const a = await runAncestryChecks({ ...opts, ...scanOpts }, head.headSha);
        ancestryLeft = a.left;
        ancestryChecked = a.checked;
        branch = head.branch;
      }
    }
    if (ancestryLeft === 0) endScanStep(opts.repoId, 'ancestry');
    if (!releasable) {
      // No range for a repo no workspace releases (the stored ones are dropped).
      return { tags, ranges: await computeTagRanges({ ...opts, defaultBranchName: branch, deps: rangeDeps }) };
    }

    // RANGES, oldest first, within their share of the run; then the range PRs; then the tickets.
    const rangeDeadline = ancestryLeft > 0 ? Date.now() : Math.min(deadline, start + runMs * RANGES_SHARE);
    const ranges = await computeTagRanges({
      ...opts,
      defaultBranchName: branch,
      deps: rangeDeps,
      deadline: rangeDeadline,
      onProgress: (p) =>
        noteScanStep(opts.repoId, { step: 'ranges', done: p.done, total: p.total, tagName: p.tagName, tagIndex: p.position, paused: p.paused }),
    });
    if (ranges.pending === 0) endScanStep(opts.repoId, 'ranges');
    const prs = await fetchMissingRangePrs({ ...opts, deadline: Math.max(deadline, Date.now() + 5_000) });
    await queueRangeTickets({ accountId: opts.accountId, repoId: opts.repoId, log: opts.log });
    next = scanNext({ ancestryLeft, ancestryChecked, ranges, prs });
    return { tags, ranges, prs };
  } finally {
    inFlight.delete(opts.repoId);
    if (next === 'quick') scheduleQuickRerun(opts.accountId, opts.repoId, opts.log);
    else {
      quickRuns.delete(opts.repoId);
      if (next === 'catch_up') markTagCatchUp(opts.repoId, Date.now() + CATCH_UP_DELAY_MS);
    }
  }
}

/** The next background run soon (work left, progress made). One timer per repo; bounded in a row. */
function scheduleQuickRerun(accountId: number, repoId: number, log?: TagSyncLogger): void {
  const n = (quickRuns.get(repoId) ?? 0) + 1;
  if (n > QUICK_RERUN_MAX) {
    quickRuns.delete(repoId);
    markTagCatchUp(repoId, Date.now() + CATCH_UP_DELAY_MS);
    return;
  }
  quickRuns.set(repoId, n);
  if (quickTimers.has(repoId)) return;
  const timer = setTimeout(() => {
    quickTimers.delete(repoId);
    if (!scheduleTagSync(accountId, repoId, log, { rescan: true })) markTagCatchUp(repoId, Date.now() + CATCH_UP_DELAY_MS);
  }, QUICK_RERUN_MS);
  if (typeof timer.unref === 'function') timer.unref();
  quickTimers.set(repoId, timer);
}

/**
 * Start the tags step for one repo in the background (the settle sweep's tag-push and catch-up path,
 * and the scan's quick re-run — `rescan`: the tag read is skipped when recent). A repo already running
 * it is skipped; an EXTERNAL repo runs only when releasable (`runTagsStep`). Fire-and-forget, never
 * throws. Returns whether it started.
 */
export function scheduleTagSync(accountId: number, repoId: number, log?: TagSyncLogger, o: { rescan?: boolean } = {}): boolean {
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
      await runTagsStep({
        ...repo,
        repoId,
        accountId,
        token,
        log,
        external: isPinnedCold(repoId),
        runMs: SCAN_RUN_MS,
        ...(o.rescan === true ? { minIntervalMs: TAG_READ_MIN_INTERVAL_MS } : {}),
      });
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
  lastHead.clear();
  for (const t of quickTimers.values()) clearTimeout(t);
  quickTimers.clear();
  quickRuns.clear();
}
