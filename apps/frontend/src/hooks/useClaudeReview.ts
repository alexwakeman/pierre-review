import { useEffect, useRef, useState } from 'react';
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  ActiveReviewsResponse,
  ClaudeReview,
  ClaudeReviewListResponse,
  ClaudeReviewModel,
  ClaudeReviewResponse,
  ClaudeReviewStatesResponse,
  ClaudeReviewStatusResponse,
  ClaudeReviewStreamEvent,
  ClaudeReviewVerdict,
} from '@pierre-review/shared';
import { CLAUDE_REVIEW_STATES_MAX_IDS, DEFAULT_CLAUDE_REVIEW_MODEL } from '@pierre-review/shared';
import { api, ApiError } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { useFilters } from '../store/filters.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';
import { anyReviewInFlight, reviewTabPill, type ReviewTabPill } from '../lib/claudeReviewColumn.js';
import { anyFixRunning } from '../lib/claudeAutoReview.js';
import {
  activeReviewSignatures,
  changedActivePrIds,
  prHasActiveReview,
} from '../lib/claudeReviewActive.js';

export function useClaudeReview(prId: number | null) {
  return useQuery<ClaudeReviewResponse>({
    queryKey: ['claude-review', prId],
    queryFn: () => api.claudeReview(prId as number),
    enabled: prId != null,
    // While an AUTO review waits in its lane it has no row, so nothing else tells this pane when
    // it starts: re-read until it does (then the row's own running state + the SSE stream take
    // over). Idle otherwise.
    // While the sweeper only HOLDS it (waiting for activity to settle), a slower re-read
    // is enough: that wait is minutes long.
    refetchInterval: (q) =>
      q.state.data?.autoReview === 'queued' ? 5000 : q.state.data?.autoReviewWaiting != null ? 30_000 : false,
  });
}

/**
 * The outcome pill on the PR pane's "Claude Review" tab label. The SAME query as the tab
 * (`['claude-review', prId]`, DB-only), so opening the tab reads the cache and this adds no second
 * request. With the tab shut there is no SSE stream to say a run started or ended, so this
 * observer also keeps the shared active list (`['claude-reviews-active']`, ONE request for every
 * PR) polled while the pane is open: `useClaudeReviewActiveSync` invalidates this PR's review the
 * moment it enters or leaves that list, and the pill re-reads every 5s while it is in it.
 */
export function useClaudeReviewTabPill(prId: number, enabled: boolean): ReviewTabPill | null {
  const starting = useClaudeReviewStarting(prId);
  const { data: active } = useQuery<ActiveReviewsResponse>({
    queryKey: ['claude-reviews-active'],
    queryFn: api.activeClaudeReviews,
    enabled,
    refetchInterval: ACTIVE_POLL_WHILE_PANE_OPEN_MS,
  });
  const inActiveList = prHasActiveReview(active?.reviews, prId);
  const { data } = useQuery<ClaudeReviewResponse>({
    queryKey: ['claude-review', prId],
    queryFn: () => api.claudeReview(prId),
    enabled,
    refetchInterval: (q) => {
      const d = q.state.data;
      if (inActiveList) return 5000;
      if (d == null) return false;
      const inFlight =
        d.review?.status === 'running' || d.review?.status === 'queued' || d.autoReview != null;
      return inFlight ? 5000 : d.autoReviewWaiting != null ? 30_000 : false;
    },
  });
  return enabled ? reviewTabPill(data, starting) : null;
}

/** The active-list cadence while a PR pane is open. The banner polls faster (2.5s) only after a
 *  person starts a run; React Query uses the shortest interval among mounted observers. */
const ACTIVE_POLL_WHILE_PANE_OPEN_MS = 5000;

/**
 * Mounted ONCE (App). A PASSIVE observer of `['claude-reviews-active']` — it never fetches; the
 * banner and the open pane's tab pill do — that invalidates `['claude-review', prId]` and the Open
 * PRs column for every PR whose entry appeared, changed or left the list between two polls. That
 * is how a run started or finished elsewhere (auto review, the Open PRs table, another tab) reaches
 * a pane whose Claude Review tab is shut. See lib/claudeReviewActive.ts.
 */
export function useClaudeReviewActiveSync(): void {
  const qc = useQueryClient();
  const { data, dataUpdatedAt } = useQuery<ActiveReviewsResponse>({
    queryKey: ['claude-reviews-active'],
    queryFn: api.activeClaudeReviews,
    enabled: false,
  });
  const prevRef = useRef<Map<number, string> | null>(null);
  useEffect(() => {
    if (data == null) return;
    const next = activeReviewSignatures(data.reviews);
    const changed = changedActivePrIds(prevRef.current, next);
    prevRef.current = next;
    if (changed.length === 0) return;
    for (const prId of changed) void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
    void qc.invalidateQueries({ queryKey: CLAUDE_REVIEW_STATES_KEY });
  }, [data, dataUpdatedAt, qc]);
}

// Fetch a specific past run by id (for the history selector when viewing a run
// other than the latest).
export function useClaudeReviewById(reviewId: number | null) {
  return useQuery<ClaudeReview>({
    queryKey: ['claude-review-by-id', reviewId],
    queryFn: () => api.claudeReviewById(reviewId as number),
    enabled: reviewId != null,
  });
}

// Poll the status endpoint while a run is active; the consumer flips `active` off
// once status leaves 'running' and refetches the full review. Retained as a
// fallback; the live UI uses useClaudeReviewStream (SSE) below.
export function useClaudeReviewStatus(prId: number | null, active: boolean) {
  return useQuery<ClaudeReviewStatusResponse>({
    queryKey: ['claude-review-status', prId],
    queryFn: () => api.claudeReviewStatus(prId as number),
    enabled: prId != null && active,
    refetchInterval: active ? 1500 : false,
  });
}

// Live progress via SSE — a single connection that PUSHES each phase / activity /
// usage change in real time (no 1.5s poll lag), then a terminal `done` that
// invalidates the full review so the finished result loads. `active` mirrors the
// run being in flight (running | queued); when it flips off, the stream is aborted.
// Returns a `{ status }` shape compatible with useClaudeReviewStatus.
export function useClaudeReviewStream(
  prId: number | null,
  active: boolean,
): { status: ClaudeReviewStatusResponse | null } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ClaudeReviewStatusResponse | null>(null);

  useEffect(() => {
    if (prId == null || !active) {
      setStatus(null);
      return;
    }
    const ac = new AbortController();
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
      // The Open PRs table's column reads the same runs.
      void qc.invalidateQueries({ queryKey: CLAUDE_REVIEW_STATES_KEY });
    };
    void sseStream<ClaudeReviewStreamEvent>(
      `/api/prs/${prId}/claude-review/stream`,
      {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'done') {
            settle();
            setStatus({ status: e.status, reviewId: e.reviewId, progress: null });
          } else {
            setStatus({
              status: e.status,
              reviewId: e.reviewId,
              progress: e.progress,
            });
          }
        },
      },
    ).catch(() => {
      /* aborted or network error — the review query still reflects the DB state */
    });
    return () => ac.abort();
  }, [prId, active, qc]);

  return { status };
}

// ⚠ ONE MUTATION KEY PER PR FOR EVERY WAY A RUN IS STARTED — the Claude Review tab's Run button
// and the Open PRs table's Review button both use it, so `useIsMutating` makes each surface see the
// other's start in flight (a per-mount `isPending` resets on a tab switch mid-request).
export const claudeReviewStartKey = (prId: number): readonly unknown[] => ['claude-review-start', prId];

// The column's query-key PREFIX (the full key appends the sorted id list).
export const CLAUDE_REVIEW_STATES_KEY = ['claude-review-states'] as const;

/** True while a start request for this PR is in flight, from ANY surface. */
export function useClaudeReviewStarting(prId: number): boolean {
  return useIsMutating({ mutationKey: claudeReviewStartKey(prId) }) > 0;
}

// What every successful start does, whichever surface pressed it: wake the global banner (the
// "review started" toast polls only after a kickoff) and refetch both readers of the run.
// ⚠ RETURNED, so the mutation stays pending until the readers show the queued run: a void
// invalidate re-enabled the Review button on the STALE state for one round trip, and a second
// click there got "already running" back from the server.
function afterReviewStarted(qc: QueryClient, prId: number): Promise<unknown> {
  useFilters.getState().bumpClaudeReviewKickoff();
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
    qc.invalidateQueries({ queryKey: ['claude-review-status', prId] }),
    qc.invalidateQueries({ queryKey: CLAUDE_REVIEW_STATES_KEY }),
  ]);
}

export function useGenerateReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: claudeReviewStartKey(prId),
    // No user story: the PR review looks at the code. Stories are the ticket review's
    // (hooks/useTicketReview.ts), a separate run.
    mutationFn: (vars: { model: ClaudeReviewModel }) => api.generateClaudeReview(prId, vars.model),
    onSuccess: () => afterReviewStarted(qc, prId),
    // 409 AutoReviewInProgress: the pane's reading was stale (it polls only while it already
    // knows of a queued hold). Re-read it, so the hold shows and its 5s poll starts — otherwise
    // the button comes back and every click is refused again.
    onError: (err) =>
      isAutoReviewHoldError(err)
        ? Promise.all([
            qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
            qc.invalidateQueries({ queryKey: CLAUDE_REVIEW_STATES_KEY }),
          ])
        : undefined,
  });
}

/**
 * The Open PRs table's "Claude review" column: the LATEST run for each listed PR, ONE request for
 * the whole list, never one per row. Enabled only with the Claude Review capability. Polls every
 * 5s only while one of the listed PRs is queued or running. The list is capped at the route's
 * limit; rows past it get no reading (the caller renders nothing for them).
 */
export function useClaudeReviewStates(prIds: readonly number[], enabled: boolean) {
  const ids = [...new Set(prIds)].sort((a, b) => a - b).slice(0, CLAUDE_REVIEW_STATES_MAX_IDS);
  return useQuery<ClaudeReviewStatesResponse>({
    queryKey: [...CLAUDE_REVIEW_STATES_KEY, ids.join(',')],
    queryFn: () => api.claudeReviewStates(ids),
    enabled: enabled && ids.length > 0,
    // …or while a fix runs, so "Fixing…" turns into "Fix ready" without a reload.
    refetchInterval: (q) =>
      anyReviewInFlight(q.state.data?.states) || anyFixRunning(q.state.data?.states) ? 5000 : false,
  });
}

/**
 * Start a review from the Open PRs table: the default model, no picker, through the SAME start
 * route and queue as the tab. No user story: stories are the ticket review's, a separate run.
 */
export function useStartReviewFromList(prId: number) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, void>({
    mutationKey: claudeReviewStartKey(prId),
    mutationFn: () => api.generateClaudeReview(prId, DEFAULT_CLAUDE_REVIEW_MODEL),
    onSuccess: () => afterReviewStarted(qc, prId),
    // 409 AutoReviewInProgress: the table's reading was stale (an auto review took the PR since
    // the last poll). RETURNED, so the mutation stays pending until the column re-reads and shows
    // the hold — the button must not come back in between.
    onError: (err) =>
      isAutoReviewHoldError(err)
        ? Promise.all([
            qc.invalidateQueries({ queryKey: CLAUDE_REVIEW_STATES_KEY }),
            qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
          ])
        : undefined,
  });
}

/** The start route's refusal while an auto review holds the PR (409 AutoReviewInProgress). */
export function isAutoReviewHoldError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'AutoReviewInProgress';
}

// Post a single finding as a standalone comment. The server auto-routes it: inline
// on its line / on the file's first change (file in the diff), or as a standalone
// PR-level comment (file outside the diff).
export function usePostFinding(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { findingId: number }) =>
      api.postClaudeFinding(vars.findingId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
      // A comment on GitHub like any other: THE ONE WRITE SET (prCacheSync.ts).
      void invalidateAfterPrWrite(qc, prId);
    },
  });
}

// "Post reply" on a previous-review reply status (an accepted reply is answered AND resolved). The
// mutation key is per (review, item) and SHARED, so a remount mid-post still reads it as pending;
// a 409 (already posted, by a click or an auto run) refetches the review so the row says so.
export const followUpReplyMutationKey = (reviewId: number, priorFindingId: number) =>
  ['follow-up-reply', reviewId, priorFindingId] as const;

export function usePostFollowUpReply(prId: number, reviewId: number, priorFindingId: number) {
  const qc = useQueryClient();
  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
    void qc.invalidateQueries({ queryKey: ['claude-review-by-id', reviewId] });
  };
  return useMutation({
    mutationKey: followUpReplyMutationKey(reviewId, priorFindingId),
    mutationFn: () => api.postFollowUpReply(reviewId, priorFindingId),
    onSuccess: () => {
      refresh();
      void invalidateAfterPrWrite(qc, prId);
    },
    onError: refresh,
  });
}

export function useCancelReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelClaudeReview(prId),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function useUpdateReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      reviewId: number;
      userBody?: string;
      userVerdict?: ClaudeReviewVerdict;
    }) =>
      api.updateClaudeReview(vars.reviewId, {
        userBody: vars.userBody,
        userVerdict: vars.userVerdict,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

export function useUpdateFinding(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      findingId: number;
      included?: boolean;
      editedBody?: string;
    }) =>
      api.updateClaudeFinding(vars.findingId, {
        included: vars.included,
        editedBody: vars.editedBody,
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] }),
  });
}

// Global poll of all in-flight reviews (for the progress banner). Polls at a slow
// cadence always, so a review started from one PR is visible while you explore
// elsewhere.
export function useActiveClaudeReviews(enabled: boolean) {
  return useQuery<ActiveReviewsResponse>({
    queryKey: ['claude-reviews-active'],
    queryFn: api.activeClaudeReviews,
    enabled,
    refetchInterval: 2500,
  });
}

// All Claude reviews across the timeline window (one entry per PR — its latest
// succeeded run), for the history modal. Gated by `enabled` so it only fetches
// when the modal is open.
export function useAllClaudeReviews(enabled: boolean) {
  return useQuery<ClaudeReviewListResponse>({
    queryKey: ['claude-reviews', 'all'],
    queryFn: api.listAllClaudeReviews,
    enabled,
  });
}

// ⚠ THE THREE ANTHROPIC-KEY HOOKS ARE GONE — `useSetClaudeKey`, `useClaudeKeyStatus` and
// `useSetClaudeKeyGlobal`, along with the `['claude-key-status']` query key and the Settings form
// that drove them. The BYO key stored in `~/.pierre-review/config.json` is retired: local Claude
// Review now has exactly TWO credential rungs — an ambient Claude session (preferred, so a
// subscription pays) and the environment's `ANTHROPIC_API_KEY` — and `ClaudeReviewResponse.auth`
// already reports which one answered. There is nothing for a hook to set, and nothing for one to
// read: `hasUserKey` left the wire with the routes.
//
// (`useSetClaudeKey(prId)` was additionally DEAD before any of this — no caller anywhere — so its
// removal is not part of the retirement, merely overdue.)

export function usePostReview(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      reviewId: number;
      userVerdict: ClaudeReviewVerdict;
      dryRun?: boolean;
    }) => api.postClaudeReview(vars.reviewId, vars.userVerdict, vars.dryRun ?? false),
    onSuccess: (_data, vars) => {
      if (!vars.dryRun) {
        void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
        // A real review with a verdict (approve / request changes) moves the PR's review
        // standing and the board: THE ONE WRITE SET (prCacheSync.ts). A dry run wrote nothing.
        void invalidateAfterPrWrite(qc, prId);
      }
    },
  });
}
