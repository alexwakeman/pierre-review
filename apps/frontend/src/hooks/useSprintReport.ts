import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SprintReportResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Insights "Sprint report" (Pro Haiku summary of the team-insights state). Cached;
// `report.stale` flags that the Insights changed since it was generated. Only fetched
// when the AI digest capability is on (`enabled`).
export function useSprintReport(enabled: boolean) {
  return useQuery<SprintReportResponse>({
    queryKey: ['sprint-report'],
    queryFn: api.sprintReport,
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
export function useRefreshSprintReport() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    mutationFn: api.refreshSprintReport,
    onSuccess: (data) => {
      qc.setQueryData(['sprint-report'], data);
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
