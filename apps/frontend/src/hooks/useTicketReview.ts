import { useEffect, useState } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  ClaudeReviewTicketInput,
  PostTicketItemResponse,
  PrTicketReviewsResponse,
  StartTicketReviewBody,
  StartTicketReviewResponse,
  TicketReview,
  TicketReviewProgress,
  TicketReviewStatesResponse,
  TicketReviewStatus,
  TicketReviewStreamEvent,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';
import { anyTicketRunning, statesRequestIdents } from '../lib/ticketReview.js';

// THE TICKET REVIEW's server state (docs/API.md § Ticket review). One review per TICKET across
// every PR on it, so one run's result lives in SEVERAL PRs' caches: `done` invalidates
// `['ticket-reviews', prId]` for EVERY member, plus the Open PRs states key.
//
// Gated by the caller on `me.ai.enabled` (local, free) — the routes are absent in the cloud.

export const ticketReviewsKey = (prId: number): readonly unknown[] => ['ticket-reviews', prId];
// The Open PRs stacks' query-key PREFIX (the full key appends the sorted ident list).
export const TICKET_REVIEW_STATES_KEY = ['ticket-review-states'] as const;
// ⚠ ONE MUTATION KEY PER TICKET for every way a check is started (the PR pane's block, the Open PRs
// stack header), so `useIsMutating` lets each surface see the other's start in flight. A pasted
// story has no ident until the server mints one, so the story panel uses `manual:<prId>`.
export const ticketReviewStartKey = (ident: string): readonly unknown[] => ['ticket-review-start', ident];
export const pastedStoryStartIdent = (prId: number): string => `manual:${prId}`;

/** True while a start for this ticket is in flight, from ANY surface. */
export function useTicketReviewStarting(ident: string): boolean {
  return useIsMutating({ mutationKey: ticketReviewStartKey(ident) }) > 0;
}

/** Every ticket the PR is on, each with its latest run and currency. Polls only while one runs. */
export function useTicketReviews(prId: number, enabled: boolean) {
  return useQuery<PrTicketReviewsResponse>({
    queryKey: ticketReviewsKey(prId),
    queryFn: () => api.prTicketReviews(prId),
    enabled,
    // A run started elsewhere (the sweeper, another PR's button) shows up here as `running`; its
    // SSE stream then pushes progress, and this re-read catches the rows it does not cover.
    refetchInterval: (q) => (anyTicketRunning(q.state.data?.tickets.map((t) => t.state)) ? 5000 : false),
  });
}

/**
 * The Open PRs ticket stacks: ONE batched request for every listed ticket, never one per stack.
 * Polls every 5s only while one of them is running.
 */
export function useTicketReviewStates(idents: readonly (string | null | undefined)[], enabled: boolean) {
  const list = statesRequestIdents(idents);
  return useQuery<TicketReviewStatesResponse>({
    queryKey: [...TICKET_REVIEW_STATES_KEY, list.join('\n')],
    queryFn: () => api.ticketReviewStates(list),
    enabled: enabled && list.length > 0,
    refetchInterval: (q) => (anyTicketRunning(q.state.data?.states) ? 5000 : false),
  });
}

/**
 * After a START: every PR pane's ticket reviews (the prefix) and the states. The run belongs to
 * every PR on the ticket, and the starter knows only its own PR — a pane open on another member
 * would otherwise keep showing the old verdict as current, with no stream and no poll.
 */
function refreshAfterStart(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['ticket-reviews'] }),
    qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
  ]);
}

function refreshAfter(qc: QueryClient, prIds: readonly number[]): Promise<unknown> {
  return Promise.all([
    ...[...new Set(prIds)].map((id) => qc.invalidateQueries({ queryKey: ticketReviewsKey(id) })),
    qc.invalidateQueries({ queryKey: TICKET_REVIEW_STATES_KEY }),
  ]);
}

/**
 * Start a check. `ident` names the mutation key (the ticket, or `pastedStoryStartIdent(prId)`).
 * ⚠ The invalidation is RETURNED, so the button stays pending until the readers show the run.
 */
export function useStartTicketReview(ident: string) {
  const qc = useQueryClient();
  return useMutation<StartTicketReviewResponse, Error, StartTicketReviewBody>({
    mutationKey: ticketReviewStartKey(ident),
    mutationFn: (body) => api.startTicketReview(body),
    onSuccess: () => refreshAfterStart(qc),
  });
}

/** One run by id — the last SUCCEEDED run of a ticket while a newer one runs or failed. */
export function useTicketReviewById(id: number | null) {
  return useQuery<TicketReview>({
    queryKey: ['ticket-review', id],
    queryFn: () => api.ticketReview(id as number),
    enabled: id != null,
  });
}

/**
 * The story panel's Check: the Jira stories the server already lists go by ident, the rest as
 * pasted stories (`planStoryStart`). One mutation key for the panel (`pastedStoryStartIdent`).
 */
export function useStartStoryCheck(prId: number) {
  const qc = useQueryClient();
  return useMutation<StartTicketReviewResponse, Error, { idents: string[]; pasted: ClaudeReviewTicketInput[] }>({
    mutationKey: ticketReviewStartKey(pastedStoryStartIdent(prId)),
    mutationFn: async ({ idents, pasted }) => {
      const answers = await Promise.all([
        ...idents.map((ident) => api.startTicketReview({ prId, ident })),
        ...(pasted.length > 0 ? [api.startTicketReview({ prId, tickets: pasted })] : []),
      ]);
      return { runs: answers.flatMap((a) => a.runs) };
    },
    onSuccess: () => refreshAfterStart(qc),
  });
}

/**
 * Live progress of ONE run over SSE. On `done` every member PR's ticket reviews and the states
 * key are invalidated (a run is shared by every PR on the ticket).
 */
export function useTicketReviewStream(
  ticketReviewId: number | null,
  active: boolean,
): { status: TicketReviewStatus | null; progress: TicketReviewProgress | null } {
  const qc = useQueryClient();
  const [state, setState] = useState<{ status: TicketReviewStatus | null; progress: TicketReviewProgress | null }>({
    status: null,
    progress: null,
  });
  useEffect(() => {
    if (ticketReviewId == null || !active) {
      setState({ status: null, progress: null });
      return;
    }
    const ac = new AbortController();
    void sseStream<TicketReviewStreamEvent>(`/api/ticket-reviews/${ticketReviewId}/stream`, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'done') {
          setState({ status: e.status, progress: null });
          void refreshAfter(qc, e.memberPrIds);
        } else {
          setState({ status: e.status, progress: e.progress });
        }
      },
    }).catch(() => {
      /* aborted or network error — the polled list still reflects the DB */
    });
    return () => ac.abort();
  }, [ticketReviewId, active, qc]);
  return state;
}

/**
 * Post ONE item as a PR comment. ⚠ NO RETRY after a non-null `commentId`: the comment is on GitHub
 * even when `visible` is false, and a second POST would double-post (the server answers 409).
 */
export function usePostTicketItem(viewedPrId: number) {
  const qc = useQueryClient();
  return useMutation<
    PostTicketItemResponse,
    Error,
    { ticketReviewId: number; itemId: number; targetPrId: number; memberPrIds: readonly number[] }
  >({
    mutationFn: (v) => api.postTicketItem(v.ticketReviewId, v.itemId, viewedPrId),
    onSuccess: (_res, v) => {
      void refreshAfter(qc, [viewedPrId, ...v.memberPrIds]);
      // A comment on GitHub like any other: THE ONE WRITE SET (prCacheSync.ts).
      void invalidateAfterPrWrite(qc, v.targetPrId);
    },
    // 409 AlreadyPosted: the reading was stale — re-read it so the item shows as posted.
    onError: () => void refreshAfter(qc, [viewedPrId]),
  });
}
