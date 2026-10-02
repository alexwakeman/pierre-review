import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MentionCandidate,
  PrDetail,
  PrFileContentResponse,
  PrFileFullDiffResponse,
  PrFilesResponse,
  SuggestedReviewersResponse,
  ThreadDetail,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// 45 minutes. Detail carries the bulky hydrated TEXT (bodies, diff hunks); a
// 7-day in-memory gcTime meant every PR/thread/file-diff opened in a session
// stayed resident forever — and got walked by every dehydrate/serialize pass to
// IndexedDB — so a long-lived tab steadily accumulated memory + GC pressure (a
// contributor to the OS-level jank on a board that's been open for hours).
// Evicting inactive detail after 45 min bounds the working set; cross-session
// reuse still comes from the IndexedDB persist layer (lib/queryPersist.ts), which
// re-hydrates a re-opened PR on demand.
// Exported so ThemeThreadsDetail's metrics fold can register byte-identical ['pr', id] queries
// (same key, same staleTime/gc) that DEDUPE against each group's own usePr instead of forking
// the cache policy.
export const DETAIL_GC_TIME = 1000 * 60 * 45;

// PR / thread detail carries the bulky text that, in cloud mode, is hydrated on
// demand from GitHub and persisted to IndexedDB (see lib/queryPersist.ts). We mark
// it `staleTime: Infinity` so an already-fetched detail is NEVER refetched on its
// own — unchanged text is served from the browser with zero network. Freshness is
// driven instead by useDetailCacheReconciler(), which invalidates a PR's detail
// when the lean feed reports a newer updatedAt, or a different CI rollup from a
// feed fetched after the detail (ciDetailOutdated) — CI moves without bumping
// updatedAt. (Explicit invalidations — mark-viewed, every PR write through
// invalidateAfterPrWrite, etc. — still force a refetch regardless of staleTime.)
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

// @mention candidates for a PR, ranked by proximity (see getMentionCandidates).
// Powers the MentionTextarea autocomplete; cached ~5 min per PR since the roster
// changes slowly relative to a composing session.
export function useMentionCandidates(prId: number | null) {
  return useQuery<MentionCandidate[]>({
    queryKey: ['mention-candidates', prId],
    queryFn: () => api.mentionCandidates(prId as number),
    enabled: prId != null,
    staleTime: 1000 * 60 * 5,
    gcTime: DETAIL_GC_TIME,
  });
}

// Suggested reviewers — a LIVE query, deliberately its own key (`['suggested-reviewers', id]`)
// so it's NOT persisted to IndexedDB (only 'pr'/'thread'/'pr-files' are; see main.tsx) and
// never freezes with the detail. Short staleTime so it reflects current state (it empties the
// moment a reviewer is requested — the assign mutation invalidates this key). Only fetched
// when the PR is selected AND on the Overview tab (ChecksTab), where the "Suggested" row lives.
export function useSuggestedReviewers(id: number | null, enabled = true) {
  return useQuery<SuggestedReviewersResponse>({
    queryKey: ['suggested-reviewers', id],
    queryFn: () => api.suggestedReviewers(id as number),
    enabled: id != null && enabled,
    staleTime: 1000 * 60 * 2,
    gcTime: DETAIL_GC_TIME,
  });
}

// The Changes-tab file diffs are hydrated on demand and persisted to IndexedDB
// (same staleTime/gc policy as PR detail).
//
// ⚠ …AND THEY FOLLOW THE PR'S HEAD, NOT THE WRITE SET. Nothing else ever refetches this key, so
// after a push (the conflict resolver, AI Fix, Update branch, or a commit made anywhere else) the
// tab went on showing the old patches for the whole session while the header moved on. Every
// one of those paths ends in a fresh `['pr', id]` read, so the rule sits here, once: when the
// detail was read AFTER the diff and names a different head, refetch the diff
// (`prFilesOutdated`). A reply or a resolve does not move the head, so it re-reads nothing — which
// is why `['pr-files', id]` is deliberately NOT in `invalidateAfterPrWrite`'s set.
//
// `usePr(id)` here adds an observer to a query the pane already holds (the Changes tab only
// mounts inside a loaded PrDetail), so it costs no request.
export function usePrFiles(id: number | null) {
  const qc = useQueryClient();
  const files = useQuery<PrFilesResponse>({
    queryKey: ['pr-files', id],
    queryFn: () => api.prFiles(id as number),
    enabled: id != null,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
  const detail = usePr(id);
  const detailAt = detail.dataUpdatedAt;
  const outdated =
    id != null &&
    files.data != null &&
    detail.data != null &&
    prFilesOutdated(
      { headSha: files.data.headSha, at: files.dataUpdatedAt },
      { headSha: detail.data.headSha, at: detailAt },
    );
  const fetching = files.isFetching;
  // Once per detail read: a refetch that FAILS keeps the old diff and its old timestamp, so without
  // this the effect would re-fire every time the failed fetch settled.
  const firedFor = useRef(0);
  useEffect(() => {
    if (!outdated || fetching || id == null || firedFor.current === detailAt) return;
    firedFor.current = detailAt;
    void qc.invalidateQueries({ queryKey: ['pr-files', id], exact: true });
  }, [outdated, fetching, id, detailAt, qc]);
  return files;
}

/**
 * "Load next 100 files" — the Changes tab's later pages, page 2 onward. CLICK-GATED: nothing is
 * fetched until `loadMore()` is called, and each later call is one more page (one GitHub call).
 *
 * ⚠ A SEPARATE KEY FROM `['pr-files', id]`, NOT AN INFINITE QUERY OVER IT. That key's data is
 * persisted to IndexedDB and read as a plain `PrFilesResponse` by PrDetail and ClaudeReviewTab;
 * turning it into `InfiniteData` would hand every persisted blob and both readers a shape they do
 * not expect, and this app has no error boundary. So page 1 stays where it was and the rest live
 * here, keyed on the head page 1 was read at — a push that refetches page 1 starts these over —
 * and deliberately NOT persisted (`main.tsx`'s allowlist), so a reload asks again.
 */
export function usePrMoreFiles(id: number | null, first: PrFilesResponse | undefined) {
  const startPage = first?.nextPage ?? null;
  const headKey = first?.headSha ?? null;
  const keyStr = `${id}:${headKey}:${startPage}`;
  // Armed for ONE key: a head move re-keys the query and must not fetch on its own.
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const query = useInfiniteQuery<PrFilesResponse>({
    queryKey: ['pr-files-more', id, headKey, startPage],
    queryFn: ({ pageParam }) => api.prFilesPage(id as number, pageParam as number),
    initialPageParam: startPage ?? 2,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled: id != null && startPage != null && armedFor === keyStr,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
  const { fetchNextPage, hasNextPage, isFetching, refetch } = query;
  const hasPages = (query.data?.pages.length ?? 0) > 0;
  const armed = armedFor === keyStr;
  const loadMore = useCallback(() => {
    if (!armed) {
      setArmedFor(keyStr);
      return;
    }
    if (isFetching) return;
    // The FIRST page failed: an infinite query with no pages reports `hasNextPage === false`, so
    // `fetchNextPage` would never run again and the button would be dead until a reload. Retry it.
    if (!hasPages) void refetch();
    else if (hasNextPage) void fetchNextPage();
  }, [armed, keyStr, hasPages, hasNextPage, isFetching, fetchNextPage, refetch]);
  const pages = useMemo(() => (armed ? (query.data?.pages ?? []) : []), [armed, query.data]);
  // Memoised: the Changes tab hands these to the memo'd FileDiffView, and a fresh array each
  // render would repaint every diff row.
  const files = useMemo(() => pages.flatMap((p) => p.files), [pages]);
  const last = pages[pages.length - 1];
  return {
    files,
    /** True while another page exists to ask for. */
    canLoadMore: startPage != null && (pages.length === 0 || last?.nextPage != null),
    /** GitHub's 3,000-file listing ceiling was reached: files exist past it that it will not list. */
    ceilingReached: (pages.length === 0 ? first?.ceilingReached : last?.ceilingReached) === true,
    loading: armed && isFetching,
    error: armed && query.isError,
    loadMore,
  };
}

/**
 * One file's raw lines at the PR head (or merge base), for a gap's expand arrows.
 * `enabled` is the CLICK: the block passes false until the reader asks. Keyed on the head the
 * diff was read at, so a push asks again. Not persisted.
 */
export function usePrFileContent(
  id: number | null,
  path: string,
  side: 'head' | 'base',
  headSha: string | null,
  enabled: boolean,
) {
  return useQuery<PrFileContentResponse>({
    queryKey: ['pr-file-content', id, headSha, side, path],
    queryFn: () => api.prFileContent(id as number, path, side),
    enabled: id != null && enabled,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
    retry: false,
  });
}

/** "Load full diff" for a file GitHub sent no patch for. Click-gated like the above. */
export function usePrFileFullDiff(
  id: number | null,
  path: string,
  previousPath: string | null,
  headSha: string | null,
  enabled: boolean,
) {
  return useQuery<PrFileFullDiffResponse>({
    queryKey: ['pr-file-diff', id, headSha, path, previousPath],
    queryFn: () => api.prFileFullDiff(id as number, path, previousPath),
    enabled: id != null && enabled,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
    retry: false,
  });
}

/**
 * Is a cached diff behind the PR? True when the PR detail was read AFTER the diff and names a
 * different head than the one the diff was read at. Pure.
 *
 * ⚠ THE TIME TEST IS WHAT MAKES IT SETTLE. The diff's head is the STORED head at its read, and
 * GitHub can be a push ahead of the database, so a diff can carry a head the detail has not
 * caught up with (or the reverse). Comparing heads alone would refetch forever; requiring the
 * detail to be the NEWER read means one refetch per detail read at most, after which the diff is
 * the newer one and this is false until the detail moves again.
 *
 * A diff with no head (`null`: no stored head, or GitHub failed and the diff is the empty
 * fallback; absent: cached before the field existed) refetches once a newer detail with a head
 * arrives. A detail with no head says nothing.
 */
export function prFilesOutdated(
  files: { headSha?: string | null; at: number },
  detail: { headSha: string | null; at: number },
): boolean {
  if (detail.headSha == null) return false;
  if (!(detail.at > files.at)) return false;
  return (files.headSha ?? null) !== detail.headSha;
}
