// The PR-detail header's CI readout, and the cache rule that keeps it honest.
//
// `prHeaderCi` decides whether the header draws a CI dot and which word sits beside it. Two
// decisions are pinned here because each has a real-data reason behind it:
//   • OPEN PRs ONLY. `pull_requests.ci_status` is frozen at the merge instant, so a merged PR can
//     carry "CI running" forever; a present-tense header on every tab may not say that.
//   • `unknown` is a hollow ring + "No checks" (about a quarter of open PRs), matching the Pending
//     card and the Overview Status row the click lands on — never nothing.
//
// `ciDetailOutdated` is the reconciler's CI test: CI finishing never bumps `updatedAt`, so a
// persisted detail could otherwise contradict the Timeline/Pending dot.
//
// `reconcileDetailCache` is the pass that applies it, driven here against a real QueryClient so the
// rules around the predicate are pinned too: the NEWEST feed read wins, a query already fetching is
// left alone, and a CI-only change refetches the detail but never its threads.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type {
  CiStatus,
  OpenPrsResponse,
  PrDetail,
  PrState,
  TimelineResponse,
} from '@pierre-review/shared';
import { CI_META, prHeaderCi } from '../src/lib/ui.js';
import { ciDetailOutdated, reconcileDetailCache } from '../src/hooks/useDetailCache.js';

const ALL_CI: CiStatus[] = ['success', 'failure', 'error', 'pending', 'expected', 'unknown'];

describe('prHeaderCi', () => {
  it('says the CI_META word for every known rollup on an open PR', () => {
    expect(prHeaderCi('open', 'success')).toEqual({ status: 'success', label: 'CI passing' });
    expect(prHeaderCi('open', 'failure')).toEqual({ status: 'failure', label: 'CI failing' });
    expect(prHeaderCi('open', 'error')).toEqual({ status: 'error', label: 'CI error' });
    expect(prHeaderCi('open', 'pending')).toEqual({ status: 'pending', label: 'CI running' });
    expect(prHeaderCi('open', 'expected')).toEqual({ status: 'expected', label: 'CI expected' });
  });

  it('never invents a second vocabulary: known labels ARE the CI_META labels', () => {
    for (const ci of ALL_CI) {
      const meta = CI_META[ci];
      if (meta == null) continue;
      expect(prHeaderCi('open', ci)?.label).toBe(meta.label);
    }
  });

  it('draws unknown as the hollow ring with "No checks", not nothing', () => {
    expect(prHeaderCi('open', 'unknown')).toEqual({ status: 'unknown', label: 'No checks' });
  });

  it('says nothing on a merged or closed PR, whatever the frozen rollup says', () => {
    for (const state of ['merged', 'closed'] as PrState[]) {
      for (const ci of ALL_CI) expect(prHeaderCi(state, ci)).toBeNull();
    }
  });
});

describe('ciDetailOutdated', () => {
  it('fires when a feed fetched AFTER the detail reports a different rollup', () => {
    expect(ciDetailOutdated({ ciStatus: 'failure', at: 2_000 }, 'pending', 1_000)).toBe(true);
  });

  it('stays quiet when the rollups agree', () => {
    expect(ciDetailOutdated({ ciStatus: 'success', at: 2_000 }, 'success', 1_000)).toBe(false);
  });

  it('settles once the detail is the newer read, even if an old feed still disagrees', () => {
    // Without the time test, a stale cached feed would invalidate the detail on every feed event.
    expect(ciDetailOutdated({ ciStatus: 'pending', at: 1_000 }, 'failure', 2_000)).toBe(false);
    expect(ciDetailOutdated({ ciStatus: 'pending', at: 2_000 }, 'failure', 2_000)).toBe(false);
  });
});

describe('reconcileDetailCache', () => {
  const PR = 7;
  const THREAD = 11;
  const T0 = '2026-09-01T10:00:00.000Z';
  const T1 = '2026-09-01T11:00:00.000Z';

  // Only the fields the reconciler reads; the casts say so rather than faking whole payloads.
  const feed = (ciStatus: CiStatus, updatedAt = T0): TimelineResponse & OpenPrsResponse =>
    ({ prs: [{ id: PR, updatedAt, ciStatus }] }) as unknown as TimelineResponse & OpenPrsResponse;
  const detail = (ciStatus: CiStatus, updatedAt = T0): PrDetail =>
    ({ id: PR, updatedAt, ciStatus, threads: [{ id: THREAD }] }) as unknown as PrDetail;

  /** A client holding the detail (+ one thread) read at `detailAt`, and the given feed reads. */
  const seed = (
    detailCi: CiStatus,
    detailAt: number,
    feeds: { key: 'timeline' | 'open-prs'; ci: CiStatus; at: number; updatedAt?: string }[],
  ): QueryClient => {
    const qc = new QueryClient();
    qc.setQueryData(['pr', PR], detail(detailCi), { updatedAt: detailAt });
    qc.setQueryData(['thread', THREAD], { id: THREAD }, { updatedAt: detailAt });
    for (const f of feeds) {
      qc.setQueryData([f.key, 'ws:1'], feed(f.ci, f.updatedAt), { updatedAt: f.at });
    }
    return qc;
  };
  const invalidated = (qc: QueryClient, key: unknown[]): boolean =>
    qc.getQueryState(key)?.isInvalidated === true;

  it('refetches the detail on a CI-only change, and leaves its threads alone', () => {
    const qc = seed('pending', 1_000, [{ key: 'timeline', ci: 'failure', at: 2_000 }]);
    reconcileDetailCache(qc);
    expect(invalidated(qc, ['pr', PR])).toBe(true);
    expect(invalidated(qc, ['thread', THREAD])).toBe(false);
  });

  it('still refetches the detail AND its threads on a newer updatedAt', () => {
    const qc = seed('success', 1_000, [
      { key: 'timeline', ci: 'success', at: 2_000, updatedAt: T1 },
    ]);
    reconcileDetailCache(qc);
    expect(invalidated(qc, ['pr', PR])).toBe(true);
    expect(invalidated(qc, ['thread', THREAD])).toBe(true);
  });

  it('believes the most recently fetched feed, whichever key it is under', () => {
    // An older disagreeing feed seen FIRST (timeline) must not beat a newer agreeing one…
    const agrees = seed('success', 1_000, [
      { key: 'timeline', ci: 'pending', at: 2_000 },
      { key: 'open-prs', ci: 'success', at: 3_000 },
    ]);
    reconcileDetailCache(agrees);
    expect(invalidated(agrees, ['pr', PR])).toBe(false);

    // …nor one seen LAST (open-prs).
    const agreesReversed = seed('success', 1_000, [
      { key: 'timeline', ci: 'success', at: 3_000 },
      { key: 'open-prs', ci: 'pending', at: 2_000 },
    ]);
    reconcileDetailCache(agreesReversed);
    expect(invalidated(agreesReversed, ['pr', PR])).toBe(false);

    // And the newer feed disagreeing does fire.
    const disagrees = seed('success', 1_000, [
      { key: 'timeline', ci: 'success', at: 2_000 },
      { key: 'open-prs', ci: 'failure', at: 3_000 },
    ]);
    reconcileDetailCache(disagrees);
    expect(invalidated(disagrees, ['pr', PR])).toBe(true);
  });

  it('settles once the detail is the newer read', () => {
    const qc = seed('failure', 3_000, [{ key: 'timeline', ci: 'pending', at: 2_000 }]);
    reconcileDetailCache(qc);
    expect(invalidated(qc, ['pr', PR])).toBe(false);
  });

  it('leaves a detail that is already refetching alone', () => {
    const qc = seed('pending', 1_000, [{ key: 'timeline', ci: 'failure', at: 2_000 }]);
    qc.getQueryCache().find({ queryKey: ['pr', PR], exact: true })?.setState({
      fetchStatus: 'fetching',
    });
    reconcileDetailCache(qc);
    expect(invalidated(qc, ['pr', PR])).toBe(false);
  });

  it('does nothing for a PR whose detail is not cached', () => {
    const qc = new QueryClient();
    qc.setQueryData(['timeline', 'ws:1'], feed('failure'), { updatedAt: 2_000 });
    reconcileDetailCache(qc);
    expect(qc.getQueryState(['pr', PR])).toBeUndefined();
  });
});
