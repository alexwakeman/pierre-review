import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FlowPointersResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { useProCapabilities } from './useTriage.js';

// Chronology's POINTERS — the Pro, credit-metered Haiku narration beside the court ledger.
//
// ⚠ GATED ON `periodReports`, THE FLAG CHRONOLOGY ITSELF RIDES, and ANDed into `enabled` so the SPA
// never learns the paywall by error (every hook reaching a gated route does this).
//
// ⚠ THE GET NEVER GENERATES. It is safe to mount with the panel: it reads the cache and reports
// whether the evidence has moved. The POST is the only billing path, and every mount of one scope
// shares its MUTATION KEY, so a tab switch mid-run cannot offer a second, billed "Generate".

export function flowPointersKeySlots(workspaceId: number | null, days: number): (string | number)[] {
  return [workspaceKey(workspaceId), days];
}

export function useFlowPointers(workspaceId: number | null, days: number) {
  const { periodReports } = useProCapabilities();
  return useQuery<FlowPointersResponse>({
    queryKey: ['flow-pointers', ...flowPointersKeySlots(workspaceId, days)],
    queryFn: workspaceId == null ? skipToken : () => api.flowPointers(workspaceId, days),
    enabled: periodReports,
    // Folded from synced rows; it can only move when a sync lands. The Chronology panel's cadence.
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useGenerateFlowPointers(workspaceId: number | null, days: number) {
  const qc = useQueryClient();
  const slots = flowPointersKeySlots(workspaceId, days);
  return useMutation<FlowPointersResponse>({
    mutationKey: ['flow-pointers-generate', ...slots],
    mutationFn: () => {
      // Generating against an unresolved workspace would bill for the account's Default.
      if (workspaceId == null) throw new Error('No workspace selected');
      return api.flowPointersGenerate(workspaceId, days);
    },
    onSuccess: (data) => {
      // ⚠ `stale` is a GET-only field: a throttled or out-of-credits reply serves the cached row
      // and omits it, and overwriting would quietly relabel an out-of-date answer as current.
      qc.setQueryData<FlowPointersResponse>(['flow-pointers', ...slots], (prev) =>
        data.stale === undefined && prev?.stale !== undefined ? { ...data, stale: prev.stale } : data,
      );
      void qc.invalidateQueries({ queryKey: ['ai-usage'] });
    },
  });
}

/** In flight for this scope on ANY mount — never a per-mount `isPending` alone. */
export function useFlowPointersGenerating(workspaceId: number | null, days: number): boolean {
  return useIsMutating({ mutationKey: ['flow-pointers-generate', ...flowPointersKeySlots(workspaceId, days)] }) > 0;
}
