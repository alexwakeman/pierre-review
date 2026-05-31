import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// Mock the two seams sync-manager touches so the orchestration logic can be
// exercised without a real DB or network: a controllable syncRepo spy and a
// minimal chainable db whose `.from(table)` decides what rows come back.
vi.mock('./sync-repo.js', () => ({ syncRepo: vi.fn() }));
vi.mock('../config.js', () => ({ config: { backfillDays: 90, syncOverlapMinutes: 20 } }));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name' };
  const syncState = {
    repoId: 'ss.repo_id',
    lastIncrementalSyncAt: 'ss.inc_at',
    lastFullSyncAt: 'ss.full_at',
    lastSyncStatus: 'ss.status',
    lastSyncError: 'ss.error',
  };
  const repoRow = { id: 1, owner: 'o', name: 'n' };
  // A prior incremental sync exists, so the scheduled path plans an incremental.
  const syncStateRow = { lastIncrementalSyncAt: new Date('2020-01-01T00:00:00Z') };
  const select = (): Record<string, unknown> => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      where: () => chain,
      get: () => (table === repos ? repoRow : table === syncState ? syncStateRow : null),
      all: () => (table === repos ? [{ id: 1 }] : []),
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState } };
});

import { syncRepo } from './sync-repo.js';
import { isDeepSyncActive, runSyncForRepo, syncAllRepos } from './sync-manager.js';

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

    // Kick off a deep sync — it stays running.
    expect(runSyncForRepo(1, log, { background: true, forceFull: true })).toBe(true);
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
