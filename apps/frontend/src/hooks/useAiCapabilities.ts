import { useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiRuntimeInstallEvent, MeResponse } from '@pierre-review/shared';
import { api } from '../api/client.js';
import { sseStream } from '../api/sse.js';
import { useMe } from './useTriage.js';
import { aiCapabilitiesOf, type AiCapabilities } from '../lib/aiCapabilities.js';

// The pure half (the type, the copy constants, `aiCapabilitiesOf`) lives in lib/aiCapabilities.ts
// so tests can import it without React Query.
export {
  AI_AUTH_LINE,
  AI_CLOUD_NOTE,
  AI_SETUP_LABEL,
  aiCapabilitiesOf,
  type AiCapabilities,
} from '../lib/aiCapabilities.js';

export function useAiCapabilities(): AiCapabilities {
  return aiCapabilitiesOf(useMe().data);
}

// ---- The one-time runtime install (POST /api/ai/runtime/install, SSE) ----------------------------
//
// ONE install per page, shared by every mount: two "Set up AI" buttons (the Claude Review tab and
// the AI Fix tab, say) must show the same progress and must not start two downloads. A tiny
// module-level store rather than per-mount state, so a tab switch mid-download keeps the line.

export interface AiInstallState {
  phase: 'idle' | 'running' | 'failed';
  /** The latest progress line from the server, or the failure reason. */
  message: string | null;
}

let installState: AiInstallState = { phase: 'idle', message: null };
const listeners = new Set<() => void>();
function setInstallState(next: AiInstallState): void {
  installState = next;
  for (const l of listeners) l();
}
function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useAiRuntimeInstall(): { state: AiInstallState; start: () => void } {
  const qc = useQueryClient();
  const state = useSyncExternalStore(subscribe, () => installState);
  const start = (): void => {
    if (installState.phase === 'running') return;
    setInstallState({ phase: 'running', message: null });
    let failed: string | null = null;
    void sseStream<AiRuntimeInstallEvent>('/api/ai/runtime/install', {
      method: 'POST',
      onEvent: (e) => {
        if (e.type === 'error') {
          failed = e.message || 'The download failed.';
        } else if (e.type === 'progress' && e.message.trim() !== '') {
          setInstallState({ phase: 'running', message: e.message.trim() });
        }
      },
    })
      .then(() => {
        setInstallState(
          failed != null ? { phase: 'failed', message: failed } : { phase: 'idle', message: null },
        );
      })
      .catch((err: unknown) => {
        setInstallState({
          phase: 'failed',
          message: err instanceof Error ? err.message : 'The download failed.',
        });
      })
      .finally(() => {
        // The server's `me.ai.runtime` is the truth either way.
        void qc.invalidateQueries({ queryKey: ['me'] });
      });
  };
  return { state, start };
}

/**
 * Poll `/api/me` while the SERVER says an install is running that this page did not start (another
 * browser tab, or `limn ai install` in a terminal), so the button turns into Run on its own.
 * Shares the `['me']` cache entry — an extra observer with an interval, nothing more.
 */
export function useAiRuntimePoll(installing: boolean): void {
  useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: api.me,
    retry: false,
    refetchInterval: installing ? 2000 : false,
  });
}
