import { useMutation, useQueryClient } from '@tanstack/react-query';
import { resolveFlowActorView, type FlowActorView, type Workspace } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useWorkspaces } from './useWorkspaces.js';

// CHRONOLOGY'S VIEW — who moves the ball (docs/BOTTLENECKS.md § Two views): "People + bots" (the
// default) or "People". A per-WORKSPACE reading setting (`Workspace.flowView`, null = the default),
// never inherited, set from the toggle on the Chronology panel.
//
// The Chronology reads (useFlowFindings, useFlowTrend) SEND the resolved view and key their cache
// on it, so a switch is a new key (both views can sit in the cache) and never a stale paint of the
// other view's figures. Null while the workspace row is not loaded yet: the reads then send no view
// (the server uses the stored one) under a `stored` slot.

/** The view in force for this workspace, or null while its row is not loaded. */
export function useWorkspaceFlowView(workspaceId: number | null): FlowActorView | null {
  const workspaces = useWorkspaces();
  if (workspaceId == null) return null;
  const ws = workspaces.data?.find((w) => w.id === workspaceId);
  return ws == null ? null : resolveFlowActorView(ws.flowView ?? null);
}

/** The cache-key slot for a view: the view itself, or `stored` when it is not known yet. */
export const flowViewKeySlot = (view: FlowActorView | null): string => view ?? 'stored';

/**
 * Saves the view. The workspace row is updated AT ONCE (so the panel re-keys and reads the new
 * view without waiting for the PUT), then every Chronology read is refetched: the pointers
 * (server-side, keyed on the stored view) included.
 */
export function useSetWorkspaceFlowView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; view: FlowActorView }) => api.setWorkspaceFlowView(v.id, v.view),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ['workspaces'] });
      const prev = qc.getQueryData<Workspace[]>(['workspaces']);
      qc.setQueryData<Workspace[]>(['workspaces'], (list) =>
        list?.map((w) => (w.id === v.id ? { ...w, flowView: v.view } : w)),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['workspaces'], ctx.prev);
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['workspaces'] }),
        qc.invalidateQueries({ queryKey: ['flow-pointers'] }),
      ]),
  });
}
