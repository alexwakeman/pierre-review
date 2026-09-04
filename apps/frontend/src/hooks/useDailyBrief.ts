import { skipToken, useQuery } from '@tanstack/react-query';
import type { DailyBriefResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The daily brief (plan P3.1/P3.3) — CORE/free counts for the Feed's BriefStrip. Always asks for
// the roll-up too: the server returns it only when the account has other workspaces, each ROLL-UP
// line riding the fold's server-side 5-min TTL cache, so the extra flag is one bounded loop of
// cache hits — not a second request the strip would have to orchestrate. (The ACTIVE workspace's
// own counts are not cached server-side — see the cadence note below.)
//
// `skipToken` while the workspace is unresolved (the workspaceId-null rule: nothing renders
// workspace-scoped data against a guessed scope). Query key carries `ws:<id>` per §8.12.
export function useDailyBrief(workspaceId: number | null) {
  return useQuery<DailyBriefResponse>({
    queryKey: ['daily-brief', workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.dailyBrief(workspaceId, true),
    // ⚠ THE BOARD'S CADENCE, NOT ITS OWN (mirrors useAttentionCards exactly). This response's
    // `myTurn` IS the my_turn card count GET /api/attention serves, and the strip's click opens
    // that board — so two different lifetimes on the two keys is two snapshots of one fold, and
    // the user sees the difference as a headline the click contradicts. The server now computes
    // these counts FRESH (db/daily-brief.ts: only the bot-anomaly slice is cached), so unlike
    // before, a refetch here really re-reads the fold instead of re-downloading a TTL'd answer —
    // which is what makes a shorter staleTime worth anything. Both keys are also swept together
    // by ACTIVITY_QUERY_KEYS when a sync lands, so the two refresh IN PHASE rather than drifting.
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
    // In lockstep with `useAttentionCards` (see its note): the app-wide default is
    // `refetchOnWindowFocus:false`, and this is one of the three keys that opt back IN together.
    // The strip's `myTurn` IS the board's `shown` denominator, so a focus that refreshed one and
    // not the other would put a stale count over a fresh list.
    refetchOnWindowFocus: true,
  });
}
