import { skipToken, useQuery } from '@tanstack/react-query';
import type { TicketPrsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The ticket tab's ONE read (GET /api/ticket-prs, core + FREE — no capability gate). DB-only on the
// server. Keyed by workspace AND ident, so the same ticket opened in two workspaces never shares a
// cache entry. A merge, comment or other PR write made here refreshes it through
// `invalidateAfterPrWrite` (hooks/prCacheSync.ts names this key); the 5-minute interval covers
// changes made elsewhere.
export function useTicketPrs(workspaceId: number | null, ident: string | null) {
  return useQuery<TicketPrsResponse>({
    queryKey: ['ticket-prs', `ws:${workspaceId}`, ident],
    queryFn: workspaceId == null || ident == null ? skipToken : () => api.ticketPrs(workspaceId, ident),
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
