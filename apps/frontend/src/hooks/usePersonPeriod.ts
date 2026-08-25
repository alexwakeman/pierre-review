// The 1:1-prep person vector (Pro `periodReports`; GET /api/pro/insights/person/:userId — plan
// P4.2). Free deterministic read; the NARRATION is not here (it rides useSynthesis with the
// 'person' descriptor — one seam per datum).
//
// The standard scope rules: the key carries `ws:<id>` plus the person + period slots; the fetch
// holds itself idle on `skipToken` while `workspaceId === null` (nothing workspace-scoped may be
// requested before the scope resolves — a 1:1 answered from the account's Default under another
// workspace's heading is a wrong document, the period-reports lesson at the person grain).
//
// `evidence` (the People report) asks the same fold for the receipt rows under the vector
// (`person.evidence` — still free, still deterministic). It gets its OWN trailing key slot
// (`ev:1` / `ev:0`) so the report's evidence-bearing response never shares a cache entry with
// the 1:1 section's evidence-less one; PersonPeriodSection keeps calling with the parameter
// omitted (⇒ `ev:0`), untouched behaviour.
import { skipToken, useQuery } from '@tanstack/react-query';
import type { PersonPeriodResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { ACTIVITY_GC_TIME, workspaceKey } from './useActivity.js';

export function personPeriodKey(
  workspaceId: number | null,
  userId: number,
  periodKey: string | null,
  evidence = false,
): (string | number)[] {
  return [
    'person-period',
    workspaceKey(workspaceId),
    `u:${userId}`,
    periodKey ?? 'none',
    `ev:${evidence ? 1 : 0}`,
  ];
}

export function usePersonPeriod(
  enabled: boolean,
  workspaceId: number | null,
  userId: number,
  periodKey: string | null,
  evidence = false,
) {
  return useQuery<PersonPeriodResponse>({
    queryKey: personPeriodKey(workspaceId, userId, periodKey, evidence),
    queryFn:
      workspaceId == null || periodKey == null
        ? skipToken
        : () => api.personPeriod(workspaceId, userId, periodKey, evidence),
    enabled: enabled && periodKey != null,
    staleTime: 60_000,
    gcTime: ACTIVITY_GC_TIME,
  });
}
