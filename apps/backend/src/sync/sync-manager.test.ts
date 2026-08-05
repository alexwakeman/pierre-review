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
      execute: () =>
        table === repos ? [repoRow] : table === syncState ? [syncStateRow] : [],
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState } };
});

import { syncRepo } from './sync-repo.js';
import {
  isDeepSyncActive,
  isSyncRunning,
  runSyncForRepo,
  syncAllRepos,
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
