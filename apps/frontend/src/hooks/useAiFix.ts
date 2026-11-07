import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AiFixPickerPreview,
  AiFixPushBody,
  AiFixResponse,
  AiFixStatusResponse,
  AiFixStreamEvent,
  GenerateFixBody,
  SandboxNetworkAllowBody,
} from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { invalidateAfterPrWrite } from './prCacheSync.js';
import { DETAIL_GC_TIME } from './usePr.js';
import { SANDBOX_RUNTIME_KEY, SESSION_POLL_MS, sandboxSettingsKey } from './useStoryBuild.js';
import { useSandboxSessionStream } from './useSandboxSessionStream.js';
import type { SessionStreamState } from '../lib/sandboxSession.js';

// Query/mutation hooks for the AI Fix tab. Mirrors useClaudeReview; every query's `enabled` is
// gated by the caller.

export function useAiFix(prId: number | null, enabled: boolean) {
  return useQuery<AiFixResponse>({
    queryKey: ['ai-fix', prId],
    queryFn: () => api.aiFix(prId as number),
    enabled: prId != null && enabled,
    // A live session: a slow fallback poll while something moves (its stream is the live path; an
    // agent waiting for the reader needs no poll).
    refetchInterval: (q) => {
      const s = q.state.data?.fix?.session;
      return s != null && s.live && s.phase !== 'ready' && s.phase !== 'built' ? SESSION_POLL_MS : false;
    },
  });
}

/**
 * WARM THE AI FIX TAB BEFORE IT OPENS — called by the header's AI fix row when a run finishes and
 * again on hover / focus / press, so a click on "Fix ready" opens on the result rather than on
 * "Loading…". Without it the click was a waterfall: the PR detail, THEN (once PrDetail had the PR and
 * seated the tab) the lazily-loaded tab's code, THEN `GET …/ai-fix` — and that route makes one live
 * GitHub read (the head, for the push controls), ~0.5s on its own.
 *
 * ⚠ THE SAME KEYS AND FETCHERS AS THE HOOKS THE TAB MOUNTS (`usePr`, `useAiFix`, `useClaudeReview`),
 * so the tab finds them in the cache. A short `staleTime` here only stops a hover storm refetching;
 * the tab's own hooks keep their own freshness rules.
 */
export function prefetchAiFixTab(qc: QueryClient, prId: number): void {
  // The lazy tab's code (PrDetail's `lazy(() => import('../components/AiFixTab.js'))`): same module.
  void import('../components/AiFixTab.js').catch(() => undefined);
  void qc.prefetchQuery({
    queryKey: ['pr', prId],
    queryFn: () => api.pr(prId),
    staleTime: Infinity,
    gcTime: DETAIL_GC_TIME,
  });
  void qc.prefetchQuery({ queryKey: ['ai-fix', prId], queryFn: () => api.aiFix(prId), staleTime: 15_000 });
  void qc.prefetchQuery({
    queryKey: ['claude-review', prId],
    queryFn: () => api.claudeReview(prId),
    staleTime: 15_000,
  });
}

// The fix picker's items for one review (DB-only on the server). Refetched after a fix finishes
// (the ['ai-fix', prId] prefix is NOT shared, so it is keyed on its own and invalidated by the
// start/push hooks below).
// `reviewId === null` ⇒ THE CI-ONLY preview (the caller enables it only when the PR has no
// succeeded AI review); a 409 there just means "nothing to fix without a review", so no retry.
export function useAiFixPreview(prId: number, reviewId: number | null, enabled: boolean) {
  return useQuery<AiFixPickerPreview>({
    queryKey: ['ai-fix-preview', prId, reviewId],
    queryFn: () => api.aiFixPreview(prId, reviewId),
    enabled,
    retry: reviewId == null ? false : undefined,
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
    // A refused start (409 NoRuntime) may mean the runtime went away: read its status again.
    onError: () => void qc.invalidateQueries({ queryKey: SANDBOX_RUNTIME_KEY }),
  });
}

// PLAN FIRST: the session boots in chat mode, makes a plan, then waits for Start fix. It shares the
// start's mutation key on purpose: one in-flight read covers
// both buttons, so neither can be pressed twice while the other's POST is out.
export function useStartPlan(prId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixStartMutationKey(prId),
    mutationFn: (body: GenerateFixBody) => api.startAiFixPlan(prId, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
    onError: () => void qc.invalidateQueries({ queryKey: SANDBOX_RUNTIME_KEY }),
  });
}

// THE WORKSPACE SESSION'S PRESSES (docs/SANDBOX.md § AI Fix sessions): a message (one more turn in the
// SAME session), Start fix (Plan first), Resume and Discard share ONE key per PR, read with
// `useIsMutating`, so a tab switch mid-POST cannot offer a second billed turn. The bottom-right banner
// reads it too (a Start fix press is about to make the row 'running').
export function aiFixSessionMutationKey(prId: number): [string, number] {
  return ['ai-fix-session', prId];
}

/** The fix query and the picker's preview (a finished or discarded fix changes what is offered). */
function invalidateFix(qc: QueryClient, prId: number): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
    qc.invalidateQueries({ queryKey: ['ai-fix-preview', prId] }),
  ]);
}

function useFixSessionAction<V>(prId: number, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: aiFixSessionMutationKey(prId),
    mutationFn: fn,
    onSuccess: () => invalidateFix(qc, prId),
    // A refused boot (Resume) may mean the runtime went away: read its status again.
    onError: () => void qc.invalidateQueries({ queryKey: SANDBOX_RUNTIME_KEY }),
  });
}

/** One more turn: chat before Start fix, a build turn after it ("also handle X"). */
export function useFixMessage(prId: number) {
  return useFixSessionAction(prId, (v: { fixId: number; text: string }) => api.aiFixMessage(v.fixId, { text: v.text }));
}

/** Start fix (Plan first): the session moves to build mode; the words in the box go with it. */
export function useStartFixBuild(prId: number) {
  return useFixSessionAction(prId, (v: { fixId: number; text?: string }) =>
    api.approveAiFixPlan(v.fixId, v.text != null && v.text.trim() !== '' ? { text: v.text.trim() } : {}),
  );
}

/** Boot a closed session again with its stored patch (the agent does not remember the conversation). */
export function useResumeFix(prId: number) {
  return useFixSessionAction(prId, (fixId: number) => api.aiFixResume(fixId));
}

/** Close the session; nothing is pushed. Runs no model. */
export function useDiscardFix(prId: number) {
  return useFixSessionAction(prId, (fixId: number) => api.aiFixDiscard(fixId));
}

/** An Allow click on the Network panel (the reader's, never automatic). Its own key, like Stop. */
export function useFixAllow(prId: number, workspaceId: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { fixId: number; body: SandboxNetworkAllowBody }) => api.aiFixAllow(v.fixId, v.body),
    onSuccess: (_r, v) =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ['ai-fix', prId] }),
        v.body.scope === 'workspace' && workspaceId != null ? qc.invalidateQueries({ queryKey: sandboxSettingsKey(workspaceId) }) : null,
      ]),
  });
}

/** The live session of one fix row, over its SSE stream (folded by lib/sandboxSession.ts). */
export function useFixSessionStream(prId: number, fixId: number | null, live: boolean): SessionStreamState {
  const qc = useQueryClient();
  return useSandboxSessionStream(fixId != null ? api.aiFixSessionStreamUrl(fixId) : null, fixId, live, () => void invalidateFix(qc, prId));
}

/** Stop: the running turn stops (a manual session stays; an unattended one ends). Its own key, so Stop
 *  never waits behind the turn's press. */
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
