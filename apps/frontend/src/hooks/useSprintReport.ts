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
      // Only nag when the click genuinely did nothing: throttled AND still stale. A throttled
      // call on an already-fresh report needs no notice.
      setNotice(
        data.throttled && data.report?.stale
          ? 'Refreshed moments ago — showing the latest. Try again shortly.'
          : null,
      );
    },
  });
  return Object.assign(mutation, { notice });
}
