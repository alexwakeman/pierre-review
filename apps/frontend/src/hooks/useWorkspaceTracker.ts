import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceTrackerSettings, WorkspaceTrackerUpdate } from '@pierre-review/shared';
import { TRACKER_PROVIDER_FIELDS } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { TICKET_LINKS_KEY } from './useTicketLinks.js';
import { TICKET_MERGED_PRS_KEY } from './useTicketMergedPrs.js';

// THE WORKSPACE'S ISSUE TRACKER (CORE, free — apiVersion 23; docs/TRACKERS.md). One tracker per
// workspace on core's `workspace_trackers` row: `GET`/`PUT /api/workspaces/:id/tracker`. It left the
// plugin's per-workspace settings route with the rest of the tracker, so it is answered in every
// install — no capability, no plugin — and the token is still WRITE-ONLY (`jira.hasToken`).
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
 * liveness test (tracker/settings.ts `isIssueConfigured`). It replaced the Pro `issueLinks`
 * capability as the gate on the Open PRs "Group by ticket" view and the ticket row: the tracker is
 * free now, so the question is no longer "may this account" but "has this workspace set one up".
 * false while unresolved — nothing tracker-shaped renders on a guess.
 */
export function useTrackerOn(workspaceId: number | null): boolean {
  const { data } = useWorkspaceTracker(workspaceId != null, workspaceId);
  const issue = data?.issue;
  if (issue == null || issue.provider == null) return false;
  // A provider that asks for no base URL (GitHub Issues: github.com) is on as soon as it is chosen.
  return !TRACKER_PROVIDER_FIELDS[issue.provider].baseUrl || (issue.baseUrl ?? '').trim() !== '';
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
