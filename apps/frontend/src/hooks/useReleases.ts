import { skipToken, useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateReleaseBody,
  CreateReleaseResponse,
  ReleaseDetail,
  ReleasePreviewResponse,
  ReleaseSettingsResponse,
  ReleasesRefreshResponse,
  ReleasesResponse,
  SetReleaseSettingsBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// RELEASES (docs/RELEASES.md) — This Sprint → Releases and Settings → Releases.
//
// ⚠ THE TAB FETCHES ONE THING ON MOUNT: `GET /api/releases` (DB only). The dialog's preview (notes +
// comment; it may call the model) runs only while the dialog is OPEN — a reader's click — and a stored
// release is read only when the reader asks to see it.
// ⚠ Every key carries `ws:<id>`; every query idles while `workspaceId` is null (not resolved yet).
// ⚠ SHARED MUTATION KEY for Confirm, read through `useIsMutating`: a tab switch mid-request must not
// offer a second press (it would write nothing new — every write is claimed — but it would confuse).

export function releasesKey(workspaceId: number | null): [string, string] {
  return ['releases', workspaceKey(workspaceId)];
}

export function releaseSettingsKey(workspaceId: number | null): [string, string] {
  return ['release-settings', workspaceKey(workspaceId)];
}

export function useReleases(workspaceId: number | null) {
  return useQuery<ReleasesResponse>({
    queryKey: releasesKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.releases(workspaceId),
    staleTime: 30_000,
  });
}

/** Refresh: `POST /api/releases/refresh` (the held tickets read again from the tracker — a reader's
 *  press, never a mount), and the answer becomes the check. */
export function useRefreshReleases(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<ReleasesRefreshResponse, Error, void>({
    mutationKey: ['releases-refresh', workspaceKey(workspaceId)],
    mutationFn: () => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.refreshReleases(workspaceId);
    },
    onSuccess: (data) => {
      const { reread: _r, unread: _u, ...rest } = data;
      qc.setQueryData<ReleasesResponse>(releasesKey(data.workspaceId), rest);
    },
  });
}

export function useReleaseSettings(workspaceId: number | null) {
  return useQuery<ReleaseSettingsResponse>({
    queryKey: releaseSettingsKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.releaseSettings(workspaceId),
    staleTime: 60_000,
  });
}

export function useSetReleaseSettings(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<ReleaseSettingsResponse, Error, SetReleaseSettingsBody>({
    mutationKey: ['release-settings-save', workspaceKey(workspaceId)],
    mutationFn: (body) => {
      // Refuses rather than sending a request the server would answer for the Default workspace.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.setReleaseSettings(workspaceId, body);
    },
    onSuccess: (data) => {
      qc.setQueryData(releaseSettingsKey(data.workspaceId), data);
      // A suffix change re-classifies every tag: the check is read again.
      void qc.invalidateQueries({ queryKey: releasesKey(data.workspaceId) });
    },
  });
}

/** The dialog's preview: notes per repo, the comment, the problems. Only while `open`. The repo
 *  list is fixed for the dialog's life (unticking re-checks on the client, never re-previews). */
export function useReleasePreview(workspaceId: number | null, repoIds: readonly number[], open: boolean) {
  const ids = [...repoIds].sort((a, b) => a - b);
  return useQuery<ReleasePreviewResponse>({
    queryKey: ['release-preview', workspaceKey(workspaceId), ids.join(',')],
    queryFn: workspaceId == null || !open || ids.length === 0 ? skipToken : () => api.releasePreview(workspaceId, { repoIds: ids }),
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export const CREATE_RELEASE_KEY = 'create-release';

export function useCreateRelease(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<CreateReleaseResponse, Error, CreateReleaseBody>({
    mutationKey: [CREATE_RELEASE_KEY, workspaceKey(workspaceId)],
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.createRelease(workspaceId, body);
    },
    onSettled: (data) => {
      // Written or stopped, the check has moved (new release tags are the baseline; a stopped one
      // means something changed): read it again, and the settings' `hasReleases` with it.
      const ws = data?.workspaceId ?? workspaceId;
      void qc.invalidateQueries({ queryKey: releasesKey(ws) });
      void qc.invalidateQueries({ queryKey: releaseSettingsKey(ws) });
      void qc.removeQueries({ queryKey: ['release-preview', workspaceKey(ws)] });
      if (data?.outcome === 'written') qc.setQueryData(['release', data.release.id], data.release);
    },
  });
}

export function useCreatingRelease(workspaceId: number | null): boolean {
  return useIsMutating({ mutationKey: [CREATE_RELEASE_KEY, workspaceKey(workspaceId)] }) > 0;
}

/** One stored release (its notes and steps) — only when the reader opens it. */
export function useRelease(id: number | null) {
  return useQuery<ReleaseDetail>({
    queryKey: ['release', id],
    queryFn: id == null ? skipToken : () => api.release(id),
    staleTime: 60_000,
  });
}
