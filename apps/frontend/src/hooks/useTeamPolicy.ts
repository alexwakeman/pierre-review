import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.js';

// THE TEAM POLICY (docs/TEAM-POLICY.md): each member repo's `.ensemble/policy.json` as sync read it,
// and whether this copy applies policies. DB only on the server; it moves with sync and the licence,
// so a slow refresh is enough. A licence write (useLicenceAction) invalidates it: a new key or the
// evaluation changes whether policies apply.
/** Save the workspace's choice for when repositories' policies differ; the answer is the new state. */
export function useSetTeamPolicyClash(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: number | null) => api.setTeamPolicyClash(workspaceId!, repoId),
    onSuccess: (data) => qc.setQueryData(['team-policy', `ws:${workspaceId ?? 'none'}`], data),
  });
}

export function useTeamPolicy(workspaceId: number | null) {
  return useQuery({
    queryKey: ['team-policy', `ws:${workspaceId ?? 'none'}`],
    queryFn: () => api.teamPolicy(workspaceId!),
    enabled: workspaceId != null,
    staleTime: 5 * 60_000,
  });
}
