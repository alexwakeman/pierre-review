import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import type { ConsolidatedFeedItem, ConsolidatedFeedResponse, User } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

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

/**
 * Build the /api/activity/feed query string from the active WORKSPACE + repo + member + bot scope.
 *
 * ⚠ `workspace` is not interchangeable with `repoIds`, and the bots-only path is why: the server
 * resolves "which logins count as automated reviewers" from the WORKSPACE, while `repoIds` only
 * narrows which data is measured. The two deliberately disagree on the single-PR isolation path
 * (`prId`), which reaches a PR whose repo may be outside the current narrowing entirely.
 *
 * ⚠ `repoIds` IS EMITTED WHENEVER IT IS NON-NULL, INCLUDING WHEN EMPTY — see activitySearch in
 * useActivity.ts for why dropping an empty array is a scope bug rather than a tidy-up.
 *
 * ⚠ `repoIds` IS AN EXPLICIT CALLER SCOPE, NEVER THE FILTERBAR'S REPO PICKER. The feed is an
 * Activity surface, so it covers the WHOLE active workspace; the only legitimate narrowing is the
 * per-repo console passing its own `[repoId]`. `filters.repoIds` is a TIMELINE-board filter whose
 * picker is not mounted while Activity is the active tab — routing it here would leave the feed
 * silently scoped with no visible control to widen it again.
 */
function feedSearch(
  workspaceId: number | null,
  repoIds: number[] | null,
  userIds: number[] | null,
  excludeBots: boolean,
  allowedBotIds: number[],
  prId: number | null,
  botsOnly: boolean,
  botWindowDays: number | null,
  includeAllCommits: boolean,
  includeCiFailures: boolean,
): string {
  const p = new URLSearchParams();
  if (workspaceId != null) p.set('workspace', String(workspaceId));
  if (repoIds) p.set('repoIds', repoIds.join(','));
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
  // Opt-in "show individual commits" — surface plain commit-push runs too. Only emitted when
  // on (default off keeps the key clean); ignored server-side on the botsOnly path.
  if (includeAllCommits) p.set('includeAllCommits', 'true');
  // Opt-in "show CI failures" — surface one item per failed check run, on PR heads AND on the
  // default branch. Only emitted when on (default off keeps the key clean); ignored server-side
  // on the botsOnly path and whenever a member filter is active (the rows are actor-less).
  if (includeCiFailures) p.set('includeCiFailures', 'true');
  return p.toString();
}

// The consolidated Feed (the Activity "Feed" entry): one chronological stream across the
// scoped repos merging My Turn actionables + the activity feed. Paginated with
// useInfiniteQuery: page 0 loads the first FEED_PAGE_SIZE; "Load more" fetches the next
// page by offset (never re-fetching earlier pages). WORKSPACE + any explicit repo scope is folded
// into the query key so a WorkspaceSelector change (or a rail repo select, which passes a
// single-id repoIds) resets to page 0 and refetches. Snapshot intent — `staleTime: Infinity` +
// `refetchOnMount: false`; the rail "Refresh" invalidates the `['consolidated-feed']`
// prefix (a PREFIX, so it sweeps every workspace's slot); `placeholderData: keep` keeps the
// previous list on screen while a new scope loads (dim, never blank).
//
// `workspaceId` is required and nullable: `null` means the store has not resolved a workspace yet,
// and the fetch is DISABLED until it has — nothing workspace-scoped may render off the wrong one.
export function useConsolidatedFeed(opts: {
  workspaceId: number | null;
  repoIds: number[] | null;
  userIds: number[] | null;
  excludeBots?: boolean;
  allowedBotIds?: number[];
  prId?: number | null;
  botsOnly?: boolean;
  botWindowDays?: number | null;
  includeAllCommits?: boolean;
  includeCiFailures?: boolean;
  enabled?: boolean;
}) {
  const search = feedSearch(
    opts.workspaceId,
    opts.repoIds,
    opts.userIds,
    opts.excludeBots ?? false,
    opts.allowedBotIds ?? [],
    opts.prId ?? null,
    opts.botsOnly ?? false,
    opts.botWindowDays ?? null,
    opts.includeAllCommits ?? false,
    opts.includeCiFailures ?? false,
  );
  const query = useInfiniteQuery<ConsolidatedFeedResponse>({
    queryKey: ['consolidated-feed', workspaceKey(opts.workspaceId), search],
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
    enabled: (opts.enabled ?? true) && opts.workspaceId != null,
    staleTime: Infinity,
    // Survive the Activity console's unmount-on-tab-switch (see ACTIVITY_GC_TIME) so a
    // switch-away-and-back repaints the loaded feed pages instantly instead of cold-loading.
    gcTime: ACTIVITY_GC_TIME,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });

  // Flatten the loaded pages into one list + a merged user index.
  //
  // ⚠ DEDUPED BY ITEM ID. Paging is by OFFSET into a stream that moves, so a row that lands
  // (or ages out) between two page fetches can shift the window and hand the same id back on
  // two pages. The auto-insert path below prepends at the head, which keeps the offsets
  // aligned BY CONSTRUCTION, but the tail can still churn server-side — and a duplicate id is
  // not merely a duplicate card, it is a duplicate React key and a `heightsRef` collision in
  // the windower. First occurrence (the newest page) wins.
  const { items, users } = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const seen = new Set<string>();
    const items: ConsolidatedFeedItem[] = [];
    for (const pg of pages) {
      for (const it of pg.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        items.push(it);
      }
    }
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

// The plan for merging one HEAD response into the loaded feed pages — pure, so the rule that
// keeps offset paging honest is testable without a query client.
//
// The head is the SAME request page 0 makes (same builder, same limit), so the two lists overlap
// unless more than a page landed since. That overlap is the whole safety property:
//
//   • `insert` is the head's PREFIX up to the first already-loaded id. Those items are strictly
//     newer than everything loaded, so prepending them keeps the loaded pages a contiguous
//     prefix of the stream — which is what keeps the NEXT `offset` fetch aligned. (An
//     unloaded id AFTER the overlap point is a backfill in the middle; splicing it would shift
//     the offsets under the tail pages, so it is deliberately ignored and picked up by the next
//     full refetch.)
//   • `verdict: 'gap'` — the head shares NO id with the loaded pages — means more than a page
//     arrived at once (or the loaded pages belong to another key). There is a hole between the
//     two lists, so the only correct move is a full refetch, never a prepend.
export function planFeedHeadMerge(
  headIds: readonly string[],
  loadedIds: ReadonlySet<string>,
): { verdict: 'none' | 'insert' | 'gap'; insert: string[] } {
  if (loadedIds.size === 0) return { verdict: 'none', insert: [] };
  const overlap = headIds.findIndex((id) => loadedIds.has(id));
  if (overlap < 0) return { verdict: 'gap', insert: [] };
  if (overlap === 0) return { verdict: 'none', insert: [] };
  return { verdict: 'insert', insert: headIds.slice(0, overlap) };
}

/**
 * How many rows a newly-committed list gained ABOVE the previous list's head, counted AFTER the
 * client-side narrowing that decides what is actually rendered. Pure, so the rule that keeps a
 * scrolled reader in place is testable without a DOM.
 *
 * This is the ONE question both arrival paths reduce to: the head poll's splice and the sync
 * round's wholesale refetch of `['consolidated-feed']` look identical from here, which is what
 * lets FeedView compensate for both with a single mechanism instead of a per-writer callback.
 *
 * ⚠ `narrow` IS NOT OPTIONAL POLISH. The feed's window indexes the NARROWED list (the My Turn /
 * Claude / CI-lens / category / bot-lens / thread-state / needs-review pills), while the arrival
 * itself is raw server rows. Shifting the window by the raw count slides it past the reader's
 * anchor, and the scroll fix then pays for rows that were never rendered. Narrowing the arriving
 * PREFIX on its own is equivalent to narrowing the whole list and taking its prefix, because
 * every pill is a pure per-item predicate.
 *
 * ⚠ NO OVERLAP IS NOT "EVERYTHING IS NEW". Two lists sharing nothing mean a replacement — a gap
 * refetch, a scope re-key, a server-side window roll — and scrolling by a whole list's height is
 * the worst possible answer. That and "nothing landed above the head" both answer 0.
 */
export function countHeadArrivals<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
  narrow: (rows: T[]) => readonly T[],
): number {
  const head = prev[0]?.id;
  if (head == null || next.length === 0) return 0;
  const at = next.findIndex((i) => i.id === head);
  if (at <= 0) return 0;
  return narrow(next.slice(0, at)).length;
}

// AUTO-INSERT: poll the head of the feed for the SAME scope and PREPEND whatever is new into the
// loaded pages, in place. This replaces the old "↑ New activity — Refresh" banner outright —
// content is no longer withheld behind a click, and there is no cross-panel button to miss.
//
// Deliberately reuses the real feed builder so the head's inclusion logic (coalescing, caps,
// thread-addressing commits) matches the loaded feed EXACTLY — with real items now being spliced
// in rather than a single id compared, that parity is STRICTER than it was: a divergent
// `excludeBots` / `includeCiFailures` / `botWindowDays` would inject rows the loaded feed's own
// request would never have returned.
//
// ⚠ THE LIMIT IS FEED_PAGE_SIZE, NOT 1, AND THAT IS THE CONTIGUITY GUARANTEE, not a bigger
// appetite: the server folds the whole stream either way (`counts`/`uncappedTotal` are
// whole-stream facets), so the limit costs payload, not query work — and a head as wide as page 0
// is what makes `planFeedHeadMerge` able to prove the two lists overlap instead of guessing.
//
// Cadence: 60s, visibility-gated (`refetchIntervalInBackground: false`), so it idles when nobody
// is looking and a reader returning from a backgrounded tab gets ONE batch covering the whole
// absence — which is exactly one "new" cohort, the way the marker wants it.
//
// ⚠ REACT QUERY HAS NO PER-PAGE REFETCH — `refetch()` on an infinite query refetches EVERY page
// and replaces the whole list under the reader. So the merge is a `setQueryData` that touches
// page 0 only and leaves the tail alone.
export function useFeedAutoInsert(opts: {
  // MUST be the same workspace the loaded feed was fetched under — this hook WRITES INTO that
  // feed's cache entry, so a head from another scope would splice foreign rows into it.
  workspaceId: number | null;
  repoIds: number[] | null;
  userIds: number[] | null;
  excludeBots?: boolean;
  allowedBotIds?: number[];
  prId?: number | null;
  botsOnly?: boolean;
  botWindowDays?: number | null;
  includeAllCommits?: boolean;
  includeCiFailures?: boolean;
  // Off for every non-cross-repo mount (per-repo console, the Bots pane's bot-only feed, a
  // person's activity tab). Those surfaces are narrowed views someone opened on purpose, not
  // "the feed" being kept current, and they carry no "new" marker to go with an insert.
  enabled?: boolean;
  // Called SYNCHRONOUSLY, while the DOM still shows the PRE-INSERT list — the last moment a
  // scroll anchor can be measured, without which every insert shoves the reader's card down the
  // page. It carries NO count and expects no work beyond that measurement.
  //
  // ⚠ THERE IS NO `onInserted` COUNTERPART, AND THIS ONE DECIDES NOTHING, ON PURPOSE. This is not
  // the only way rows reach the feed — `SyncStatus.invalidateData()` sweeps the
  // `['consolidated-feed']` prefix on every sync round, which refetches EVERY loaded page and
  // replaces the list wholesale, with no callback at all. Anything keyed to THIS path — the "New"
  // cohorts, the window shift, the scroll fix — would be missing for exactly the arrivals the
  // reader is most likely to get, and which path won the race would decide the outcome. FeedView
  // diffs the committed item list instead (countHeadArrivals), so both paths are one rule.
  onBeforeInsert: () => void;
}): { scopeKey: string } {
  const qc = useQueryClient();
  const search = feedSearch(
    opts.workspaceId,
    opts.repoIds,
    opts.userIds,
    opts.excludeBots ?? false,
    opts.allowedBotIds ?? [],
    opts.prId ?? null,
    opts.botsOnly ?? false,
    opts.botWindowDays ?? null,
    opts.includeAllCommits ?? false,
    opts.includeCiFailures ?? false,
  );
  const wsKey = workspaceKey(opts.workspaceId);
  const enabled = (opts.enabled ?? true) && opts.workspaceId != null;
  const head = useQuery<ConsolidatedFeedResponse>({
    queryKey: ['feed-head', wsKey, search],
    queryFn: () => {
      const p = new URLSearchParams(search);
      p.set('limit', String(FEED_PAGE_SIZE));
      p.set('offset', '0');
      return api.consolidatedFeed(p.toString());
    },
    enabled,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });

  // The callbacks reach into live DOM measurements, so they are re-created every render. Held in
  // refs so the merge effect can depend on the head response ALONE — an effect that re-ran on
  // every parent render would re-enter the merge mid-scroll.
  const beforeRef = useRef(opts.onBeforeInsert);
  beforeRef.current = opts.onBeforeInsert;

  const headData = head.data;
  useEffect(() => {
    if (!enabled || headData == null) return;
    const key = ['consolidated-feed', wsKey, search];
    const cached = qc.getQueryData<InfiniteData<ConsolidatedFeedResponse>>(key);
    // Nothing loaded yet (initial fetch in flight, or a re-key whose page 0 hasn't landed).
    // Page 0 is about to arrive WITH these items in it — there is nothing to merge into.
    if (cached == null || cached.pages.length === 0) return;
    const loaded = new Set<string>();
    for (const pg of cached.pages) for (const it of pg.items) loaded.add(it.id);
    const plan = planFeedHeadMerge(
      headData.items.map((it) => it.id),
      loaded,
    );
    if (plan.verdict === 'none') return;
    if (plan.verdict === 'gap') {
      // More than a page landed at once — refetch rather than splice a hole into the stream.
      void qc.invalidateQueries({ queryKey: key });
      return;
    }
    const insert = headData.items.slice(0, plan.insert.length);
    // Measure BEFORE the cache write — the next line is what moves the DOM.
    beforeRef.current();
    qc.setQueryData<InfiniteData<ConsolidatedFeedResponse>>(key, (prev) => {
      if (prev == null || prev.pages.length === 0) return prev;
      const [first, ...rest] = prev.pages as [ConsolidatedFeedResponse, ...ConsolidatedFeedResponse[]];
      const seen = new Set<number>();
      const users = [...headData.users, ...first.users].filter((u) => {
        if (seen.has(u.id)) return false;
        seen.add(u.id);
        return true;
      });
      return {
        ...prev,
        pages: [
          {
            ...first,
            items: [...insert, ...first.items],
            users,
            // The head is a FRESH whole-stream fold at the same scope, so its total/facets
            // describe the stream the loaded pages are now a prefix of. `getNextPageParam`
            // compares the loaded count against `pages[0].total`, and both just grew by the
            // same N — keep them from the same fold or "Load more" stops N items early.
            total: headData.total,
            uncappedTotal: headData.uncappedTotal,
            counts: headData.counts,
            generatedAt: headData.generatedAt,
          },
          ...rest,
        ],
      };
    });
  }, [headData, enabled, qc, wsKey, search]);

  // The scope the "new" markers belong to (see FeedNewCohorts in store/filters.ts). Spelled from
  // the SAME two parts as the query key, so a lens flip or a workspace switch discards markers
  // that describe a stream nobody is looking at any more.
  return { scopeKey: `${wsKey}|${search}` };
}
