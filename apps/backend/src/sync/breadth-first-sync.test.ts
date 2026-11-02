import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Logger, SyncRepoOptions, SyncRepoResult } from './sync-repo.js';

// THE BREADTH-FIRST FIRST SYNC (sync-manager.ts, the per-account queue): several never-synced
// repos queued together run every repo's FOREGROUND pass before any repo's 90-day backfill, the
// backfill continues phase 1's cursor (it is never re-walked from scratch), a running backfill
// yields resumably to a waiting foreground pass, and a full walk's follow-on work (the one-time
// CI-history backfill etc.) waits until no repo is still waiting for its first pass — but ONLY a
// first pass: behind a deep or manual walk it runs at once.
//
// syncRepo is a controllable fake: every call parks until the test finishes it, so the ORDER of
// calls is the thing under test.
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
const ciBackfill = vi.hoisted(() => ({ run: vi.fn(async (_o: { repoId: number }) => {}) }));
vi.mock('./backfill-ci-history.js', () => ({ runCiHistoryBackfill: ciBackfill.run }));
// The rest of the follow-on work, inert (each is a dynamic import the tail runs non-fatally).
vi.mock('./routing-files.js', () => ({ backfillMissingPrFiles: vi.fn(async () => {}) }));
vi.mock('./backfill-review-requests.js', () => ({
  backfillReviewRequestHistory: vi.fn(async () => {}),
}));
vi.mock('./backfill-pr-security.js', () => ({ backfillPrSecurity: vi.fn(async () => {}) }));
vi.mock('./backfill-commit-headlines.js', () => ({
  backfillCommitHeadlines: vi.fn(async () => {}),
}));
vi.mock('./unsettled-prs.js', () => ({ runUnsettledPrBackstop: vi.fn(async () => {}) }));
vi.mock('../db/file-coupling.js', () => ({ rebuildRepoCoupling: vi.fn(async () => {}) }));
vi.mock('./classify-change-shape.js', () => ({
  runChangeShapeClassification: vi.fn(async () => {}),
}));
vi.mock('./repo-synced-hooks.js', () => ({ notifyRepoSynced: vi.fn() }));
// The persisted "CI-history still owed" stamp (sync_state.ci_history_pending_at), in memory.
const owed = vi.hoisted(() => ({ set: new Set<number>(), marks: [] as number[] }));
vi.mock('./ci-history-pending.js', () => ({
  markCiHistoryPending: vi.fn(async (id: number) => {
    owed.set.add(id);
    owed.marks.push(id);
  }),
  clearCiHistoryPending: vi.fn(async (id: number) => {
    owed.set.delete(id);
  }),
  isCiHistoryPending: vi.fn(async (id: number) => owed.set.has(id)),
  listCiHistoryPendingRepoIds: vi.fn(async () => [...owed.set]),
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: vi.fn(async () => 'test-token'),
  LOCAL_ACCOUNT_ID: 1,
}));
// `synced`: syncState reads as already synced (an INCREMENTAL plan) instead of never-synced.
const dbSeam = vi.hoisted(() => ({ failNextRepoLookup: null as Error | null, synced: false }));
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
      // Never-synced: no syncState rows → planSync → a first full (two-phase) backfill.
      execute: () => {
        if (table === repos && dbSeam.failNextRepoLookup) {
          const err = dbSeam.failNextRepoLookup;
          dbSeam.failNextRepoLookup = null;
          throw err;
        }
        if (table === repos) return [repoRow];
        if (table === syncState && dbSeam.synced) {
          return [{ lastIncrementalSyncAt: new Date('2020-01-01T00:00:00Z') }];
        }
        return [];
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
  resumePendingCiHistory,
  isSyncQueued,
  isSyncRunning,
  requestSyncCancel,
  waitForSyncToStop,
} from './sync-manager.js';

const mockSyncRepo = vi.mocked(syncRepo) as unknown as Mock;
const makeLog = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r));
};

interface Call {
  repoId: number;
  phase: 'foreground' | 'backfill' | 'single';
  opts: SyncRepoOptions;
  finish: (over?: Partial<SyncRepoResult>) => void;
}
let calls: Call[] = [];
const result = (over: Partial<SyncRepoResult> = {}): SyncRepoResult => ({
  repoId: 1,
  prCount: 10,
  pages: 1,
  rateLimitRemaining: 5000,
  rateLimitCost: 1,
  cancelled: false,
  endCursor: null,
  ...over,
});
const trace = (): string[] => calls.map((c) => `${c.repoId}:${c.phase}`);
const last = (): Call => calls[calls.length - 1]!;

beforeEach(() => {
  calls = [];
  dbSeam.failNextRepoLookup = null;
  dbSeam.synced = false;
  owed.set.clear();
  owed.marks = [];
  ciBackfill.run.mockClear();
  mockSyncRepo.mockReset();
  mockSyncRepo.mockImplementation(
    (opts: SyncRepoOptions) =>
      new Promise<SyncRepoResult>((resolve) => {
        calls.push({
          repoId: opts.knownRepoId!,
          phase:
            opts.commitState === false
              ? 'foreground'
              : opts.startCursor !== undefined
                ? 'backfill'
                : 'single',
          opts,
          finish: (over) => resolve(result(over)),
        });
      }),
  );
});

describe('breadth-first first sync', () => {
  it("runs every queued repo's foreground pass before any backfill", async () => {
    const log = makeLog();
    const t0 = Date.now();
    for (const id of [101, 102, 103]) expect(await enqueueSyncForRepo(id, log)).toBe(true);
    await flush();
    expect(trace()).toEqual(['101:foreground']);

    const t1 = Date.now();
    last().finish({ endCursor: 'C101' });
    await flush();
    // Repo 101 is done with its recent PRs and WAITS for its backfill: an honest queued row
    // that already says the foreground is complete — never idle, so the scheduler leaves it be.
    expect(isSyncQueued(101)).toBe(true);
    expect(isSyncRunning(101)).toBe(false);
    const between = await getSyncStatus(101);
    expect(between?.status).toBe('running');
    expect(between?.progress?.paused).toEqual({ reason: 'queued' });
    expect(between?.progress?.foregroundComplete).toBe(true);

    last().finish({ endCursor: 'C102' });
    await flush();
    last().finish({ endCursor: 'C103' });
    await flush();
    expect(trace()).toEqual(['101:foreground', '102:foreground', '103:foreground', '101:backfill']);

    // The backfill CONTINUES phase 1's cursor (no re-walk of the foreground pages), stamps
    // syncState, and stamps `lastIncrementalSyncAt` with phase 1's START — the gap between the
    // phases is behind the cursor, so the next incremental walk must cover it.
    const b101 = last().opts;
    expect(b101.startCursor).toBe('C101');
    expect(b101.commitState).toBe(true);
    expect(b101.stampIncrementalAt!.getTime()).toBeGreaterThanOrEqual(t0);
    expect(b101.stampIncrementalAt!.getTime()).toBeLessThanOrEqual(t1);

    last().finish();
    await flush();
    last().finish();
    await flush();
    last().finish();
    await flush();
    expect(trace()).toEqual([
      '101:foreground',
      '102:foreground',
      '103:foreground',
      '101:backfill',
      '102:backfill',
      '103:backfill',
    ]);
    expect(calls[4]!.opts.startCursor).toBe('C102');
    expect(calls[5]!.opts.startCursor).toBe('C103');
    for (const id of [101, 102, 103]) {
      expect(isSyncQueued(id)).toBe(false);
      expect(isSyncRunning(id)).toBe(false);
    }
  });

  it('a running backfill yields to a newly queued repo, then resumes from its page', async () => {
    const log = makeLog();
    await enqueueSyncForRepo(201, log);
    await flush();
    last().finish({ endCursor: 'C201' });
    await flush();
    expect(trace()).toEqual(['201:foreground', '201:backfill']);
    const backfill = last();
    // Nothing waiting: the backfill has no reason to stop.
    expect(backfill.opts.shouldCancel!()).toBe(false);

    await enqueueSyncForRepo(202, log);
    // A repo is now waiting for its foreground pass: the walk's own between-pages check says stop.
    expect(backfill.opts.shouldCancel!()).toBe(true);
    backfill.finish({ cancelled: true, endCursor: 'PAGE_7', prCount: 40, pages: 3 });
    await flush();
    expect(trace()).toEqual(['201:foreground', '201:backfill', '202:foreground']);
    // Yielding is NOT a cancel: 201 still waits for its backfill.
    expect(isSyncQueued(201)).toBe(true);
    expect(ciBackfill.run).not.toHaveBeenCalled();

    last().finish({ endCursor: 'C202' });
    await flush();
    // 201 resumes FIRST (it was ahead), from the page it stopped on; its count never goes back.
    expect(trace()).toEqual(['201:foreground', '201:backfill', '202:foreground', '201:backfill']);
    expect(last().opts.startCursor).toBe('PAGE_7');
    last().opts.onProgress!({ percent: 0.5, prsProcessed: 5, pages: 1 });
    expect((await getSyncStatus(201))?.progress?.prsProcessed).toBe(45);

    last().finish();
    await flush();
    last().finish();
    await flush();
    expect(trace().slice(-1)).toEqual(['202:backfill']);
    expect(last().opts.startCursor).toBe('C202');
  });
});

describe('cancel and failure while waiting for the backfill', () => {
  it('a cancel of a queued backfill drops it at once; it never runs', async () => {
    const log = makeLog();
    await enqueueSyncForRepo(301, log);
    await enqueueSyncForRepo(302, log);
    await flush();
    last().finish({ endCursor: 'C301' });
    await flush();
    expect(trace()).toEqual(['301:foreground', '302:foreground']);
    expect(isSyncQueued(301)).toBe(true);

    requestSyncCancel(301);
    // Synchronous: not queued, not running (the cancel endpoint's delete path waits on this),
    // no progress row — and syncState was never stamped, so it is still an initial backfill.
    expect(isSyncQueued(301)).toBe(false);
    expect(await waitForSyncToStop(301, 1_000)).toBe(true);
    expect((await getSyncStatus(301))?.progress).toBeNull();

    last().finish({ endCursor: 'C302' });
    await flush();
    last().finish();
    await flush();
    // Only 302's backfill ran.
    expect(trace()).toEqual(['301:foreground', '302:foreground', '302:backfill']);
    expect(ciBackfill.run).toHaveBeenCalledTimes(1);
    expect(ciBackfill.run.mock.calls[0]![0].repoId).toBe(302);
  });

  it('a thrown lookup when the backfill starts releases every slot', async () => {
    const log = makeLog();
    await enqueueSyncForRepo(401, log);
    await flush();
    dbSeam.failNextRepoLookup = new Error('transient db error');
    last().finish({ endCursor: 'C401' });
    await flush();
    // The backfill's repo lookup threw: nothing leaked — not running, not queued, no row.
    expect(trace()).toEqual(['401:foreground']);
    expect(isSyncRunning(401)).toBe(false);
    expect(isSyncQueued(401)).toBe(false);
    expect((await getSyncStatus(401))?.status).not.toBe('running');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('transient db error'));

    // Not wedged: a later enqueue starts again (syncState is still unstamped → a first sync).
    expect(await enqueueSyncForRepo(401, log)).toBe(true);
    await flush();
    expect(trace()).toEqual(['401:foreground', '401:foreground']);
    last().finish({ endCursor: 'C401' });
    await flush();
    last().finish();
    await flush();
    expect(isSyncRunning(401)).toBe(false);
  });
});

describe('follow-on work waits for every first pass', () => {
  it('parks a completed full walk’s follow-ons while a repo waits for its foreground pass', async () => {
    const log = makeLog();
    // A deep (single-pass full) sync of 501, then a never-synced 502 queued behind it.
    await enqueueSyncForRepo(501, log, { forceFull: true });
    await flush();
    await enqueueSyncForRepo(502, log);
    await flush();
    expect(trace()).toEqual(['501:single']);

    last().finish();
    await flush();
    // 501's walk is complete, but 502 was waiting: its CI-history backfill is parked, and 502's
    // recent PRs go first. 501 still reads as running (queued) until its follow-ons ran.
    expect(trace()).toEqual(['501:single', '502:foreground']);
    expect(ciBackfill.run).not.toHaveBeenCalled();
    expect(isSyncQueued(501)).toBe(true);
    expect((await getSyncStatus(501))?.status).toBe('running');

    last().finish({ endCursor: 'C502' });
    await flush();
    // Front empty: 501's parked follow-ons run (ahead of 502's backfill).
    expect(ciBackfill.run).toHaveBeenCalledTimes(1);
    expect(ciBackfill.run.mock.calls[0]![0].repoId).toBe(501);
    expect(isSyncQueued(501)).toBe(false);
    expect(isSyncRunning(501)).toBe(false);
    expect(trace()).toEqual(['501:single', '502:foreground', '502:backfill']);

    last().finish();
    await flush();
    // Nothing waiting any more: 502's follow-ons run inline, once.
    expect(ciBackfill.run).toHaveBeenCalledTimes(2);
    expect(ciBackfill.run.mock.calls[1]![0].repoId).toBe(502);
  });
});

describe('behind a deep or manual walk the follow-ons run at once', () => {
  it('a deep sync of several repos runs each repo’s follow-ons right after its own walk', async () => {
    const log = makeLog();
    // "Deep sync everything": three forced-full walks queued together. None is a first pass.
    for (const id of [801, 802, 803]) expect(await enqueueSyncForRepo(id, log, { forceFull: true })).toBe(true);
    await flush();
    expect(trace()).toEqual(['801:single']);

    last().finish();
    await flush();
    // 801's follow-ons ran BEFORE 802's walk started — not parked until the last deep walk ended.
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([801]);
    expect(isSyncQueued(801)).toBe(false);
    expect(trace()).toEqual(['801:single', '802:single']);

    last().finish();
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([801, 802]);
    expect(trace()).toEqual(['801:single', '802:single', '803:single']);
    last().finish();
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([801, 802, 803]);
  });

  it('parked follow-ons do not wait behind a deep walk once the first pass ran', async () => {
    const log = makeLog();
    // 901 (deep) completes while never-synced 902 waits for its first pass: parked.
    await enqueueSyncForRepo(901, log, { forceFull: true });
    await flush();
    await enqueueSyncForRepo(902, log);
    await flush();
    last().finish();
    await flush();
    expect(trace()).toEqual(['901:single', '902:foreground']);
    expect(ciBackfill.run).not.toHaveBeenCalled();
    // A deep walk of 903 is queued while 902's first pass runs.
    await enqueueSyncForRepo(903, log, { forceFull: true });
    await flush();
    last().finish({ endCursor: 'C902' });
    await flush();
    // No first pass waits any more: 901's parked follow-ons run ahead of 903's deep walk.
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([901]);
    expect(trace()).toEqual(['901:single', '902:foreground', '903:single']);
    last().finish();
    await flush();
    // 903's own follow-ons run at once; 902's backfill (a back job) follows.
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([901, 903]);
    expect(trace()).toEqual(['901:single', '902:foreground', '903:single', '902:backfill']);
    last().finish();
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([901, 903, 902]);
  });
});

describe('the CI-history backfill is owed until it ran', () => {
  // Parks 601's follow-ons behind 602's foreground pass and returns with 602's pass in flight.
  const parkFollowOns = async (log: Logger): Promise<void> => {
    await enqueueSyncForRepo(601, log, { forceFull: true });
    await flush();
    await enqueueSyncForRepo(602, log);
    await flush();
    last().finish();
    await flush();
    expect(trace()).toEqual(['601:single', '602:foreground']);
  };

  it('stamps it owed before parking, and clears the stamp once it ran', async () => {
    const log = makeLog();
    await parkFollowOns(log);
    // The walk is stamped and the follow-ons only live in memory: the debt is written down.
    expect(owed.set.has(601)).toBe(true);
    expect(ciBackfill.run).not.toHaveBeenCalled();

    last().finish({ endCursor: 'C602' });
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([601]);
    expect(owed.set.has(601)).toBe(false);
    last().finish();
    await flush();
    expect(owed.set.size).toBe(0);
  });

  it('a cancel leaves a stamped repo’s parked follow-ons in place', async () => {
    const log = makeLog();
    await parkFollowOns(log);
    requestSyncCancel(601);
    // Still waiting: its walk is done and stamped, so nothing would ever ask for this work again.
    expect(isSyncQueued(601)).toBe(true);
    last().finish({ endCursor: 'C602' });
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([601]);
    last().finish();
    await flush();
  });

  it('removing the repo drops them (dropFollowOns)', async () => {
    const log = makeLog();
    await parkFollowOns(log);
    requestSyncCancel(601, { dropFollowOns: true });
    expect(isSyncQueued(601)).toBe(false);
    last().finish({ endCursor: 'C602' });
    await flush();
    last().finish();
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([602]);
  });

  it('a later incremental walk (or the boot recovery) runs a backfill still owed', async () => {
    // A restart lost 701's parked job: it is stamped synced (incremental from now on) and owed.
    dbSeam.synced = true;
    owed.set.add(701);
    const log = makeLog();
    expect(await resumePendingCiHistory(log)).toBe(1);
    await flush();
    expect(trace()).toEqual(['701:single']);
    last().finish();
    await flush();
    expect(ciBackfill.run.mock.calls.map((c) => c[0].repoId)).toEqual([701]);
    expect(owed.set.has(701)).toBe(false);
    // An incremental walk never stamps a new debt, and with nothing owed runs no backfill.
    expect(owed.marks).toEqual([]);
    await enqueueSyncForRepo(701, log);
    await flush();
    last().finish();
    await flush();
    expect(ciBackfill.run).toHaveBeenCalledTimes(1);
  });
});
