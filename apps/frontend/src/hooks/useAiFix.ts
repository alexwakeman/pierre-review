import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiFixPickerPreview,
  AiFixPushBody,
  AiFixResponse,
  AiFixStatusResponse,
  AiFixStreamEvent,
  GenerateFixBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';

// Query/mutation hooks for the AI Fix tab. Mirrors useClaudeReview; every query's `enabled` is
// gated by the caller.

export function useAiFix(prId: number | null, enabled: boolean) {
  return useQuery<AiFixResponse>({
    queryKey: ['ai-fix', prId],
    queryFn: () => api.aiFix(prId as number),
    enabled: prId != null && enabled,
  });
}

// The fix picker's items for one review (DB-only on the server). Refetched after a fix finishes
// (the ['ai-fix', prId] prefix is NOT shared, so it is keyed on its own and invalidated by the
// start/push hooks below).
export function useAiFixPreview(prId: number, reviewId: number | null, enabled: boolean) {
  return useQuery<AiFixPickerPreview>({
    queryKey: ['ai-fix-preview', prId, reviewId],
    queryFn: () => api.aiFixPreview(prId, reviewId as number),
    enabled: enabled && reviewId != null,
  });
}

// The start mutation's SHARED key: a per-mount `isPending` resets on a tab switch mid-start and
// would offer a second BILLED agent run. Read in-flight off this key with
// `useIsMutating({ mutationKey: aiFixStartMutationKey(prId) })`, never off a mutation object.
export function aiFixStartMutationKey(prId: number): [string, number] {
  return ['ai-fix-start', prId];
}

export function useStartFix(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixStartMutationKey(prId),
    mutationFn: (body: GenerateFixBody) => api.startAiFix(prId, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-fix', prId] });
      void qc.invalidateQueries({ queryKey: ['ai-fix-preview', prId] });
    },
  });
}

// PLAN MODE. "Plan first" shares the start's mutation key on purpose: one in-flight read covers
// both buttons, so neither can be pressed twice while the other's POST is out.
export function useStartPlan(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixStartMutationKey(prId),
    mutationFn: (body: GenerateFixBody) => api.startAiFixPlan(prId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
  });
}

// Every plan action (message, approve, discard) shares ONE key per PR, read with `useIsMutating`,
// so a tab switch mid-POST cannot offer a second billed pass.
export function aiFixPlanMutationKey(prId: number): [string, number] {
  return ['ai-fix-plan', prId];
}

export function usePlanMessage(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixPlanMutationKey(prId),
    mutationFn: (vars: { fixId: number; text: string }) => api.sendAiFixPlanMessage(vars.fixId, { text: vars.text }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
  });
}

export function useApprovePlan(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixPlanMutationKey(prId),
    mutationFn: (fixId: number) => api.approveAiFixPlan(fixId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
  });
}

export function useDiscardPlan(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixPlanMutationKey(prId),
    mutationFn: (fixId: number) => api.discardAiFixPlan(fixId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-fix', prId] });
      void qc.invalidateQueries({ queryKey: ['ai-fix-preview', prId] });
    },
  });
}

export function useCancelFix(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.cancelAiFix(prId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
  });
}

export function usePushFix(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { fixId: number; body: AiFixPushBody }) =>
      api.pushAiFix(vars.fixId, vars.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ai-fix', prId] });
      // A push moves the PR's head, CI and mergeability: THE ONE WRITE SET (prCacheSync.ts).
      void invalidateAfterPrWrite(qc, prId);
    },
  });
}

// Live progress via SSE — pushes each phase/activity change, then a terminal `done`
// that invalidates the full ai-fix query so the finished result loads. `active`
// mirrors the run being in flight; when it flips off the stream is aborted.
export function useAiFixStream(
  prId: number | null,
  active: boolean,
): { status: AiFixStatusResponse | null } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AiFixStatusResponse | null>(null);

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
      void qc.invalidateQueries({ queryKey: ['ai-fix', prId] });
    };
    void sseStream<AiFixStreamEvent>(`/api/pro/prs/${prId}/ai-fix/stream`, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'done') {
          settle();
          setStatus({ status: e.status, fixId: e.fixId, progress: null });
        } else {
          setStatus({ status: e.status, fixId: e.fixId, progress: e.progress });
        }
      },
    }).catch(() => {
      /* aborted or network error — the ai-fix query still reflects the DB state */
    });
    return () => ac.abort();
  }, [prId, active, qc]);

  return { status };
}
