import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AddReviewCommentBody } from '@pierre-review/shared';
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
