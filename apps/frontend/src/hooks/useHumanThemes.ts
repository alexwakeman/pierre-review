import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HumanThemesResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Feed "Discussion themes" AI summary (Pro Haiku) — the human sibling of useBotThemes. Cached per
// (window, team scope). Only fetched when the AI-summary capability is on (`enabled`); absent the
// plugin the route 404s. `scope` ('all' | 'none' | '<teamId>') is the current Team.
export function useHumanThemes(window: BotWindowKind, enabled: boolean, scope?: string) {
  return useQuery<HumanThemesResponse>({
    queryKey: ['human-themes', window, `scope:${scope ?? 'all'}`],
    queryFn: () => api.humanThemes(window, scope),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate the human-themes report (the only billing path). Mirrors useRefreshBotThemes.
export function useRefreshHumanThemes(window: BotWindowKind, scope?: string) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = globalThis.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => globalThis.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    mutationFn: () => api.humanThemesRefresh(window, scope),
    onSuccess: (data) => {
      qc.setQueryData(['human-themes', window, `scope:${scope ?? 'all'}`], data);
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — the summary resumes on the 1st.'
          : data.empty
            ? 'No human review comments in this scope / window yet.'
            : data.throttled
              ? 'A summary is already generating — showing the latest shortly.'
              : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
