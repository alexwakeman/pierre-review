// The 1:1-prep person vector (Pro `periodReports`; GET /api/pro/insights/person/:userId — plan
// P4.2). Free deterministic read; the NARRATION is not here (it rides useSynthesis with the
// 'person' descriptor — one seam per datum).
//
// The standard scope rules: the key carries `ws:<id>` plus the person + period slots; the fetch
// holds itself idle on `skipToken` while `workspaceId === null` (nothing workspace-scoped may be
// requested before the scope resolves — a 1:1 answered from the account's Default under another
// workspace's heading is a wrong document, the period-reports lesson at the person grain).
import { skipToken, useQuery } from '@tanstack/react-query';
import type { PersonPeriodResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

export function personPeriodKey(
  workspaceId: number | null,
  userId: number,
  periodKey: string | null,
): (string | number)[] {
  return ['person-period', workspaceKey(workspaceId), `u:${userId}`, periodKey ?? 'none'];
}

export function usePersonPeriod(
  enabled: boolean,
  workspaceId: number | null,
  userId: number,
  periodKey: string | null,
) {
  return useQuery<PersonPeriodResponse>({
    queryKey: personPeriodKey(workspaceId, userId, periodKey),
    queryFn:
      workspaceId == null || periodKey == null
        ? skipToken
        : () => api.personPeriod(workspaceId, userId, periodKey),
    enabled: enabled && periodKey != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}
