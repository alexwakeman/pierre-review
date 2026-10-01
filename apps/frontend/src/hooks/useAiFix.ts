import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiFixPushBody,
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
import { invalidateAfterPrWrite } from './prCacheSync.js';

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

// The agentic fixer is now STARTED from two places for the same PR: the AI Fix tab's
// FixerSection and the CI-analysis card's "Fix it" shortcut, which is mounted on the Overview's
// Checks row as well. Same trap the CI-analysis mutation above closed — click Fix on Overview,
// switch tabs before the invalidation lands, and the other mount's per-mount `isPending` is
// false, offering a second BILLED agent run. Read in-flight off this key with
// `useIsMutating({ mutationKey: aiFixStartMutationKey(prId) })`, never off a mutation object.
export function aiFixStartMutationKey(prId: number): [string, number] {
  return ['ai-fix-start', prId];
}

export function useStartFix(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixStartMutationKey(prId),
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
