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

// PR write mutations. The PR-detail query is staleTime:Infinity +
// IndexedDB-persisted, so every write to the open PR MUST invalidate ['pr', prId]
// (the backend optimistically stamps the local DB, so the refetch shows the change
// immediately). Triage queues (['my-turn'], ['me']) and feeds (['timeline'],
// ['open-prs']) are invalidated where a write can change them.

export function useReplyToThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: number; threadId: number; body: string }) =>
      api.replyToThread(vars.threadId, { body: vars.body }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['pr', vars.prId] });
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      // The Activity feed can be acted on inline (thread cards), so refresh it too.
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
    },
  });
}

export function useResolveThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { prId: number; threadId: number; resolved: boolean }) =>
      api.resolveThread(vars.threadId, { resolved: vars.resolved }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['pr', vars.prId] });
      void qc.invalidateQueries({ queryKey: ['thread', vars.threadId] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
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
      void qc.invalidateQueries({ queryKey: ['pr', vars.prId] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
    },
  });
}

export function useCreatePrComment(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.createPrComment(prId, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
    },
  });
}

export function useApprovePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: string) =>
      api.approvePr(prId, body !== undefined ? { body } : undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      // ⚠ THE BOARD, TOO. Approving is the single most common way a Pending "Review or reply"
      // card stops being true, and until now the click left it sitting there — the route's
      // server half now clears the viewer's `review_requests` row AND re-reads the PR from
      // GitHub, so a refetch here is what turns the card into a `merge` card (or retires it).
      // Both keys together: `/api/daily-brief` (the Welcome-back banner, the Workspace badges)
      // counts these very cards, so the two must come from ONE snapshot.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      // The THIRD read of that same fold. All three move together or the plan's `stale` chip —
      // whose whole job is to say "the list has moved on since this was written" — stays false
      // for up to five minutes after the write that moved it.
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
    },
  });
}

// The merge control's options (allowed methods + live mergeability). Fetched lazily — enable it
// only when the control is open, so the hot PR-detail path isn't slowed by a live GitHub call.
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      // The Pending board can now MERGE — so the `merge` card the click came from has to leave it,
      // and the daily brief that counts the same cards has to agree. ⚠ An INVALIDATION, not
      // a local edit: each tab's ORDER is the server's score order, and a mutation response has
      // no business re-ranking it.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      // The THIRD read of that same fold. All three move together or the plan's `stale` chip —
      // whose whole job is to say "the list has moved on since this was written" — stays false
      // for up to five minutes after the write that moved it.
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
      // The viewer's first merge in a repo grants them merge rights → refresh the shield.
      void qc.invalidateQueries({ queryKey: ['mergers'] });
    },
  });
}

// ---- GitHub's native merge queue ----
// When the base branch has a queue, enqueuing IS the merge action (GitHub won't take a direct
// merge), so these invalidate the same surfaces as a merge would EXCEPT the PR-state ones —
// the PR isn't merged yet, it's queued. merge-options carries the live queue position.
// ⚠ THESE TWO AWAIT THEIR merge-options INVALIDATION, AND IT IS THE ONLY PLACE IN THIS FILE
// THAT DOES. The button these mutations sit behind renders from `useMergeOptions`, whose
// `inQueue` is the very fact the mutation just changed — and a fire-and-forget invalidation
// leaves `isPending` false while the cache still holds the PRE-CLICK payload. The button
// therefore snapped back to "Add to merge queue" and STAYED there for the whole refetch, which
// is a live GitHub call: seconds, not a flicker, and clickable throughout, so a second click
// could enqueue twice. React Query v5 keeps a mutation pending until an `onSuccess` promise
// settles, so awaiting exactly this one query carries the spinner across the gap.
//
// The other invalidations stay `void`: nothing on this control reads them, and awaiting a
// refetch nobody is looking at would just hold the spinner open for longer.
export function useEnqueueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (method?: MergeMethod) =>
      api.enqueueMergeQueue(prId, method ? { method } : undefined),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      await qc.invalidateQueries({ queryKey: ['merge-options', prId] });
    },
  });
}

export function useDequeueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.dequeueMergeQueue(prId),
    onSuccess: async () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      await qc.invalidateQueries({ queryKey: ['merge-options', prId] });
    },
  });
}

// Close the PR without merging (reversible on GitHub). Like useMergePr it moves the PR out of
// the open set, so invalidate every surface that shows open-PR state (timeline, open-PRs,
// triage queues, the feeds, the Activity console). The backend optimistically stamps closed.
export function useClosePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.closePr(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      // `markPrClosedLocally` sets state='closed', which removes the PR from the openPrs fold
      // every Pending card is built from — so the card IS gone server-side and only the client
      // was still drawing it. Same pair, same reason, as the merge mutation above.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      // The THIRD read of that same fold. All three move together or the plan's `stale` chip —
      // whose whole job is to say "the list has moved on since this was written" — stays false
      // for up to five minutes after the write that moved it.
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
    },
  });
}

// Reopen a closed PR. The mirror image of useClosePr: it moves the PR back INTO the open set, so
// every surface that shows open-PR state has to be re-read — the SAME nine keys, for the same
// reasons, including the three that are ONE FOLD read three times.
export function useReopenPr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.reopenPr(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['activity'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      // `markPrReopenedLocally` sets state='open', which puts the PR BACK into the openPrs fold
      // every Pending card is built from — so a card may now exist that the client is not
      // drawing. Same three keys, same rule, as the close mutation above: they are one fold read
      // three times (board / brief count / ranked plan) and must move together or `capFor`'s
      // `shown === count` guard compares two snapshots and drops the "50 of 148" disclosure.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
    },
  });
}

// Update the PR branch from trunk (rebase/merge). Re-fetch mergeability afterwards so the merge
// control reflects the now-up-to-date branch.
export function useUpdatePrBranch(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    // EXPLICIT AND SHARED PER PR (the two-mounts-share-the-mutation-key rule): the Pending card's
    // merge row reads this key through `useIsMutating` to say "Updating the branch…" while the
    // POST is open, and it is mounted separately from the `MergeControl` that fires it.
    mutationKey: updateBranchMutationKey(prId),
    mutationFn: (body?: UpdateBranchBody) => api.updatePrBranch(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
      // An `update_branch` card exists BECAUSE `mergeStateStatus === 'behind'`; a successful
      // update is the fact that retires it (or turns it into a `merge` card). Same invalidate-
      // don't-edit rule as the merge mutation above.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      // The THIRD read of that same fold. All three move together or the plan's `stale` chip —
      // whose whole job is to say "the list has moved on since this was written" — stays false
      // for up to five minutes after the write that moved it.
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
    },
  });
}

export function useAddReviewComment(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddReviewCommentBody) => api.addReviewComment(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['my-turn'] });
      // A new inline comment is a new `review_comment` event, not just a thread on this PR:
      // it changes the FYI badge, shows up as a feed card, and draws a marker on the board.
      // Reaching those is what makes this hook match `useReplyToThread`, which writes the same
      // kind of row. Deliberately NOT ['pr-files', prId] — the patches are unchanged, and
      // dropping that cache entry would re-fetch every diff in the PR for nothing. ['users'] is
      // left alone too: the Members roster only changes when a NEW actor appears, and the actor
      // here is the signed-in viewer, who is already in it.
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['consolidated-feed'] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
    },
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
// (useAttentionCards). All are PREFIXES owned by other files, written here as literals, so a rename
// there fails silently here (the request succeeds and the card just doesn't clear); they still sweep
// every `['<name>', 'ws:<id>']` entry, which matters with more than one workspace cached.
export function requestReviewersOptions(qc: QueryClient, prId: number, reviewerKey?: string) {
  return {
    mutationKey: requestReviewersMutationKey(prId, reviewerKey),
    mutationFn: (body: RequestReviewersBody) => api.requestReviewers(prId, body),
    onSuccess: () => {
      // The PR's own reads, always: the detail is staleTime:Infinity + persisted (this file's rule),
      // and the live suggestions query re-gates to empty once anyone is requested.
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['suggested-reviewers', prId] });
      if (qc.isMutating({ mutationKey: requestReviewersMutationKey(prId) }) > 1) return;
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      void qc.invalidateQueries({ queryKey: ['daily-brief'] });
      void qc.invalidateQueries({ queryKey: ['work-plan'] });
      // The capped fold's copy of the same card (useWorkspaceInsights).
      void qc.invalidateQueries({ queryKey: ['workspace-insights'] });
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
