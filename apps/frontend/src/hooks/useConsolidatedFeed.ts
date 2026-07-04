import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ConsolidatedFeedItem, ConsolidatedFeedResponse, User } from '@pierre-review/shared';
import { api } from '../api/client.js';

// Record that the cross-repo Activity Feed has been viewed (server-side "seen" marker).
// On success, refresh /api/me so the Welcome-back banner's "new since last seen" count
// resets to 0. Fire-and-forget from the feed view.
export function useMarkFeedSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.markFeedSeen(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

// How many feed items load initially and per "Load more" click. Only these are fetched
// AND rendered — hidden items cost nothing (no transfer, no DOM), keeping the Activity fast
// and its memory bounded on large accounts.
export const FEED_PAGE_SIZE = 50;

/** Build the /api/activity/feed query string from the active repo + member + bot scope. */
function feedSearch(
  repoIds: number[] | null,
  userIds: number[] | null,
  excludeBots: boolean,
  allowedBotIds: number[],
): string {
  const p = new URLSearchParams();
  if (repoIds && repoIds.length > 0) p.set('repoIds', repoIds.join(','));
  if (userIds && userIds.length > 0) p.set('userIds', userIds.join(','));
  // Mirror the timeline: only emit when hiding bots (default false keeps the key clean).
  if (excludeBots) {
    p.set('excludeBots', 'true');
    // The allow-list only bites under excludeBots — keep those bots visible.
    if (allowedBotIds.length > 0) p.set('allowBotIds', allowedBotIds.join(','));
  }
  return p.toString();
}

// The consolidated Feed (the Activity "Feed" entry): one chronological stream across the
// scoped repos merging My Turn actionables + the activity feed. Paginated with
// useInfiniteQuery: page 0 loads the first FEED_PAGE_SIZE; "Load more" fetches the next
// page by offset (never re-fetching earlier pages). Repo/member scope is folded into the
// query key so a FilterBar change (or a rail repo select, which passes a single-id
// repoIds) resets to page 0 and refetches. Snapshot intent — `staleTime: Infinity` +
// `refetchOnMount: false`; the rail "Refresh" invalidates the `['consolidated-feed']`
// prefix; `placeholderData: keep` keeps the previous list on screen while a new scope
// loads (dim, never blank).
export function useConsolidatedFeed(opts: {
  repoIds: number[] | null;
  userIds: number[] | null;
  excludeBots?: boolean;
  allowedBotIds?: number[];
  enabled?: boolean;
}) {
  const search = feedSearch(
    opts.repoIds,
    opts.userIds,
    opts.excludeBots ?? false,
    opts.allowedBotIds ?? [],
  );
  const query = useInfiniteQuery<ConsolidatedFeedResponse>({
    queryKey: ['consolidated-feed', search],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(search);
      p.set('limit', String(FEED_PAGE_SIZE));
      p.set('offset', String(pageParam as number));
      return api.consolidatedFeed(p.toString());
    },
    getNextPageParam: (_lastPage, allPages) => {
      const loaded = allPages.reduce((n, pg) => n + pg.items.length, 0);
      const total = allPages[0]?.total ?? 0;
      return loaded < total ? loaded : undefined;
    },
    enabled: opts.enabled ?? true,
    staleTime: Infinity,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });

  // Flatten the loaded pages into one list + a merged user index.
  const { items, users } = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const items: ConsolidatedFeedItem[] = pages.flatMap((pg) => pg.items);
    const byId = new Map<number, User>();
    for (const pg of pages) for (const u of pg.users) byId.set(u.id, u);
    return { items, users: [...byId.values()] };
  }, [query.data]);

  return {
    items,
    users,
    total: query.data?.pages[0]?.total ?? 0,
    generatedAt: query.data?.pages[0]?.generatedAt ?? null,
    hasMore: query.hasNextPage,
    loadMore: query.fetchNextPage,
    isFetchingMore: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
  };
}
