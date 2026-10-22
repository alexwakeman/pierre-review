import { useSyncExternalStore } from 'react';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { MeResponse, MlInstallEvent } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';

// ---- The one-time download for local bot-comment scoring (POST /api/ml/install, SSE) ---------
//
// ONE download per page, shared by every mount, like the AI runtime's (useAiCapabilities.ts):
// the Settings row and "Set up AI" (which starts this one too) must show the same progress and
// must never start two.

export const ML_SETUP_LABEL = 'Set up (one-time ~240 MB download)';

export interface MlInstallState {
  phase: 'idle' | 'running' | 'failed';
  message: string | null;
}

let installState: MlInstallState = { phase: 'idle', message: null };
const listeners = new Set<() => void>();
function setInstallState(next: MlInstallState): void {
  installState = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Start the download unless one is already running. Not a hook: "Set up AI" chains into it. */
export function startMlInstall(qc: QueryClient): void {
  if (installState.phase === 'running') return;
  setInstallState({ phase: 'running', message: null });
  let failed: string | null = null;
  void sseStream<MlInstallEvent>('/api/ml/install', {
    method: 'POST',
    onEvent: (e) => {
      if (e.type === 'error') failed = e.message || 'The download failed.';
      else if (e.type === 'progress' && e.message.trim() !== '') {
        setInstallState({ phase: 'running', message: e.message.trim() });
      }
    },
  })
    .then(() => {
      setInstallState(failed != null ? { phase: 'failed', message: failed } : { phase: 'idle', message: null });
    })
    .catch((err: unknown) => {
      setInstallState({ phase: 'failed', message: err instanceof Error ? err.message : 'The download failed.' });
    })
    .finally(() => {
      // `me.ml` and `me.mlSeverity` are the truth either way; the ML queries gate on the latter.
      void qc.invalidateQueries({ queryKey: ['me'] });
    });
}

export function useMlInstallState(): MlInstallState {
  return useSyncExternalStore(subscribe, () => installState);
}

/** Poll `/api/me` while an install this page did not start (`limn ml install`) is running. */
export function useMlInstallPoll(installing: boolean): void {
  useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    refetchInterval: installing ? 2000 : false,
  });
}
