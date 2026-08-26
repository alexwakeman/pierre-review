import { useQuery } from '@tanstack/react-query';
import type { ActivityResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceScopeKey } from '../store/filters.js';

// Every query key that reflects the workspace-scoped Activity/Insights surface (rail aggregate,
// consolidated feed + its head poll, Pro digests, workspace insights, sprint report). Invalidate
// ALL of them whenever the scope's repo set changes (add a repo / move one between workspaces) or
// a sync lands, so the Activity console tracks its workspace live — no manual Refresh. These are
// all cheap DB reads (the AI summaries are GET-only here; regeneration is a separate, delta-gated
// action).
//
// They are PREFIXES, which is what makes them survive the workspace segment: every entry below is
// keyed `[name, 'ws:<id>', …]`, so invalidating `[name]` sweeps every workspace's slot rather than
// only the one on screen. Nothing here may narrow to a single workspace.
export const ACTIVITY_QUERY_KEYS = [
  'activity',
  'consolidated-feed',
  'feed-head',
  'repo-digests',
  'workspace-insights',
  'sprint-report',
  // The default-branch strip rides the same console, so a repo add / move / sync must re-scope
  // it alongside everything else.
  'branch-status',
  // ⚠ THESE TWO MUST STAY TOGETHER AND MUST STAY IN THIS LIST. They are one fold read twice:
  // 'daily-brief' carries the strip's "N items need your review or reply", 'attention-cards' is
  // the board that line CLICKS INTO, and both are getWorkspaceInsights over the same scope. Sweep
  // one without the other (or leave them out, as this list used to) and a sync that changes the
  // fold moves the list while the headline keeps the old number — the exact "5 items" over a
  // board of 3 the server-side cache split fixed. Invalidated here, they refetch IN PHASE.
  'attention-cards',
  'daily-brief',
] as const;

/**
 * THE WORKSPACE CACHE SEGMENT — one helper, so no two hooks spell it differently.
 *
 * Every workspace-scoped query key carries this string in its own slot. It is not decoration:
 * two workspaces sitting on `repoIds = null` build the SAME query string (each means "every repo
 * in MY workspace", which only the server can expand), so without a distinct key segment React
 * Query serves one workspace's data under the other's name, with no refetch and no error. The
 * request carrying `?workspace=` fixes the wire; only this fixes the cache.
 *
 * The format is NOT re-spelled here — it delegates to the store's `workspaceScopeKey`, which is
 * the one definition of `ws:<id>`. That prefix is the SAME vocabulary the Pro plugin persists in
 * `scope_key` (`scopeKeyFor(workspaceId)`, plugin migration 0020), so a cached AI answer and the
 * cache slot it renders into agree by construction, and a legacy `'3'` (team 3) can never alias
 * workspace 3.
 *
 * This wrapper exists only to widen the argument to `number | null`: the store's id starts null
 * and is filled once `useWorkspaces()` lands, and a not-yet-resolved query still needs a key.
 * `null` gets its own slot (`ws:pending`) so an idle, never-fetched query can never share an entry
 * with a resolved workspace.
 */
export function workspaceKey(workspaceId: number | null): string {
  return workspaceId == null ? 'ws:pending' : workspaceScopeKey(workspaceId);
}

/**
 * Build the /api/activity query string from the active workspace + repo + member scope.
 *
 * ⚠ `repoIds` IS EMITTED WHENEVER IT IS NON-NULL, INCLUDING WHEN EMPTY. The old builder wrote
 * `if (ids && ids.length > 0)`, which collapsed "narrow to nothing" into "no narrowing at all" —
 * under a workspace scope that is the difference between an empty selection and the whole
 * workspace. `null` still means "no narrowing"; the server expands it to the workspace's
 * membership, which is what makes an EMPTY workspace render empty instead of the whole account.
 *
 * ⚠ BOTH NARROWING ARGUMENTS ARE NULL FROM THE ONLY CALLER TODAY, AND THAT IS THE RULE, NOT AN
 * ACCIDENT. The Activity console covers the WHOLE active workspace: `filters.repoIds` is a
 * TIMELINE-board filter (its picker is unmounted on Activity) and `filters.userIds` is the
 * timeline's Members filter, so neither may reach this request. The parameters survive because the
 * route still supports them — a future surface that means to narrow may pass an EXPLICIT set, the
 * way `useBranchStatus` takes one — never the store's picker state.
 */
function activitySearch(
  workspaceId: number | null,
  repoIds: number[] | null,
  userIds: number[] | null,
): string {
  const p = new URLSearchParams();
  if (workspaceId != null) p.set('workspace', String(workspaceId));
  if (repoIds) p.set('repoIds', repoIds.join(','));
  if (userIds && userIds.length > 0) p.set('userIds', userIds.join(','));
  return p.toString();
}

// 45 minutes — matches usePr's DETAIL_GC_TIME. The Activity console (and the Bots sub-tab)
// UNMOUNTS on every tab switch (`{inboxActive && <ActivityView/>}` in App.tsx), so the moment
// you flip to the Timeline / a PR tab, these queries lose their only observer. At the default
// 5-min gcTime the cached snapshot is then evicted, so switching back after a short while hit a
// cold `isLoading` skeleton → refetch → a big first render. These are snapshots (staleTime
// Infinity / short-stale, invalidated explicitly on watch/add/sync), so a longer gcTime only
// keeps the already-fetched data resident across a working session's tab churn — never an extra
// refetch — and repeat opens repaint instantly from cache. Bounded + not IndexedDB-persisted, so
// abandoned scopes still evict after 45 min idle.
export const ACTIVITY_GC_TIME = 1000 * 60 * 45;

// The multi-repo triage aggregate backing the Activity tab. WORKSPACE (+ any explicit repo/member
// narrowing — see activitySearch; the console passes none) rides in the query key so a
// WorkspaceSelector change refetches. Snapshot intent — like the
// IndexedDB-cached PR/thread queries it's `staleTime: Infinity` + `refetchOnMount: false`, so
// opening the tab paints the cached snapshot instantly and only the rail header's
// "Refresh" re-pulls it (`query.refetch()`). `placeholderData: keep` keeps the previous
// data on screen while a refetch is in flight (dim, never blank).
//
// `workspaceId` is the FIRST parameter and is required (nullable, not optional): the store holds
// `number | null` until the workspaces query lands, and nothing workspace-scoped may render before
// then — so `null` DISABLES the fetch rather than silently asking the server for the Default.
export function useActivity(
  workspaceId: number | null,
  repoIds: number[] | null,
  userIds: number[] | null,
) {
  const search = activitySearch(workspaceId, repoIds, userIds);
  return useQuery<ActivityResponse>({
    queryKey: ['activity', workspaceKey(workspaceId), search],
    queryFn: () => api.inbox(search),
    enabled: workspaceId != null,
    staleTime: Infinity,
    gcTime: ACTIVITY_GC_TIME,
    refetchOnMount: false,
    placeholderData: (prev) => prev,
  });
}
