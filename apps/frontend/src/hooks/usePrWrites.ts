import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AddReviewCommentBody,
  MergeMethod,
  RequestReviewersBody,
  UpdateBranchBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { reviewerRequestView, type ReviewerRequestView } from '../lib/reviewerRequest.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

// PR write mutations. The backend stamps the local DB before it answers, so a refetch shows the
// change at once — and EVERY write refetches through ONE set, `invalidateAfterPrWrite`
// (prCacheSync.ts): the PR's own detail/threads/merge control, every workspace screen, and the
// Pending board's three reads together. A write that hand-picks its own keys is how a card
// outlives the fact that retired it. The helper also opens SyncStatus's fast `['repos']` poll, so
// the server's follow-up re-reads (GitHub computes mergeability and CI seconds later) reach the
// screen too.

export function useReplyToThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: number; threadId: number; body: string }) =>
      api.replyToThread(vars.threadId, { body: vars.body }),
    onSuccess: (_data, vars) => {
      // A reply can end "Unanswered threads" and move the my_turn ball, so the board moves too.
      void invalidateAfterPrWrite(qc, vars.prId, { threadIds: [vars.threadId] });
    },
  });
}

export function useResolveThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: number; threadId: number; resolved: boolean }) =>
      api.resolveThread(vars.threadId, { resolved: vars.resolved }),
    onSuccess: (_data, vars) => {
      void invalidateAfterPrWrite(qc, vars.prId, { threadIds: [vars.threadId] });
    },
  });
}

// Bulk-resolve the likely-addressed review-bot threads on a PR (Phase 3 "clear the bot
// backlog in one click"). The server re-derives eligibility; we send the reviewed thread ids.
export function useResolveBotThreads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: number; threadIds: number[] }) =>
      api.resolveBotThreads(vars.prId, { threadIds: vars.threadIds }),
    onSuccess: (_data, vars) => {
      void invalidateAfterPrWrite(qc, vars.prId, { threadIds: vars.threadIds });
    },
  });
}

export function useCreatePrComment(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.createPrComment(prId, { body }),
    // A PR comment can hand the my_turn ball back, so the board is part of this set too.
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

export function useApprovePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: string) =>
      api.approvePr(prId, body !== undefined ? { body } : undefined),
    // Approving is the most common way a Pending "Review or reply" card stops being true: the
    // route clears the viewer's `review_requests` row and re-reads the PR, so the refetch turns
    // the card into a `merge` card or retires it. GitHub's blocked → clean flip usually lands a
    // few seconds later, and reaches the board through the fast `['repos']` poll.
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

export function useRequestChangesPr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: string) =>
      api.requestChanges(prId, body !== undefined ? { body } : undefined),
    // The same cascade as approve: the route clears the viewer's review request and re-reads
    // the PR, so the refetch moves the Pending card and the pane's standing.
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

// The merge control's options (allowed methods + live mergeability). Fetched lazily — enable it
// only when the control is open, so the hot PR-detail path isn't slowed by a live GitHub call.
// A DISABLED observer still reads the cache: that is how the Pending board's merge row borrows a
// queue position somebody already paid for, without fetching one itself.
export function useMergeOptions(prId: number, enabled: boolean) {
  return useQuery({
    queryKey: ['merge-options', prId],
    queryFn: () => api.mergeOptions(prId),
    enabled,
    staleTime: 30_000,
  });
}

// ---- The two FORWARD writes' shared mutation keys -------------------------------------------
//
// ⚠ EXPLICIT KEYS, BECAUSE TWO COMPONENTS MUST SEE ONE IN-FLIGHT STATE. `MergeControl` owns the
// mutation and lives inside the Pending card's merge row; the row ALSO wants to say "Merging…"
// beside it, and PrDetail's own Actions row mounts a second `useMergePr(prId)` for the same PR.
// A per-mount `isPending` is invisible to every other mount (the CiAnalysisCard lesson), so the
// in-flight fact is read off the KEY via `useIsMutating` instead. One spelling, exported, so a
// reader and a writer cannot address different rows.
export function mergePrMutationKey(prId: number): unknown[] {
  return ['merge-pr', prId];
}
export function updateBranchMutationKey(prId: number): unknown[] {
  return ['update-pr-branch', prId];
}

// Merge the PR. Invalidates the PR + every surface that shows PR state (timeline, open-PRs,
// triage queues, the feeds) — the backend optimistically stamps merged, so the refetch is fresh.
export function useMergePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: mergePrMutationKey(prId),
    mutationFn: (method: MergeMethod) => api.mergePr(prId, { method }),
    // The `merge` card the click came from has to leave the board. ⚠ An INVALIDATION, not a
    // local edit: each tab's ORDER is the server's score order. `merged` adds the maintainer
    // shield (a first merge grants merge rights) and the trunk strip (the PR just landed on it).
    onSuccess: () => void invalidateAfterPrWrite(qc, prId, { merged: true }),
  });
}

// ---- GitHub's native merge queue ----
// When the base branch has a queue, enqueuing IS the merge action (GitHub won't take a direct
// merge). Membership is SYNCED now and stamped by both routes, so a queue write moves the same
// screens any other PR write moves — the Pending card's queue chip and merge row, the PR pane's
// merge-state row, the card's sentence — and goes through the ONE write set.
//
// ⚠ EXPLICIT, SHARED KEYS (the two-mounts rule — see `mergePrMutationKey`). "Remove from queue"
// renders on the COLLAPSED merge row of a Pending card AND on the PR pane, and a card re-keys when
// its kind changes, so a per-mount `isPending` would forget a removal in flight and offer the
// button again. Both verbs share the `['merge-queue', prId]` PREFIX, so `useIsMutating` on
// `mergeQueueMutationKey(prId)` answers "is anything happening to this PR's queue entry?" and the
// verb-specific key says which.
export function mergeQueueMutationKey(prId: number, verb?: 'enqueue' | 'dequeue'): unknown[] {
  return verb == null ? ['merge-queue', prId] : ['merge-queue', prId, verb];
}

// ⚠ THESE TWO AWAIT THEIR REFETCH, AND THE REASON IS SPINNER CONTINUITY. The control decides what
// to draw from THREE reads — the live `['merge-options', prId]`, the synced `['pr', prId]` (PR pane)
// and `['attention-cards']` (the board) — whichever answered LAST (`mergeQueueStatus`). A
// fire-and-forget invalidation drops `isPending` while all three still hold the PRE-CLICK answer,
// so the row snapped back to "Add to merge queue" (or "Remove from queue") for the whole refetch
// — a live GitHub call, seconds long, and clickable throughout, so a second click could enqueue
// twice. React Query v5 keeps a mutation pending until an `onSuccess` promise settles, so awaiting
// the write set carries "Queueing…" / "Removing…" across the gap. The set refetches only ACTIVE
// queries and puts `['repos']` first; inside the sweep throttle it waits for the trailing sweep,
// which is the board read the row is waiting for anyway.
//
// The old comment here said "nothing on this control reads" the board. It was wrong the day the
// card's queue chip shipped, and the board kept offering Merge after a queue click until its own
// 60-second staleTime ran out.
export function useEnqueueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: mergeQueueMutationKey(prId, 'enqueue'),
    mutationFn: (method?: MergeMethod) =>
      api.enqueueMergeQueue(prId, method ? { method } : undefined),
    onSuccess: () => invalidateAfterPrWrite(qc, prId),
  });
}

export function useDequeueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: mergeQueueMutationKey(prId, 'dequeue'),
    mutationFn: () => api.dequeueMergeQueue(prId),
    onSuccess: () => invalidateAfterPrWrite(qc, prId),
  });
}

// Close the PR without merging (reversible on GitHub). `markPrClosedLocally` sets state='closed',
// which removes the PR from the fold every Pending card is built from — the card is gone
// server-side and the refetch is what stops the client drawing it.
export function useClosePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.closePr(prId),
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

// Reopen a closed PR. The mirror image of useClosePr: the PR is back in the open set, so a card
// may now exist that the client is not drawing.
export function useReopenPr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.reopenPr(prId),
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

// Update the PR branch from trunk (rebase/merge). An `update_branch` card exists BECAUSE
// `mergeStateStatus === 'behind'`; the update retires it (or turns it into a `merge` card) once
// GitHub has attached the new head — usually a few seconds after this answers, which is what the
// fast `['repos']` poll the helper opens is for.
export function useUpdatePrBranch(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    // EXPLICIT AND SHARED PER PR (the two-mounts-share-the-mutation-key rule): the Pending card's
    // merge row reads this key through `useIsMutating` to say "Updating the branch…" while the
    // POST is open, and it is mounted separately from the `MergeControl` that fires it.
    mutationKey: updateBranchMutationKey(prId),
    mutationFn: (body?: UpdateBranchBody) => api.updatePrBranch(prId, body),
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

export function useAddReviewComment(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddReviewCommentBody) => api.addReviewComment(prId, body),
    // A new inline comment is a new `review_comment` event: FYI badge, feed card, board marker.
    // Deliberately NOT ['pr-files', prId] (the patches are unchanged; dropping it re-fetches
    // every diff) and NOT ['users'] (the actor is the viewer, already in the roster) — neither is
    // in the helper's set.
    onSuccess: () => void invalidateAfterPrWrite(qc, prId),
  });
}

// ---- Requesting reviewers: ONE REVIEWER PER REQUEST, from both callers ------------------------
// The PR pane's Suggested row (ChecksTab) and the Pending card's per-suggestion Assign
// (AttentionCards `RoutingReviewerRow`); the card's old "Assign all" asked every suggestion at once.
//
// ⚠ EXPLICIT KEYS — the two-mounts rule (see mergePrMutationKey). A Pending tab switch REMOUNTS the
// card, so a row reads its state off the cache (useReviewerRequestState), never a per-mount
// isPending/isSuccess: those forget an open request (inviting a second POST) and offer "Assign" for
// someone already asked. The PR key is a PREFIX of every row key, so
// isMutating({ mutationKey: requestReviewersMutationKey(prId) }) counts every request open on that PR.
export function requestReviewersMutationKey(prId: number, reviewerKey?: string): unknown[] {
  return reviewerKey == null
    ? ['request-reviewers', prId]
    : ['request-reviewers', prId, reviewerKey];
}

// Split out of the hook so the refresh rule is testable with a bare QueryClient (no React).
//
// ⚠ THE BOARD REFRESH WAITS FOR THE LAST REQUEST ON THE PR, AND ONLY A SUCCESS TRIGGERS IT. The route
// stamps the request locally, so refetching the board RETIRES the card (the orphan rule is "nobody was
// asked") and takes every other row's outcome with it. While a sibling is still in flight the board is
// left alone; that sibling refreshes it when it lands. isMutating still counts THIS request here
// (TanStack marks it settled only after the callbacks run), hence `> 1`. A failure refreshes nothing:
// nothing changed on GitHub, and the card must stay to show the words and offer the retry. A held
// board catches up on its own (focus / the 5-minute interval).
//
// ⚠ ['attention-cards'], ['daily-brief'], ['work-plan'] MOVE TOGETHER — one fold read three times
// (useAttentionCards) — and they arrive together through `invalidateAfterPrWrite`, alongside the
// capped fold's copy of the same card (['workspace-insights']).
export function requestReviewersOptions(qc: QueryClient, prId: number, reviewerKey?: string) {
  return {
    mutationKey: requestReviewersMutationKey(prId, reviewerKey),
    mutationFn: (body: RequestReviewersBody) => api.requestReviewers(prId, body),
    onSuccess: () => {
      // The live suggestions query re-gates to empty once anyone is requested. Not in the shared
      // set: only this write changes it.
      void qc.invalidateQueries({ queryKey: ['suggested-reviewers', prId] });
      // A sibling still in flight: refresh the PR's own detail only (staleTime:Infinity +
      // persisted), and leave the board to whichever request lands last.
      if (qc.isMutating({ mutationKey: requestReviewersMutationKey(prId) }) > 1) {
        void qc.invalidateQueries({ queryKey: ['pr', prId] });
        return;
      }
      void invalidateAfterPrWrite(qc, prId);
    },
  };
}

export function useRequestReviewers(prId: number, reviewerKey?: string) {
  const qc = useQueryClient();
  return useMutation(requestReviewersOptions(qc, prId, reviewerKey));
}

/** One suggestion row's request state, read off the shared key, so it survives a remount (and outlives
 *  it by TanStack's 5-minute mutation gcTime). The latest attempt wins. */
export function useReviewerRequestState(prId: number, reviewerKey: string): ReviewerRequestView {
  const attempts = useMutationState({
    filters: { mutationKey: requestReviewersMutationKey(prId, reviewerKey) },
    select: (m) => ({ status: m.state.status, error: m.state.error }),
  });
  return reviewerRequestView(attempts);
}
