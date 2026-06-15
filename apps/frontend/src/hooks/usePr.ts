import { useQuery } from '@tanstack/react-query';
import type { PrDetail, PrFilesResponse, ThreadDetail } from '@pierre-review/shared';
import { api } from '../api/client.js';

// One week — detail entries persist in IndexedDB and are reused until evicted.
const DETAIL_GC_TIME = 1000 * 60 * 60 * 24 * 7;

// PR / thread detail carries the bulky text that, in cloud mode, is hydrated on
// demand from GitHub and persisted to IndexedDB (see lib/queryPersist.ts). We mark
// it `staleTime: Infinity` so an already-fetched detail is NEVER refetched on its
// own — unchanged text is served from the browser with zero network. Freshness is
// driven instead by useDetailCacheReconciler(), which invalidates a PR's detail
// only when the lean feed reports a newer updatedAt. (Explicit invalidations —
// mark-viewed, etc. — still force a refetch regardless of staleTime.)
export function usePr(id: number | null) {
  return useQuery<PrDetail>({
    queryKey: ['pr', id],
    queryFn: () => api.pr(id as number),
    enabled: id != null,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
}

export function useThread(id: number | null) {
  return useQuery<ThreadDetail>({
    queryKey: ['thread', id],
    queryFn: () => api.thread(id as number),
    enabled: id != null,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
}

// The Changes-tab file diffs are hydrated on demand and persisted to IndexedDB
// (same staleTime/gc policy as PR detail).
export function usePrFiles(id: number | null) {
  return useQuery<PrFilesResponse>({
    queryKey: ['pr-files', id],
    queryFn: () => api.prFiles(id as number),
    enabled: id != null,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
}
