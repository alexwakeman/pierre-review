import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HumanThemesResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The Feed "Discussion themes" AI summary (Pro Haiku) — the human sibling of the retired bot
// Themes hook (that surface folded into the synthesis seam, plan P2.3/C6). Cached
// per (window, WORKSPACE). Only fetched when the AI-summary capability is on (`enabled`); absent
// the plugin the route 404s. The `ws:<id>` segment matches the plugin's persisted `scope_key`.
export function useHumanThemes(
  window: BotWindowKind,
  enabled: boolean,
  workspaceId: number | null,
) {
  return useQuery<HumanThemesResponse>({
    queryKey: ['human-themes', window, workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.humanThemes(window, workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate the human-themes report (the only billing path). The `setQueryData` key must
// be built exactly like the read's.
export function useRefreshHumanThemes(window: BotWindowKind, workspaceId: number | null) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = globalThis.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => globalThis.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    // Refuses on an unresolved workspace — a mutation cannot be skipToken-gated the way the
    // read is, and generating for an unresolved workspace would bill for the account's Default
    // and cache under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.humanThemesRefresh(window, workspaceId);
    },
    onSuccess: (data) => {
      qc.setQueryData(['human-themes', window, workspaceKey(workspaceId)], data);
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — the summary resumes on the 1st.'
          : data.empty
            ? 'No human review comments in this workspace / window yet.'
            : data.throttled
              ? 'A summary is already generating — showing the latest shortly.'
              : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
