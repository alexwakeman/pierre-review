import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PresetPromptKey, PresetPromptResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// A single preset-prompt answer (Pro Haiku one-click "ask about this workspace"). Cached per
// (preset, WORKSPACE) so switching presets / workspaces reads its own cached Markdown. Only
// fetched when the AI digest capability is on (`enabled`); absent the plugin the route 404s.
//
// The `ws:<id>` segment is the same vocabulary the plugin persists in `scope_key`
// (`scopeKeyFor(workspaceId)`), so a stored answer and the slot it renders into cannot drift.
export function usePresetPrompt(
  key: PresetPromptKey | null,
  enabled: boolean,
  workspaceId: number | null,
) {
  return useQuery<PresetPromptResponse>({
    queryKey: ['preset-prompt', key, workspaceKey(workspaceId)],
    queryFn:
      key == null || workspaceId == null
        ? skipToken
        : () => api.presetPrompt(key, workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate a preset answer (the only billing path). Writes the fresh result into
// the shared cache so the panel updates in place; surfaces a transient `notice` when the
// server throttled the request or the account is out of credits — so a no-op click doesn't
// read as a silent failure. (Mirrored the removed useRefreshSprintReport.) The mutation takes the preset key
// (which one the user clicked); the workspace is fixed per panel.
export function useRefreshPresetPrompt(workspaceId: number | null) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    // Refuses on an unresolved workspace: this is the BILLING path, and an unscoped generation
    // would spend credits answering about the account's Default.
    mutationFn: (key: PresetPromptKey) => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.refreshPresetPrompt(key, workspaceId);
    },
    onSuccess: (data, key) => {
      qc.setQueryData(['preset-prompt', key, workspaceKey(workspaceId)], data);
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
