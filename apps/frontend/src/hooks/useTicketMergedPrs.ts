import { useQuery } from '@tanstack/react-query';
import { create } from 'zustand';
import { TICKET_MERGED_PRS_MAX_KEYS, type TicketMergedPrsResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Open PRs ticket stacks' "Merged (n)" panel: ONE request for every stack on the board (never
// one per stack), only where the workspace has a tracker (core, free — the caller passes
// `useTrackerOn`). DB-only on the server: the stored ticket
// rows joined to `pull_requests`, read on the workspace's Jira site.
//
// ⚠ `workspaceId === null` is "not resolved yet": no request until it is, and the key carries the
// `ws:<id>` segment like every scoped query.
export const TICKET_MERGED_PRS_KEY = ['ticket-merged-prs'] as const;

export function useTicketMergedPrs(workspaceId: number | null, keys: readonly string[], enabled: boolean) {
  const sorted = [...new Set(keys.map((k) => k.trim().toUpperCase()).filter((k) => k !== ''))]
    .sort()
    .slice(0, TICKET_MERGED_PRS_MAX_KEYS);
  return useQuery<TicketMergedPrsResponse>({
    queryKey: [...TICKET_MERGED_PRS_KEY, `ws:${workspaceId ?? 'none'}`, sorted.join(',')],
    queryFn: () => api.ticketMergedPrs(workspaceId as number, sorted),
    enabled: enabled && workspaceId != null && sorted.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// Which stacks have their "Merged (n)" panel OPEN. Collapsed by default; remembered for the
// session only (in memory, never storage or the URL) — so leaving the tab and coming back keeps
// it, and a reload starts collapsed again.
interface MergedPanelState {
  open: ReadonlySet<string>;
  toggle: (stackId: string) => void;
}

export const useMergedPanelOpen = create<MergedPanelState>((set, get) => ({
  open: new Set<string>(),
  toggle: (id) => {
    const next = new Set(get().open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ open: next });
  },
}));
