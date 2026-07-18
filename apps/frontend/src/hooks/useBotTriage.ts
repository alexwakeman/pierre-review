import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BotAnalyticsResponse,
  BotDedupResponse,
  BotMuteRule,
  BotMuteRuleInput,
  BotMuteRulesResponse,
  BotWindowKind,
  DetectedReviewersResponse,
  ReviewerClassification,
  ReviewerOverrideBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

// The bot-triage read/write hooks (CORE, deterministic — no AI). Detection, dedup and mute
// rules are free-tier; the Bot-ROI analytics panel that consumes useBotAnalytics is
// UI-gated on caps.teamInsights by its component (the route itself is core). Every getter
// is account-scoped server-side; these are plain DB reads that refresh on the sync cadence.

// Per-vendor bot ROI / utilisation analytics over the selected window. Keyed by window +
// scope so either change refetches. Cost fields arrive null — the panel overlays cost
// client-side from /api/pro/settings `bots.cost`. `enabled` lets the caller gate the fetch
// (Pro panel). `scope` ('all' | 'none' | '<teamId>') narrows to a team's repos.
export function useBotAnalytics(
  window: BotWindowKind,
  enabled = true,
  scope?: string,
  repoIds?: number[] | null,
) {
  // A repo scope (the per-repo Bots tab) wins over the team scope, both here and on the wire.
  // NAMESPACE the key slot (`repo:` vs `scope:`) — a bare repoId and a numeric teamId are both
  // plain integer strings (repo/team ids are independent autoincrements), so an un-prefixed slot
  // would let repo N alias team N's cache entry and show the wrong in-account scope.
  const repoKey = repoIds && repoIds.length > 0 ? [...repoIds].sort((a, b) => a - b).join(',') : null;
  return useQuery<BotAnalyticsResponse>({
    queryKey: ['bot-analytics', window, repoKey != null ? `repo:${repoKey}` : `scope:${scope ?? 'all'}`],
    queryFn: () => api.botAnalytics(window, scope, repoIds),
    enabled,
    refetchInterval: 5 * 60_000, // main sync cadence
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}

// Every distinct reviewer in the account joined with its automated/human classification,
// volume and a sample review body — the Settings "Review bots" detected-reviewers table.
export function useDetectedReviewers(enabled = true) {
  return useQuery<DetectedReviewersResponse>({
    queryKey: ['bot-reviewers'],
    queryFn: () => api.botReviewers(),
    enabled,
    staleTime: 60_000,
  });
}

// Two-way manual override of a reviewer's classification (mark automated / not-a-bot). On
// success the detected-reviewers table refetches; the ROI analytics also shift (a
// reclassification changes which users count as automated), so invalidate both.
export function useReviewerOverride() {
  const qc = useQueryClient();
  return useMutation<
    ReviewerClassification,
    Error,
    { userId: number; body: ReviewerOverrideBody }
  >({
    mutationFn: ({ userId, body }) => api.setReviewerOverride(userId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-reviewers'] });
      void qc.invalidateQueries({ queryKey: ['bot-analytics'] });
    },
  });
}

// Cross-bot dedup + consensus/conflict clusters for a PR (≥2 automated reviewers of distinct
// kinds on the same path/line window). Fetched only when a PR id is in hand.
export function usePrBotDedup(prId: number | null, enabled = true) {
  return useQuery<BotDedupResponse>({
    queryKey: ['bot-dedup', prId],
    queryFn: () => api.prBotDedup(prId as number),
    enabled: enabled && prId != null,
    staleTime: 60_000,
  });
}

// The account's mute / auto-triage rules (hide or auto-resolve automated-bot threads by
// vendor / path / severity).
export function useBotMuteRules(enabled = true) {
  return useQuery<BotMuteRulesResponse>({
    queryKey: ['bot-mute-rules'],
    queryFn: () => api.botMuteRules(),
    enabled,
    staleTime: 60_000,
  });
}

// Add a mute rule. Invalidates the rule list AND analytics (a mute excludes the muted
// vendor×path×severity from the ROI counts).
export function useAddBotMuteRule() {
  const qc = useQueryClient();
  return useMutation<BotMuteRule, Error, BotMuteRuleInput>({
    mutationFn: (input) => api.addBotMuteRule(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-mute-rules'] });
      void qc.invalidateQueries({ queryKey: ['bot-analytics'] });
    },
  });
}

// Delete a mute rule (204). Same invalidations as adding one.
export function useDeleteBotMuteRule() {
  const qc = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id) => api.deleteBotMuteRule(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bot-mute-rules'] });
      void qc.invalidateQueries({ queryKey: ['bot-analytics'] });
    },
  });
}
