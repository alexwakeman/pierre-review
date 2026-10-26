import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ThreadCheckStatus, ThreadCheckStatusResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { useAiCapabilities } from './useAiCapabilities.js';

// CHECK THREADS — the light, threads-only Claude pass (docs/CLAUDE-REVIEW.md § Check threads).
// ONE status read per PR, shared by the Threads only view's button and the Claude Review tab's (React
// Query dedupes the key). It polls every 3s while a run is queued or running (30s otherwise, for an
// automatic run started server-side); a finished run
// refreshes the PR's Claude review read, which carries the thread judgements beneath it
// (`claudeThreadJudgementsKey` sits under `['claude-review', prId]`).
//
// PR-detail only: never mounted on a board, so its one read on mount is not a board fetch.

export function threadCheckKey(prId: number): unknown[] {
  return ['thread-check', prId];
}

export function threadCheckActive(status: ThreadCheckStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running';
}

export function useThreadCheck(prId: number) {
  const qc = useQueryClient();
  const enabled = useAiCapabilities().enabled;
  const q = useQuery<ThreadCheckStatusResponse>({
    queryKey: threadCheckKey(prId),
    queryFn: () => api.threadCheckStatus(prId),
    enabled,
    staleTime: 10_000,
    retry: false,
    // 3s while a run is queued or running; otherwise a slow 30s read, because an AUTOMATIC check
    // (auto review routes a comment burst here) starts minutes after the burst with nothing on the
    // client to tell this query — without it the open pane never saw that run, its status line or
    // its result. DB-only, paused while the tab is hidden (React Query's default), PR-detail only.
    refetchInterval: (query) => (threadCheckActive(query.state.data?.check?.status) ? 3000 : 30_000),
  });

  const status = q.data?.check?.status ?? null;
  const checkId = q.data?.check?.id ?? null;
  const loaded = q.data !== undefined;
  // The last answer seen; null until the first one lands (so a mount never counts as a change).
  const prev = useRef<{ id: number | null; status: ThreadCheckStatus | null } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const was = prev.current;
    prev.current = { id: checkId, status };
    if (was == null || status !== 'succeeded') return;
    // A run we saw queued or running has finished, or a NEW run finished between two reads.
    if (threadCheckActive(was.status) || was.id !== checkId) {
      void qc.invalidateQueries({ queryKey: ['claude-review', prId] });
    }
  }, [qc, prId, checkId, status, loaded]);

  const start = useMutation({
    mutationKey: ['thread-check-start', prId],
    mutationFn: () => api.startThreadCheck(prId),
    onSettled: () => void qc.invalidateQueries({ queryKey: threadCheckKey(prId) }),
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelThreadCheck(prId),
    onSettled: () => void qc.invalidateQueries({ queryKey: threadCheckKey(prId) }),
  });

  return { enabled, data: q.data, active: threadCheckActive(status), start, cancel };
}
