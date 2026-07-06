import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProSettings, ProSettingsUpdate } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useProCapabilities } from './useTriage.js';

// Whether the config modal has ANY Pro section to show. Used to gate the /api/pro/settings
// fetch (which 404s without the plugin) so the free tier never calls it.
export function useHasProSettings(): boolean {
  const caps = useProCapabilities();
  return (
    caps.teamInsights || caps.activityDigest || caps.slackDigest || caps.issueLinks
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
    },
  });
}
