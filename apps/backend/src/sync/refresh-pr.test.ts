// refreshPrFromGitHub — the probe-gated body of POST /api/prs/:id/refresh. Mocked at the
// same boundaries as sync-one-pr.test.ts (target resolver, token, the conditional REST
// probe, syncOnePr, the hydration invalidator), so what is exercised is exactly this
// module's own contract: when a tick is free, when it pays for a walk, what `changed`
// means, and that a failure is a report and never a throw.
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../auth/account.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }));
vi.mock('../github/client.js', () => ({ ghRestGetConditional: vi.fn() }));
vi.mock('./hydrate-detail.js', () => ({ invalidatePrHydration: vi.fn() }));
vi.mock('./sync-one-pr.js', () => ({
  syncOnePr: vi.fn(async () => true),
  isPrSyncInFlight: vi.fn(() => false),
}));
vi.mock('./resync-after-write.js', () => ({
  asSyncLogger: (l: unknown) => l,
  getPrSyncTarget: vi.fn(),
}));

import { ghRestGetConditional } from '../github/client.js';
import { invalidatePrHydration } from './hydrate-detail.js';
import { getPrSyncTarget } from './resync-after-write.js';
import { isPrSyncInFlight, syncOnePr } from './sync-one-pr.js';
import { __resetPrRefreshState, refreshPrFromGitHub } from './refresh-pr.js';

const mockTarget = vi.mocked(getPrSyncTarget) as unknown as Mock;
const mockProbe = vi.mocked(ghRestGetConditional) as unknown as Mock;
const mockSync = vi.mocked(syncOnePr) as unknown as Mock;
const mockInFlight = vi.mocked(isPrSyncInFlight) as unknown as Mock;
const mockInvalidate = vi.mocked(invalidatePrHydration);

const T0 = new Date('2026-08-01T00:00:00Z');
const T1 = new Date('2026-08-01T00:05:00Z');
const target = (updatedAt: Date) => ({
  repoId: 3,
  owner: 'o',
  name: 'n',
  number: 42,
  updatedAt,
});

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const refresh = (wait = false) =>
  refreshPrFromGitHub({ prId: 9, accountId: 1, wait, log });

beforeEach(() => {
  vi.clearAllMocks();
  __resetPrRefreshState();
  mockTarget.mockResolvedValue(target(T0));
  mockProbe.mockResolvedValue({ status: 200, notModified: false, etag: 'W/"e1"' });
  mockSync.mockResolvedValue(true);
  mockInFlight.mockReturnValue(false);
});

describe('refreshPrFromGitHub — ownership', () => {
  it('returns null (→ 404 upstream) for a PR the account does not own', async () => {
    mockTarget.mockResolvedValue(null);
    expect(await refresh()).toBeNull();
    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
  });
});

describe('refreshPrFromGitHub — the poll variant', () => {
  it('walks on the first tick (no stored ETag) and reports changed from updatedAt movement', async () => {
    mockTarget.mockResolvedValueOnce(target(T0)).mockResolvedValueOnce(target(T1));

    const res = await refresh();

    expect(mockSync).toHaveBeenCalledWith(3, 42, log, undefined);
    // First-tick walk is probe-triggered (a 200), NOT floor-forced: with updatedAt moved
    // it reports changed.
    expect(res).toEqual({ synced: true, changed: true, updatedAt: T1.toISOString() });
    // The hydration bust precedes the walk (the resync-after-write order rule).
    expect(mockInvalidate.mock.invocationCallOrder[0]).toBeLessThan(
      mockSync.mock.invocationCallOrder[0]!,
    );
    expect(mockInvalidate).toHaveBeenCalledWith(1, 'o', 'n', 42);
  });

  it('a probe-200 walk with an unmoved updatedAt is NOT changed (ETag churn ≠ activity)', async () => {
    const res = await refresh();
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ synced: true, changed: false, updatedAt: T0.toISOString() });
  });

  it('304 inside the floor window is free: no walk, no hydration bust, changed:false', async () => {
    await refresh(); // tick 1: walks, records the ETag + walk time
    vi.clearAllMocks();
    mockTarget.mockResolvedValue(target(T0));
    mockProbe.mockResolvedValue({ status: 304, notModified: true, etag: 'W/"e1"' });

    const res = await refresh();

    expect(res).toEqual({ synced: true, changed: false, updatedAt: T0.toISOString() });
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockInvalidate).not.toHaveBeenCalled();
    // The stored ETag was sent as If-None-Match.
    expect(mockProbe).toHaveBeenCalledWith('tok', '/repos/o/n/pulls/42', 'W/"e1"');
  });

  it('the floor forces a walk past a 304 and reports it potentially-changed (checks are blind to updatedAt)', async () => {
    vi.useFakeTimers();
    try {
      await refresh(); // tick 1 walks
      mockProbe.mockResolvedValue({ status: 304, notModified: true, etag: 'W/"e1"' });
      vi.advanceTimersByTime(30_001);
      vi.clearAllMocks();
      mockTarget.mockResolvedValue(target(T0));
      mockProbe.mockResolvedValue({ status: 304, notModified: true, etag: 'W/"e1"' });
      mockSync.mockResolvedValue(true);

      const res = await refresh();

      expect(mockSync).toHaveBeenCalledTimes(1);
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
      // updatedAt did NOT move, but the floor-forced walk refreshed hydration-only
      // detail, so the client must repaint.
      expect(res).toEqual({ synced: true, changed: true, updatedAt: T0.toISOString() });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a stand-down against an in-flight sync as synced (that freshness is the answer)', async () => {
    mockInFlight.mockReturnValue(true);
    mockSync.mockResolvedValue(false); // the no-wait call stood down

    const res = await refresh();

    expect(mockSync).toHaveBeenCalledWith(3, 42, log, undefined);
    expect(res!.synced).toBe(true);
  });

  it('probe failure falls back to a walk rather than silently skipping', async () => {
    mockProbe.mockRejectedValue(new Error('network'));
    const res = await refresh();
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(res!.synced).toBe(true);
  });
});

describe('refreshPrFromGitHub — the manual variant (wait:true)', () => {
  it('skips the probe, busts hydration, queues behind in-flight syncs, and is always potentially-changed', async () => {
    const res = await refresh(true);

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledWith(1, 'o', 'n', 42);
    expect(mockSync).toHaveBeenCalledWith(3, 42, log, { waitForInFlight: true });
    // updatedAt held still, but the user's click re-read GitHub — repaint.
    expect(res).toEqual({ synced: true, changed: true, updatedAt: T0.toISOString() });
  });

  it('reports a failed sync as {synced:false, changed:false}, never a throw', async () => {
    mockSync.mockResolvedValue(false);
    const res = await refresh(true);
    expect(res).toEqual({ synced: false, changed: false, updatedAt: T0.toISOString() });
  });
});

describe('refreshPrFromGitHub — nothing throws', () => {
  it('reports {synced:false} when the token fetch rejects', async () => {
    const { getAccessToken } = await import('../auth/account.js');
    (vi.mocked(getAccessToken) as unknown as Mock).mockRejectedValue(new Error('no gh'));
    // Probe unreachable without a token → the walk itself still runs; make IT fail too so
    // the reported outcome is the honest one.
    mockSync.mockRejectedValue(new Error('boom'));

    const res = await refresh();

    expect(res).toEqual({ synced: false, changed: false, updatedAt: T0.toISOString() });
  });
});
