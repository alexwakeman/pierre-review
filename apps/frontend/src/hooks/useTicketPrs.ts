import { skipToken, useQuery } from '@tanstack/react-query';
import { SPRINT_READ_INTERVAL_MS, type TicketPrsResponse, type TicketStoryResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

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

// The story view's second read (GET /api/ticket-story, core + FREE): the ticket's stored sprint text and
// its CURRENT brief — what gives a ticket with no pull request its header, its story and its summary.
// DB-only. The sprint refresh invalidates it (`['ticket-story', ws:<id>]`, hooks/useSprintStories.ts).
export function useTicketStory(workspaceId: number | null, ident: string | null) {
  return useQuery<TicketStoryResponse>({
    queryKey: ['ticket-story', workspaceKey(workspaceId), ident],
    queryFn: workspaceId == null || ident == null ? skipToken : () => api.ticketStory(workspaceId, ident),
    // A pending brief lands after the next sprint read's brief pass: look again each minute. 'off' (no
    // agentic AI here) never moves. Anything else moves only with a sprint read — a manual refresh
    // invalidates this key, and the worker reads every SPRINT_READ_INTERVAL_MS, so look that often.
    refetchInterval: (q) => {
      const s = q.state.data?.briefState;
      return s === 'pending' ? 60_000 : s === 'off' ? false : SPRINT_READ_INTERVAL_MS;
    },
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
