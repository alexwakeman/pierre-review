import { useEffect, useRef, useState } from 'react';
import type { SandboxSessionStreamEvent } from '@pierre-review/shared';
import { sseStream } from '../api/sse.js';
import { applySessionEvent, EMPTY_SESSION_STREAM, sessionEventNeedsRefetch, type SessionStreamState } from '../lib/sandboxSession.js';

// ONE WORKSPACE SESSION'S SSE STREAM (docs/SANDBOX.md § Sessions), shared by the build tab and the AI Fix
// tab: a `snapshot`, then the changes, `done` when the sandbox closes; folded by lib/sandboxSession.ts. A
// phase change, a turn's end and `done` call `refetch` (spend, repositories, the status the board reads).
// A stream that drops while the session is still live is opened again after a pause.

/** How long to wait before opening a dropped stream again. */
export const SESSION_STREAM_RETRY_MS = 3_000;

export function useSandboxSessionStream(
  /** The stream's path; null = nothing to follow. */
  path: string | null,
  /** The session row's id: another session's frames never show on this one. */
  id: number | null,
  live: boolean,
  refetch: () => void,
): SessionStreamState {
  const [held, setHeld] = useState<{ id: number | null; s: SessionStreamState }>({ id: null, s: EMPTY_SESSION_STREAM });
  const [attempt, setAttempt] = useState(0);
  // The latest callback, without reopening the stream when the caller passes a new closure.
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  useEffect(() => {
    if (path == null || id == null || !live) return;
    const ac = new AbortController();
    let sawDone = false;
    const again = (): void => refetchRef.current();
    void sseStream<SandboxSessionStreamEvent>(path, {
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'done') sawDone = true;
        setHeld((h) => ({ id, s: applySessionEvent(h.id === id ? h.s : EMPTY_SESSION_STREAM, e) }));
        if (sessionEventNeedsRefetch(e)) again();
      },
    })
      .catch(() => {
        /* aborted or a network error: the retry below, and the fallback poll, follow the DB */
      })
      .finally(() => {
        if (ac.signal.aborted) return;
        again();
        if (!sawDone) window.setTimeout(() => !ac.signal.aborted && setAttempt((n) => n + 1), SESSION_STREAM_RETRY_MS);
      });
    return () => ac.abort();
  }, [path, id, live, attempt]);
  return held.id === id ? held.s : EMPTY_SESSION_STREAM;
}
