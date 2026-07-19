import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import type { ConsolidatedFeedItem, ConsolidatedFeedResponse, User } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME } from './useActivity.js';

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
  prId: number | null,
  botsOnly: boolean,
  botWindowDays: number | null,
): string {
  const p = new URLSearchParams();
  if (repoIds && repoIds.length > 0) p.set('repoIds', repoIds.join(','));
  if (userIds && userIds.length > 0) p.set('userIds', userIds.join(','));
  // Isolate to a single PR (the Feed "open PRs" panel). Only emitted when set.
  if (prId != null) p.set('prId', String(prId));
  // Mirror the timeline: only emit when hiding bots (default false keeps the key clean).
  if (excludeBots) {
    p.set('excludeBots', 'true');
    // The allow-list only bites under excludeBots — keep those bots visible.
    if (allowedBotIds.length > 0) p.set('allowBotIds', allowedBotIds.join(','));
  }
  // The Bots pane's bot-only feed — filtered to automated reviewers server-side, before the cap.
  if (botsOnly) p.set('botsOnly', 'true');
  // Bot-only feed window (days), following the analytics window selector. Only meaningful —
  // and only emitted — alongside botsOnly (the server ignores it otherwise).
  if (botsOnly && botWindowDays != null) p.set('botWindowDays', String(botWindowDays));
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
  prId?: number | null;
  botsOnly?: boolean;
  botWindowDays?: number | null;
  enabled?: boolean;
}) {
  const search = feedSearch(
    opts.repoIds,
    opts.userIds,
    opts.excludeBots ?? false,
    opts.allowedBotIds ?? [],
    opts.prId ?? null,
    opts.botsOnly ?? false,
    opts.botWindowDays ?? null,
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
    // Survive the Activity console's unmount-on-tab-switch (see ACTIVITY_GC_TIME) so a
    // switch-away-and-back repaints the loaded feed pages instantly instead of cold-loading.
    gcTime: ACTIVITY_GC_TIME,
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
    // Pre-cap stream length (see ConsolidatedFeedResponse.uncappedTotal) — > total means the
    // plain-activity cap dropped older rows. Undefined on a stale IndexedDB response.
    uncappedTotal: query.data?.pages[0]?.uncappedTotal,
    // Server-computed facet counts over the WHOLE loadable stream (see ConsolidatedFeedCounts).
    // From the FIRST page — every page carries the same whole-stream counts. Undefined only for
    // a stale IndexedDB-persisted response predating this field; consumers fall back then.
    counts: query.data?.pages[0]?.counts,
    generatedAt: query.data?.pages[0]?.generatedAt ?? null,
    // The newest LOADED item's id (items are newest-first) — the baseline useFeedHasNew
    // compares the server head against.
    latestId: items[0]?.id ?? null,
    hasMore: query.hasNextPage,
    loadMore: query.fetchNextPage,
    isFetchingMore: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    // True while a key change (e.g. the bots window selector re-keying the search) is being
    // served from the PREVIOUS key's pages via placeholderData — total/latestId reflect the
    // old key then, so has-new comparisons against them are meaningless.
    isPlaceholderData: query.isPlaceholderData,
  };
}

// Detect that the server has NEWER feed activity than what's currently loaded, to drive the
// "New activity — Refresh" banner. Polls just the HEAD of the feed (limit=1) for the SAME
// scope every 60s — deliberately reusing the real feed builder so the head's inclusion logic
// (coalescing, caps, thread-addressing commits) matches the loaded feed EXACTLY, avoiding
// false positives from a divergent cheap query. Visibility-gated (react-query pauses interval
// refetches while the tab is unfocused via refetchIntervalInBackground:false), so it's idle
// when nobody's looking; new data only lands on the 5-min sync anyway. Returns `hasNew` +
// `refresh` (invalidate the loaded feed → the banner clears as items[0]/total catch up).
export function useFeedHasNew(opts: {
  repoIds: number[] | null;
  userIds: number[] | null;
  excludeBots?: boolean;
  allowedBotIds?: number[];
  prId?: number | null;
  botsOnly?: boolean;
  botWindowDays?: number | null;
  loadedLatestId: string | null;
  loadedTotal: number;
  // True once the loaded feed's data actually belongs to the CURRENT key: initial load done
  // AND not placeholder pages from a previous key (a re-key, e.g. the bots window selector).
  // Distinguishes "empty because still loading" (suppress) from "truly empty" (a later
  // arrival should surface the banner), and keeps a stale loadedTotal from false-firing
  // against a fresh head.
  feedSettled: boolean;
  enabled?: boolean;
}): { hasNew: boolean; refresh: () => void } {
  const qc = useQueryClient();
  const search = feedSearch(
    opts.repoIds,
    opts.userIds,
    opts.excludeBots ?? false,
    opts.allowedBotIds ?? [],
    opts.prId ?? null,
    opts.botsOnly ?? false,
    opts.botWindowDays ?? null,
  );
  const head = useQuery<ConsolidatedFeedResponse>({
    queryKey: ['feed-head', search],
    queryFn: () => {
      const p = new URLSearchParams(search);
      p.set('limit', '1');
      p.set('offset', '0');
      return api.consolidatedFeed(p.toString());
    },
    enabled: opts.enabled ?? true,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  const serverLatestId = head.data?.items[0]?.id ?? null;
  const serverTotal = head.data?.total ?? 0;
  // New activity = the loaded scope was empty and now has some (loadedLatestId == null), OR a
  // different newest item landed at the top, OR strictly more items than we've loaded (backfill
  // in the middle). A decrease (items aging out of the 14-day window) never prompts a refresh.
  // Gated on feedSettled so the initial load never flashes (and an empty scope isn't judged
  // "new" while still loading).
  const hasNew =
    opts.feedSettled &&
    serverLatestId != null &&
    (opts.loadedLatestId == null ||
      serverLatestId !== opts.loadedLatestId ||
      serverTotal > opts.loadedTotal);

  return {
    hasNew,
    // Refresh BOTH the loaded feed and the head poll, so the banner clears immediately even when
    // the feed refetches to a state newer than the last-cached head snapshot (else the stale
    // head keeps hasNew true until the next 60s poll).
    refresh: () => {
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      void qc.invalidateQueries({ queryKey: ['feed-head'] });
    },
  };
}
