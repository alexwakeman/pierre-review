import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { StartTicketReviewResponse, TicketRefResult } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { TICKET_LINKS_KEY } from './useTicketLinks.js';
import { TICKET_REVIEW_STATES_KEY, pastedStoryStartIdent, ticketReviewStartKey } from './useTicketReview.js';

// THE STORY CHECK'S PASTE BOX (docs/TRACKERS.md § Adding a ticket by hand). Two calls to ONE route,
// `POST /api/prs/:id/tracker-ticket/resolve`:
//   • `usePreviewTicketRefs` — read the pasted tickets (the chips' "found: title"), nothing stored;
//   • `useLinkAndCheckTickets` — add each readable one to the PR, then start ONE ticket review per
//     ticket (`{ prId, ident }`). It shares the story panel's mutation key, so its Check and the
//     panel's show one start in flight.

export function usePreviewTicketRefs(prId: number) {
  return useMutation<TicketRefResult[], Error, string[]>({
    mutationFn: async (refs) => (await api.resolveTicketRefs(prId, refs, false)).results,
  });
}

export interface LinkAndCheckResult {
  results: TicketRefResult[];
  runs: StartTicketReviewResponse['runs'];
  /** ident → why its review did not start (a 409, a 402, a network error). The ticket IS linked;
   *  only its chip stays, so a retry restarts only what did not start. */
  startFailed: Record<string, string>;
}

export function useLinkAndCheckTickets(prId: number) {
  const qc = useQueryClient();
  return useMutation<LinkAndCheckResult, Error, string[]>({
    mutationKey: ticketReviewStartKey(pastedStoryStartIdent(prId)),
    mutationFn: async (refs) => {
      const { results } = await api.resolveTicketRefs(prId, refs, true);
      const idents = [
        ...new Set(
          results
            .filter((r) => (r.status === 'linked' || r.status === 'already') && r.ident != null)
            .map((r) => r.ident as string),
        ),
      ];
      // One review per ticket: never a combined run. ⚠ SETTLED, not Promise.all: one refused start
      // must not throw away the others' answers (some already started, maybe billed) and make a
      // retry start them again.
      const settled = await Promise.allSettled(idents.map((ident) => api.startTicketReview({ prId, ident })));
      const runs: StartTicketReviewResponse['runs'] = [];
      const startFailed: Record<string, string> = {};
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') runs.push(...s.value.runs);
        else {
          const e = s.reason;
          startFailed[idents[i]!] = (e instanceof Error && e.message) || 'Could not start the check.';
        }
      });
      return { results, runs, startFailed };
    },
    // The PR now carries the added tickets: its chips, the Open PRs ticket row and every story
    // check list. Returned, so the button stays pending until the blocks show the runs.
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['pr', prId] }),
        qc.invalidateQueries({ queryKey: TICKET_LINKS_KEY }),
        qc.invalidateQueries({ queryKey: ['ticket-reviews'] }),
        qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
      ]),
  });
}

/** Remove a ticket a person added by hand (`TicketRef.manual`) from one PR. */
export function useRemoveManualTicket(prId: number) {
  const qc = useQueryClient();
  return useMutation<{ removed: number }, Error, string>({
    mutationFn: (key) => api.removeManualTicket(prId, key),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['pr', prId] }),
        qc.invalidateQueries({ queryKey: TICKET_LINKS_KEY }),
        qc.invalidateQueries({ queryKey: ['ticket-reviews'] }),
        qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
      ]),
  });
}
