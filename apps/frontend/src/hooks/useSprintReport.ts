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

// Regenerate (the only billing path). Writes the fresh result into the shared cache so
// the card updates in place.
export function useRefreshSprintReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.refreshSprintReport,
    onSuccess: (data) => qc.setQueryData(['sprint-report'], data),
  });
}
