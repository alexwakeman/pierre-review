import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import type {
  DependencyMergeAllResponse,
  DependencyMergeItem,
  WorkspaceDependencyAutoMergeResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

// ── PENDING → DEPENDENCIES: "MERGE OR ARM ALL" + the per-workspace setting ─────────────────────
//
// The server decides everything (merge/dependency-policy.ts): which listed PRs are dependency
// updates it can push to, which land now and which wait armed. The dialog reads the server's own
// dry run; the run's per-PR outcomes become ONE summary card in App.tsx's toast column.

/** ONE key for every mount: a second press while a run is in flight must see it (useIsMutating). */
export const DEPENDENCY_MERGE_ALL_KEY = ['dependency-merge-all'] as const;

/** The dialog's plan — no GitHub call, nothing written. Only fetched while the dialog is open. */
export function useDependencyMergePlan(workspaceId: number | null, prIds: number[], open: boolean) {
  return useQuery({
    queryKey: ['dependency-merge-plan', `ws:${workspaceId}`, prIds],
    queryFn: () => api.mergeAllDependencies(workspaceId!, { prIds, dryRun: true }),
    enabled: open && workspaceId != null && prIds.length > 0,
    staleTime: 0,
    gcTime: 0,
  });
}

/** The toast's one piece of state — the last run's outcomes, until closed or timed out. */
export const useDependencyMergeToast = create<{
  last: DependencyMergeItem[] | null;
  show: (items: DependencyMergeItem[]) => void;
  clear: () => void;
}>((set) => ({
  last: null,
  show: (items) => set({ last: items }),
  clear: () => set({ last: null }),
}));

export function useDependencyMergeAll(workspaceId: number | null) {
  const qc = useQueryClient();
  const show = useDependencyMergeToast((s) => s.show);
  return useMutation({
    mutationKey: DEPENDENCY_MERGE_ALL_KEY,
    mutationFn: (prIds: number[]) =>
      api.mergeAllDependencies(workspaceId!, { prIds }) as Promise<DependencyMergeAllResponse>,
    // HOOK-level, so a card unmounted mid-run still reports and refreshes.
    onSuccess: (resp) => {
      show(resp.items);
      const touched = resp.items
        .filter((i) => i.outcome.action === 'merged' || i.outcome.action === 'armed')
        .map((i) => i.prId);
      const merged = resp.items.some((i) => i.outcome.action === 'merged');
      if (touched.length > 0) void invalidateAfterPrWrite(qc, touched, { merged, armed: true });
    },
  });
}

const settingKey = (workspaceId: number | null) => ['dependency-auto-merge', `ws:${workspaceId}`];

export function useDependencyAutoMergeSetting(workspaceId: number | null) {
  return useQuery({
    queryKey: settingKey(workspaceId),
    queryFn: () => api.workspaceDependencyAutoMerge(workspaceId!),
    enabled: workspaceId != null,
  });
}

export function useSetDependencyAutoMerge(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => api.setWorkspaceDependencyAutoMerge(workspaceId!, enabled),
    onSuccess: (resp: WorkspaceDependencyAutoMergeResponse) => {
      qc.setQueryData(settingKey(workspaceId), resp);
    },
  });
}
