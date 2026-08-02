import { useEffect, useState } from 'react';
import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SprintReportResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The Insights "Sprint report" (Pro Haiku summary of the workspace-insights state). Cached;
// `report.stale` flags that the Insights changed since it was generated. Only fetched
// when the AI digest capability is on (`enabled`). The WORKSPACE narrows the report to that
// workspace's repos, and it is part of the cache key so each one caches independently —
// under the same `ws:<id>` vocabulary the plugin persists in `scope_key`.
export function useSprintReport(enabled: boolean, workspaceId: number | null) {
  return useQuery<SprintReportResponse>({
    queryKey: ['sprint-report', workspaceKey(workspaceId)],
    queryFn: workspaceId == null ? skipToken : () => api.sprintReport(workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Regenerate (the only billing path). Writes the fresh result into the shared cache so
// the card updates in place. Surfaces a transient `notice` when the server throttled the
// request (a regeneration ran moments ago) AND the report is still stale — so a no-op
// "Regenerate" reads as "refreshed moments ago", not as a silent failure (mirrors the
// per-repo digest refresh). Auto-clears.
export function useRefreshSprintReport(workspaceId: number | null) {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    // Refuses on an unresolved workspace: the billing path must never generate for the Default
    // just because the store had not settled yet.
    mutationFn: () => {
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.refreshSprintReport(workspaceId);
    },
    onSuccess: (data) => {
      qc.setQueryData(['sprint-report', workspaceKey(workspaceId)], data);
      // A generation may have spent credits → refresh the meter + the out-of-credits gate.
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
      // Nag when the click genuinely did nothing: out of credits, or throttled AND still stale.
      setNotice(
        data.creditsExhausted
          ? 'Out of AI credits this month — summaries resume on the 1st.'
          : data.throttled && data.report?.stale
            ? 'Refreshed moments ago — showing the latest. Try again shortly.'
            : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
