import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiFixMergePreview,
  AiFixPushBody,
  AiFixRebaseBody,
  AiFixResolveStatusResponse,
  AiFixResolveStreamEvent,
  AiFixResponse,
  AiFixStatusResponse,
  AiFixStreamEvent,
  CiAnalysisResponse,
  FailingCheckInput,
  GenerateFixBody,
  PrSummaryResponse,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';

// Query/mutation hooks for the Pro AI Fix tab. Mirrors useClaudeReview; every query's
// `enabled` is gated on the relevant Pro capability by the caller.

export function useAiFix(prId: number | null, enabled: boolean) {
  return useQuery<AiFixResponse>({
    queryKey: ['ai-fix', prId],
    queryFn: () => api.aiFix(prId as number),
    enabled: prId != null && enabled,
  });
}

export function usePrSummary(prId: number | null, enabled: boolean) {
  return useQuery<PrSummaryResponse>({
    queryKey: ['ai-fix-summary', prId],
    queryFn: () => api.aiFixSummary(prId as number),
    enabled: prId != null && enabled,
  });
}

export function useCiAnalysis(prId: number | null, enabled: boolean) {
  return useQuery<CiAnalysisResponse>({
    queryKey: ['ai-fix-ci', prId],
    queryFn: () => api.aiFixCiAnalysis(prId as number),
    enabled: prId != null && enabled,
  });
}

export function useRefreshSummary(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.refreshAiFixSummary(prId),
    onSuccess: (data) => qc.setQueryData(['ai-fix-summary', prId], data),
  });
}

// The CI diagnosis is now mounted TWICE for the same PR (the Overview's Checks row and the
// AI Fix tab's CI-status section). Both read the one `['ai-fix-ci', prId]` query key, so a
// generation in either updates both — but `isPending` is per-mount, so switching tabs
// mid-run used to reset the button to "Analyze" and invite a SECOND billed POST. The
// mutationKey makes the run observable across mounts via `useIsMutating` (CiAnalysisCard).
// It is load-bearing for that, not cosmetic: without it the mutation is anonymous.
export function useRefreshCiAnalysis(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['ai-fix-ci', prId],
    mutationFn: (checks: FailingCheckInput[]) =>
      api.refreshAiFixCiAnalysis(prId, checks),
    onSuccess: (data) => qc.setQueryData(['ai-fix-ci', prId], data),
  });
}

export function useStartFix(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerateFixBody) => api.startAiFix(prId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
  });
}

// ---- trunk reconciliation (merge-preview / rebase-resolve / async push) ----

export function useMergePreview() {
  return useMutation<AiFixMergePreview, unknown, number>({
    mutationFn: (fixId: number) => api.aiFixMergePreview(fixId),
  });
}

export function useStartRebase() {
  return useMutation({
    mutationFn: (vars: { fixId: number; body: AiFixRebaseBody }) =>
      api.startAiFixRebase(vars.fixId, vars.body),
  });
}

export function useCancelRebase() {
  return useMutation({ mutationFn: (fixId: number) => api.cancelAiFixRebase(fixId) });
}

export function useCancelPush() {
  return useMutation({ mutationFn: (fixId: number) => api.cancelAiFixPush(fixId) });
}

// Live progress for a rebase-resolve or async-push job (SSE keyed by fixId). On the
// terminal `done`, invalidates the ai-fix query so the stored result reloads.
export function useAiFixJobStream(
  prId: number | null,
  fixId: number | null,
  kind: 'rebase' | 'push',
  active: boolean,
): { status: AiFixResolveStatusResponse | null } {
  const qc = useQueryClient();
  const [status, setStatus] = useState<AiFixResolveStatusResponse | null>(null);

  useEffect(() => {
    if (prId == null || fixId == null || !active) {
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
    void sseStream<AiFixResolveStreamEvent>(
      `/api/pro/ai-fixes/${fixId}/${kind}/stream`,
      {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === 'done') {
            settle();
            setStatus({
              status: e.status,
              fixId: e.fixId,
              progress: null,
              error: e.error ?? null,
            });
          } else {
            setStatus({ status: e.status, fixId: e.fixId, progress: e.progress });
          }
        },
      },
    ).catch(() => {
      /* aborted or network error — the ai-fix query still reflects DB state */
    });
    return () => ac.abort();
  }, [prId, fixId, kind, active, qc]);

  return { status };
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
