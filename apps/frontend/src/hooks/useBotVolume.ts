import { skipToken, useQuery } from '@tanstack/react-query';
import type {
  BotVolumeResponse,
  BotVolumeScatterResponse,
  BotWindowKind,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';

// Bot comment VOLUME — "how much does each bot say on a PR" (deterministic).
//
// TWO hooks over the same server-side scan: `useBotVolume` backs the ROI table's per-bot average
// column, `useBotVolumeScatter` the PR-size chart in Workspace charts. They must be called with
// the SAME (workspaceId, window, repoIds) triple, which is why both take those three in the same
// positions and both spell their key slots with the IMPORTED `workspaceKey` / `repoKeySlot` — two
// hand-rolled spellings of the repo slot is how a repo-scoped answer and a workspace-wide one end
// up sharing one cache entry.
//
// ⚠ THE POPULATION IS PRs **MERGED** IN THE WINDOW. Open PRs are excluded — every caption written
// against these numbers has to say "merged" or it is wrong by ~45% on a busy repo.
//
// ⚠ NOTHING HERE RE-DERIVES A COUNT. The averages, the expectations and the ratios are the
// server's, folded once from one scan so the column and the chart cannot contradict each other.

/**
 * The per-bot volume aggregates for the ROI table's column.
 *
 * `enabled` lets the caller hold it back (the table renders without the column in states where the
 * analytics query itself has nothing). Same 60s staleness + long gcTime as the other Bots-rail
 * queries: the sub-tab unmounts on every rail switch, and at the default gcTime reopening would
 * repaint the column blank.
 */
export function useBotVolume(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotVolumeResponse>({
    queryKey: ['bot-volume', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    // `skipToken`, not a bare `enabled`: it NARROWS `workspaceId` to a number, so a request with
    // no workspace — which the server answers from the account's DEFAULT — cannot be written.
    queryFn:
      workspaceId == null ? skipToken : () => api.botVolume(window, workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    // ⚠ DELIBERATELY NO `refetchInterval`, unlike `useBotAnalytics`'s 5-minute sync-cadence poll.
    // This route walks every merged PR in the window plus three grouped comment counts over them,
    // which is why it sits on the 60/min `search` tier rather than the 600/min blanket one — a
    // background poll would spend that budget on a column nobody is watching. It refetches when
    // the scope or window changes and on mount, which is every moment it can be read.
    placeholderData: (prev) => prev,
  });
}

/**
 * The five LOC-bucket means behind the Behaviour tab's "PR size vs bot comment volume" card.
 *
 * Same shape and same reasoning as `useBotVolume` above — one scan, `search` tier, 60s staleness,
 * NO background poll — and deliberately the SAME (workspaceId, window, repoIds) triple, since the
 * card explains the very column that hook feeds.
 *
 * ⚠ NOT gated on `mlSeverity`. Bot comment volume is counted from stored comment rows; it needs no
 * severity-api and no model, so it renders on a deployment where the whole ML block is dark.
 */
export function useBotVolumeScatter(
  workspaceId: number | null,
  window: BotWindowKind,
  enabled = true,
  repoIds?: number[] | null,
) {
  return useQuery<BotVolumeScatterResponse>({
    queryKey: ['bot-volume-scatter', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    queryFn:
      workspaceId == null ? skipToken : () => api.botVolumeScatter(window, workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
    placeholderData: (prev) => prev,
  });
}
