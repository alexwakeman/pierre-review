import { skipToken, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type {
  BotVolumePrRow,
  BotVolumePrSort,
  BotVolumePrsResponse,
  BotVolumeResponse,
  BotVolumeScatterResponse,
  BotWindowKind,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';

// Bot comment VOLUME — "how much does each bot say on a PR" (CORE, free, deterministic).
//
// TWO hooks over the same server-side scan: `useBotVolume` backs the ROI table's per-bot average
// column, `useBotVolumePrs` backs the paginated PR drill-down behind it. They must be called with
// the SAME (workspaceId, window, repoIds) triple, which is why both take those three in the same
// positions and both spell their key slots with the IMPORTED `workspaceKey` / `repoKeySlot` — two
// hand-rolled spellings of the repo slot is how a repo-scoped answer and a workspace-wide one end
// up sharing one cache entry.
//
// ⚠ THE POPULATION IS PRs **MERGED** IN THE WINDOW. Open PRs are excluded — every caption written
// against these numbers has to say "merged" or it is wrong by ~45% on a busy repo.
//
// ⚠ NOTHING HERE RE-DERIVES A COUNT. The averages, the expectations and the ratios are the
// server's, folded once from one scan so the column and the list cannot contradict each other.

/** The drill-down's page size. Each PR row is one line plus a per-bot breakdown, so it pages at
 *  the comment-list grain rather than the cluster grain. */
const PR_PAGE_SIZE = 20;

/**
 * The per-bot volume aggregates for the ROI table's column.
 *
 * `enabled` lets the caller hold it back (the table renders without the column in states where the
 * analytics query itself has nothing). Same 60s staleness + long gcTime as the other Bots-rail
 * queries: the sub-tab unmounts on every rail switch, and at the default gcTime reopening would
 * repaint the column blank.
 */
export function useBotVolume(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotVolumeResponse>({
    queryKey: ['bot-volume', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    // `skipToken`, not a bare `enabled`: it NARROWS `workspaceId` to a number, so a request with
    // no workspace — which the server answers from the account's DEFAULT — cannot be written.
    queryFn:
      workspaceId == null ? skipToken : () => api.botVolume(window, workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    // ⚠ DELIBERATELY NO `refetchInterval`, unlike `useBotAnalytics`'s 5-minute sync-cadence poll.
    // This route walks every merged PR in the window plus three grouped comment counts over them,
    // which is why it sits on the 60/min `search` tier rather than the 600/min blanket one — a
    // background poll would spend that budget on a column nobody is watching. It refetches when
    // the scope or window changes and on mount, which is every moment it can be read.
    placeholderData: (prev) => prev,
  });
}

/**
 * The five LOC-bucket means behind the Behaviour tab's "PR size vs bot comment volume" card.
 *
 * Same shape and same reasoning as `useBotVolume` above — one scan, `search` tier, 60s staleness,
 * NO background poll — and deliberately the SAME (workspaceId, window, repoIds) triple, since the
 * card explains the very column that hook feeds.
 *
 * ⚠ NOT gated on `mlSeverity`. Bot comment volume is counted from stored comment rows; it needs no
 * severity-api and no model, so it renders on a deployment where the whole ML block is dark.
 */
export function useBotVolumeScatter(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotVolumeScatterResponse>({
    queryKey: ['bot-volume-scatter', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    queryFn:
      workspaceId == null ? skipToken : () => api.botVolumeScatter(window, workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    placeholderData: (prev) => prev,
  });
}

/**
 * The paginated PR drill-down. Modelled on `useBotFlagging`: one infinite query, pages flattened,
 * the aggregate numbers taken from the FIRST page (they describe the whole population, not the
 * loaded slice, and are stable across pages).
 */
export function useBotVolumePrs(p: {
  workspaceId: number | null;
  repoIds: number[] | null;
  window: BotWindowKind;
  sort: BotVolumePrSort;
  /** The bot narrowing. `null` widens to every bot; `[]` means NO bots and is a real state. */
  authorUserIds: number[] | null;
  enabled: boolean;
}): {
  items: BotVolumePrRow[];
  /** Merged-in-window PRs in scope — including the ones no bot touched. undefined until page 1. */
  total: number | undefined;
  /** PRs carrying ≥1 comment from the refined bot set — what the list actually enumerates. */
  filteredTotal: number | undefined;
  truncated: boolean;
  isLoading: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  isFetchingMore: boolean;
} {
  const { workspaceId, repoIds, window: windowKind, sort, authorUserIds, enabled } = p;

  const qc = useQueryClient();
  const key = useMemo(
    () => [
      'bot-volume-prs',
      windowKind,
      workspaceKey(workspaceId),
      repoKeySlot(repoIds),
      sort,
      // ⚠ The bot narrowing is part of the key, and `null` (every bot) must not collide with `[]`
      // (no bots) — they are opposite populations. Sorted so two spellings of one set share an
      // entry, the `repoKeySlot` rule.
      authorUserIds ? `bots:[${[...authorUserIds].sort((a, b) => a - b).join(',')}]` : 'bots:-',
    ],
    [windowKind, workspaceId, repoIds, sort, authorUserIds],
  );

  // Collapse a cached entry back to its FIRST page as this hook mounts. An infinite query
  // refetches EVERY loaded page, and one page here re-walks every merged PR in the window plus
  // three grouped comment counts over them (which is why all three volume routes sit on the
  // `search` rate tier) — so a reader who had scrolled ten pages would otherwise pay ten scans
  // just for reopening the tab. Nothing is lost: the overlay remounts scrolled to the top.
  //
  // In a `useState` initializer rather than an effect ON PURPOSE — this must land BEFORE the query
  // observer subscribes (effects run after render), or the refetch it triggers is already the
  // expensive all-pages one. Idempotent, so StrictMode's double invoke is harmless.
  useState(() => {
    qc.setQueryData<{ pages: BotVolumePrsResponse[]; pageParams: unknown[] }>(key, (d) =>
      d && d.pages.length > 1
        ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) }
        : d,
    );
  });

  const query$ = useInfiniteQuery<BotVolumePrsResponse>({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn:
      workspaceId == null
        ? skipToken
        : ({ pageParam }) =>
            api.botVolumePrs({
              window: windowKind,
              workspaceId,
              repoIds,
              authorUserIds,
              sort,
              limit: PR_PAGE_SIZE,
              // OPAQUE — handed back exactly as the server issued it, never parsed here.
              cursor: pageParam as string | null,
            }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    // ⚠ NOT `refetchOnMount: false`. In query-core v5 `shouldFetchOnMount` short-circuits on
    // `data !== undefined && refetchOnMount !== false` BEFORE consulting staleness, so `false`
    // suppresses the mount refetch outright, staleTime notwithstanding — and this overlay renders
    // only while its tab is active, so leaving and returning is a real unmount/remount onto the
    // still-cached entry. The same mistake silently swallowed reclassify invalidations on the
    // flagging drill-down. Left at the default, a stale-or-invalidated entry heals on mount.
    refetchOnMount: true,
    placeholderData: (prev) => prev,
  });

  const pages = query$.data?.pages;
  const first = pages?.[0];
  const items = useMemo(() => (pages ?? []).flatMap((pg) => pg.items), [pages]);

  return {
    items,
    total: first?.total,
    filteredTotal: first?.filteredTotal,
    truncated: first?.truncated ?? false,
    // ⚠ `isPlaceholderData` COUNTS AS LOADING. This query carries its previous pages across a key
    // change (`placeholderData: prev => prev`), and the key holds the SORT, the window and the bot
    // narrowing — so without this term a sort toggle leaves `isLoading` false and the page renders
    // the OLD ordering's rows underneath the NEW ordering's on-screen explanation, with
    // "Showing N of M" quoting the previous fold's totals. An ordering the screen describes but is
    // not actually showing is the exact failure the second sort exists to prevent.
    isLoading: query$.isLoading || query$.isPlaceholderData,
    hasMore: query$.hasNextPage,
    fetchMore: () => void query$.fetchNextPage(),
    isFetchingMore: query$.isFetchingNextPage,
  };
}
