import { skipToken, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { SearchHit, SearchHitKind, SearchPerson, SearchResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useFilters } from '../store/filters.js';
import { workspaceKey } from './useActivity.js';

// Workspace-wide text search hooks. Both scope to the ACTIVE WORKSPACE (read straight from the
// store, exactly like Activity/Insights) so results honour the user's current selection. The
// server resolves `?workspace=` to that workspace's repos, so an empty workspace yields no hits
// rather than the whole account, and a caller cannot widen the scope.

const DROPDOWN_LIMIT = 8;
export const SEARCH_PAGE_SIZE = 25;

// The quick-search dropdown: one small page, fired only for a query ≥ 2 chars. `placeholderData`
// keeps the prior results on screen while typing so the panel doesn't flicker empty.
export function useSearchDropdown(query: string): {
  data: SearchResponse | undefined;
  isFetching: boolean;
} {
  const workspaceId = useFilters((s) => s.workspaceId);
  const q = query.trim();
  const enabled = q.length >= 2 && workspaceId != null;
  const res = useQuery<SearchResponse>({
    queryKey: ['search-dropdown', workspaceKey(workspaceId), q],
    queryFn:
      workspaceId == null
        ? skipToken
        : () => api.search({ q, workspaceId, limit: DROPDOWN_LIMIT }),
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
  const workspaceId = useFilters((s) => s.workspaceId);
  const q = query.trim();
  const enabled = q.length >= 1 && workspaceId != null;
  const kindKey = [...kinds].sort().join(',');
  const query$ = useInfiniteQuery<SearchResponse>({
    queryKey: ['search-results', workspaceKey(workspaceId), q, kindKey],
    initialPageParam: 0,
    queryFn:
      workspaceId == null
        ? skipToken
        : ({ pageParam }) =>
            api.search({
              q,
              workspaceId,
              kinds,
              limit: SEARCH_PAGE_SIZE,
              offset: pageParam as number,
            }),
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
