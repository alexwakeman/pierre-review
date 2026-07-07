import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddReviewCommentBody, MergeMethod, UpdateBranchBody } from '@pierre-review/shared';
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
    mutationFn: (userIds: number[]) => api.requestReviewers(prId, { userIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['team-insights'] });
      void qc.invalidateQueries({ queryKey: ['pr', prId] });
    },
  });
}
