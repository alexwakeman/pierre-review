import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SonarConnectionCheck,
  SonarPostResponse,
  SonarPrResponse,
  WorkspaceSonarSettings,
  WorkspaceSonarUpdate,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

// SONARCLOUD (CORE, free; docs/SONARCLOUD.md). The workspace's settings (token WRITE-ONLY —
// `hasToken`), a PR's STORED snapshot (no SonarCloud call), a click-gated refresh and the one PR
// comment. ⚠ Nothing here fetches SonarCloud on mount: the stored read is a DB read, and the two
// calls that reach SonarCloud (refresh, Test connection) are buttons.

export function workspaceSonarKey(workspaceId: number | null): [string, string] {
  return ['workspace-sonar', workspaceKey(workspaceId)];
}

export function useWorkspaceSonar(workspaceId: number | null) {
  return useQuery<WorkspaceSonarSettings>({
    queryKey: workspaceSonarKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.workspaceSonar(workspaceId),
    staleTime: 60_000,
  });
}

export function useUpdateWorkspaceSonar(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceSonarSettings, Error, WorkspaceSonarUpdate>({
    mutationFn: (patch) =>
      workspaceId == null ? Promise.reject(new Error('No workspace selected')) : api.updateWorkspaceSonar(workspaceId, patch),
    onSuccess: (settings) => {
      qc.setQueryData(workspaceSonarKey(workspaceId), settings);
      // `configured` on every PR's stored read may have flipped.
      void qc.invalidateQueries({ queryKey: ['pr-sonar'] });
    },
  });
}

export function useCheckWorkspaceSonar(workspaceId: number | null) {
  return useMutation<SonarConnectionCheck, Error, void>({
    mutationFn: () =>
      workspaceId == null ? Promise.reject(new Error('No workspace selected')) : api.checkWorkspaceSonar(workspaceId),
  });
}

export function prSonarKey(prId: number, head: string | null): [string, number, string] {
  return ['pr-sonar', prId, head ?? 'head'];
}

/** The stored snapshot at `head`. `enabled` lets a caller idle it (AI off, no review yet). */
export function usePrSonar(prId: number, head: string | null, enabled = true) {
  return useQuery<SonarPrResponse>({
    queryKey: prSonarKey(prId, head),
    queryFn: () => api.prSonar(prId, head),
    enabled,
    staleTime: 30_000,
  });
}

export function useRefreshPrSonar(prId: number, head: string | null) {
  const qc = useQueryClient();
  return useMutation<SonarPrResponse, Error, void>({
    mutationKey: ['pr-sonar-refresh', prId, head ?? 'head'],
    mutationFn: () => api.refreshPrSonar(prId, head),
    onSuccess: (res) => {
      qc.setQueryData(prSonarKey(prId, head), res);
      // AI Fix's picker reads the snapshot at the current head.
      void qc.invalidateQueries({ queryKey: ['ai-fix-preview', prId] });
    },
  });
}

/** ONE shared mutation key per (PR, head), so a second mount shows the same "Posting…". */
export function usePostPrSonar(prId: number, head: string | null) {
  const qc = useQueryClient();
  return useMutation<SonarPostResponse, Error, void>({
    mutationKey: ['pr-sonar-post', prId, head ?? 'head'],
    mutationFn: () => (head == null ? Promise.reject(new Error('No commit to post for')) : api.postPrSonar(prId, head)),
    onSuccess: (res) => {
      qc.setQueryData<SonarPrResponse>(prSonarKey(prId, head), (old) => ({
        prId,
        configured: old?.configured ?? true,
        snapshot: res.snapshot,
      }));
      void invalidateAfterPrWrite(qc, prId);
    },
    // A refusal (already posted, head moved) means the stored record changed: read it again.
    onError: () => void qc.invalidateQueries({ queryKey: prSonarKey(prId, head) }),
  });
}
