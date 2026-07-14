import { useQuery } from '@tanstack/react-query';
import type {
  AutomatedReviewerKind,
  BotVendorPrsResponse,
  BotWindowKind,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The per-vendor PR drill-down behind a Bot-ROI row (CORE, deterministic — no AI): the PRs
// an automated-reviewer KIND touched in the window (threads/comments/acted-on/untouched/
// bot-only), most-recent-bot-activity first. A heavier read than the always-loaded Bot-ROI
// panel, so it's fetched lazily — `enabled` is gated on the drill-down tab being open AND a
// vendor being selected. Keyed by (kind, window) so either change refetches; account-scoped
// server-side. Refetches on the sync cadence.
export function useBotVendorPrs(
  kind: AutomatedReviewerKind | null,
  window: BotWindowKind,
  enabled = true,
  scope?: string,
) {
  return useQuery<BotVendorPrsResponse>({
    queryKey: ['bot-vendor-prs', kind, window, scope ?? 'all'],
    queryFn: () => api.botVendorPrs(kind as AutomatedReviewerKind, window, scope),
    enabled: enabled && kind != null,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
