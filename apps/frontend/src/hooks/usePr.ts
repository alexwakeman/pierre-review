import { useQuery } from '@tanstack/react-query';
import type {
  MentionCandidate,
  PrDetail,
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
// only when the lean feed reports a newer updatedAt. (Explicit invalidations —
// mark-viewed, etc. — still force a refetch regardless of staleTime.)
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
export function usePrFiles(id: number | null) {
  return useQuery<PrFilesResponse>({
    queryKey: ['pr-files', id],
    queryFn: () => api.prFiles(id as number),
    enabled: id != null,
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
}
