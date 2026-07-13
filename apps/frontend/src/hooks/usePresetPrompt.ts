import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PresetPromptKey, PresetPromptResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// A single preset-prompt answer (Pro Haiku one-click "ask about this scope"). Cached per
// preset + team scope so switching presets / teams reads its own cached Markdown. Only
// fetched when the AI digest capability is on (`enabled`); absent the plugin the route 404s.
// `scope` ('all' | 'none' | '<teamId>') narrows the question to a team's repos.
export function usePresetPrompt(
  key: PresetPromptKey | null,
  enabled: boolean,
  scope?: string,
) {
  return useQuery<PresetPromptResponse>({
    queryKey: ['preset-prompt', key, scope ?? 'all'],
    queryFn: () => api.presetPrompt(key as PresetPromptKey, scope),
    enabled: enabled && key != null,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate a preset answer (the only billing path). Writes the fresh result into
// the shared cache so the panel updates in place; surfaces a transient `notice` when the
// server throttled the request or the account is out of credits — so a no-op click doesn't
// read as a silent failure. Mirrors useRefreshSprintReport. The mutation takes the preset key
// (which one the user clicked); the scope is fixed per panel.
export function useRefreshPresetPrompt(scope?: string) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    mutationFn: (key: PresetPromptKey) => api.refreshPresetPrompt(key, scope),
    onSuccess: (data, key) => {
      qc.setQueryData(['preset-prompt', key, scope ?? 'all'], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — answers resume on the 1st.'
          : data.throttled
            ? 'Refreshed moments ago — showing the latest. Try again shortly.'
            : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
