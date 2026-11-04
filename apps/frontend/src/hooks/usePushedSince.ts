import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';

/** Every commit a Pending "Pushed since" card counts. ⚠ `enabled` only while the reader has the
 *  card's disclosure OPEN — nothing on the Pending board may fetch on mount. */
export function usePushedSinceCommits(workspaceId: number | null, prId: number, open: boolean) {
  return useQuery({
    queryKey: ['pushed-since-commits', `ws:${workspaceId}`, prId],
    queryFn: () => api.pushedSinceCommits(workspaceId!, prId),
    enabled: open && workspaceId != null,
    staleTime: 30_000,
  });
}
