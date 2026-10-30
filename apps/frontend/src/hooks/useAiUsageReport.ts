import { skipToken, useQuery } from '@tanstack/react-query';
import type { AiUsageReportResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// Reports → AI usage (GET /api/ai/usage-report). Idle until the workspace resolves and while AI is
// off (the route is not registered then).

export function aiUsageReportKey(workspaceId: number | null): [string, string] {
  return ['ai-usage-report', workspaceKey(workspaceId)];
}

export function useAiUsageReport(workspaceId: number | null, enabled: boolean) {
  return useQuery<AiUsageReportResponse>({
    queryKey: aiUsageReportKey(workspaceId),
    queryFn: workspaceId == null || !enabled ? skipToken : () => api.aiUsageReport(workspaceId),
    // The ledger grows only when a run finishes.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}
