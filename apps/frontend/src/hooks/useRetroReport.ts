import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RetroReportResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';

// The Insights "Retro" (Pro Haiku retrospective narrative of the sprint window). Cached;
// `report.stale` flags that the window's activity changed since it was generated (it advances
// daily as the window ends "today"). Only fetched when the AI digest capability is on.
export function useRetroReport(enabled: boolean) {
  return useQuery<RetroReportResponse>({
    queryKey: ['retro-report'],
    queryFn: api.retroReport,
    enabled,
    staleTime: 60_000,
  });
}

const NOTICE_MS = 5000;

// Regenerate (the only billing path). Writes the fresh result into the shared cache so the
// view updates in place; surfaces a transient `notice` when the request was throttled AND the
// report is still stale, or when out of credits. Mirrors useRefreshSprintReport.
export function useRefreshRetroReport() {
  const qc = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice == null) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const mutation = useMutation({
    mutationFn: api.refreshRetroReport,
    onSuccess: (data) => {
      qc.setQueryData(['retro-report'], data);
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
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
