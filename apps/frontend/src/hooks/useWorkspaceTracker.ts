import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  TrackerCopyBody,
  TrackerCopySourcesResponse,
  WorkspaceTrackerSettings,
  WorkspaceTrackerUpdate,
} from '@pierre-review/shared';
import { TRACKER_PROVIDER_FIELDS } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { TICKET_LINKS_KEY } from './useTicketLinks.js';
import { TICKET_MERGED_PRS_KEY } from './useTicketMergedPrs.js';
import { jiraAcFieldSettingsKey } from './useJiraAcFieldSettings.js';

// THE WORKSPACE'S ISSUE TRACKER (apiVersion 23; docs/TRACKERS.md). One tracker per
// workspace on core's `workspace_trackers` row: `GET`/`PUT /api/workspaces/:id/tracker`. It left the
// plugin's per-workspace settings route with the rest of the tracker, so it is answered in every
// install, and the token is still WRITE-ONLY (`jira.hasToken`).
//
// ⚠ THE KEY CARRIES `ws:<id>` AND THE FETCH IDLES ON AN UNRESOLVED SCOPE (`workspaceId === null`
// is "not resolved yet"), like every scoped query.

export function workspaceTrackerKey(workspaceId: number | null): [string, string] {
  return ['workspace-tracker', workspaceKey(workspaceId)];
}

export function useWorkspaceTracker(enabled: boolean, workspaceId: number | null) {
  return useQuery<WorkspaceTrackerSettings>({
    queryKey: workspaceTrackerKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.workspaceTracker(workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Whether THIS workspace links tickets — a provider AND a non-blank base URL, the server's one
 * liveness test (tracker/settings.ts `isIssueConfigured`) — the gate on the Open PRs "Group by
 * ticket" view and the ticket row: "has this workspace set one up".
 * false while unresolved — nothing tracker-shaped renders on a guess.
 */
export function useTrackerOn(workspaceId: number | null): boolean {
  return useTrackerState(workspaceId).on;
}

/**
 * `useTrackerOn` plus whether the answer is IN: `known` is false until the tracker settings have
 * answered (or failed) for a resolved workspace. The Open PRs cards wait on it before their first
 * paint, so a tracker answer landing late cannot regroup the page under the reader.
 */
export function useTrackerState(workspaceId: number | null): { on: boolean; known: boolean } {
  const { data, isError } = useWorkspaceTracker(workspaceId != null, workspaceId);
  const known = workspaceId != null && (data != null || isError);
  const issue = data?.issue;
  if (issue == null || issue.provider == null) return { on: false, known };
  // A provider that asks for no base URL (GitHub Issues: github.com) is on as soon as it is chosen.
  const on = !TRACKER_PROVIDER_FIELDS[issue.provider].baseUrl || (issue.baseUrl ?? '').trim() !== '';
  return { on, known };
}

export function useUpdateWorkspaceTracker(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceTrackerSettings, Error, WorkspaceTrackerUpdate>({
    mutationFn: (patch) => {
      // Refuses rather than writing to a workspace the reader is not looking at.
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.updateWorkspaceTracker(workspaceId, patch);
    },
    onSuccess: (settings) => {
      qc.setQueryData(workspaceTrackerKey(workspaceId), settings);
      // This workspace may now be (or stop being) another workspace's copy source.
      void qc.invalidateQueries({ queryKey: [TRACKER_COPY_SOURCES_KEY] });
      // Ticket links are computed on read into the PR-detail payload, which is IndexedDB-persisted
      // with staleTime:Infinity — a provider / base URL / key list / match scope change would not
      // appear on already-viewed PRs without this. A saved or removed token flips each ticket's
      // `canFetchDetails`. The Open PRs ticket row and stacks re-read too.
      void qc.invalidateQueries({ queryKey: ['pr'] });
      void qc.invalidateQueries({ queryKey: ['thread'] });
      void qc.invalidateQueries({ queryKey: TICKET_LINKS_KEY });
      void qc.invalidateQueries({ queryKey: TICKET_MERGED_PRS_KEY });
    },
  });
}

// "Copy from another workspace" (docs/TRACKERS.md § Copying a tracker): the account's OTHER workspaces
// with a tracker set up, fetched when the reader opens the picker.
export const TRACKER_COPY_SOURCES_KEY = 'tracker-copy-sources';

export function useTrackerCopySources(workspaceId: number | null, enabled: boolean) {
  return useQuery<TrackerCopySourcesResponse>({
    queryKey: [TRACKER_COPY_SOURCES_KEY, workspaceKey(workspaceId)],
    queryFn: workspaceId == null || !enabled ? skipToken : () => api.trackerCopySources(workspaceId),
    staleTime: 60_000,
  });
}

/** The copy replaces this workspace's whole tracker setup, so everything the tracker feeds re-reads:
 *  the PUT's set, plus the criteria-field list, the stored tickets and This Sprint. */
export function useCopyWorkspaceTracker(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceTrackerSettings, Error, TrackerCopyBody>({
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.copyWorkspaceTracker(workspaceId, body);
    },
    onSuccess: (settings) => {
      qc.setQueryData(workspaceTrackerKey(workspaceId), settings);
      for (const queryKey of [
        [TRACKER_COPY_SOURCES_KEY],
        jiraAcFieldSettingsKey(workspaceId),
        ['pr'],
        ['thread'],
        TICKET_LINKS_KEY,
        TICKET_MERGED_PRS_KEY,
        ['jira-ticket'],
        ['ticket-reviews'],
        ['sprint-graph', workspaceKey(workspaceId)],
      ]) {
        void qc.invalidateQueries({ queryKey });
      }
    },
  });
}
