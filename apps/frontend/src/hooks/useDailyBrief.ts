import { skipToken, useQuery } from '@tanstack/react-query';
import type { DailyBriefResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The daily brief (plan P3.1/P3.3) — CORE/free counts for the Feed's BriefStrip. Always asks for
// the roll-up too: the server returns it only when the account has other workspaces, each line
// riding the fold's own server-side 5-min TTL cache, so the extra flag is one bounded loop of
// cache hits — not a second request the strip would have to orchestrate.
//
// `skipToken` while the workspace is unresolved (the workspaceId-null rule: nothing renders
// workspace-scoped data against a guessed scope). Query key carries `ws:<id>` per §8.12.
export function useDailyBrief(workspaceId: number | null) {
  return useQuery<DailyBriefResponse>({
    queryKey: ['daily-brief', workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.dailyBrief(workspaceId, true),
    // The server folds behind a 5-min TTL; a shorter client staleTime would only re-download
    // the same cached answer. Refetch on mount after that window keeps a morning tab honest.
    staleTime: 5 * 60_000,
  });
}
