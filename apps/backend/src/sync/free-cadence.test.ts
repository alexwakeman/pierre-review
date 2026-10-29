import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// THE FREE CADENCE, WIRED: a 10-second tick, free 304 probes, at most one scheduled walk per repo
// per 60s, and the settle sweep kicked off the tick. adaptive.test.ts pins the pure cadence rules
// against a controllable clock; this file pins the WIRING in sync-manager's scheduled loop —
// which a mocked ./adaptive.js would fake away, so adaptive is real here.
vi.mock('./sync-repo.js', () => ({ syncRepo: vi.fn() }));
vi.mock('../config.js', () => ({
  config: {
    backfillDays: 90,
    syncOverlapMinutes: 20,
    commitFileConcurrency: 10,
    syncAdaptive: true,
    syncHotIntervalSec: 20,
    syncWarmIntervalSec: 60,
    syncColdIntervalSec: 300,
    syncFloorIntervalSec: 3 * 60 * 60,
    syncMinWalkIntervalSec: 60,
    syncSettleIntervalSec: 300,
    syncSettleColdIntervalSec: 900,
    syncSettleMaxPrSyncs: 20,
  },
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  LOCAL_ACCOUNT_ID: 1,
}));
vi.mock('../github/client.js', () => ({ ghRestGetConditional: vi.fn() }));
vi.mock('../ml/severity-client.js', () => ({ isSeverityApiConfigured: () => false }));
vi.mock('./ml-enrichment.js', () => ({ runMlEnrichmentTick: vi.fn() }));
// The settle sweep is its own unit (settle-sweep.test.ts); here only that the tick KICKS it.
const sweep = vi.hoisted(() => ({ run: vi.fn(async () => ({})) }));
vi.mock('./settle-sweep.js', () => ({ runSettleSweep: sweep.run }));
// Post-walk tails: no-ops, so a walk is just the walk.
vi.mock('./backfill-review-requests.js', () => ({ backfillReviewRequestHistory: vi.fn() }));
vi.mock('./backfill-pr-security.js', () => ({ backfillPrSecurity: vi.fn() }));
vi.mock('./backfill-commit-headlines.js', () => ({ backfillCommitHeadlines: vi.fn() }));
vi.mock('./unsettled-prs.js', () => ({ runUnsettledPrBackstop: vi.fn() }));
vi.mock('./routing-files.js', () => ({ backfillMissingPrFiles: vi.fn() }));
vi.mock('./classify-change-shape.js', () => ({ runChangeShapeClassification: vi.fn() }));
vi.mock('../db/file-coupling.js', () => ({ rebuildRepoCoupling: vi.fn() }));
vi.mock('./repo-synced-hooks.js', () => ({ notifyRepoSynced: vi.fn() }));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name' };
  const syncState = { repoId: 'ss.repo_id', lastIncrementalSyncAt: 'ss.inc_at' };
  const repoRow = { id: 1, owner: 'o', name: 'n', accountId: 1 };
  // A prior incremental sync exists, so the scheduled path probes before it walks.
  const syncStateRow = { lastIncrementalSyncAt: new Date('2026-10-28T00:00:00Z') };
  const select = (): Record<string, unknown> => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      execute: () => (table === repos ? [repoRow] : table === syncState ? [syncStateRow] : []),
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState, accounts: {} } };
});

import { ghRestGetConditional } from '../github/client.js';
import { syncRepo } from './sync-repo.js';
import { __resetAdaptiveState } from './adaptive.js';
import {
  __isScheduledTickInFlight,
  getSyncStatus,
  isSyncRunning,
  runSyncForRepo,
  syncAllRepos,
} from './sync-manager.js';

const mockSyncRepo = vi.mocked(syncRepo) as unknown as Mock;
const mockProbe = vi.mocked(ghRestGetConditional) as unknown as Mock;
const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const changed = (etag: string) => ({ status: 200, notModified: false, etag });
const unchanged = (etag: string) => ({ status: 304, notModified: true, etag });
const T0 = new Date('2026-10-28T12:00:00Z').getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  mockSyncRepo.mockReset();
  mockSyncRepo.mockResolvedValue({ cancelled: false, prCount: 0, pages: 1, endCursor: null });
  mockProbe.mockReset();
  sweep.run.mockClear();
  __resetAdaptiveState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the default tick', () => {
  it('is every ten seconds under adaptive polling; an explicit SYNC_CRON still wins', async () => {
    const saved = { cron: process.env.SYNC_CRON, adaptive: process.env.SYNC_ADAPTIVE };
    try {
      vi.resetModules();
      vi.doUnmock('../config.js');
      delete process.env.SYNC_CRON;
      delete process.env.SYNC_ADAPTIVE;
      const fresh = (await import('../config.js')).config;
      expect(fresh.syncCron).toBe('*/10 * * * * *');
      expect(fresh.syncHotIntervalSec).toBe(20);
      expect(fresh.syncWarmIntervalSec).toBe(60);
      expect(fresh.syncColdIntervalSec).toBe(300);
      expect(fresh.syncMinWalkIntervalSec).toBe(60);
      expect(fresh.syncFloorIntervalSec).toBe(3 * 60 * 60);
      expect(fresh.syncSettleIntervalSec).toBe(300);
      expect(fresh.syncSettleColdIntervalSec).toBe(900);
      const cron = (await import('node-cron')).default;
      expect(cron.validate(fresh.syncCron)).toBe(true);

      vi.resetModules();
      process.env.SYNC_CRON = '*/5 * * * *';
      expect((await import('../config.js')).config.syncCron).toBe('*/5 * * * *');

      vi.resetModules();
      delete process.env.SYNC_CRON;
      process.env.SYNC_ADAPTIVE = 'false';
      expect((await import('../config.js')).config.syncCron).toBe('*/5 * * * *');
    } finally {
      if (saved.cron === undefined) delete process.env.SYNC_CRON;
      else process.env.SYNC_CRON = saved.cron;
      if (saved.adaptive === undefined) delete process.env.SYNC_ADAPTIVE;
      else process.env.SYNC_ADAPTIVE = saved.adaptive;
    }
  });
});

describe('a free probe is not a sync', () => {
  it('a 304 walks nothing and the repo never reads as running', async () => {
    let release!: (v: unknown) => void;
    // First tick: a 200 seeds the ETag (and walks — a first sighting).
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog());
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // Twenty seconds later the probe is due again; hold it open and look at the status.
    vi.setSystemTime(T0 + 20_000);
    mockProbe.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const tick = syncAllRepos(makeLog());
    await vi.waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(2));
    // Mid-probe: busy for the delete guard, but NOT "running" — no "syncing" flash on a poll.
    expect(isSyncRunning(1)).toBe(true);
    expect((await getSyncStatus(1))?.status).not.toBe('running');
    release(unchanged('e1'));
    await tick;
    expect(mockSyncRepo).toHaveBeenCalledTimes(1); // the 304 walked nothing
    expect(isSyncRunning(1)).toBe(false);
  });

  it('a person pressing Sync during a probe is not refused, and the tick stands down', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog());
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 61_000);
    let release!: (v: unknown) => void;
    mockProbe.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const tick = syncAllRepos(makeLog());
    await vi.waitFor(() => expect(mockProbe).toHaveBeenCalledTimes(2));
    // The manual sync starts while the scheduler is still probing.
    expect(await runSyncForRepo(1, makeLog(), { background: true })).toBe(true);
    release(changed('e2')); // the probe wants a walk too...
    await tick;
    await vi.waitFor(() => expect(isSyncRunning(1)).toBe(false));
    // ...but only the manual walk ran.
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });
});

describe('the walk cap, wired', () => {
  it('a change inside the cap is walked once the cap allows — not lost, not walked twice', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog()); // T0: walk
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 20_000);
    mockProbe.mockResolvedValueOnce(changed('e2'));
    await syncAllRepos(makeLog()); // +20s: changed, but capped
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 40_000);
    mockProbe.mockResolvedValueOnce(unchanged('e2'));
    await syncAllRepos(makeLog()); // +40s: quiet, still capped, still dirty
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 60_000);
    const probesBefore = mockProbe.mock.calls.length;
    await syncAllRepos(makeLog()); // +60s: the cap allows → the held change is walked
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
    expect(mockProbe.mock.calls.length).toBe(probesBefore); // no second probe for it

    vi.setSystemTime(T0 + 80_000);
    mockProbe.mockResolvedValueOnce(unchanged('e2'));
    await syncAllRepos(makeLog()); // clean again: a 304 walks nothing
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });

  it('a manual sync is not capped', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog());
    vi.setSystemTime(T0 + 5_000);
    expect(await runSyncForRepo(1, makeLog(), { background: false })).toBe(true);
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });

  it('a manual sync covers the dirty flag: the scheduler does not re-walk what it just read', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog()); // walk 1 (scheduled)
    vi.setSystemTime(T0 + 20_000);
    mockProbe.mockResolvedValueOnce(changed('e2'));
    await syncAllRepos(makeLog()); // capped → dirty
    vi.setSystemTime(T0 + 30_000);
    expect(await runSyncForRepo(1, makeLog(), { background: false })).toBe(true); // walk 2
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
    vi.setSystemTime(T0 + 60_000);
    mockProbe.mockResolvedValueOnce(unchanged('e2'));
    await syncAllRepos(makeLog()); // the cap allows, but nothing is dirty any more
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });

  it('no insurance walk on an unchanged repo for three hours; then one', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    await syncAllRepos(makeLog());
    mockProbe.mockResolvedValue(unchanged('e1'));
    for (const at of [31 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 3 * 60 * 60_000 - 60_000]) {
      vi.setSystemTime(T0 + at);
      await syncAllRepos(makeLog());
    }
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(T0 + 3 * 60 * 60_000 + 1_000);
    await syncAllRepos(makeLog());
    expect(mockSyncRepo).toHaveBeenCalledTimes(2);
  });
});

describe('ticks never overlap', () => {
  it('a tick that finds the previous one still running returns at once', async () => {
    mockProbe.mockResolvedValueOnce(changed('e1'));
    let finish!: (v: unknown) => void;
    mockSyncRepo.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const slow = syncAllRepos(makeLog());
    await vi.waitFor(() => expect(mockSyncRepo).toHaveBeenCalledTimes(1));
    expect(__isScheduledTickInFlight()).toBe(true);

    // Three ten-second ticks fire while the walk is still going: none probes or walks...
    for (let i = 1; i <= 3; i += 1) {
      vi.setSystemTime(T0 + i * 10_000);
      await syncAllRepos(makeLog());
    }
    expect(mockProbe).toHaveBeenCalledTimes(1);
    // ...but each still kicks the settle sweep (its own claim), so one long walk cannot starve
    // every other repo's updatedAt-silent freshness.
    await vi.waitFor(() => expect(sweep.run).toHaveBeenCalledTimes(4));

    finish({ cancelled: false, prCount: 0, pages: 1, endCursor: null });
    await slow;
    expect(__isScheduledTickInFlight()).toBe(false);
  });

  it('a tick that throws still releases the claim', async () => {
    mockProbe.mockRejectedValueOnce(new Error('network'));
    mockSyncRepo.mockRejectedValueOnce(new Error('boom'));
    await syncAllRepos(makeLog());
    expect(__isScheduledTickInFlight()).toBe(false);
  });
});

describe('the settle sweep rides the tick', () => {
  it('is kicked every tick (it gates itself), with a busy predicate', async () => {
    mockProbe.mockResolvedValue(unchanged('e1'));
    await syncAllRepos(makeLog());
    expect(sweep.run).toHaveBeenCalledTimes(1);
    const arg = (sweep.run.mock.calls[0] as unknown as [{ isBusy: (id: number) => boolean }])[0];
    expect(arg.isBusy(1)).toBe(false);
  });
});
