import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CiStatus,
  OpenPrsResponse,
  PrDetail,
  TimelineResponse,
} from '@pierre-review/shared';

// Keeps the persisted PR/thread detail cache fresh without ever re-downloading
// unchanged text. Detail queries use `staleTime: Infinity` (served from IndexedDB
// across reloads), so on their own they'd never refetch. This watches the lean
// timeline / open-PRs feeds — which DO refetch on the sync cadence and carry each
// PR's `updatedAt` — and invalidates a PR's cached detail (and its threads) when
// the feed shows a newer `updatedAt`. That single invalidation triggers one
// re-hydration; an unchanged PR is never refetched.
//
// ⚠ …OR A DIFFERENT CI ROLLUP. CI finishing never bumps `updatedAt`, so the updatedAt test alone
// left a persisted detail saying "CI running" beside a Timeline/Pending dot that had gone red —
// and the PR-detail header now prints that rollup on every tab. See `ciDetailOutdated`. A CI-only
// change refetches the detail and never its threads.
export function useDetailCacheReconciler(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        reconcileDetailCache(qc);
      }, 300);
    };

    schedule();
    // React only to lean-feed changes; pr/thread invalidations below don't re-trigger.
    const unsub = qc.getQueryCache().subscribe((event) => {
      const k = event.query.queryKey[0];
      if (k === 'timeline' || k === 'open-prs') schedule();
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [qc]);
}

/**
 * One reconcile pass over the cache: invalidate every cached `['pr', id]` the lean feeds show to
 * be behind (a newer `updatedAt`, or a different CI rollup from a feed fetched after the detail),
 * and that PR's `['thread', …]` entries on a newer `updatedAt` only. Compares cached data; fetches
 * nothing itself. Exported so the rules are pinned against a real QueryClient
 * (test/prHeaderCi.test.ts), not just the predicate.
 */
export function reconcileDetailCache(qc: QueryClient): void {
  // Newest known updatedAt per PR id, across every cached timeline/open-prs query.
  const latest = new Map<number, string>();
  const note = (id: number, updatedAt: string): void => {
    const prev = latest.get(id);
    if (!prev || updatedAt > prev) latest.set(id, updatedAt);
  };
  // Each PR's CI rollup as the MOST RECENTLY FETCHED feed query saw it (two cached feeds may
  // disagree; the older one is simply behind).
  const ciSeen = new Map<number, FeedCi>();
  for (const key of ['timeline', 'open-prs'] as const) {
    for (const q of qc.getQueryCache().findAll({ queryKey: [key] })) {
      const data = q.state.data as TimelineResponse | OpenPrsResponse | undefined;
      const at = q.state.dataUpdatedAt;
      for (const p of data?.prs ?? []) {
        note(p.id, p.updatedAt);
        const prev = ciSeen.get(p.id);
        if (!prev || at > prev.at) ciSeen.set(p.id, { ciStatus: p.ciStatus, at });
      }
    }
  }

  for (const [prId, updatedAt] of latest) {
    const cached = qc.getQueryData<PrDetail>(['pr', prId]);
    if (!cached) continue;
    const state = qc.getQueryState(['pr', prId]);
    // ISO-8601 strings compare chronologically. Act when the feed is newer…
    const newer = cached.updatedAt < updatedAt;
    // …or when a feed fetched AFTER the detail reports a different CI rollup.
    const seen = ciSeen.get(prId);
    const ciMoved =
      seen != null && ciDetailOutdated(seen, cached.ciStatus, state?.dataUpdatedAt ?? 0);
    if (!newer && !ciMoved) continue;
    if (state && state.fetchStatus !== 'idle') continue; // already refetching
    void qc.invalidateQueries({ queryKey: ['pr', prId] });
    // A CI change touches no thread, so only a newer updatedAt re-hydrates them.
    if (!newer) continue;
    for (const t of cached.threads ?? []) {
      void qc.invalidateQueries({ queryKey: ['thread', t.id] });
    }
  }
}

/** One PR's CI rollup as a lean feed reported it, and when that feed's data arrived (ms). */
export interface FeedCi {
  ciStatus: CiStatus;
  at: number;
}

/**
 * Is a cached PR detail's CI rollup behind the lean feeds? Both read the SAME synced
 * `pull_requests.ci_status` column, so a disagreement means the database moved between the two
 * reads — but only a feed fetched AFTER the detail can know that. The time test is also what makes
 * this settle: once the detail refetches, its own timestamp is the newer one and the pair stops
 * firing, even if an older cached feed still holds the old value. Pure (no fetch, no clock).
 */
export function ciDetailOutdated(
  feed: FeedCi,
  detailCiStatus: CiStatus,
  detailFetchedAt: number,
): boolean {
  return feed.at > detailFetchedAt && feed.ciStatus !== detailCiStatus;
}
