import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Mock the interval config + the conditional-probe REST call so the cadence/probe logic is
// exercised with a controllable clock and canned GitHub responses.
vi.mock('../config.js', () => ({
  config: {
    syncHotIntervalSec: 120,
    syncWarmIntervalSec: 300,
    syncColdIntervalSec: 900,
    syncFloorIntervalSec: 1800,
  },
}));
vi.mock('../github/client.js', () => ({ ghRestGetConditional: vi.fn() }));

import { ghRestGetConditional } from '../github/client.js';
import {
  bucketFor,
  decideIncrementalWalk,
  isDue,
  recordFullWalk,
  __resetAdaptiveState,
} from './adaptive.js';

const mockProbe = vi.mocked(ghRestGetConditional) as unknown as Mock;

// A fixed base epoch; tests offset from it so the huge lastFullWalkAt=0 seed always reads
// as "floor due" on a repo's first decide (until recordFullWalk stamps it).
const T0 = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

const changed = (etag: string | null) => ({ status: 200, notModified: false, etag });
const unchanged = (etag: string | null) => ({ status: 304, notModified: true, etag });

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

  it('after an attempt a hot repo is not due until its interval elapses', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // attempt=T0, change=T0 → hot (120s)
    expect(bucketFor(1, T0)).toBe('hot');
    expect(isDue(1, T0 + 119_000)).toBe(false);
    expect(isDue(1, T0 + 121_000)).toBe(true);
  });

  it('buckets by how recently a change was observed', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // last change at T0
    expect(bucketFor(1, T0 + 30 * MIN)).toBe('hot'); // < 1h
    expect(bucketFor(1, T0 + 3 * HOUR)).toBe('warm'); // < 6h
    expect(bucketFor(1, T0 + 7 * HOUR)).toBe('cold'); // ≥ 6h
  });

  it('a cold repo honours the longer cold interval', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0); // change=T0
    // A later 304 attempt advances lastAttemptAt but not lastChangeAt.
    mockProbe.mockResolvedValue(unchanged('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 7 * HOUR); // now cold, attempt bumped
    expect(bucketFor(1, T0 + 7 * HOUR)).toBe('cold');
    expect(isDue(1, T0 + 7 * HOUR + 800_000)).toBe(false); // < 900s cold interval
    expect(isDue(1, T0 + 7 * HOUR + 901_000)).toBe(true);
  });
});

describe('decideIncrementalWalk (conditional probe)', () => {
  it('walks and marks a change when the probe reports 200', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    expect(d).toEqual({ walk: true, reason: 'changed' });
    expect(bucketFor(1, T0)).toBe('hot');
  });

  it('skips the walk on 304 when the re-walk floor is not due', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    recordFullWalk(1, T0); // floor reset at T0
    mockProbe.mockResolvedValue(unchanged('e1'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 5 * MIN); // < 30min floor
    expect(d).toEqual({ walk: false, reason: 'unchanged' });
  });

  it('walks on 304 once the floor IS due (catches CI-finish / thread-resolve)', async () => {
    mockProbe.mockResolvedValue(changed('e1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
    recordFullWalk(1, T0);
    mockProbe.mockResolvedValue(unchanged('e1'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 31 * MIN); // > 30min floor
    expect(d).toEqual({ walk: true, reason: 'floor' });
  });

  it('walks on a probe error (never skips on uncertainty)', async () => {
    recordFullWalk(1, T0); // floor not due, so the reason must be the error, not the floor
    mockProbe.mockRejectedValue(new Error('network'));
    const d = await decideIncrementalWalk(1, 'o', 'n', 'tok', T0 + 5 * MIN);
    expect(d).toEqual({ walk: true, reason: 'probe_error' });
  });

  it('threads the stored ETag into the next If-None-Match probe', async () => {
    mockProbe.mockResolvedValueOnce(changed('etag-1'));
    await decideIncrementalWalk(1, 'o', 'n', 'tok', T0);
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
