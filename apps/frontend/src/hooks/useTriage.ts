import { useQuery } from '@tanstack/react-query';
import type {
  DismissedMyTurnResponse,
  MeResponse,
  MyTurnResponse,
  OpenPrsResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { buildOpenPrsSearch, useFilters } from '../store/filters.js';

export function useOpenPrs() {
  const search = useFilters(buildOpenPrsSearch);
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', search],
    queryFn: () => api.openPrs(search),
    placeholderData: (prev) => prev,
  });
}

// Open PRs for the PR-title search index — ignores the member filter so search
// is global (see useSearchTimeline). Dedupes with useOpenPrs when no member
// filter is active (identical query string → shared cache entry).
export function useSearchOpenPrs() {
  const search = useFilters((s) => buildOpenPrsSearch(s, false));
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', search],
    queryFn: () => api.openPrs(search),
    placeholderData: (prev) => prev,
  });
}

export function useMe() {
  // `retry: false` so a cloud-mode 401 (signed out) surfaces immediately to the
  // App auth gate instead of being retried.
  return useQuery<MeResponse>({ queryKey: ['me'], queryFn: api.me, retry: false });
}

export function useMyTurn() {
  return useQuery<MyTurnResponse>({ queryKey: ['my-turn'], queryFn: api.myTurn });
}

// The "Done" tab — completed (dismissed) entries, past 90 days. Only fetched when
// the tab is active (`enabled`).
export function useMyTurnDone(enabled: boolean) {
  return useQuery<DismissedMyTurnResponse>({
    queryKey: ['my-turn-done'],
    queryFn: api.myTurnDone,
    enabled,
  });
}
