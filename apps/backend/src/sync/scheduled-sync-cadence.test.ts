import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger } from './sync-repo.js';

// THE REGRESSION. The scheduler tick is every MINUTE under adaptive polling (the default in
// both modes), so `isDue` is the only thing standing between one repo and 60 GraphQL walks an
// hour. It gates on an attempt stamp that, for a long time, only the INCREMENTAL branch wrote
// — and a repo whose first walk always fails never leaves `full` mode, because planSync reads
// a `lastIncrementalSyncAt` that a failed walk never writes. Four repos that 404 on GitHub sat
// in that loop for five weeks at 15 points a walk: 3,600 of a 5,000-point hourly budget.
//
// Mocked at sync-manager's usual seams (syncRepo, config, token, db, ML) — but NOT at
// ./adaptive.js, which is the unit under test here: what this file pins is the WIRING between
// the scheduler loop and the cadence state, which a mocked adaptive would fake away entirely.
vi.mock('./sync-repo.js', () => ({ syncRepo: vi.fn() }));
vi.mock('../config.js', () => ({
  config: {
    isCloud: false,
    backfillDays: 90,
    syncOverlapMinutes: 20,
    commitFileConcurrency: 10,
    syncAdaptive: true,
    syncHotIntervalSec: 120,
    syncWarmIntervalSec: 300,
    syncColdIntervalSec: 900,
    syncFloorIntervalSec: 1800,
  },
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  LOCAL_ACCOUNT_ID: 1,
}));
// The adaptive probe's REST seam. A `full`-mode repo never reaches it — asserting that is
// half the point of the first test — so any call here is a fixture that drifted.
vi.mock('../github/client.js', () => ({ ghRestGetConditional: vi.fn() }));
vi.mock('../ml/severity-client.js', () => ({ isSeverityApiConfigured: () => false }));
vi.mock('./ml-enrichment.js', () => ({ runMlEnrichmentTick: vi.fn() }));
vi.mock('../db/client.js', () => {
  const repos = { id: 'repos.id', owner: 'repos.owner', name: 'repos.name' };
  const syncState = { repoId: 'ss.repo_id', lastIncrementalSyncAt: 'ss.inc_at' };
  const repoRow = { id: 1, owner: 'o', name: 'n', accountId: 1 };
  const select = (): Record<string, unknown> => {
    let table: unknown = null;
    const chain: Record<string, unknown> = {
      from: (t: unknown) => ((table = t), chain),
      innerJoin: () => chain,
      where: () => chain,
      limit: () => chain,
      // NO syncState row: never successfully synced ⇒ planSync says `full` ⇒ exactly the
      // state a repo whose every walk fails is permanently stuck in.
      execute: () => (table === repos ? [repoRow] : []),
    };
    return chain;
  };
  return { db: { select }, schema: { repos, syncState, accounts: {} } };
});

import { ghRestGetConditional } from '../github/client.js';
import { syncRepo } from './sync-repo.js';
import { __resetAdaptiveState } from './adaptive.js';
import { syncAllRepos } from './sync-manager.js';

const mockSyncRepo = vi.mocked(syncRepo) as unknown as Mock;
const mockProbe = vi.mocked(ghRestGetConditional) as unknown as Mock;
const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

beforeEach(() => {
  mockSyncRepo.mockReset();
  mockProbe.mockReset();
  // Cadence is process-global in-memory state; a leak between cases would make a later
  // "not due" assertion pass for the wrong reason.
  __resetAdaptiveState();
});

describe('a full-mode repo is not re-walked on every tick', () => {
  it('walks once, then stands down on the tick a minute later', async () => {
    mockSyncRepo.mockResolvedValue({});
    const log = makeLog();

    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // THE ASSERTION. Two more ticks, back to back. Before the unconditional `noteAttempt`
    // this was 3 walks, and 60 an hour thereafter — the walk itself never stamped anything,
    // so `isDue` kept answering "never attempted".
    await syncAllRepos(log);
    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // ...and it got there without spending the incremental probe (full mode never probes).
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('threads the repo id in so a pre-upsertRepo failure can be recorded', async () => {
    mockSyncRepo.mockResolvedValue({});
    await syncAllRepos(makeLog());
    // syncRepo learns its own repoId only from the first page; without this the 404 path
    // writes no sync_state row at all (see sync-repo-failure-visibility.test.ts).
    expect(mockSyncRepo.mock.calls[0]?.[0]).toMatchObject({ knownRepoId: 1, mode: 'full' });
  });
});

describe('a failing repo backs off instead of retrying at the tick rate', () => {
  it('stops re-walking after the first failure and says how long for', async () => {
    mockSyncRepo.mockRejectedValue(new Error('Repository o/n not found or inaccessible'));
    const log = makeLog();

    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // The next ticks find it backed off — NOT merely stamped. The stamp alone would leave it
    // in the HOT bucket (120s), i.e. still 30 walks an hour on a repo we cannot even read.
    for (let i = 0; i < 5; i += 1) await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // The operator-visible half: one error line per failure, carrying the failure count and
    // the wait it bought (2 × the 900s cold interval on the first).
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('1 consecutive; next attempt in ≥30 min'),
    );
  });

  it('resumes at its normal cadence once a walk succeeds', async () => {
    const log = makeLog();
    mockSyncRepo.mockRejectedValueOnce(new Error('boom')).mockResolvedValue({});

    await syncAllRepos(log); // fails → 30 min backoff
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    await syncAllRepos(log); // backed off
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);

    // A manual/queued walk succeeding is the realistic recovery (someone re-granted access
    // and pressed Refresh); runSyncForRepo clears the backoff, so the scheduler picks the
    // repo back up on its ordinary interval rather than hours later.
    const { noteWalkSuccess } = await import('./adaptive.js');
    noteWalkSuccess(1, Date.now());
    // Still gated by the plain hot interval — the stamp is unchanged — so no walk yet...
    await syncAllRepos(log);
    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    // ...and the health penalty is gone, which is what the next test of the pair proves in
    // adaptive.test.ts against a controllable clock.
    const { backoffMsFor } = await import('./adaptive.js');
    expect(backoffMsFor(1)).toBe(0);
  });
});
