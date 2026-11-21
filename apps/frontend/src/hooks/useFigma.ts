import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FigmaConnectionCheck, WorkspaceFigmaSettings, WorkspaceFigmaUpdate } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// FIGMA (docs/IMPLEMENT-UI-PLAN.md § 3): the workspace's token (WRITE-ONLY — `hasToken`) and a click-gated
// "Test token". ⚠ Nothing here calls Figma on mount: the read is a DB read.

export function workspaceFigmaKey(workspaceId: number | null): [string, string] {
  return ['workspace-figma', workspaceKey(workspaceId)];
}

export function useWorkspaceFigma(workspaceId: number | null) {
  return useQuery<WorkspaceFigmaSettings>({
    queryKey: workspaceFigmaKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.workspaceFigma(workspaceId),
    staleTime: 60_000,
  });
}

export function useUpdateWorkspaceFigma(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceFigmaSettings, Error, WorkspaceFigmaUpdate>({
    mutationFn: (patch) => (workspaceId == null ? Promise.reject(new Error('No workspace selected')) : api.updateWorkspaceFigma(workspaceId, patch)),
    onSuccess: (settings) => qc.setQueryData(workspaceFigmaKey(workspaceId), settings),
  });
}

export function useCheckWorkspaceFigma(workspaceId: number | null) {
  return useMutation<FigmaConnectionCheck, Error, void>({
    mutationFn: () => (workspaceId == null ? Promise.reject(new Error('No workspace selected')) : api.checkWorkspaceFigma(workspaceId)),
  });
}
