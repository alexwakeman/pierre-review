import { skipToken, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type {
  BotFlaggingCluster,
  BotFlaggingComment,
  BotFlaggingRefine,
  BotFlaggingResponse,
  BotFlaggingSelector,
  BotWindowKind,
  SeverityAgreementMatrix,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { refineQueryKey, selectorQueryKey } from '../lib/severityAgreement.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';
import { useProCapabilities } from './useTriage.js';

// PAID (`botDepth`). `GET /api/bot-analytics/flagging` 402s without it, and the gate is AND-ed into
// `enabled` INSIDE this hook rather than left to the caller — this is an infinite query whose
// `fetchMore` fires from an IntersectionObserver sentinel, so an unentitled mount that survived a
// live entitlement change (a plan downgrade, /api/me refetching after `PRO_DIGEST_ENABLED` flips)
// would 402 on every scroll tick against the 60/min `search` bucket and rate-limit the free
// surfaces sharing the screen. Precedent: `useBotBehaviour`, useBotTriage.ts.
//
// The "what the bots are flagging" drill-down: one paginated stream per (selector, refine) over
// the SAME window/workspace/repo triple the ML totals strip was measured at. Modelled on
// useSearchResults — one infinite query, pages flattened, the aggregate numbers taken from the
// FIRST page (they describe the whole population, not the loaded slice, and are stable across
// pages).
//
// ⚠ EVERY NUMBER HERE IS THE SERVER'S. `total` is the tile's count by construction (the server
// re-runs the strip's own scan and the same JS fold), and nothing on the client may re-derive it —
// notably `lib/botComments.ts`'s `pillOf`, which buckets praise BEFORE isSummary and would
// therefore disagree with the backend about a praise-flavoured walkthrough. `pillOf` is for
// display pills only.

// A cluster card is several comments tall, so the overlap selector pages in smaller batches; the
// comment selectors page at the feed's usual grain.
const OVERLAP_PAGE_SIZE = 10;
const COMMENT_PAGE_SIZE = 20;

/** The loaded items, discriminated exactly as the wire is — a comments page and a clusters page
 *  can never be mixed into one list. */
export type BotFlaggingItems =
  | { kind: 'comments'; items: BotFlaggingComment[] }
  | { kind: 'clusters'; items: BotFlaggingCluster[] };

export function useBotFlagging(p: {
  workspaceId: number | null;
  repoIds: number[] | null;
  window: BotWindowKind;
  selector: BotFlaggingSelector;
  refine: BotFlaggingRefine;
  enabled: boolean;
}): {
  items: BotFlaggingItems;
  /** The SELECTOR population — the number that equals the tile. undefined until the first page. */
  total: number | undefined;
  /** After `refine`; equals `total` when refine is empty. */
  filteredTotal: number | undefined;
  /** Ours-vs-vendor over the selector population, PRE-refine (so a cell never zeroes itself out
   *  once clicked). undefined until the first page. */
  matrix: SeverityAgreementMatrix | undefined;
  truncated: boolean;
  isLoading: boolean;
  isFetching: boolean;
  hasMore: boolean;
  fetchMore: () => void;
  isFetchingMore: boolean;
} {
  const { workspaceId, repoIds, window: windowKind, selector, refine, enabled } = p;
  const { botDepth } = useProCapabilities();
  const limit = selector.kind === 'overlap' ? OVERLAP_PAGE_SIZE : COMMENT_PAGE_SIZE;

  const qc = useQueryClient();
  const key = useMemo(
    () => [
      'bot-flagging',
      selectorQueryKey(selector),
      windowKind,
      workspaceKey(workspaceId),
      repoKeySlot(repoIds),
      refineQueryKey(refine),
    ],
    [selector, windowKind, workspaceId, repoIds, refine],
  );

  // Collapse a cached entry back to its FIRST page as this hook mounts. Pairs with
  // `refetchOnMount: true` below to bound what that costs: an infinite query refetches EVERY
  // loaded page, and one page here re-runs the strip's whole label scan (or the whole thread scan
  // + clustering), so a user who had scrolled ten pages would otherwise pay ten scans just for
  // reopening the tab. Nothing is lost — the overlay remounts scrolled to the top, so the deep
  // pages were about to be re-read from row one anyway.
  //
  // In a `useState` initializer rather than an effect ON PURPOSE: this must land BEFORE the query
  // observer subscribes (effects run after render), or the refetch it triggers is already the
  // expensive all-pages one. Idempotent, so StrictMode's double invoke is harmless.
  useState(() => {
    qc.setQueryData<{ pages: BotFlaggingResponse[]; pageParams: unknown[] }>(key, (d) =>
      d && d.pages.length > 1 ? { pages: d.pages.slice(0, 1), pageParams: d.pageParams.slice(0, 1) } : d,
    );
  });

  const query$ = useInfiniteQuery<BotFlaggingResponse>({
    // ⚠ SIX SLOTS, EACH ITS OWN SEGMENT. `workspaceKey` and `repoKeySlot` are IMPORTED (never
    // re-spelled inline — two hand-rolled spellings of the repo slot is how a repo-scoped and a
    // workspace-wide answer end up sharing one cache entry), and `selectorQueryKey` canonicalises
    // the severity arm so `['major','critical']` and `['critical','major']` are ONE entry.
    queryKey: key,
    initialPageParam: null as string | null,
    // `skipToken`, not a bare `enabled`: it NARROWS `workspaceId` to a number, so a request with
    // no workspace — which the server answers from the account's DEFAULT — cannot be written.
    queryFn:
      workspaceId == null
        ? skipToken
        : ({ pageParam }) =>
            api.botFlagging({
              selector,
              refine,
              window: windowKind,
              workspaceId,
              repoIds,
              limit,
              // OPAQUE — handed back exactly as the server issued it, never parsed here.
              cursor: pageParam as string | null,
            }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && botDepth,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    // ⚠ `refetchOnMount: false` WAS WRONG HERE, in a way that broke this feature's one promise.
    // In query-core v5 `shouldFetchOnMount` short-circuits on `data !== undefined && refetchOnMount
    // !== false` BEFORE consulting staleness — so `false` suppresses the mount refetch outright,
    // staleTime notwithstanding. Two consequences, both reachable: App.tsx renders this overlay
    // only while its tab is active, so leaving and returning is a real unmount/remount onto the
    // still-cached entry, and the caption would keep reporting a total the tile had since moved
    // past (the tile itself polls every 5 min). Worse, `bot-flagging` sits in
    // RECLASSIFY_INVALIDATE_KEYS, but this query is ALWAYS inactive when a reclassify fires (one
    // board mounts at a time) — invalidation only marks an inactive query, and the suppressed
    // mount refetch then swallowed it, so "Not a bot" silently failed to change the population.
    // Left at the default, an invalidated-or-stale entry refetches on mount and both paths heal.
    refetchOnMount: true,
    placeholderData: (prev) => prev,
  });

  const pages = query$.data?.pages;
  const first = pages?.[0];

  const items = useMemo((): BotFlaggingItems => {
    // Before the first page lands, the SELECTOR already says which shape is coming — so an empty
    // overlap stream reports `clusters`, not a comments list that happens to be empty.
    if (!pages || pages.length === 0) {
      return selector.kind === 'overlap'
        ? { kind: 'clusters', items: [] }
        : { kind: 'comments', items: [] };
    }
    // Flatten by the pages' OWN discriminator rather than the selector's, so a page of the other
    // shape (only reachable mid-flight, since the selector rides the query key) can never be
    // spliced into the list.
    const kind = pages[0]?.kind;
    if (kind === 'clusters') {
      return {
        kind: 'clusters',
        items: pages.flatMap((pg) => (pg.kind === 'clusters' ? pg.items : [])),
      };
    }
    return {
      kind: 'comments',
      items: pages.flatMap((pg) => (pg.kind === 'comments' ? pg.items : [])),
    };
  }, [pages, selector.kind]);

  return {
    items,
    total: first?.total,
    filteredTotal: first?.filteredTotal,
    matrix: first?.matrix,
    truncated: first?.truncated ?? false,
    isLoading: query$.isLoading,
    isFetching: query$.isFetching,
    hasMore: query$.hasNextPage,
    fetchMore: () => void query$.fetchNextPage(),
    isFetchingMore: query$.isFetchingNextPage,
  };
}
