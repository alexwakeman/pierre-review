import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotThemesResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The Bots "Themes" AI summary (Pro Haiku). Cached per (window, WORKSPACE) so switching windows /
// workspaces reads its own cached report. Only fetched when the AI-summary capability is on
// (`enabled`); absent the plugin the route 404s. Workspace-scoped only (the cross-repo Bots rail),
// so no repoIds key slot.
//
// The `ws:<id>` segment is the SAME string the plugin persists in `scope_key`
// (`scopeKeyFor(workspaceId)` → `ws:<id>`), so the client cache slot and the server-side cached
// report agree by construction.
export function useBotThemes(
  window: BotWindowKind,
  enabled: boolean,
  workspaceId: number | null,
) {
  return useQuery<BotThemesResponse>({
    queryKey: ['bot-themes', window, workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.botThemes(window, workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate the themes report (the only billing path). Writes the fresh result into the
// shared cache so the panel updates in place; surfaces a transient `notice` when the server
// throttled, the account is out of credits, or Claude auth is missing — so a no-op click doesn't
// read as a silent failure. Mirrors useRefreshPresetPrompt.
//
// ⚠ The `setQueryData` key must be built the SAME way as the read above (one `workspaceKey` call
// each): writing the generated report under a hand-spelled key is how a "Regenerate" appears to do
// nothing until the next refetch.
export function useRefreshBotThemes(window: BotWindowKind, workspaceId: number | null) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = globalThis.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => globalThis.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    // The mutation cannot be `skipToken`-gated, so it refuses outright: generating a report for
    // an unresolved workspace would BILL for the account's Default and cache it under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.botThemesRefresh(window, workspaceId);
    },
    onSuccess: (data) => {
      qc.setQueryData(['bot-themes', window, workspaceKey(workspaceId)], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — the summary resumes on the 1st.'
          : data.empty
            ? 'No review-bot comments in this workspace / window yet.'
            : data.throttled
              ? 'A summary is already generating — showing the latest shortly.'
              : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
