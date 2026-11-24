import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

// THE TEAM POLICY (docs/TEAM-POLICY.md): each member repo's `.ensemble/policy.json` as sync read it,
// and whether this copy applies policies. DB only on the server; it moves with sync and the licence,
// so a slow refresh is enough. A licence write (useLicenceAction) invalidates it: a new key or the
// evaluation changes whether policies apply.
export function useTeamPolicy(workspaceId: number | null) {
  return useQuery({
    queryKey: ['team-policy', `ws:${workspaceId ?? 'none'}`],
    queryFn: () => api.teamPolicy(workspaceId!),
    enabled: workspaceId != null,
    staleTime: 5 * 60_000,
  });
}
