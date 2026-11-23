import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LicenceStatusResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// THE LICENCE STATUS (docs/LICENSING.md): one query, read by Settings → Licence and the reminder
// toast. DB only on the server, so a slow refresh is enough: the colleague count moves with sync.
export const LICENCE_QUERY_KEY = ['licence'] as const;

export function useLicenceStatus() {
  return useQuery({
    queryKey: LICENCE_QUERY_KEY,
    queryFn: () => api.licence(),
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
  });
}

/** Every licence write answers with the new status: put it straight into the cache. */
export function useLicenceAction<A>(fn: (arg: A) => Promise<LicenceStatusResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (status) => qc.setQueryData(LICENCE_QUERY_KEY, status),
  });
}
