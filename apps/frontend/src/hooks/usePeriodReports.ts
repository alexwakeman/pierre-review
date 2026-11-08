// Reports → Period reports: THE series (GET /api/pro/insights/period-series). DB only — nothing in
// reporting calls a model (the AI write-up was removed 2026-11-08).
//
// The key carries the `ws:<id>` segment AND the grain (sprint and month are two different series
// from one route), and the fetch idles on `skipToken` while `workspaceId === null`: a request sent
// before the scope resolves would be answered from the DEFAULT workspace and cached under whichever
// key the store settles on — the wrong workspace's numbers under the right workspace's name.
import { skipToken, useQuery } from '@tanstack/react-query';
import type { PeriodGrain, PeriodSeriesResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

export function periodSeriesKey(workspaceId: number | null, grain: PeriodGrain = 'sprint'): [string, string, string] {
  return ['period-series', workspaceKey(workspaceId), grain];
}

/** The series. Recomputed live on the server (≤ 12 + 12 scans), so a minute's staleness is plenty. */
export function usePeriodSeries(workspaceId: number | null, grain: PeriodGrain = 'sprint') {
  return useQuery<PeriodSeriesResponse>({
    queryKey: periodSeriesKey(workspaceId, grain),
    queryFn: workspaceId == null ? skipToken : () => api.periodSeries(workspaceId, grain),
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}
