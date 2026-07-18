import { useQuery } from '@tanstack/react-query';
import type { BotVendorPrsResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The per-REVIEWER PR drill-down behind a Bot-ROI row (CORE, deterministic — no AI): the PRs
// one automated reviewer touched in the window (threads/comments/acted-on/untouched/bot-only),
// most-recent-bot-activity first. A heavier read than the always-loaded Bot-ROI panel, so it's
// fetched lazily — `enabled` is gated on the drill-down tab being open AND a row being selected.
// `key` is the analytics row identity (`u<userId>` | 'pierre'); keyed by (key, window) so either
// change refetches; account-scoped server-side. Refetches on the sync cadence.
export function useBotVendorPrs(
  key: string | null,
  window: BotWindowKind,
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  // A repo scope (the per-repo Bots tab drill-down) wins over the team scope, keyed for cache.
  // NAMESPACE the slot (`repo:` vs `scope:`) so a bare repoId can't collide with a numeric teamId
  // (independent id-spaces) and alias the wrong scope's cache entry — see useBotAnalytics.
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<BotVendorPrsResponse>({
    queryKey: ['bot-vendor-prs', key, window, repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.botVendorPrs(key as string, window, scope, repoIds),
    enabled: enabled && key != null,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
