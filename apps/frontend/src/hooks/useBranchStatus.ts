import { useQuery } from '@tanstack/react-query';
import type { BranchStatusResponse } from '@pierre-review/shared';
import { useFilters } from '../store/filters.js';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

/**
 * Build the /api/branch-status query string — the fifth and last of the WORKSPACE-scoped content
 * routes (activity / feed / timeline / open-prs / branch-status), and it follows their two rules
 * exactly:
 *
 *  • `workspace=<id>` is always sent once resolved. `repoIds` alone cannot express the scope: two
 *    workspaces both on `repoIds = null` produce the same string, and an EMPTY workspace sends no
 *    ids at all — which used to render the whole ACCOUNT's trunk strip.
 *  • `repoIds` is emitted whenever it is NON-NULL, including when EMPTY. `null` means "no
 *    narrowing" (the server expands it to the workspace's membership); an empty array is a real
 *    narrowing and dropping it is what turned "nothing selected" into "everything". It now only
 *    ever arrives as an EXPLICIT caller argument — see the hook below.
 */
function branchStatusSearch(workspaceId: number | null, repoIds: number[] | null): string {
  const p = new URLSearchParams();
  if (workspaceId != null) p.set('workspace', String(workspaceId));
  // Sorted so a caller rebuilding the id list in a different order (or a fresh array each render)
  // yields the SAME string — the key is the string, and churn there is a refetch.
  if (repoIds) p.set('repoIds', [...repoIds].sort((a, b) => a - b).join(','));
  return p.toString();
}

/**
 * Default-branch status for the repos currently in scope.
 *
 * Scope mirrors the rest of the Activity console: the active WORKSPACE, whole. The workspace comes
 * from the store — reading the same field the console reads is what makes a workspace change
 * re-scope this strip in the same render as everything around it, and it removes any way for a
 * caller-supplied workspace to disagree with the string it keys.
 *
 * ⚠ THE ONLY NARROWING IS THE ARGUMENT, AND IT IS ALWAYS EXPLICIT. This hook used to fall back to
 * the FilterBar's per-repo visibility (`filters.repoIds`) when no argument was given. That is a
 * TIMELINE-board filter — its picker is not even mounted while Activity is the active tab — so the
 * cross-repo trunk strip could sit silently narrowed with no visible control to widen it again.
 * `repoIds` here means what the CALLER pinned (RepoFeedHeader passes `[repo.repoId]` for the
 * per-repo console); omit it and you get the whole workspace, by construction.
 *
 * The `ws:<id>` key segment is NOT redundant with the `workspace=` param: the param fixes what the
 * server returns, the segment fixes which cache entry it lands in. Retention matches the Activity
 * queries — the console unmounts on every tab switch, so a short gcTime would mean a cold skeleton
 * every time you come back.
 *
 * Informational only. Nothing here is allowed to feed attention counts, the rail sort, My Turn,
 * or the `/api/me` badge — trunk being red is a readout, not a new alert channel.
 */
export function useBranchStatus(repoIds?: number[] | null) {
  const workspaceId = useFilters((s) => s.workspaceId);
  const search = branchStatusSearch(workspaceId, repoIds ?? null);
  return useQuery<BranchStatusResponse>({
    queryKey: ['branch-status', workspaceKey(workspaceId), search],
    queryFn: () => api.branchStatus(search),
    enabled: workspaceId != null,
    // A snapshot of already-synced rows, like the rest of the Activity console: it refreshes
    // when a sync invalidates it, not on a timer of its own.
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    placeholderData: (prev) => prev,
  });
}
