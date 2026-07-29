import { useQuery } from '@tanstack/react-query';
import type { BranchStatusResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useFilters } from '../store/filters.js';
import { ACTIVITY_GC_TIME } from './useActivity.js';

/**
 * Default-branch status for the repos currently in scope.
 *
 * Scope mirrors `useActivity` EXACTLY — team scope 'all' means "every repo the account
 * watches" (the server resolves it), anything else passes the FilterBar-resolved `repoIds`.
 * Reading the same two store fields is what makes a team/repo change re-scope this strip in
 * the same render as the rest of the console.
 *
 * `repoIds` rides in the query key (as a stable joined string, so array identity churn doesn't
 * refetch), and the retention matches the Activity queries: the console unmounts on every tab
 * switch, so a short gcTime would mean a cold skeleton every time you come back.
 *
 * Informational only. Nothing here is allowed to feed attention counts, the rail sort, My Turn,
 * or the `/api/me` badge — trunk being red is a readout, not a new alert channel.
 */
export function useBranchStatus(repoIdsOverride?: number[] | null) {
  const teamScope = useFilters((s) => s.teamScope);
  const filterRepoIds = useFilters((s) => s.repoIds);
  const scoped =
    repoIdsOverride !== undefined
      ? repoIdsOverride
      : teamScope === 'all'
        ? null
        : filterRepoIds;
  const key = scoped == null ? '' : [...scoped].sort((a, b) => a - b).join(',');
  return useQuery<BranchStatusResponse>({
    queryKey: ['branch-status', key],
    queryFn: () => api.branchStatus(scoped),
    // A snapshot of already-synced rows, like the rest of the Activity console: it refreshes
    // when a sync invalidates it, not on a timer of its own.
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    placeholderData: (prev) => prev,
  });
}
