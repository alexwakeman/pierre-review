import { eq, gte } from 'drizzle-orm';
import type { SyncProgress, SyncRunStatus, SyncStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { syncRepo, type Logger } from './sync-repo.js';
import { isDue, decideIncrementalWalk, recordFullWalk } from './adaptive.js';
import { isSeverityApiConfigured } from '../ml/severity-client.js';
import { runMlEnrichmentTick } from './ml-enrichment.js';
import { deleteMlLabelsForRepo } from '../db/ml-labels.js';

const { repos, syncState, accounts } = schema;

// In-memory record of which repos are mid-sync (status isn't persisted as
// "running" — it lives only for the lifetime of the process).
const running = new Set<number>();

// Repos currently undergoing a user-initiated FULL ("deep") sync. The deep button
// fires a forced full sync on every repo at once; they finish at different times.
// While ANY deep sync is still in flight we skip the scheduled incremental run
// entirely — otherwise the cron starts a fresh incremental on each repo the moment
// its deep sync finishes, resetting that repo's progress bar to 0% mid-session.
const deepSyncing = new Set<number>();

// True while a deep (forced-full) sync is in progress on any repo.
export function isDeepSyncActive(): boolean {
  return deepSyncing.size > 0;
}

// ---- Manual-sync throttling ----
//
// `running.has(repoId)` only refuses a sync for the SAME repo that is already going. It did
// not stop: (a) restarting a repo the instant its sync finished, or (b) starting a forced
// 90-day backfill on all 100 permitted repos at once. Either turns one authenticated caller
// into a permanent, N-way GraphQL+REST walk that drains the tenant's GitHub quota (so their
// real sync silently stalls) and, in cloud, starves every other tenant of event-loop time in
// the single shared Fastify process.
//
// Two bounds, both deliberately outside `runSyncForRepo` so its signature (and its tests)
// stay as they are: a per-repo cooldown the route checks first, and a cap on how many
// API-triggered syncs may be in flight at once. The SCHEDULER is exempt from both — it is a
// sequential loop that already skips `running` repos and is not caller-controlled.
const manualSyncAt = new Map<number, number>();

// A forced full backfill is the expensive one (90 days, every page, per-commit REST fetches),
// so it gets the long cooldown. A plain manual sync is an incremental walk — cheap, and users
// legitimately hit Refresh — so it only needs enough to stop a hammering loop.
// Read straight from env with a local parser rather than importing config's `intFromEnv`:
// sync-manager's tests vi.mock('../config.js') wholesale, so importing a second symbol from it
// would make every one of them fail on a missing mock export.
const envSec = (key: string, fallback: number): number => {
  const n = Number.parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const FULL_SYNC_COOLDOWN_MS = envSec('FULL_SYNC_COOLDOWN_SEC', 5 * 60) * 1000;
const MANUAL_SYNC_COOLDOWN_MS = envSec('MANUAL_SYNC_COOLDOWN_SEC', 30) * 1000;

// How many API-triggered background syncs may run concurrently across the process. The "deep
// sync everything" button fires one POST per repo, so this queues them instead of running 100
// GraphQL walks at once — the work still happens, just not all in the same second.
const MAX_CONCURRENT_API_SYNCS = envSec('MAX_CONCURRENT_SYNCS', 4);

/**
 * Milliseconds a caller must wait before manually syncing this repo again, or 0 when it may
 * go now. Checked by the route so it can answer 429 + Retry-After; `runSyncForRepo` itself is
 * unchanged so the scheduler and the tests are unaffected.
 */
export function manualSyncCooldownMs(repoId: number, forceFull: boolean): number {
  const last = manualSyncAt.get(repoId);
  if (last === undefined) return 0;
  const window = forceFull ? FULL_SYNC_COOLDOWN_MS : MANUAL_SYNC_COOLDOWN_MS;
  const remaining = window - (Date.now() - last);
  return remaining > 0 ? remaining : 0;
}

/** True when too many API-triggered syncs are already in flight (caller should 429). */
export function apiSyncSlotsExhausted(): boolean {
  return running.size >= MAX_CONCURRENT_API_SYNCS;
}

/** Record a manual sync so the cooldown above starts running. Called by the route. */
export function noteManualSync(repoId: number): void {
  manualSyncAt.set(repoId, Date.now());
  // Bounded: a tenant may watch at most MAX_REPOS_PER_ACCOUNT repos, but in cloud this map is
  // process-wide across all tenants, so drop entries that are past every cooldown window.
  if (manualSyncAt.size > 5_000) {
    const cutoff = Date.now() - Math.max(FULL_SYNC_COOLDOWN_MS, MANUAL_SYNC_COOLDOWN_MS);
    for (const [id, at] of manualSyncAt) if (at < cutoff) manualSyncAt.delete(id);
  }
}

// Repos the user has asked to STOP mid-sync. syncRepo polls this between pages
// (and PRs) and bails out without recording the run as complete, so a cancelled
// initial backfill leaves the repo "never synced" (the cancel endpoint then
// deletes it + its partial data). Only meaningful while the repo is running.
const cancelRequested = new Set<number>();

export function requestSyncCancel(repoId: number): void {
  if (running.has(repoId)) cancelRequested.add(repoId);
}

// Block until a repo's in-flight sync has actually stopped (the loop notices the
// cancel flag after its current page/PR), or the timeout elapses. Returns true if
// it stopped. Used by the cancel endpoint before deleting an initial-load repo.
export async function waitForSyncToStop(
  repoId: number,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (running.has(repoId)) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;
}

// Live progress for in-flight syncs, surfaced via getSyncStatus so the UI can
// show a determinate bar. Lives only for the duration of the run.
const progressByRepo = new Map<number, SyncProgress>();

function setSyncProgress(repoId: number, p: SyncProgress): void {
  progressByRepo.set(repoId, p);
}

function clearSyncProgress(repoId: number): void {
  progressByRepo.delete(repoId);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function isSyncRunning(repoId: number): boolean {
  return running.has(repoId);
}

export async function getSyncStatus(repoId: number): Promise<SyncStatus | null> {
  const state = (
    await db
      .select()
      .from(syncState)
      .where(eq(syncState.repoId, repoId))
      .limit(1)
      .execute()
  )[0];

  let status: SyncRunStatus = 'idle';
  if (running.has(repoId)) status = 'running';
  else if (state?.lastSyncStatus === 'error') status = 'error';
  else if (state?.lastSyncStatus === 'ok') status = 'ok';

  return {
    repoId,
    status,
    progress: status === 'running' ? progressByRepo.get(repoId) ?? null : null,
    lastFullSyncAt: state?.lastFullSyncAt?.toISOString() ?? null,
    lastIncrementalSyncAt: state?.lastIncrementalSyncAt?.toISOString() ?? null,
    lastSyncError: state?.lastSyncError ?? null,
  };
}

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  accountId: number;
}

async function getRepoRow(repoId: number): Promise<RepoRow | null> {
  return (
    (
      await db
        .select({
          id: repos.id,
          owner: repos.owner,
          name: repos.name,
          accountId: repos.accountId,
        })
        .from(repos)
        .where(eq(repos.id, repoId))
        .limit(1)
        .execute()
    )[0] ?? null
  );
}

// Decide window: incremental if we've ever synced, otherwise a full backfill.
async function planSync(
  repoId: number,
): Promise<{ mode: 'full' | 'incremental'; since: Date }> {
  const state = (
    await db
      .select()
      .from(syncState)
      .where(eq(syncState.repoId, repoId))
      .limit(1)
      .execute()
  )[0];
  if (state?.lastIncrementalSyncAt) {
    const since = new Date(
      state.lastIncrementalSyncAt.getTime() - config.syncOverlapMinutes * 60 * 1000,
    );
    return { mode: 'incremental', since };
  }
  return { mode: 'full', since: new Date(Date.now() - config.backfillDays * DAY_MS) };
}

/**
 * Run a sync for one repo. When `background` is true (the default for the API),
 * returns immediately and the sync continues; the running flag and sync_state
 * reflect progress. Returns false if a sync is already in flight.
 */
export async function runSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { background?: boolean; forceFull?: boolean } = {},
): Promise<boolean> {
  if (running.has(repoId)) return false;
  // Reserve the slot synchronously, BEFORE any await, so a cron tick (or a
  // second request) firing during the now-async getRepoRow/planSync below sees
  // this repo as already in-flight and stands down. Mirror this with a
  // running.delete on every early-bail after this point.
  running.add(repoId);
  // Track forced-full runs so the scheduler stands down for the whole deep-sync
  // session (added synchronously here, before any await, so a cron tick that
  // fires right after this call already sees the deep sync as active).
  if (opts.forceFull) deepSyncing.add(repoId);

  const repo = await getRepoRow(repoId);
  if (!repo) {
    running.delete(repoId);
    if (opts.forceFull) deepSyncing.delete(repoId);
    return false;
  }

  const plan = opts.forceFull
    ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
    : await planSync(repoId);

  setSyncProgress(repoId, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
  let token: string;
  try {
    token = await getAccessToken(repo.accountId);
  } catch (err) {
    running.delete(repoId);
    if (opts.forceFull) deepSyncing.delete(repoId);
    clearSyncProgress(repoId);
    log.error(
      `sync ${repo.owner}/${repo.name}: no access token for account ${repo.accountId}: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  const common = {
    owner: repo.owner,
    name: repo.name,
    accountId: repo.accountId,
    token,
    log,
    commitFileConcurrency: config.commitFileConcurrency,
    shouldCancel: () => cancelRequested.has(repoId),
  };

  // Two-phase only for a first full backfill (never-synced, not a forced "deep"
  // re-sync) when the backfill window is wider than the foreground window. A deep
  // re-sync stays single-pass — its board is already populated, so there's no
  // blank-board wait to shorten.
  const twoPhase =
    !opts.forceFull && plan.mode === 'full' && config.backfillDays > config.foregroundSyncDays;

  const runWalk = async (): Promise<{ cancelled: boolean }> => {
    if (!twoPhase) {
      const r = await syncRepo({
        ...common,
        mode: plan.mode,
        since: plan.since,
        commitState: true,
        onProgress: (p) => setSyncProgress(repoId, { ...p, mode: plan.mode }),
      });
      return { cancelled: r.cancelled };
    }
    // Phase 1 — the fast foreground window (the default timeline range). Committed
    // per-PR so the recent board is usable in seconds, but does NOT stamp
    // syncState, so the repo stays an "initial backfill" until phase 2 finishes.
    const foregroundSince = new Date(Date.now() - config.foregroundSyncDays * DAY_MS);
    const p1 = await syncRepo({
      ...common,
      mode: 'full',
      since: foregroundSince,
      commitState: false,
      onProgress: (p) =>
        setSyncProgress(repoId, { ...p, mode: 'full', foregroundComplete: false }),
    });
    if (p1.cancelled) return { cancelled: true };
    // Foreground done — flip the flag so the UI drops the user into the recent
    // view, then continue the SAME cursor walk back to the full backfill window.
    setSyncProgress(repoId, {
      percent: 1,
      prsProcessed: p1.prCount,
      pages: p1.pages,
      mode: 'full',
      foregroundComplete: true,
    });
    const p2 = await syncRepo({
      ...common,
      mode: 'full',
      since: plan.since, // now − backfillDays
      startCursor: p1.endCursor,
      commitState: true,
      onProgress: (p) =>
        setSyncProgress(repoId, { ...p, mode: 'full', foregroundComplete: true }),
    });
    return { cancelled: p2.cancelled };
  };

  const task = runWalk()
    .then(async (walk) => {
      // Deep re-sync is the user's explicit "re-fetch and re-derive everything" gesture:
      // purge this repo's ML labels so the enrichment worker re-scores the whole corpus
      // against the CURRENTLY served model (labels are model_version-stamped; a deep sync
      // after a model upgrade is exactly how stale labels get replaced).
      if (opts.forceFull && isSeverityApiConfigured()) {
        await deleteMlLabelsForRepo(repo.accountId, repoId);
        log.info(`deep sync ${repo.owner}/${repo.name}: purged ML labels for re-scoring`);
      }
      // One-time CI-HISTORY backfill after a completed FULL walk (a repo's first sync, or a
      // forced deep re-sync): trunk commits back to the trend window + synthesized per-PR CI
      // transition events, so the Activity CI charts aren't blank on a fresh repo. Runs while
      // this repo still holds its `running` slot (no snapshot can race it) and is internally
      // non-fatal + cancellation-aware. Dynamically imported so the gate stays the only
      // coupling — a disabled backfill loads nothing.
      if (
        plan.mode === 'full' &&
        !walk.cancelled &&
        !cancelRequested.has(repoId) &&
        config.ciHistoryBackfill
      ) {
        const { runCiHistoryBackfill } = await import('./backfill-ci-history.js');
        await runCiHistoryBackfill({
          owner: repo.owner,
          name: repo.name,
          repoId,
          accountId: repo.accountId,
          token,
          log,
          shouldCancel: common.shouldCancel,
        });
      }
    })
    .catch((err) => {
      log.error(
        `background sync ${repo.owner}/${repo.name} failed: ${err instanceof Error ? err.message : err}`,
      );
    })
    .finally(() => {
      // ⚠ ORDER IS LOAD-BEARING: the enrichment tick is kicked BEFORE this repo is released
      // and its progress cleared.
      //
      // The GitHub walk is only half of making the board correct — the severity badges come
      // from a CPU-bound model pass over the same text, which cannot run inside the walk (see
      // docs/ML-SEVERITY.md) and therefore always follows it. This used to run AFTER
      // clearSyncProgress, which put the model calls structurally downstream of "done": the
      // client saw every repo idle, declared the sync complete, and only then did scoring
      // start — so no indicator could ever represent it.
      //
      // runMlEnrichmentTick's guards and its `running = true` all sit before its first await,
      // so by the time this line returns `GET /api/ml-status` already reports the scoring
      // phase and there is no window in which a poll sees both halves idle. The tick is
      // re-entrancy-guarded and budget-bounded; if one is already running this is a cheap
      // no-op (and the pending count keeps the UI honest until it is picked up).
      if (isSeverityApiConfigured()) void runMlEnrichmentTick(log);
      running.delete(repoId);
      deepSyncing.delete(repoId);
      cancelRequested.delete(repoId);
      clearSyncProgress(repoId);
    });

  if (!opts.background) return Boolean(task);
  return true;
}

/** Incrementally sync every configured repo (used by the scheduler). */
export async function syncAllRepos(log: Logger): Promise<void> {
  // Stand down entirely while a deep (forced-full) sync is in progress. Resuming
  // a repo incrementally the instant its deep sync finishes would reset its
  // progress bar mid-session; idempotent upserts + the overlap window mean the
  // next scheduled tick loses nothing by waiting.
  if (deepSyncing.size > 0) {
    log.info(
      `scheduled sync skipped: deep sync in progress (${deepSyncing.size} repo(s))`,
    );
    return;
  }
  // CLOUD: only sync repos whose owning account has a loaded frontend (active within
  // config.syncActiveWindowMinutes). With no open tab a tenant's repos stop being
  // re-synced — periodic sync follows the user, not the server clock. LOCAL: one
  // always-on account, so sync every repo unconditionally (unchanged behaviour).
  const all = config.isCloud
    ? await db
        .select({ id: repos.id })
        .from(repos)
        .innerJoin(accounts, eq(repos.accountId, accounts.id))
        .where(
          gte(
            accounts.lastActiveAt,
            new Date(Date.now() - config.syncActiveWindowMinutes * 60_000),
          ),
        )
        .execute()
    : await db.select({ id: repos.id }).from(repos).execute();
  if (config.isCloud && all.length === 0) {
    log.info('scheduled sync skipped: no accounts with a loaded frontend');
    return;
  }
  for (const r of all) {
    if (running.has(r.id)) continue;
    // Adaptive (config.syncAdaptive): skip repos not yet due for their activity bucket —
    // cheap, no I/O — before reserving the slot or fetching a token. Off by default, so
    // the loop below is unchanged for everyone who hasn't opted in.
    if (config.syncAdaptive && !isDue(r.id, Date.now())) continue;
    // Reserve the slot synchronously before the now-async getRepoRow/planSync
    // awaits below so a concurrent tick doesn't double-start this repo.
    running.add(r.id);
    try {
      const repo = (await getRepoRow(r.id))!;
      const token = await getAccessToken(repo.accountId);
      const plan = await planSync(r.id);
      // Adaptive: for an INCREMENTAL sync, probe a cheap conditional request first and skip
      // the fat GraphQL walk when nothing changed (304, free) and the re-walk floor isn't
      // due. First backfills (mode 'full') always walk. The `finally` releases the slot.
      if (config.syncAdaptive && plan.mode === 'incremental') {
        const decision = await decideIncrementalWalk(
          r.id,
          repo.owner,
          repo.name,
          token,
          Date.now(),
        );
        if (!decision.walk) {
          log.info(
            `scheduled sync ${repo.owner}/${repo.name} skipped (${decision.reason})`,
          );
          continue;
        }
      }
      setSyncProgress(r.id, { percent: 0, prsProcessed: 0, pages: 0, mode: plan.mode });
      await syncRepo({
        owner: repo.owner,
        name: repo.name,
        accountId: repo.accountId,
        token,
        ...plan,
        commitState: true,
        commitFileConcurrency: config.commitFileConcurrency,
        log,
        onProgress: (p) => setSyncProgress(r.id, { ...p, mode: plan.mode }),
        shouldCancel: () => cancelRequested.has(r.id),
      });
      // Adaptive: reset the re-walk floor now that a full walk has completed.
      if (config.syncAdaptive) recordFullWalk(r.id, Date.now());
    } catch (err) {
      log.error(
        `scheduled sync of repo ${r.id} failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running.delete(r.id);
      cancelRequested.delete(r.id);
      clearSyncProgress(r.id);
    }
  }
}
