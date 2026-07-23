import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { SearchHit, SearchHitKind, SearchPerson, SearchResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useFilters, scopeToParam } from '../store/filters.js';

// Cross-team text search hooks. Both scope to the ACTIVE team (`teamScope` → the API `scope`
// string) so results honour the user's current team selection, exactly like Activity/Insights.

const DROPDOWN_LIMIT = 8;
export const SEARCH_PAGE_SIZE = 25;

// The quick-search dropdown: one small page, fired only for a query ≥ 2 chars. `placeholderData`
// keeps the prior results on screen while typing so the panel doesn't flicker empty.
export function useSearchDropdown(query: string): {
  data: SearchResponse | undefined;
  isFetching: boolean;
} {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const q = query.trim();
  const enabled = q.length >= 2;
  const res = useQuery<SearchResponse>({
    queryKey: ['search-dropdown', scope, q],
    queryFn: () => api.search({ q, scope, limit: DROPDOWN_LIMIT }),
    enabled,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
  return { data: enabled ? res.data : undefined, isFetching: enabled && res.isFetching };
}

// The full paginated results tab. `kinds` optionally narrows to hit kinds. Flattens the loaded
// pages into one hit list; `people`/`total` come from the first page (stable across pages).
export function useSearchResults(query: string, kinds: SearchHitKind[]): {
  hits: SearchHit[];
  people: SearchPerson[];
  total: number;
  isLoading: boolean;
  isFetching: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  isFetchingMore: boolean;
} {
  const scope = scopeToParam(useFilters((s) => s.teamScope));
  const q = query.trim();
  const enabled = q.length >= 1;
  const kindKey = [...kinds].sort().join(',');
  const query$ = useInfiniteQuery<SearchResponse>({
    queryKey: ['search-results', scope, q, kindKey],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api.search({ q, scope, kinds, limit: SEARCH_PAGE_SIZE, offset: pageParam as number }),
    getNextPageParam: (_last, all) => {
      const loaded = all.reduce((n, p) => n + p.hits.length, 0);
      const total = all[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // `placeholderData` keeps the PRIOR query's pages on screen while typing/paging — but for an
  // EMPTY (disabled) query that would surface the last search's results under a "Type to search"
  // header. Gate every returned field on `enabled` so a cleared box shows nothing, mirroring the
  // dropdown hook's `enabled ? data : undefined`.
  const hits = useMemo(
    () => (enabled ? (query$.data?.pages ?? []).flatMap((p) => p.hits) : []),
    [query$.data, enabled],
  );
  return {
    hits,
    people: enabled ? query$.data?.pages[0]?.people ?? [] : [],
    total: enabled ? query$.data?.pages[0]?.total ?? 0 : 0,
    isLoading: enabled && query$.isLoading,
    isFetching: enabled && query$.isFetching,
    hasMore: enabled && query$.hasNextPage,
    fetchMore: () => void query$.fetchNextPage(),
    isFetchingMore: query$.isFetchingNextPage,
  };
}
