import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AddReviewCommentBody,
  MergeMethod,
  RequestReviewersBody,
  UpdateBranchBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';

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
      // Both keys together: the brief strip counts these very cards and the cap disclosure
      // divides one by the other, so they must come from ONE snapshot.
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
      // and the daily-brief strip that counts the same cards has to agree. ⚠ An INVALIDATION, not
      // a local edit: the board's ORDER is the server's `doNextIds`, and a mutation response has
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
export function useEnqueueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (method?: MergeMethod) =>
      api.enqueueMergeQueue(prId, method ? { method } : undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
    },
  });
}

export function useDequeueMergeQueue(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.dequeueMergeQueue(prId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
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

// Request reviewers on a PR (the Insights "Assign reviewers" action). GitHub drops the
// request once a review lands, and reviewRequests are re-derived each sync, so the
// routing card that prompted this leaves the board on the next refresh — invalidate
// ['workspace-insights'] (+ the PR detail, whose Requested list changes) to reflect it.
//
// ⚠ Both keys below are owned by OTHER files (useWorkspaceInsights, useAttentionCards) and written
// here as bare literals, so a rename there fails silently here — the mutation succeeds and the
// card just doesn't clear. They are PREFIXES, so they still sweep every `['<name>', 'ws:<id>']`
// entry, which matters because a user can have more than one workspace cached at a time.
export function useRequestReviewers(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RequestReviewersBody) => api.requestReviewers(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workspace-insights'] });
      // The CORE **Pending** rail entry renders the same routing card from a different query key —
      // refresh it too so an Assign there also clears the card.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      // The assign route stamps review_requests locally, so refetching the detail now shows
      // the requested reviewer, and the (live) suggestions query re-gates to empty.
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['suggested-reviewers', prId] });
    },
  });
}
