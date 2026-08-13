import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger, SyncRepoResult } from './sync-repo.js';

// Same mocking approach as sync-manager.test.ts, but the syncState table reports
// NO prior sync, so planSync classifies the repo as a first full backfill — the
// case the two-phase orchestration kicks in for.
vi.mock('./sync-repo.js', () => ({ syncRepo: vi.fn() }));
vi.mock('../config.js', () => ({
  config: {
    backfillDays: 90,
    foregroundSyncDays: 14,
    syncOverlapMinutes: 20,
    commitFileConcurrency: 10,
    ciHistoryBackfill: true,
  },
}));
// The one-time CI-history backfill that must fire exactly once, after a COMPLETED full walk.
// `vi.hoisted` for the same reason as sync-manager.test.ts's ML seam: the factory runs while
// the import graph is being built.
const ciBackfill = vi.hoisted(() => ({ run: vi.fn(async () => {}) }));
vi.mock('./backfill-ci-history.js', () => ({ runCiHistoryBackfill: ciBackfill.run }));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  LOCAL_ACCOUNT_ID: 1,
}));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name' };
  const syncState = { repoId: 'ss.repo_id', lastIncrementalSyncAt: 'ss.inc_at' };
  const repoRow = { id: 1, owner: 'o', name: 'n', accountId: 1 };
  const select = (): Record<string, unknown> => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      where: () => chain,
      limit: () => chain,
      // Never-synced: syncState query returns no rows → planSync → full backfill.
      execute: () => (table === repos ? [repoRow] : []),
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState } };
});

import { syncRepo } from './sync-repo.js';
import { runSyncForRepo } from './sync-manager.js';

const mockSyncRepo = vi.mocked(syncRepo) as unknown as Mock;
const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
// Let the fire-and-forget background task (its awaited phases + the finally that
// clears the `running` set) drain before assertions.
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r));
  await new Promise((r) => setTimeout(r));
};

const result = (over: Partial<SyncRepoResult>): SyncRepoResult => ({
  repoId: 1,
  prCount: 0,
  pages: 1,
  rateLimitRemaining: 5000,
  rateLimitCost: 1,
  cancelled: false,
  endCursor: null,
  ...over,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (since: Date): number => (Date.now() - since.getTime()) / DAY_MS;

describe('two-phase first sync', () => {
  beforeEach(() => {
    mockSyncRepo.mockReset();
    ciBackfill.run.mockClear();
  });

  it('runs a fast foreground pass then a background backfill pass, handing off the cursor', async () => {
    mockSyncRepo
      .mockResolvedValueOnce(result({ prCount: 30, endCursor: 'CURSOR_AT_CUTOFF' }))
      .mockResolvedValueOnce(result({ prCount: 200, endCursor: null }));

    expect(await runSyncForRepo(1, makeLog(), { background: true })).toBe(true);
    await flush();

    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
    const p1 = mockSyncRepo.mock.calls[0]![0];
    const p2 = mockSyncRepo.mock.calls[1]![0];

    // Phase 1: foreground window (~14d), no authoritative state write.
    expect(p1.commitState).toBe(false);
    expect(p1.startCursor).toBeUndefined();
    expect(daysAgo(p1.since)).toBeGreaterThan(13);
    expect(daysAgo(p1.since)).toBeLessThan(15);

    // Phase 2: resumes from phase 1's cursor, deep window (~90d), commits state.
    expect(p2.commitState).toBe(true);
    expect(p2.startCursor).toBe('CURSOR_AT_CUTOFF');
    expect(daysAgo(p2.since)).toBeGreaterThan(89);
    expect(daysAgo(p2.since)).toBeLessThan(91);

    // The concurrency knob is threaded into both passes.
    expect(p1.commitFileConcurrency).toBe(10);
    expect(p2.commitFileConcurrency).toBe(10);
  });

  it('does not start phase 2 when the foreground pass is cancelled', async () => {
    mockSyncRepo.mockResolvedValueOnce(result({ cancelled: true, endCursor: 'X' }));

    await runSyncForRepo(1, makeLog(), { background: true });
    await flush();

    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    // A cancelled walk must not spend the backfill's GraphQL budget either.
    expect(ciBackfill.run).not.toHaveBeenCalled();
  });

  it('runs the CI-history backfill exactly once, after a completed full walk', async () => {
    mockSyncRepo
      .mockResolvedValueOnce(result({ prCount: 30, endCursor: 'CURSOR_AT_CUTOFF' }))
      .mockResolvedValueOnce(result({ prCount: 200, endCursor: null }));

    await runSyncForRepo(1, makeLog(), { background: true });
    await flush();

    expect(ciBackfill.run).toHaveBeenCalledTimes(1);
    expect(ciBackfill.run).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'o',
        name: 'n',
        repoId: 1,
        accountId: 1,
        token: 'test-token',
      }),
    );
  });

  it('skips the backfill when a cancellation lands during phase 2', async () => {
    mockSyncRepo
      .mockResolvedValueOnce(result({ prCount: 30, endCursor: 'CURSOR_AT_CUTOFF' }))
      .mockResolvedValueOnce(result({ prCount: 12, cancelled: true }));

    await runSyncForRepo(1, makeLog(), { background: true });
    await flush();

    expect(ciBackfill.run).not.toHaveBeenCalled();
  });

  it('keeps a forced "deep" re-sync single-pass (no foreground split)', async () => {
    mockSyncRepo.mockResolvedValue(result({ endCursor: null }));

    await runSyncForRepo(1, makeLog(), { background: true, forceFull: true });
    await flush();

    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    const call = mockSyncRepo.mock.calls[0]![0];
    expect(call.commitState).toBe(true);
    expect(call.startCursor).toBeUndefined();
    expect(daysAgo(call.since)).toBeGreaterThan(89);
  });
});
