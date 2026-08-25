import { useEffect, useState } from 'react';
import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotThemesResponse, BotWindowKind } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { repoKeySlot } from './useBotTriage.js';

// The Bots "What they're flagging" AI summary (Pro Haiku) — the revived Themes report, merged
// with the deterministic Bots layer. Cached per (window, WORKSPACE, repo narrowing) so switching
// any of the three reads its own cached report. Only fetched when the AI-summary capability is on
// (`enabled`); absent the plugin the route 404s.
//
// The `ws:<id>` segment is the SAME string the plugin persists in `scope_key`
// (`themesScopeKey(workspaceId, …)` → `ws:<id>` + an `|r:` suffix when narrowed), so the client
// cache slot and the server-side cached report agree by construction. `repoIds` occupies its OWN
// slot (repoKeySlot — the two-slot rule from useBotTriage): the per-repo Bots console tab narrows
// the DATA to one repo, while the workspace still decides who counts as a bot.
export function useBotThemes(
  window: BotWindowKind,
  enabled: boolean,
  workspaceId: number | null,
  repoIds?: number[] | null,
) {
  return useQuery<BotThemesResponse>({
    queryKey: ['bot-themes', window, workspaceKey(workspaceId), repoKeySlot(repoIds)],
    queryFn:
      workspaceId == null ? skipToken : () => api.botThemes(window, workspaceId, repoIds),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Generate/regenerate the themes report (the only billing path). Writes the fresh result into the
// shared cache so the panel updates in place; surfaces a transient `notice` when the server
// throttled, the account is out of credits, or the scope/window is empty — so a no-op click
// doesn't read as a silent failure. Mirrors useRefreshHumanThemes.
//
// ⚠ The `setQueryData` key must be built the SAME way as the read above (one `workspaceKey` +
// one `repoKeySlot` call each): writing the generated report under a hand-spelled key is how a
// "Regenerate" appears to do nothing until the next refetch.
//
// ⚠ The MUTATION KEY IS SHARED PER SCOPE (the useSynthesis / CiAnalysisCard two-mounts lesson):
// a board switch mid-run unmounts the panel, and a per-mount `isPending` would reset the button
// to "Generate" while the Haiku run is still in flight — the returned `busy` reads the in-flight
// state via `useIsMutating`, so every mount of the same scope agrees.
export function useRefreshBotThemes(
  window: BotWindowKind,
  workspaceId: number | null,
  repoIds?: number[] | null,
) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = globalThis.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => globalThis.clearTimeout(t);
  }, [notice]);
  const mutationKey = ['bot-themes-refresh', window, workspaceKey(workspaceId), repoKeySlot(repoIds)];
  const mutation = useMutation({
    mutationKey,
    // The mutation cannot be `skipToken`-gated, so it refuses outright: generating a report for
    // an unresolved workspace would BILL for the account's Default and cache it under 'ws:pending'.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.botThemesRefresh(window, workspaceId, repoIds);
    },
    onSuccess: (data) => {
      qc.setQueryData(['bot-themes', window, workspaceKey(workspaceId), repoKeySlot(repoIds)], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — the summary resumes on the 1st.'
          : data.empty
            // An empty scope/window doesn't touch the stored report — the server returns it
            // alongside `empty` so the panel keeps showing it rather than flashing "No summary yet".
            ? data.result != null
              ? 'No bot comments in this scope / window any more — showing the last report.'
              : 'No review-bot comments in this scope / window yet.'
            : data.throttled
              ? 'A summary is already generating — showing the latest shortly.'
              : null,
      );
    },
  });
  const busy = useIsMutating({ mutationKey }) > 0;
  return Object.assign(mutation, { notice, busy });
}
