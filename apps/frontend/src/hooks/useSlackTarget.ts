import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  WorkspaceSlackTargetResponse,
  WorkspaceSlackTargetUpdate,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';

// The Slack delivery target for ONE workspace (Pro `workspace_slack_targets`;
// GET/PUT/DELETE /api/pro/slack/target?workspace=<id>).
//
// ⚠ THE KEY CARRIES `ws:<id>`, unlike the plural predecessor it replaces. That one fetched the
// ACCOUNT's whole selection, so a scope segment would have fragmented the cache into N identical
// copies; this response is ONE workspace's row, so an unsegmented key would serve the workspace
// the reader opened first to every workspace they switch to afterwards — and the Save that
// followed would write a channel onto the wrong team.
//
// ⚠ THE FETCH IDLES ON AN UNRESOLVED SCOPE. `workspaceId === null` means "not resolved yet"; a
// request sent before it lands is answered from the account's DEFAULT workspace.
//
// ⚠ ALL THREE VERBS ANSWER THE SAME SHAPE, which is why one key holds the result of each: after a
// DELETE the server's own `{target: null, configuredCount: n-1}` seeds the cache, so the UI never
// has to invent the post-delete state (or the freed cap slot).
export function slackTargetKey(workspaceId: number | null): [string, string] {
  return ['slack-target', workspaceKey(workspaceId)];
}

export function useSlackTarget(enabled: boolean, workspaceId: number | null) {
  return useQuery<WorkspaceSlackTargetResponse>({
    queryKey: slackTargetKey(workspaceId),
    queryFn: workspaceId == null ? skipToken : () => api.slackTarget(workspaceId),
    enabled,
    staleTime: 60_000,
  });
}

export function useUpdateSlackTarget(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceSlackTargetResponse, Error, WorkspaceSlackTargetUpdate>({
    mutationFn: (patch) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.updateSlackTarget(workspaceId, patch);
    },
    // The PUT returns the stored truth (the cap / missing-webhook / bad-webhook refusals are all
    // 400s, so a resolved response is authoritative). Seeding the cache from it rather than
    // invalidating means the freshly-stored cadence and the new `configuredCount` land together.
    onSuccess: (resp) => {
      qc.setQueryData(slackTargetKey(workspaceId), resp);
    },
  });
}

// ⚠ THE OFF SWITCH IS ITS OWN VERB. Under the deleted whole-selection PUT, "stop sending to this
// workspace" was expressed by OMITTING it from a submitted list, so any client bug that shortened
// the list silently cancelled deliveries. `cadence: 'off'` pauses and KEEPS the channel; this
// removes the row and frees a slot under the cap.
export function useDeleteSlackTarget(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<WorkspaceSlackTargetResponse, Error, void>({
    mutationFn: () => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.deleteSlackTarget(workspaceId);
    },
    onSuccess: (resp) => {
      qc.setQueryData(slackTargetKey(workspaceId), resp);
    },
  });
}
