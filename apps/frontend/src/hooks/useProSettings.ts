import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProSettings, ProSettingsUpdate } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';

// Whether the config modal has ANY section to show — the pro_settings-backed sections OR the
// advanced-AI BYO Anthropic-key section. Used to gate the menu entry + the /api/pro/settings
// fetch (which 404s without the plugin) so the free tier never calls it. `botTriage` is true
// whenever the plugin is loaded (even with the paid flags off), so the FREE "Review bots"
// settings section keeps the modal reachable on a flag-less local run.
export function useHasProSettings(): boolean {
  const caps = useProCapabilities();
  return (
    caps.workspaceInsights ||
    caps.activityDigest ||
    caps.slackDigest ||
    caps.issueLinks ||
    caps.claudeReview ||
    caps.aiFix ||
    caps.botTriage
  );
}

// Per-account Pro settings (sprint / Slack / AI-update policy / Jira-Linear). Fetched only when
// `enabled` (the modal is open AND a Pro section exists).
export function useProSettings(enabled: boolean) {
  return useQuery<ProSettings>({
    queryKey: ['pro-settings'],
    queryFn: api.proSettings,
    enabled,
    staleTime: 60_000,
  });
}

// Patch the settings; on success the server returns the full ProSettings, which we write straight
// into the cache so every open section re-renders from server truth.
export function useUpdateProSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: ProSettingsUpdate) => api.updateProSettings(patch),
    onSuccess: (settings, patch) => {
      qc.setQueryData(['pro-settings'], settings);
      // Jira/Linear ticket links are computed on read into the PR-detail payload. PR/thread detail
      // is IndexedDB-persisted with staleTime:Infinity, so a provider/base-URL change would NOT
      // appear on already-viewed PRs without an explicit invalidation. Only when the issue section
      // changed (the other sections don't affect PR detail).
      if (patch.issue) {
        void qc.invalidateQueries({ queryKey: ['pr'] });
        void qc.invalidateQueries({ queryKey: ['thread'] });
      }
      // The sprint / comparison-window setting is resolved fresh on every /api/pro/insights read
      // (getComparisonWindow → resolveComparisonWindow), so changing it re-frames the flow-metrics
      // + sprint report — but those queries otherwise only refetch on the 5-min sync cadence. Push
      // the new window through immediately so the Insights UI reflects Save without waiting for a
      // sync. The sprint report refetch is a cheap CACHED read (no regeneration/billing); when the
      // window moved it comes back flagged `stale`, surfacing the Regenerate prompt.
      // ⚠ These three are keys this file does NOT own (useWorkspaceInsights /
      // useWorkspaceMetricsDetail / useSprintReport). They are bare literals, so a rename there is
      // silent here: the mutation succeeds, the invalidation targets a key nobody uses, and the UI
      // reads "the setting didn't take". They are PREFIXES, which is what makes them still sweep
      // every workspace's `['<name>', 'ws:<id>']` slot.
      if (patch.sprint) {
        void qc.invalidateQueries({ queryKey: ['workspace-insights'] });
        void qc.invalidateQueries({ queryKey: ['workspace-metrics-detail'] });
        void qc.invalidateQueries({ queryKey: ['sprint-report'] });
      }
    },
  });
}
