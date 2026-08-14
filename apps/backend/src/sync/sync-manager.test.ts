import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// Mock the two seams sync-manager touches so the orchestration logic can be
// exercised without a real DB or network: a controllable syncRepo spy and a
// minimal chainable db whose `.from(table)` decides what rows come back.
vi.mock('./sync-repo.js', () => ({ syncRepo: vi.fn() }));
vi.mock('../config.js', () => ({ config: { backfillDays: 90, syncOverlapMinutes: 20 } }));
// The token is resolved per repo's account; stub it so the manager doesn't hit
// the real DB / gh CLI.
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  LOCAL_ACCOUNT_ID: 1,
}));
// The ML seam. `vi.hoisted` because a `vi.mock` factory runs while the import graph is being
// built — before any plain `let` in this file has executed.
const mlSeam = vi.hoisted(() => ({ configured: false, tick: vi.fn() }));
// Lets a test make the NEXT repo-row lookup reject (a transient DB error) — consumed once.
const dbSeam = vi.hoisted(() => ({ failNextRepoLookup: null as Error | null }));
vi.mock('../ml/severity-client.js', () => ({
  isSeverityApiConfigured: () => mlSeam.configured,
}));
vi.mock('./ml-enrichment.js', () => ({ runMlEnrichmentTick: mlSeam.tick }));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name' };
  const syncState = {
    repoId: 'ss.repo_id',
    lastIncrementalSyncAt: 'ss.inc_at',
    lastFullSyncAt: 'ss.full_at',
    lastSyncStatus: 'ss.status',
    lastSyncError: 'ss.error',
  };
  const repoRow = { id: 1, owner: 'o', name: 'n', accountId: 1 };
  // A prior incremental sync exists, so the scheduled path plans an incremental.
  const syncStateRow = { lastIncrementalSyncAt: new Date('2020-01-01T00:00:00Z') };
  // The query layer is now portable-async: `.limit(1).execute()` (was `.get()`)
  // and `.execute()` (was `.all()`), both returning row arrays.
  const select = (): Record<string, unknown> => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      where: () => chain,
      limit: () => chain,
      execute: () => {
        if (table === repos && dbSeam.failNextRepoLookup) {
          const err = dbSeam.failNextRepoLookup;
          dbSeam.failNextRepoLookup = null;
          throw err;
        }
        return table === repos ? [repoRow] : table === syncState ? [syncStateRow] : [];
      },
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState } };
});

import { syncRepo } from './sync-repo.js';
import {
  enqueueSyncForRepo,
  getSyncStatus,
  isDeepSyncActive,
  isSyncQueued,
  isSyncRunning,
  requestSyncCancel,
  runSyncForRepo,
  syncAllRepos,
  waitForSyncToStop,
} from './sync-manager.js';

// Loosely typed so the spy can return bare promises — the test never inspects
// syncRepo's resolved value, only that it was (or wasn't) called.
const mockSyncRepo = vi.mocked(syncRepo) as unknown as Mock;
const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

describe('scheduler stands down during a deep sync', () => {
  beforeEach(() => {
    mockSyncRepo.mockReset();
  });

  it('skips the scheduled run while a deep sync is in flight, then resumes', async () => {
    // The deep (forced-full) sync hangs until we release it; any later
    // (scheduled) sync resolves immediately.
    let releaseDeep!: () => void;
    const deepDone = new Promise<void>((res) => {
      releaseDeep = res;
    });
    mockSyncRepo.mockReturnValueOnce(deepDone).mockReturnValue(Promise.resolve());

    const log = makeLog();

    // Kick off a deep sync — it stays running. runSyncForRepo is now async
    // (awaits the repo/plan lookups) but still fire-and-forgets the sync task.
    expect(
      await runSyncForRepo(1, log, { background: true, forceFull: true }),
    ).toBe(true);
    expect(isDeepSyncActive()).toBe(true);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // A scheduled tick now must NOT start any sync (it would reset progress).
    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('deep sync in progress'),
    );

    // Deep sync finishes → the guard clears.
    releaseDeep();
    await flush();
    expect(isDeepSyncActive()).toBe(false);

    // The next scheduled tick proceeds as normal.
    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });
});

// API-triggered walks are SERIALIZED per account (enqueueSyncForRepo): the add-repo path
// and the manual/deep sync both queue behind whatever walk the account already has going,
// so N consecutive adds never run N concurrent 90-day walks on one token. The three
// contracts pinned here: (1) one walk at a time, with the waiter reporting an honest
// 'running' + paused:'queued' row; (2) a cancel while queued drops the repo WITHOUT
// running it and leaves waitForSyncToStop seeing not-running (cancel-and-delete's
// precondition); (3) a repo already queued or running is refused.
describe('per-account API-sync queue', () => {
  beforeEach(() => {
    mockSyncRepo.mockReset();
    dbSeam.failNextRepoLookup = null;
  });

  it('runs queued repos one at a time; the waiter shows an honest queued row', async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((res) => {
      releaseFirst = res;
    });
    mockSyncRepo.mockReturnValueOnce(firstDone).mockReturnValue(Promise.resolve());
    const log = makeLog();

    expect(await enqueueSyncForRepo(11, log)).toBe(true);
    await flush();
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(isSyncRunning(11)).toBe(true);

    expect(await enqueueSyncForRepo(12, log)).toBe(true);
    await flush();
    // Still only ONE walk in flight; repo 12 waits with status 'running' + queued row.
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(isSyncQueued(12)).toBe(true);
    const status = await getSyncStatus(12);
    expect(status?.status).toBe('running');
    expect(status?.progress?.paused).toEqual({ reason: 'queued' });

    releaseFirst();
    await flush();
    await flush();
    // The chain moved on: repo 12 started (and, with an instantly-resolving syncRepo,
    // already finished — no longer queued).
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
    expect(isSyncQueued(12)).toBe(false);
  });

  it('a cancel while queued drops the repo without ever running it', async () => {
    let release!: () => void;
    mockSyncRepo
      .mockReturnValueOnce(
        new Promise<void>((res) => {
          release = res;
        }),
      )
      .mockReturnValue(Promise.resolve());
    const log = makeLog();

    await enqueueSyncForRepo(21, log);
    await enqueueSyncForRepo(22, log);
    await flush();
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(isSyncQueued(22)).toBe(true);

    requestSyncCancel(22);
    // Dropped instantly: not queued, not running (waitForSyncToStop returns at once —
    // the cancel endpoint's delete path depends on this), progress row gone.
    expect(isSyncQueued(22)).toBe(false);
    expect(await waitForSyncToStop(22, 1_000)).toBe(true);
    expect((await getSyncStatus(22))?.progress).toBeNull();

    release();
    await flush();
    await flush();
    // Repo 22 never ran.
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
  });

  it('refuses a repo that is already queued (and one already running)', async () => {
    let release!: () => void;
    mockSyncRepo
      .mockReturnValueOnce(
        new Promise<void>((res) => {
          release = res;
        }),
      )
      .mockReturnValue(Promise.resolve());
    const log = makeLog();

    expect(await enqueueSyncForRepo(31, log)).toBe(true);
    await flush();
    expect(await enqueueSyncForRepo(31, log)).toBe(false); // running
    expect(await enqueueSyncForRepo(32, log)).toBe(true);
    expect(await enqueueSyncForRepo(32, log)).toBe(false); // queued

    release();
    await flush();
    await flush();
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });

  it('a rejected repo lookup releases the queue reservation (a later enqueue works)', async () => {
    mockSyncRepo.mockReturnValue(Promise.resolve());
    const log = makeLog();

    dbSeam.failNextRepoLookup = new Error('transient pg error');
    await expect(enqueueSyncForRepo(41, log)).rejects.toThrow('transient pg error');
    // The reservation must not leak: a leaked queuedRepos entry reads 'running' forever
    // with no progress, and every later enqueue is refused.
    expect(isSyncQueued(41)).toBe(false);
    expect((await getSyncStatus(41))?.status).not.toBe('running');

    expect(await enqueueSyncForRepo(41, log)).toBe(true);
    await flush();
    await flush();
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(isSyncQueued(41)).toBe(false);
  });
});

// runSyncForRepo reserves `running` (and `deepSyncing` for a forced-full run) synchronously,
// then awaits getRepoRow/planSync — a rejection there must release both, or a single transient
// DB error leaks them for the life of the process: a leaked `running` entry makes the repo
// un-syncable and un-deletable, and a leaked `deepSyncing` entry stands the scheduler down on
// every tick (isDeepSyncActive).
describe('a rejected pre-task lookup releases the in-memory reservations', () => {
  beforeEach(() => {
    mockSyncRepo.mockReset();
    dbSeam.failNextRepoLookup = null;
  });

  it('runSyncForRepo returns false and clears running + deepSyncing', async () => {
    const log = makeLog();
    dbSeam.failNextRepoLookup = new Error('transient pg error');

    expect(await runSyncForRepo(51, log, { background: true, forceFull: true })).toBe(false);
    expect(isSyncRunning(51)).toBe(false);
    expect(isDeepSyncActive()).toBe(false);
    expect(mockSyncRepo).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('transient pg error'));

    // The repo is not wedged: the next attempt starts normally.
    mockSyncRepo.mockReturnValue(Promise.resolve());
    expect(await runSyncForRepo(51, log, { background: true })).toBe(true);
    await flush();
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(isSyncRunning(51)).toBe(false);
  });
});

// A sync has two halves: the GitHub walk, and the ML pass that scores the bot text the walk
// stored. The second cannot run inside the first (docs/ML-SEVERITY.md), so it always follows —
// which means the ORDER of these two lines decides whether any UI can represent it. Kicking the
// tick after `running.delete` / `clearSyncProgress` left a window in which a client polling both
// halves saw the walk idle and no scoring in flight, and concluded the sync was complete; it
// then started the model calls. Nothing threw and nothing was slower, so only a test of the
// ordering catches a regression here.
describe('the scoring pass starts before the sync is reported done', () => {
  beforeEach(() => {
    mockSyncRepo.mockReset();
    mlSeam.tick.mockReset();
    mlSeam.configured = false;
  });

  it('kicks the enrichment tick while the repo is still marked running', async () => {
    mlSeam.configured = true;
    let runningWhenKicked: boolean | null = null;
    mlSeam.tick.mockImplementation(() => {
      runningWhenKicked = isSyncRunning(1);
    });

    await runSyncForRepo(1, makeLog(), { background: true });
    await flush();

    expect(mlSeam.tick).toHaveBeenCalledTimes(1);
    // THE ASSERTION. False here means the repo was released first, and the client's "every repo
    // idle" observation could land before scoring had begun.
    expect(runningWhenKicked).toBe(true);
    // ...and the repo is of course released immediately afterwards.
    expect(isSyncRunning(1)).toBe(false);
  });

  it('does not kick one when no severity-api is configured', async () => {
    await runSyncForRepo(1, makeLog(), { background: true });
    await flush();
    expect(mlSeam.tick).not.toHaveBeenCalled();
  });
});
