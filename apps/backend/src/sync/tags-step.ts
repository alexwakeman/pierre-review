import { getAccessToken } from '../auth/account.js';
import { db, schema } from '../db/client.js';
import { and, eq } from 'drizzle-orm';
import type { ReleaseRangeView } from '@pierre-review/shared';
import { releaseRangeViews } from '../db/release-repos.js';
import { endScanStep, noteScanStep } from '../releases/scan-state.js';
import { isPinnedCold } from './adaptive.js';
import { REPO_TAGS_READ_CAP_RELEASABLE, syncRepoTagsSafe, type RepoTagSyncResult, type TagSyncLogger } from './repo-tags.js';
import { walkReleaseHistory, type WalkHistoryResult } from './release-history.js';

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
  /** Test seams. */
  deps?: {
    walk?: typeof walkReleaseHistory;
    tickets?: (a: { accountId: number; repoId: number; views: readonly ReleaseRangeView[]; log?: TagSyncLogger }) => Promise<TicketStepResult>;
  };
}

/** How often a walk's tail re-reads the tags (1 point a page) when the settle sweep saw no tag change. */
export const TAG_READ_MIN_INTERVAL_MS = 15 * 60_000;
/** The release scan's time box inside a repo walk's tail (the walk waits for it). */
export const WALK_RUN_MS = 20_000;
/** The release scan's time box in a background run. */
export const SCAN_RUN_MS = 45_000;
/** Work left after a run that made progress: the next background run starts this soon. */
export const QUICK_RERUN_MS = 3_000;
/** Work left and no progress (the budget, a failure): the settle sweep runs the step after this. */
export const CATCH_UP_DELAY_MS = 60_000;
/** Quick re-runs in a row before the step waits for the sweep (a guard; progress normally ends it). */
export const QUICK_RERUN_MAX = 400;

const inFlight = new Set<number>();
/** repoId → when the catch-up is due (ms). Bounded by the number of releasable repos. */
const catchUp = new Map<number, number>();
/** repoId → the default branch head and name the last tag read saw (a quick re-run's walk). */
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

export interface TicketStepResult {
  /** Keys asked of the tracker this run, across the releasing workspaces. */
  asked: number;
  /** Keys that got an answer (ok, not found, no access). */
  answered: number;
  /** Tracker requests made. */
  calls: number;
  /** Keys left for a later run (a reader read one by one past its cap). */
  left: number;
}

export interface TagsStepResult {
  tags: RepoTagSyncResult | null;
  history?: WalkHistoryResult | null;
  tickets?: TicketStepResult | null;
}

/** What one run of the scan leaves: GitHub / tracker work left, and whether the run moved anything.
 *  Pure. */
export function scanNext(r: {
  history: Pick<WalkHistoryResult, 'complete' | 'walked' | 'paused'> | null;
  tickets: Pick<TicketStepResult, 'left' | 'answered'> | null;
}): 'done' | 'quick' | 'catch_up' {
  const left = (r.history != null && !r.history.complete) || (r.tickets?.left ?? 0) > 0;
  if (!left) return 'done';
  const moved = (r.history?.walked ?? 0) > 0 || (r.tickets?.answered ?? 0) > 0;
  return moved && r.history?.paused !== true ? 'quick' : 'catch_up';
}

/** THE TICKET STEP: per releasing workspace, the keys owed a read (not read yet, failed and due, older
 *  than the TTL) read in a batch. Never throws. */
async function readRangeTickets(a: { accountId: number; repoId: number; views: readonly ReleaseRangeView[]; log?: TagSyncLogger }): Promise<TicketStepResult> {
  const out: TicketStepResult = { asked: 0, answered: 0, calls: 0, left: 0 };
  try {
    // LAZY: tracker/runtime.ts opens the database at import.
    const [{ releaseTicketKeysOwed }, { trackerContext }, { readTicketStatuses }] = await Promise.all([
      import('../db/release-check.js'),
      import('../tracker/runtime.js'),
      import('../tracker/ticket-status.js'),
    ]);
    for (const v of a.views) {
      if (v.workspaceId == null) continue;
      const owed = await releaseTicketKeysOwed(a.accountId, v.workspaceId, a.repoId, v.settings);
      if (owed.keys.length === 0) continue;
      noteScanStep(a.repoId, { step: 'tickets', done: 0, total: owed.keys.length, paused: false });
      const r = await readTicketStatuses(trackerContext(), a.accountId, v.workspaceId, owed.keys);
      out.asked += r.asked;
      out.answered += r.answered.size;
      out.calls += r.calls;
      out.left += r.left;
    }
    endScanStep(a.repoId, 'tickets');
  } catch (err) {
    a.log?.warn(`release scan: reading ticket statuses failed (non-fatal): ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
  }
  return out;
}

/**
 * Tag sync then (releasable) the scan. NEVER THROWS. One run per repo at a time: a call while another is
 * running for the repo does nothing (both read the same GitHub state).
 */
export async function runTagsStep(opts: TagsStepOptions): Promise<TagsStepResult> {
  if (inFlight.has(opts.repoId)) return { tags: null };
  inFlight.add(opts.repoId);
  let next: 'done' | 'quick' | 'catch_up' = 'done';
  try {
    const views = await viewsOf(opts);
    const releasable = views.length > 0;
    if (opts.external === true && !releasable) return { tags: null };
    const deadline = Date.now() + (opts.runMs ?? WALK_RUN_MS);

    let tags: RepoTagSyncResult | null = null;
    let head: { headSha: string; branch: string | null } | null = null;
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
      // A releasable repo with no head in memory (a restart) reads, so its walk can go on.
      if (skipRead && releasable && !lastHead.has(opts.repoId)) skipRead = false;
    }
    if (!skipRead) {
      const { deps: _deps, ...tagOpts } = opts;
      tags = await syncRepoTagsSafe({ ...tagOpts, ...(releasable ? { readCap: REPO_TAGS_READ_CAP_RELEASABLE } : {}) });
      if (tags == null || !tags.read) {
        if (releasable) markTagCatchUp(opts.repoId, Date.now() + CATCH_UP_DELAY_MS);
        return { tags };
      }
      if (tags.headSha != null) {
        head = { headSha: tags.headSha, branch: tags.defaultBranchName };
        lastHead.set(opts.repoId, head);
      }
    } else head = lastHead.get(opts.repoId) ?? null;
    if (!releasable || head == null || head.branch == null) return { tags };

    // THE ONE HISTORY PASS, then the tickets of the tags it has walked.
    const walk = opts.deps?.walk ?? walkReleaseHistory;
    const history = await walk({
      owner: opts.owner,
      name: opts.name,
      repoId: opts.repoId,
      accountId: opts.accountId,
      token: opts.token,
      headSha: head.headSha,
      defaultBranch: head.branch,
      views,
      deadline,
      // The newest-first rule: once every releasing workspace has its candidate, nothing older is read.
      deepEnough: async () => {
        const { releaseCandidateProven } = await import('../db/release-check.js');
        return releaseCandidateProven(opts.accountId, opts.repoId, views);
      },
      ...(opts.log != null ? { log: opts.log } : {}),
      onProgress: (p) => noteScanStep(opts.repoId, { step: 'history', done: p.done, total: p.total, paused: p.paused }),
    });
    if (history.complete) endScanStep(opts.repoId, 'history');
    const tickets = await (opts.deps?.tickets ?? readRangeTickets)({ accountId: opts.accountId, repoId: opts.repoId, views, log: opts.log });
    next = scanNext({ history, tickets });
    return { tags, history, tickets };
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
