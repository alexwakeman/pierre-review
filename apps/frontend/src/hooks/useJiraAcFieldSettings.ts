import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JiraAcFieldSettingsBody, JiraAcFieldSettingsResponse, JiraOpenPointsFieldBody } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { workspaceKey } from './useActivity.js';
import { TICKET_REVIEW_STATES_KEY } from './useTicketReview.js';

// Settings → Trackers: which Jira field holds the acceptance criteria, per issue type, for ONE
// workspace (`GET`/`PUT /api/workspaces/:id/tracker/ac-fields`). Read from the stored tickets only.
// A change re-derives every stored ticket of that type, so the stored-ticket and ticket-review
// reads are refreshed too (as the old per-ticket picker did).

export const jiraAcFieldSettingsKey = (workspaceId: number | null): [string, string] => ['jira-ac-fields', workspaceKey(workspaceId)];

export function useJiraAcFieldSettings(workspaceId: number | null, enabled: boolean) {
  return useQuery<JiraAcFieldSettingsResponse>({
    queryKey: jiraAcFieldSettingsKey(workspaceId),
    queryFn: workspaceId == null || !enabled ? skipToken : () => api.jiraAcFieldSettings(workspaceId),
    staleTime: 60_000,
  });
}

export function useSetJiraAcFieldSetting(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<JiraAcFieldSettingsResponse, Error, JiraAcFieldSettingsBody>({
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.setJiraAcFieldSetting(workspaceId, body);
    },
    onSuccess: (data) => {
      qc.setQueryData(jiraAcFieldSettingsKey(workspaceId), data);
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['jira-ticket'] }),
        qc.invalidateQueries({ queryKey: ['ticket-reviews'] }),
        qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
      ]);
    },
  });
}

/** The OPEN-POINTS field for one issue type (docs/TRACKERS.md § Open points). Open points are derived
 *  on read, so only the list and the stored-ticket read refresh. */
export function useSetJiraOpenPointsField(workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation<JiraAcFieldSettingsResponse, Error, JiraOpenPointsFieldBody>({
    mutationFn: (body) => {
      if (workspaceId == null) return Promise.reject(new Error('No workspace selected'));
      return api.setJiraOpenPointsField(workspaceId, body);
    },
    onSuccess: (data) => {
      qc.setQueryData(jiraAcFieldSettingsKey(workspaceId), data);
      return qc.invalidateQueries({ queryKey: ['jira-ticket'] });
    },
  });
}
