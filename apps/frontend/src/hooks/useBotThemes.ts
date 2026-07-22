import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotThemesResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Bots "Themes" AI summary (Pro Haiku). Cached per (window, team scope) so switching windows /
// teams reads its own cached report. Only fetched when the AI-summary capability is on (`enabled`);
// absent the plugin the route 404s. `scope` ('all' | 'none' | '<teamId>') is the current Team.
// Team-scoped only (the cross-repo Bots rail), so no repoIds key slot.
export function useBotThemes(
  window: BotWindowKind,
  enabled: boolean,
  scope?: string,
) {
  return useQuery<BotThemesResponse>({
    queryKey: ['bot-themes', window, `scope:${scope ?? 'all'}`],
    queryFn: () => api.botThemes(window, scope),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate the themes report (the only billing path). Writes the fresh result into the
// shared cache so the panel updates in place; surfaces a transient `notice` when the server
// throttled, the account is out of credits, or Claude auth is missing — so a no-op click doesn't
// read as a silent failure. Mirrors useRefreshPresetPrompt.
export function useRefreshBotThemes(window: BotWindowKind, scope?: string) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = globalThis.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => globalThis.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    mutationFn: () => api.botThemesRefresh(window, scope),
    onSuccess: (data) => {
      qc.setQueryData(['bot-themes', window, `scope:${scope ?? 'all'}`], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — the summary resumes on the 1st.'
          : data.empty
            ? 'No review-bot comments in this scope / window yet.'
            : data.throttled
              ? 'A summary is already generating — showing the latest shortly.'
              : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
