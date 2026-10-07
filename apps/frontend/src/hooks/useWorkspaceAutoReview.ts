import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SetWorkspaceAutoReviewBody, WorkspaceAutoReviewResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// Auto Claude review for ONE workspace — CORE (`workspaces.auto_review_enabled[_at]`, migration
// 0074 / pg 0061), read and written on `/api/workspaces/:id/auto-review`. It moved out of the Pro
// `pro_workspace_settings` row when Claude Review went free, so it no longer waits on the plugin.
//
// ⚠ THE KEY CARRIES `ws:<id>` AND THE FETCH IDLES ON AN UNRESOLVED SCOPE (`workspaceId === null`
// means "not resolved yet"), like every scoped query here. `enabled` is the caller's `me.ai.enabled`
// — the route is not registered where agentic AI cannot run.
export function workspaceAutoReviewKey(workspaceId: number | null): [string, string] {
  return ['workspace-auto-review', workspaceKey(workspaceId)];
}

export function useWorkspaceAutoReview(enabled: boolean, workspaceId: number | null) {
  return useQuery<WorkspaceAutoReviewResponse>({
    queryKey: workspaceAutoReviewKey(workspaceId),
    queryFn:
      enabled && workspaceId != null ? () => api.workspaceAutoReview(workspaceId) : skipToken,
    staleTime: 60_000,
  });
}

export function useSetWorkspaceAutoReview(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetWorkspaceAutoReviewBody) => {
      if (workspaceId == null) throw new Error('Workspace not resolved yet.');
      return api.setWorkspaceAutoReview(workspaceId, body);
    },
    onSuccess: (res) => {
      // The PUT echo carries no `usage` (only the GET counts it): keep the cached one, then
      // refetch so a switch on/off shows or drops the counter.
      const key = workspaceAutoReviewKey(res.workspaceId);
      qc.setQueryData<WorkspaceAutoReviewResponse>(key, (prev) => ({ ...res, usage: prev?.usage ?? null }));
      void qc.invalidateQueries({ queryKey: key });
    },
  });
}
