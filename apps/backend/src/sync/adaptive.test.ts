import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Mock the interval config + the conditional-probe REST call so the cadence/probe logic is
// exercised with a controllable clock and canned GitHub responses. The values are the shipped
// defaults (config.ts): free probes every 20s / 60s / 300s, a 60s walk cap, a 3h insurance walk,
// and the settle sweep every 5 min (hot, warm) / 15 min (cold).
vi.mock('../config.js', () => ({
  config: {
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
vi.mock('../github/client.js', () => ({ ghRestGetConditional: vi.fn() }));

import { ghRestGetConditional } from '../github/client.js';
import {
  backoffMsFor,
  bucketFor,
  decideIncrementalWalk,
  isDirty,
  isDue,
  isSettleDue,
  lastCheckedAtFor,
  markDirty,
  noteAttempt,
  noteSettle,
  noteWalkFailure,
  noteWalkStart,
  noteWalkSuccess,
  recordFullWalk,
  withLastChecked,
  __resetAdaptiveState,
} from './adaptive.js';

const mockProbe = vi.mocked(ghRestGetConditional) as unknown as Mock;

// A fixed base epoch; tests offset from it so the huge lastFullWalkAt=0 seed always reads
// as "insurance due" on a repo's first decide (until recordFullWalk stamps it).
const T0 = 1_700_000_000_000;
const SEC = 1_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const changed = (etag: string | null) => ({ status: 200, notModified: false, etag });
const unchanged = (etag: string | null) => ({ status: 304, notModified: true, etag });

/** What the scheduler does around a walk: stamp its start, then record it complete. */
function walked(repoId: number, at: number): void {
  noteWalkStart(repoId, at);
  recordFullWalk(repoId, at, at);
}

beforeEach(() => {
  __resetAdaptiveState();
  mockProbe.mockReset();
  mockProbe.mockResolvedValue(changed(null));
});

describe('isDue + bucketFor (cadence)', () => {
  it('an unseen repo is due immediately and reads as cold', () => {
    expect(isDue(1, T0)).toBe(true);
    expect(bucketFor(1, T0)).toBe('cold');
  });

  it('after an attempt a hot repo is probed again after 20s — the probe is free', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // attempt=T0, change=T0 → hot
    walked(1, T0);
    expect(bucketFor(1, T0)).toBe('hot');
    expect(isDue(1, T0 + 19 * SEC)).toBe(false);
    expect(isDue(1, T0 + 20 * SEC)).toBe(true);
  });

  it('buckets by how recently a change was observed', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // last change at T0
    expect(bucketFor(1, T0 + 30 * MIN)).toBe('hot'); // < 1h
    expect(bucketFor(1, T0 + 3 * HOUR)).toBe('warm'); // < 6h
    expect(bucketFor(1, T0 + 7 * HOUR)).toBe('cold'); // ≥ 6h
  });

  it('warm and cold repos honour their longer probe intervals (60s / 300s)', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // change=T0
    walked(1, T0);
    mockProbe.mockResolvedValue(unchanged('e1'));
    // Warm: three hours on.
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 3 * HOUR);
    expect(isDue(1, T0 + 3 * HOUR + 59 * SEC)).toBe(false);
    expect(isDue(1, T0 + 3 * HOUR + 60 * SEC)).toBe(true);
    // Cold: seven hours on.
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 7 * HOUR);
    expect(bucketFor(1, T0 + 7 * HOUR)).toBe('cold');
    expect(isDue(1, T0 + 7 * HOUR + 299 * SEC)).toBe(false);
    expect(isDue(1, T0 + 7 * HOUR + 300 * SEC)).toBe(true);
  });
});

describe('decideIncrementalWalk (conditional probe)', () => {
  it('walks and marks a change when the probe reports 200', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    expect(d).toEqual({ walk: true, reason: 'changed' });
    expect(bucketFor(1, T0)).toBe('hot');
    expect(isDirty(1)).toBe(true);
  });

  it('skips the walk on 304 when the insurance walk is not due', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    walked(1, T0);
    mockProbe.mockResolvedValue(unchanged('e1'));
    // The old 30-minute floor is gone: an unchanged repo is NOT walked blind at 31 min.
    expect(await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 31 * MIN)).toEqual({
      walk: false,
      reason: 'unchanged',
    });
    expect(await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 2 * HOUR)).toEqual({
      walk: false,
      reason: 'unchanged',
    });
  });

  it('walks on 304 once the 3h insurance walk IS due', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    walked(1, T0);
    mockProbe.mockResolvedValue(unchanged('e1'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 3 * HOUR + MIN);
    expect(d).toEqual({ walk: true, reason: 'floor' });
  });

  it('walks on a probe error (never skips on uncertainty)', async () => {
    recordFullWalk(1, T0); // insurance not due, so the reason must be the error
    mockProbe.mockRejectedValue(new Error('network'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 5 * MIN);
    expect(d).toEqual({ walk: true, reason: 'probe_error' });
  });

  it('threads the stored ETag into the next If-None-Match probe', async () => {
    mockProbe.mockResolvedValueOnce(changed('etag-1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    walked(1, T0);
    expect(mockProbe).toHaveBeenNthCalledWith(
      1,
      'tok',
      expect.stringContaining('/repos/o/n/pulls'),
      null, // no prior ETag on the first probe
    );
    mockProbe.mockResolvedValueOnce(unchanged('etag-1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 200_000);
    expect(mockProbe).toHaveBeenNthCalledWith(2, 'tok', expect.any(String), 'etag-1');
  });
});

describe('the walk cap: at most one scheduled walk per repo per 60s', () => {
  it('a 200 inside the cap marks the repo dirty instead of walking', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    expect((await decideIncrementalWalk(1, 'o', 'n', 'tok', T0)).walk).toBe(true);
    walked(1, T0);
    expect(isDirty(1)).toBe(false);

    mockProbe.mockResolvedValue(changed('e2'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 20 * SEC);
    expect(d).toEqual({ walk: false, reason: 'capped' });
    expect(isDirty(1)).toBe(true); // the change is kept, not lost
  });

  it('the dirty repo is due the moment the cap allows, and walks without probing again', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    walked(1, T0);
    mockProbe.mockResolvedValue(changed('e2'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 20 * SEC); // capped, dirty

    // Inside the cap: the hot interval (20s) says due, the decision says capped.
    expect(isDue(1, T0 + 59 * SEC)).toBe(true);
    // At the cap: due, and walks on the dirty flag alone (the probe already spent its answer).
    mockProbe.mockClear();
    expect(isDue(1, T0 + 60 * SEC)).toBe(true);
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 60 * SEC);
    expect(d).toEqual({ walk: true, reason: 'dirty' });
    expect(mockProbe).not.toHaveBeenCalled();
    walked(1, T0 + 60 * SEC);
    expect(isDirty(1)).toBe(false);
  });

  it('a dirty repo is due the moment the cap allows, whatever its probe interval says', () => {
    walked(1, T0); // a walk just ran
    markDirty(1, T0 + 10 * SEC); // the settle sweep saw a newer PR
    noteAttempt(1, T0 + 55 * SEC); // a probe 5s before the cap — its interval says "not yet"
    expect(isDue(1, T0 + 59 * SEC)).toBe(false); // neither the cap nor the 20s interval
    expect(isDue(1, T0 + 60 * SEC)).toBe(true); // the cap elapsed: due at once
  });

  it('a walk that started BEFORE the change keeps the flag; one that started after clears it', () => {
    noteWalkStart(1, T0);
    markDirty(1, T0 + 5 * SEC); // seen mid-walk
    recordFullWalk(1, T0 + 10 * SEC, T0);
    expect(isDirty(1)).toBe(true);
    recordFullWalk(1, T0 + 80 * SEC, T0 + 70 * SEC);
    expect(isDirty(1)).toBe(false);
  });

  it('the health backoff still holds a dirty repo whose walks fail', () => {
    markDirty(1, T0);
    noteAttempt(1, T0);
    noteWalkFailure(1, T0); // 30 min backoff
    expect(isDue(1, T0 + 2 * MIN)).toBe(false);
    expect(isDue(1, T0 + 31 * MIN)).toBe(true);
  });

  it('a rate-limited account neither probes nor walks, and keeps the flag', async () => {
    const { noteLimited } = await import('../github/rate-budget.js');
    markDirty(1, T0);
    noteLimited(42, new Date(Date.now() + HOUR));
    mockProbe.mockClear();
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 2 * MIN, 42);
    expect(d).toEqual({ walk: false, reason: 'rate_limited' });
    expect(mockProbe).not.toHaveBeenCalled();
    expect(isDirty(1)).toBe(true);
  });
});

describe('settle cadence', () => {
  it('an unread repo is due at once; hot/warm every 5 min, cold every 15', async () => {
    expect(isSettleDue(1, T0)).toBe(true);
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // hot
    noteSettle(1, T0);
    expect(isSettleDue(1, T0 + 4 * MIN)).toBe(false);
    expect(isSettleDue(1, T0 + 5 * MIN)).toBe(true);
    // Cold after 6h of quiet.
    noteSettle(1, T0 + 7 * HOUR);
    expect(isSettleDue(1, T0 + 7 * HOUR + 14 * MIN)).toBe(false);
    expect(isSettleDue(1, T0 + 7 * HOUR + 15 * MIN)).toBe(true);
  });
});

describe('lastCheckedAt — when GitHub last answered', () => {
  it('a 304 counts, a probe error does not, a failed settle read does not', async () => {
    expect(lastCheckedAtFor(1)).toBeNull();
    mockProbe.mockRejectedValue(new Error('network'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    expect(lastCheckedAtFor(1)).toBeNull();
    noteSettle(1, T0 + 30 * SEC, false);
    expect(lastCheckedAtFor(1)).toBeNull();
    // Repo 2 is clean, so its decision probes; a 304 is GitHub answering.
    recordFullWalk(2, T0);
    mockProbe.mockResolvedValue(unchanged('e1'));
    await decideIncrementalWalk(2, 'o', 'n', 'tok', T0 + MIN);
    expect(lastCheckedAtFor(2)?.getTime()).toBe(T0 + MIN);
    noteSettle(2, T0 + 3 * MIN);
    expect(lastCheckedAtFor(2)?.getTime()).toBe(T0 + 3 * MIN);
  });

  it('decorates a listing, omitting the key (never null) for a repo never checked', () => {
    noteSettle(1, T0);
    const out = withLastChecked([{ id: 1 }, { id: 2 }]);
    expect(out[0]).toEqual({ id: 1, lastCheckedAt: new Date(T0).toISOString() });
    expect(out[1]).toEqual({ id: 2 });
    expect('lastCheckedAt' in out[1]!).toBe(false);
  });
});

// THE REGRESSION THIS FILE EXISTS FOR.
//
// isDue() is the only thing between a repo and the 10-second tick, and it gates on
// `lastAttemptAt` — which, for a long time, ONLY decideIncrementalWalk wrote. A repo planned as
// `full` never reached that call, so it was due on every tick: four repos that 404 on GitHub
// were re-walked once a minute, at 15 GraphQL points each, for five weeks — 3,600 points/hour of
// a 5,000/hour budget, with nothing on screen saying so.
//
// Two halves, and BOTH are load-bearing: the unconditional attempt stamp (a floor no future
// mode can slip past) and the health backoff (because the stamp alone leaves an unreadable
// repo in the HOT bucket — a walk every 20 seconds).
describe('noteAttempt (the floor under isDue)', () => {
  it('gates a repo that never goes through the incremental probe', () => {
    // The full-mode path: no probe, no decideIncrementalWalk, so this stamp is the only one.
    noteAttempt(1, T0);
    expect(isDue(1, T0)).toBe(false);
    expect(isDue(1, T0 + 10 * SEC)).toBe(false); // the next tick, ten seconds later
    expect(isDue(1, T0 + 20 * SEC)).toBe(true); // ...and no sooner than the hot interval
  });

  it('is NOT sufficient on its own — a first-sighted repo reads hot', () => {
    // Documents exactly why the backoff below has to exist: ensure() seeds lastChangeAt=now,
    // so a repo nobody has ever successfully read still looks like the busiest repo there is.
    noteAttempt(1, T0);
    expect(bucketFor(1, T0)).toBe('hot');
    expect(backoffMsFor(1)).toBe(0);
  });
});

describe('health backoff on consecutive failures', () => {
  it('widens with each consecutive failure, from a 15-min base up to the 6h cap', () => {
    expect(backoffMsFor(1)).toBe(0); // healthy (and unseen)

    // The base is a constant, NOT the cold probe interval: probes got cheaper (300s), an
    // unreadable repo must not be retried more often because of it.
    expect(noteWalkFailure(1, T0)).toBe(1);
    expect(backoffMsFor(1)).toBe(30 * MIN);
    expect(noteWalkFailure(1, T0)).toBe(2);
    expect(backoffMsFor(1)).toBe(HOUR);
    expect(noteWalkFailure(1, T0)).toBe(3);
    expect(backoffMsFor(1)).toBe(2 * HOUR);
    expect(noteWalkFailure(1, T0)).toBe(4);
    expect(backoffMsFor(1)).toBe(4 * HOUR);

    // ...and it stops at the cap rather than growing without bound.
    for (let i = 0; i < 20; i += 1) noteWalkFailure(1, T0);
    expect(backoffMsFor(1)).toBe(6 * HOUR);
  });

  it('overrides the activity bucket: a failing HOT repo waits out the backoff', () => {
    noteAttempt(1, T0);
    noteWalkFailure(1, T0);
    expect(bucketFor(1, T0)).toBe('hot'); // the bucket still says "busy"...
    expect(isDue(1, T0 + 5 * MIN)).toBe(false); // ...but health decides.
    expect(isDue(1, T0 + 29 * MIN)).toBe(false);
    expect(isDue(1, T0 + 31 * MIN)).toBe(true);

    // A second failure at that attempt widens it again.
    noteAttempt(1, T0 + 31 * MIN);
    noteWalkFailure(1, T0 + 31 * MIN);
    expect(isDue(1, T0 + 31 * MIN + 45 * MIN)).toBe(false); // 1h now, not 30 min
    expect(isDue(1, T0 + 31 * MIN + 61 * MIN)).toBe(true);
  });

  it('a success clears it — the repo returns to its activity cadence immediately', () => {
    noteAttempt(1, T0);
    noteWalkFailure(1, T0);
    noteWalkFailure(1, T0);
    expect(isDue(1, T0 + 45 * MIN)).toBe(false);

    noteWalkSuccess(1, T0);
    expect(backoffMsFor(1)).toBe(0);
    // Back to the plain hot interval, from the same (unchanged) attempt stamp.
    expect(isDue(1, T0 + 19 * SEC)).toBe(false);
    expect(isDue(1, T0 + 20 * SEC)).toBe(true);
  });

  it('never widens a healthy repo (the cadence is exactly what it always was)', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    walked(1, T0);
    noteWalkSuccess(1, T0);
    expect(isDue(1, T0 + 19 * SEC)).toBe(false);
    expect(isDue(1, T0 + 20 * SEC)).toBe(true);
  });
});
