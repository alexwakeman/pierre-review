import { useQuery } from '@tanstack/react-query';
import { TICKET_LINKS_MAX_PRS, type TicketLinksResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Open PRs cards' ticket row: ONE request for every listed card (never one per card), Pro
// `issueLinks` only — the caller ANDs the capability into `enabled`, so an unentitled account never
// asks (the route would 402 / 404). The server caches Jira titles; while it reports
// `titlesComplete: false` (its per-request Jira budget ran out) this asks again until it is done.
export const TICKET_LINKS_KEY = ['ticket-links'] as const;

export function useTicketLinks(prIds: readonly number[], enabled: boolean) {
  const ids = [...new Set(prIds)].sort((a, b) => a - b).slice(0, TICKET_LINKS_MAX_PRS);
  return useQuery<TicketLinksResponse>({
    queryKey: [...TICKET_LINKS_KEY, ids.join(',')],
    queryFn: () => api.ticketLinks(ids),
    enabled: enabled && ids.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
    refetchInterval: (q) => (q.state.data != null && !q.state.data.titlesComplete ? 3000 : false),
  });
}
