import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  DismissedMyTurnResponse,
  InsightsResponse,
  MeResponse,
  MyTurnResponse,
  OpenPrsResponse,
  ProCapabilities,
  RepoAnalytics,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { noteLargePrThreshold } from '../lib/ui.js';
import { buildOpenPrsSearch, useFilters } from '../store/filters.js';
import { workspaceKey } from './useActivity.js';

// The open-PR list is WORKSPACE-scoped: `buildOpenPrsSearch` emits `workspace=<id>` alongside the
// repo/member narrowing, and the key carries the same id in its own slot. Both halves are needed —
// the param fixes what the server returns, the key segment fixes which cache entry it lands in
// (two workspaces on `repoIds = null` build an identical query string).
//
// ⚠ THIS ONE IS FOR THE TIMELINE BOARD, and it is the reason it still honours `filters.repoIds`:
// the board is the surface the repo picker is mounted on and the surface it narrows. Every
// ACTIVITY surface must use `useWorkspaceOpenPrs` below instead.
export function useOpenPrs() {
  const search = useFilters(buildOpenPrsSearch);
  const workspaceId = useFilters((s) => s.workspaceId);
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', workspaceKey(workspaceId), search],
    queryFn: () => api.openPrs(search),
    enabled: workspaceId != null,
    placeholderData: (prev) => prev,
  });
}

// Open PRs for the TIMELINE's PR-title search index — ignores the member filter so search
// is global within the board's repo scope (see useSearchTimeline). Dedupes with useOpenPrs when no
// member filter is active (identical workspace + query string → shared cache entry).
//
// ⚠ TIMELINE-ONLY, like useOpenPrs: it keeps `filters.repoIds`. Its two callers are the board
// itself and the FilterBar's Members derivation, both of which are only rendered on the Timeline.
export function useSearchOpenPrs() {
  const search = useFilters((s) => buildOpenPrsSearch(s, false));
  const workspaceId = useFilters((s) => s.workspaceId);
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', workspaceKey(workspaceId), search],
    queryFn: () => api.openPrs(search),
    enabled: workspaceId != null,
    placeholderData: (prev) => prev,
  });
}

// Every open PR in the ACTIVE WORKSPACE — the ACTIVITY-side open-PR source (the Feed's open-PR
// panel, the isolation banner's PR lookup, the 'feed'-scoped drill-down).
//
// It exists because `useSearchOpenPrs` narrows by `filters.repoIds`, which is a TIMELINE-board
// filter: its picker is not mounted while Activity is the active tab, so an Activity list scoped
// by it would be silently short with no visible control to widen it. The isolation banner made
// that concrete — it resolves the isolated PR's title out of this list, and a picker set on the
// Timeline could hide the very PR the banner is naming.
//
// No `repoIds` and no `userIds`, so the query string is just `workspace=<id>` — which is BYTE-
// IDENTICAL to what `useSearchOpenPrs` builds whenever the picker is unset (the overwhelmingly
// common case), so the two share one cache entry and this costs no extra fetch. They only diverge
// into two fetches while the board is actually narrowed, which is exactly when they must.
//
// The builder is exported and pure so that byte-identity is PINNED by a test rather than asserted
// in this comment: it is exactly the kind of claim that drifts silently (both strings still work;
// you just quietly fetch the same list twice, forever).
export function workspaceOpenPrsSearch(workspaceId: number | null): string {
  const params = new URLSearchParams();
  if (workspaceId != null) params.set('workspace', String(workspaceId));
  return params.toString();
}

export function useWorkspaceOpenPrs() {
  const workspaceId = useFilters((s) => s.workspaceId);
  const search = workspaceOpenPrsSearch(workspaceId);
  return useQuery<OpenPrsResponse>({
    queryKey: ['open-prs', workspaceKey(workspaceId), search],
    queryFn: () => api.openPrs(search),
    enabled: workspaceId != null,
    placeholderData: (prev) => prev,
  });
}

// The DRILL-DOWN builder — the workspace plus an EXPLICIT repo narrowing (the open-PRs tab's
// repo/group scope). The narrowing is an ARGUMENT, never `filters.repoIds`: that is the Timeline
// board's picker (see workspaceOpenPrsSearch above for the two failure modes a store read invites).
//
// Two properties are load-bearing, both pinned by test/workspaceOpenPrsScope.test.ts:
//  • `repoIds == null` (workspace-wide) is BYTE-IDENTICAL to workspaceOpenPrsSearch, so the
//    unscoped drill-down shares the Activity surfaces' cache entry rather than re-fetching it.
//  • `workspace=` is ALWAYS kept alongside `repoIds`: `/api/open-prs` resolves the workspace from
//    `?workspace=` (absent ⇒ the account's DEFAULT) and returns membership ∩ repoIds, so a bare
//    `repoIds=<id>` comes back EMPTY for any repo the user moved into another workspace.
export function scopedOpenPrsSearch(
  workspaceId: number | null,
  repoIds: number[] | null,
): string {
  const params = new URLSearchParams();
  if (workspaceId != null) params.set('workspace', String(workspaceId));
  if (repoIds != null) params.set('repoIds', repoIds.join(','));
  return params.toString();
}

export function useScopedOpenPrs(repoIds: number[] | null) {
  const workspaceId = useFilters((s) => s.workspaceId);
  const search = scopedOpenPrsSearch(workspaceId, repoIds);
  return useQuery<OpenPrsResponse>({
    // The `ws:<id>` segment is NOT redundant with the `workspace=` param: the param fixes what the
    // server returns, the segment fixes which cache entry it lands in (two workspaces on the same
    // repo narrowing build the same string).
    queryKey: ['open-prs', workspaceKey(workspaceId), search],
    queryFn: () => api.openPrs(search),
    enabled: workspaceId != null,
    placeholderData: (prev) => prev,
  });
}

export function useMe() {
  // `retry: false` so a cloud-mode 401 (signed out) surfaces immediately to the
  // App auth gate instead of being retried.
  //
  // ACCOUNT-GRAINED KEY, deliberately: `['me']` carries no `ws:<id>` segment because nothing on
  // this response is workspace-scoped — the large-PR threshold included (it is one number per
  // account, set once in Settings).
  const q = useQuery<MeResponse>({ queryKey: ['me'], queryFn: api.me, retry: false });
  // ⚠ THE ONE WRITER of lib/ui.ts's large-PR threshold cell. `components/Timeline/prBar.ts`
  // builds raw HTML strings for vis-timeline, so it cannot call a hook to learn the account's
  // threshold; it reads that cell instead. App.tsx mounts `useMe()` at the root, so the cell is
  // seeded before any board paints, and every other `useMe()` caller re-writes the same value.
  const threshold = q.data?.largePrCodeLocThreshold;
  useEffect(() => {
    noteLargePrThreshold(threshold);
  }, [threshold]);
  return q;
}

// Premium capability flags (mirrors claudeReviewEnabled). All-false until /api/me
// loads and in OSS mode (no @pierre/pro plugin).
export function useProCapabilities(): ProCapabilities {
  return (
    useMe().data?.pro ?? {
      activityDigest: false,
      reviewMemory: false,
      aiAnalysis: false,
      prSummary: false,
      aiFix: false,
      workspaceInsights: false,
      claudeReview: false,
      slackDigest: false,
      issueLinks: false,
      botTriage: false,
      botAdvisor: false,
      periodReports: false,
      botDepth: false,
      workPlan: false,
    }
  );
}

export function useMyTurn() {
  return useQuery<MyTurnResponse>({ queryKey: ['my-turn'], queryFn: api.myTurn });
}

// Per-repo Insights stats. Respects the active repo filter (other filters don't
// apply — insights are a current-state snapshot). Only fetched while the panel is
// open (`enabled`), and kept fresh-ish on reopen.
//
// ⚠ `/api/insights` is deliberately NOT workspace-scoped server-side — its own route comment says
// it is "a per-repo snapshot the caller already names its repos for". That makes `repoIds: null`
// (which now means "every repo in the ACTIVE WORKSPACE") send nothing and widen to the whole
// ACCOUNT. It is currently harmless: this hook has NO importer anywhere in the SPA. Anything that
// revives it must pass an explicit, workspace-resolved repo id list rather than leaning on the
// store's null — and NOT `filters.repoIds`, which is a TIMELINE-board filter (Activity/Feed/Bots
// cover the whole workspace); this read of it is the last one left and survives only because
// nothing calls it.
export function useInsights(enabled: boolean) {
  const search = useFilters((s) =>
    s.repoIds && s.repoIds.length > 0 ? `repoIds=${s.repoIds.join(',')}` : '',
  );
  return useQuery<InsightsResponse>({
    queryKey: ['insights', search],
    queryFn: () => api.insights(search),
    enabled,
  });
}

// Heavier per-repo analytics for the drill-down chart panel. Fetched only when the
// panel is open for a specific repo; cached per repo.
export function useRepoAnalytics(repoId: number | null) {
  return useQuery<RepoAnalytics>({
    queryKey: ['repo-analytics', repoId],
    queryFn: () => api.repoAnalytics(repoId as number),
    enabled: repoId != null,
  });
}

// The "Done" tab — completed (dismissed) entries, past 90 days. Only fetched when
// the tab is active (`enabled`).
export function useMyTurnDone(enabled: boolean) {
  return useQuery<DismissedMyTurnResponse>({
    queryKey: ['my-turn-done'],
    queryFn: api.myTurnDone,
    enabled,
  });
}
