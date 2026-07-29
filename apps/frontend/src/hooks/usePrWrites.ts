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

// Merge the PR. Invalidates the PR + every surface that shows PR state (timeline, open-PRs,
// triage queues, the feeds) — the backend optimistically stamps merged, so the refetch is fresh.
export function useMergePr(prId: number) {
  const qc = useQueryClient();
  return useMutation({
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
    },
  });
}

// Update the PR branch from trunk (rebase/merge). Re-fetch mergeability afterwards so the merge
// control reflects the now-up-to-date branch.
export function useUpdatePrBranch(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: UpdateBranchBody) => api.updatePrBranch(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['merge-options', prId] });
      void qc.invalidateQueries({ queryKey: ['timeline'] });
      void qc.invalidateQueries({ queryKey: ['open-prs'] });
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
    },
  });
}

// Request reviewers on a PR (the Insights "Assign reviewers" action). GitHub drops the
// request once a review lands, and reviewRequests are re-derived each sync, so the
// routing card that prompted this leaves the board on the next refresh — invalidate
// ['team-insights'] (+ the PR detail, whose Requested list changes) to reflect it.
export function useRequestReviewers(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RequestReviewersBody) => api.requestReviewers(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team-insights'] });
      // The CORE "Needs attention" tab renders the same routing card from a different query key —
      // refresh it too so an Assign there also clears the card.
      void qc.invalidateQueries({ queryKey: ['attention-cards'] });
      // The assign route stamps review_requests locally, so refetching the detail now shows
      // the requested reviewer, and the (live) suggestions query re-gates to empty.
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
      void qc.invalidateQueries({ queryKey: ['suggested-reviewers', prId] });
    },
  });
}
