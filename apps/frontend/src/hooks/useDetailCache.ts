import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  OpenPrsResponse,
  PrDetail,
  TimelineResponse,
} from '@pierre-review/shared';

// Keeps the persisted PR/thread detail cache fresh without ever re-downloading
// unchanged text. Detail queries use `staleTime: Infinity` (served from IndexedDB
// across reloads), so on their own they'd never refetch. This watches the lean
// timeline / open-PRs feeds — which DO refetch on the sync cadence and carry each
// PR's `updatedAt` — and invalidates a PR's cached detail (and its threads) only
// when the feed shows a newer `updatedAt`. That single invalidation triggers one
// re-hydration; an unchanged PR is never refetched.
export function useDetailCacheReconciler(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const reconcile = (): void => {
      // Newest known updatedAt per PR id, across every cached timeline/open-prs query.
      const latest = new Map<number, string>();
      const note = (id: number, updatedAt: string): void => {
        const prev = latest.get(id);
        if (!prev || updatedAt > prev) latest.set(id, updatedAt);
      };
      for (const [, data] of qc.getQueriesData<TimelineResponse>({
        queryKey: ['timeline'],
      })) {
        for (const p of data?.prs ?? []) note(p.id, p.updatedAt);
      }
      for (const [, data] of qc.getQueriesData<OpenPrsResponse>({
        queryKey: ['open-prs'],
      })) {
        for (const p of data?.prs ?? []) note(p.id, p.updatedAt);
      }

      for (const [prId, updatedAt] of latest) {
        const cached = qc.getQueryData<PrDetail>(['pr', prId]);
        // ISO-8601 strings compare chronologically. Only act when the feed is newer.
        if (!cached || cached.updatedAt >= updatedAt) continue;
        const state = qc.getQueryState(['pr', prId]);
        if (state && state.fetchStatus !== 'idle') continue; // already refetching
        void qc.invalidateQueries({ queryKey: ['pr', prId] });
        for (const t of cached.threads ?? []) {
          void qc.invalidateQueries({ queryKey: ['thread', t.id] });
        }
      }
    };

    const schedule = (): void => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        reconcile();
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
