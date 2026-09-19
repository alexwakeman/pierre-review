import { eq, gte } from 'drizzle-orm';
import type { SyncProgress, SyncRunStatus, SyncStatus } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { syncRepo, type Logger } from './sync-repo.js';
import {
  backoffMsFor,
  decideIncrementalWalk,
  isDue,
  noteAttempt,
  noteWalkFailure,
  noteWalkSuccess,
  recordFullWalk,
} from './adaptive.js';
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
// stay as they are: a per-repo cooldown the route checks first, and the per-account SERIAL
// queue below (`enqueueSyncForRepo` — which replaced the old process-wide
// MAX_CONCURRENT_SYNCS cap + its 429). The SCHEDULER is exempt from both — it is a
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
  // A repo still WAITING in the per-account queue never started anything: drop it and
  // clear its 'queued' progress row synchronously, so waitForSyncToStop (which watches
  // `running`) returns immediately and cancel-and-delete of a never-synced repo works
  // without ever touching GitHub.
  if (queuedRepos.delete(repoId)) {
    clearSyncProgress(repoId);
    return;
  }
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

// ---- Per-account serialization of API-triggered syncs ----
//
// POST /api/repos (add → initial backfill) and POST /api/repos/:id/sync used to fire
// runSyncForRepo directly, so adding several repos consecutively (or "deep sync
// everything") ran N concurrent two-phase 90-day walks — each with a 10-way commit-file
// REST fan-out — against ONE token, which is precisely how a caller drives their own
// account into GitHub's rate limiter. API-triggered walks now run ONE AT A TIME per
// account: a chained promise per accountId; later repos wait with an honest
// `paused: { reason: 'queued' }` progress row (status reads 'running'). The SCHEDULER
// stays exempt — it is already a sequential loop and is not caller-controlled.
const apiSyncChain = new Map<number, Promise<void>>();
// Repos waiting in a chain (queued, not yet started). The source of truth for "still
// wants to run": requestSyncCancel drops a repo from here synchronously and the chain
// skips it when its turn comes.
const queuedRepos = new Set<number>();

/** True while a repo is waiting in the per-account API-sync queue (not yet running). */
export function isSyncQueued(repoId: number): boolean {
  return queuedRepos.has(repoId);
}

// Live progress for in-flight syncs, surfaced via getSyncStatus so the UI can
// show a determinate bar. Lives only for the duration of the run.
const progressByRepo = new Map<number, SyncProgress>();

/**
 * Snapshot of every live progress row — running walks AND repos still waiting in the
 * per-account queue (their seeded row rides `paused: { reason: 'queued' }`). Read-only,
 * for `GET /api/sync-activity`; the maps themselves stay private to this module. The
 * caller filters (e.g. to full-mode walks) and MUST re-scope by account — this map is
 * process-wide across tenants in cloud. Progress objects are replaced wholesale by
 * setSyncProgress (never mutated in place), so returning the references is safe.
 */
export function listActiveSyncProgress(): Array<{ repoId: number; progress: SyncProgress }> {
  return [...progressByRepo].map(([repoId, progress]) => ({ repoId, progress }));
}

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

  // A repo WAITING in the per-account queue reads as 'running' with its queued progress
  // row — an honest "held, will go on its own", never idle/error.
  let status: SyncRunStatus = 'idle';
  if (running.has(repoId) || queuedRepos.has(repoId)) status = 'running';
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

  let repo: RepoRow;
  let plan: { mode: 'full' | 'incremental'; since: Date };
  try {
    const row = await getRepoRow(repoId);
    if (!row) {
      running.delete(repoId);
      if (opts.forceFull) deepSyncing.delete(repoId);
      return false;
    }
    repo = row;
    plan = opts.forceFull
      ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
      : await planSync(repoId);
  } catch (err) {
    // Mirror of the token catch below: a rejected lookup must release BOTH reservations,
    // or a transient DB error leaks them forever — a leaked `running` entry makes the
    // repo un-syncable and un-deletable, and a leaked `deepSyncing` entry stands the
    // scheduler down on every tick (isDeepSyncActive).
    running.delete(repoId);
    if (opts.forceFull) deepSyncing.delete(repoId);
    clearSyncProgress(repoId);
    log.error(
      `sync repo ${repoId}: repo/plan lookup failed: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }

  setSyncProgress(repoId, {
    percent: 0,
    prsProcessed: 0,
    pages: 0,
    mode: plan.mode,
    sinceMs: plan.since.getTime(),
  });
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
    // So a walk that dies BEFORE upsertRepo (404 / dead token / SAML wall) still records an
    // error on sync_state — otherwise a repo that never once synced reads 'idle' forever.
    knownRepoId: repoId,
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
        onProgress: (p) =>
          setSyncProgress(repoId, { ...p, mode: plan.mode, sinceMs: plan.since.getTime() }),
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
        setSyncProgress(repoId, {
          ...p,
          mode: 'full',
          foregroundComplete: false,
          // Phase 1 walks the FOREGROUND window, not plan.since — `sinceMs` names the cutoff
          // this percent is measured against, so it must be the same one syncRepo was given.
          sinceMs: foregroundSince.getTime(),
        }),
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
      // Still the foreground window: this percent is phase 1's completed one. Phase 2's own
      // first update below re-stamps it with the backfill window.
      sinceMs: foregroundSince.getTime(),
    });
    const p2 = await syncRepo({
      ...common,
      mode: 'full',
      since: plan.since, // now − backfillDays
      startCursor: p1.endCursor,
      commitState: true,
      onProgress: (p) =>
        setSyncProgress(repoId, {
          ...p,
          mode: 'full',
          foregroundComplete: true,
          sinceMs: plan.since.getTime(),
        }),
    });
    return { cancelled: p2.cancelled };
  };

  const task = runWalk()
    .then(async (walk) => {
      // A user-initiated walk that came back clean is proof the repo is readable again:
      // clear the scheduler's health backoff so the normal cadence resumes at once instead
      // of after the (up to 6h) window. Failures are deliberately NOT recorded here — the
      // backoff paces the SCHEDULER's unattended attempts, not a person pressing Refresh.
      if (!walk.cancelled) noteWalkSuccess(repoId, Date.now());
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

      // BLAST RADIUS, step 1 of 3: give every open pull request a FILE LIST.
      //
      // ⚠ FIRST, because the two steps below both read `files` — the co-change index folds it and
      // the change-shape candidate test needs a level to narrow from. Ordering, not preference.
      //
      // A pull request with no stored `files` has no blast radius at all (measured: 9.8% of open
      // pull requests), and no diff read can fix that — there is nothing for a diff to refine.
      // Bounded per run, once per pull request, strictly non-fatal.
      try {
        const { backfillMissingPrFiles } = await import('./routing-files.js');
        await backfillMissingPrFiles(repo.accountId, repoId, log);
      } catch (err) {
        log.warn(
          `files backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }

      // Chronology's REVIEW-REQUEST HISTORY for merged PRs the walk will never revisit — bounded
      // per run, once per PR (stamped), budget-aware, strictly non-fatal. After every walk, like the
      // files backfill above, so a repo's history converges over a few syncs rather than waiting
      // for a forced deep re-sync.
      try {
        const { backfillReviewRequestHistory } = await import('./backfill-review-requests.js');
        await backfillReviewRequestHistory(repo.accountId, repoId, log);
      } catch (err) {
        log.warn(
          `review-request backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }

      // DEPENDENCY + SECURITY signals for open automation PRs the walk has not classified — the
      // same shape as the backfill above: bounded per run, stamped once per PR, budget-aware,
      // strictly non-fatal. After every walk, so a PR classified before the detector existed
      // converges in a few syncs rather than waiting for its next push.
      try {
        const { backfillPrSecurity } = await import('./backfill-pr-security.js');
        await backfillPrSecurity(repo.accountId, repoId, log);
      } catch (err) {
        log.warn(
          `security backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }

      // The BLAST-RADIUS co-change index for this repo. Purely LOCAL — one indexed read of the
      // repo's merged pull requests, an in-memory fold and one upsert; it makes NO GitHub call
      // and spends no rate-limit budget, so unlike the backfill above it needs no gate and no
      // cancellation check beyond finishing quickly.
      //
      // Rebuilt after every walk rather than once: the index is a function of the repo's merged
      // history, which every walk can extend. It is also self-correcting — a repo that has
      // dropped below the coverage floor has its row DELETED rather than left stale, which is
      // why this is a rebuild and not an append.
      //
      // ⚠ STRICTLY NON-FATAL, like the branch snapshot. This is a nice-to-have arm on one
      // indicator; it must never be the reason a sync reports failure.
      try {
        const { rebuildRepoCoupling } = await import('../db/file-coupling.js');
        await rebuildRepoCoupling(repo.accountId, repoId);
      } catch (err) {
        log.warn(
          `co-change index ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }

      // BLAST RADIUS: the targeted diff read that tells a comments-only change from a real one.
      // ⚠ AFTER the co-change index above, not before — its candidate test reads the hub signal,
      // and a stale index would misjudge a hub-driven high as surface-driven and spend a call on
      // it. Ordering, not preference.
      //
      // Unlike the index this DOES spend GitHub quota, which is why it is narrow: only pull
      // requests that are currently high on a CONTRACT SURFACE ALONE and small enough for the
      // answer to be plausible, once per head sha, capped per run. Measured at 1.7% of open pull
      // requests. Strictly non-fatal.
      try {
        const { runChangeShapeClassification } = await import('./classify-change-shape.js');
        await runChangeShapeClassification({
          owner: repo.owner,
          name: repo.name,
          repoId,
          accountId: repo.accountId,
          token,
          log,
          shouldCancel: common.shouldCancel,
        });
      } catch (err) {
        log.warn(
          `change-shape ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
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

  // background:false waits for the whole task (walk + follow-on phases + the finally) to
  // settle before returning — the per-account queue's serialization depends on it. The
  // task's .catch above means this await never throws.
  if (!opts.background) await task;
  return true;
}

/**
 * Queue an API-triggered sync behind the account's other API-triggered walks (the add-repo
 * initial backfill and the manual/deep sync both come through here). Returns false when the
 * repo is already running or queued (the manual route 409s), true once queued — the walk
 * itself runs when its turn comes. While waiting, the repo shows a 'running' status with a
 * `paused: { reason: 'queued' }` progress row; runSyncForRepo's own first progress write
 * clears the flag when the walk actually starts.
 */
export async function enqueueSyncForRepo(
  repoId: number,
  log: Logger,
  opts: { forceFull?: boolean } = {},
): Promise<boolean> {
  if (running.has(repoId) || queuedRepos.has(repoId)) return false;
  // Reserve synchronously, BEFORE any await (the running.add rule above): a second
  // enqueue racing the lookups below must already see this repo as queued.
  queuedRepos.add(repoId);
  let repo: RepoRow;
  try {
    const row = await getRepoRow(repoId);
    if (!row) {
      queuedRepos.delete(repoId);
      return false;
    }
    repo = row;
    // The plan is display-only here (the honest waiting row); runSyncForRepo re-plans when
    // the walk actually starts. `since` rides it so a repo QUEUED for a cold-return catch-up
    // is reported as one from the moment it is queued, not only once it starts walking.
    const plan = opts.forceFull
      ? { mode: 'full' as const, since: new Date(Date.now() - config.backfillDays * DAY_MS) }
      : await planSync(repoId);
    // A cancel may have raced the awaits above (requestSyncCancel drops queued repos and
    // clears their progress synchronously) — don't resurrect the row it already cleared.
    if (!queuedRepos.has(repoId)) return false;
    setSyncProgress(repoId, {
      percent: 0,
      prsProcessed: 0,
      pages: 0,
      mode: plan.mode,
      sinceMs: plan.since.getTime(),
      paused: { reason: 'queued' },
    });
  } catch (err) {
    // A rejected lookup must release the reservation, or a transient DB error leaves the
    // repo 'queued' forever: status reads 'running' with no progress, every later
    // enqueue is refused, and the scheduler skips it. Rethrow so both routes keep their
    // current error behaviour.
    queuedRepos.delete(repoId);
    clearSyncProgress(repoId);
    throw err;
  }

  const prev = apiSyncChain.get(repo.accountId) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      // Dropped while waiting (cancelled / cancel-and-deleted): its progress row is
      // already cleared, and nothing must run.
      if (!queuedRepos.delete(repoId)) return;
      // background:false ⇒ resolves only when the walk has fully settled — that await IS
      // the serialization. A false return (repo deleted mid-queue, token failure) must
      // still drop the queued progress row, which runSyncForRepo never owned.
      const started = await runSyncForRepo(repoId, log, {
        background: false,
        forceFull: opts.forceFull,
      });
      if (!started) clearSyncProgress(repoId);
    })
    .catch((err) => {
      // The chain must survive a rejected link, or one bad repo wedges every later sync
      // of the account. (runSyncForRepo's task never rejects; this guards its lookups.)
      log.error(
        `queued sync of repo ${repoId} failed: ${err instanceof Error ? err.message : err}`,
      );
      clearSyncProgress(repoId);
      queuedRepos.delete(repoId);
    });
  apiSyncChain.set(repo.accountId, next);
  // Self-clean: when this link settles and is still the chain's tail, drop the map entry
  // (bounded by accounts either way; this just keeps the idle map empty).
  void next.then(() => {
    if (apiSyncChain.get(repo.accountId) === next) apiSyncChain.delete(repo.accountId);
  });
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
    // Skip repos mid-sync AND repos waiting in the API queue — the queue will run them,
    // and a scheduler-started incremental would reset their honest 'queued' row.
    if (running.has(r.id) || queuedRepos.has(r.id)) continue;
    // Adaptive (config.syncAdaptive, ON BY DEFAULT IN BOTH MODES — the tick is every
    // MINUTE, so this due-check is the only thing between a repo and 60 walks an hour):
    // skip repos not yet due for their activity bucket, widened by the health backoff after
    // consecutive failures. Cheap, no I/O — before reserving the slot or fetching a token.
    if (config.syncAdaptive && !isDue(r.id, Date.now())) continue;
    // Reserve the slot synchronously before the now-async getRepoRow/planSync
    // awaits below so a concurrent tick doesn't double-start this repo.
    running.add(r.id);
    // ⚠ STAMP THE ATTEMPT FOR EVERY SCHEDULED SYNC, WHATEVER THE MODE, BEFORE ANY AWAIT.
    // decideIncrementalWalk stamps the incremental branch, and for a long time that was the
    // ONLY writer — so a repo pinned in FULL mode (which is exactly what a repo whose first
    // walk always fails is) was due on every single tick and re-walked once a minute
    // forever. This is the floor that makes that structurally impossible; the backoff below
    // is what makes the interval sane.
    noteAttempt(r.id, Date.now());
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
          // Lets the probe stand down entirely while the account is rate-limited (a
          // limited probe fails non-304, which "never skip on uncertainty" would turn
          // into MORE walks — the opposite of what a limited token needs).
          repo.accountId,
        );
        if (!decision.walk) {
          log.info(
            `scheduled sync ${repo.owner}/${repo.name} skipped (${decision.reason})`,
          );
          continue;
        }
      }
      setSyncProgress(r.id, {
        percent: 0,
        prsProcessed: 0,
        pages: 0,
        mode: plan.mode,
        sinceMs: plan.since.getTime(),
      });
      await syncRepo({
        owner: repo.owner,
        name: repo.name,
        accountId: repo.accountId,
        // So a walk that dies BEFORE upsertRepo still records an error on sync_state (see
        // SyncRepoOptions.knownRepoId): without it a repo that has never once synced
        // reports 'idle' with no error and the failure is invisible on every surface.
        knownRepoId: r.id,
        token,
        ...plan,
        commitState: true,
        commitFileConcurrency: config.commitFileConcurrency,
        log,
        onProgress: (p) =>
          setSyncProgress(r.id, { ...p, mode: plan.mode, sinceMs: plan.since.getTime() }),
        shouldCancel: () => cancelRequested.has(r.id),
      });
      // Adaptive: reset the re-walk floor now that a full walk has completed.
      if (config.syncAdaptive) recordFullWalk(r.id, Date.now());
      // ...and clear any health backoff: this repo is readable again.
      noteWalkSuccess(r.id, Date.now());
      // Chronology's review-request history for merged PRs the walk never revisits. The
      // scheduled path carries no post-walk tail of its own (runSyncForRepo's is user-triggered),
      // and without this the history would only converge when somebody pressed Sync. Bounded,
      // stamped once per PR, budget-aware, and a failure here is logged, never the walk's.
      try {
        const { backfillReviewRequestHistory } = await import('./backfill-review-requests.js');
        await backfillReviewRequestHistory(repo.accountId, r.id, log);
      } catch (err) {
        log.warn(
          `review-request backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
      // The dependency + security backfill, for the same reason: without it, an open automation
      // PR nobody pushes to is only classified when somebody presses Sync.
      try {
        const { backfillPrSecurity } = await import('./backfill-pr-security.js');
        await backfillPrSecurity(repo.accountId, r.id, log);
      } catch (err) {
        log.warn(
          `security backfill ${repo.owner}/${repo.name} failed (non-fatal): ${err instanceof Error ? err.message : err}`,
        );
      }
    } catch (err) {
      // Health backoff: a repo we cannot read must not be retried at the cadence of a
      // healthy one. The count is the ONLY thing that widens the interval past its activity
      // bucket (a first-sighted repo reads HOT, i.e. 120s), so this line is load-bearing —
      // and the error itself is already on sync_state via knownRepoId, so the UI can say so.
      const failures = noteWalkFailure(r.id, Date.now());
      log.error(
        `scheduled sync of repo ${r.id} failed (${failures} consecutive; next attempt in ` +
          `≥${Math.round(backoffMsFor(r.id) / 60_000)} min): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    } finally {
      running.delete(r.id);
      cancelRequested.delete(r.id);
      clearSyncProgress(r.id);
    }
  }
}
