import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { JiraTicketDetails } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { TICKET_REVIEW_STATES_KEY } from './useTicketReview.js';

// ONE STORED JIRA TICKET (`GET /api/prs/:id/tracker-ticket?key=`): the row core's tracker worker
// wrote when the PR was RECEIVED — reading it makes no Jira call. ⚠ CLICK-GATED: the callers
// enable it only once the reader opens a Story disclosure or a ticket modal, so nothing on a list
// or a card fetches on mount. Same key as the story panel's reads (ClaudeReviewFollowUp.tsx), so
// one cache serves both.

export const jiraTicketKey = (prId: number, key: string): readonly unknown[] => ['jira-ticket', prId, key];
const STALE_MS = 60_000;

export function useStoredJiraTicket(prId: number | null, key: string | null, enabled: boolean) {
  return useQuery<JiraTicketDetails>({
    queryKey: jiraTicketKey(prId ?? 0, key ?? ''),
    queryFn: () => api.jiraTicket(prId as number, key as string),
    enabled: enabled && prId != null && key != null && key !== '',
    staleTime: STALE_MS,
    retry: false,
  });
}

/**
 * Which field holds the criteria for this ticket's ISSUE TYPE in the PR's workspace (null = back
 * to the default). The server re-derives every stored ticket of that type, so the ticket reviews
 * reading them may now be out of date ("Story edited since"): re-read those too.
 */
export function useSetJiraAcField(prId: number, key: string) {
  const qc = useQueryClient();
  return useMutation<JiraTicketDetails, Error, string | null>({
    mutationKey: ['jira-ac-field', prId, key],
    mutationFn: (fieldId) => api.setJiraAcField(prId, key, fieldId),
    onSuccess: (details) => {
      qc.setQueryData(jiraTicketKey(prId, key), details);
      return Promise.all([
        qc.invalidateQueries({ queryKey: ['jira-ticket'], predicate: (q) => q.queryKey[2] !== key }),
        qc.invalidateQueries({ queryKey: ['ticket-reviews'] }),
        qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
      ]);
    },
  });
}
