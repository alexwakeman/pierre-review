import { useQuery } from '@tanstack/react-query';
import type {
  MeResponse,
  MyTurnResponse,
  OpenPrsResponse,
} from '@gh-team-monitor/shared';
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
  return useQuery<MeResponse>({ queryKey: ['me'], queryFn: api.me });
}

export function useMyTurn() {
  return useQuery<MyTurnResponse>({ queryKey: ['my-turn'], queryFn: api.myTurn });
}
