import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AddressedCheckProgress, AddressedCheckSummary } from '@pierre-review/shared';
import { sseStream } from '../api/sse.js';

export interface PrAddressedCheckState {
  running: boolean;
  done: number;
  total: number;
  summary: AddressedCheckSummary | null;
  error: string | null;
}

const EMPTY: PrAddressedCheckState = {
  running: false,
  done: 0,
  total: 0,
  summary: null,
  error: null,
};

// PR-wide "check all threads + PR comments addressed" — one item at a time over SSE (mirrors the
// Claude-review stream). Each completed item invalidates its per-item cache so open cards refresh
// live; the `done` rollup answers "can I safely resolve these?".
export function usePrAddressedCheck(prId: number): {
  state: PrAddressedCheckState;
  run: () => void;
  stop: () => void;
} {
  const qc = useQueryClient();
  const [state, setState] = useState<PrAddressedCheckState>(EMPTY);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...EMPTY, running: true });
    void sseStream<AddressedCheckProgress>(`/api/pro/prs/${prId}/addressed/check/stream`, {
      method: 'POST',
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'start') {
          setState((s) => ({ ...s, total: e.total }));
        } else if (e.type === 'item') {
          setState((s) => ({ ...s, done: e.done, total: e.total }));
          void qc.invalidateQueries({
            queryKey: ['addressed-check', e.targetKind, e.targetId],
          });
        } else if (e.type === 'error') {
          setState((s) => ({ ...s, error: e.message }));
        } else if (e.type === 'done') {
          setState((s) => ({ ...s, running: false, summary: e.summary }));
        }
      },
    })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        setState((s) => ({ ...s, running: false, error: (err as Error)?.message ?? 'Failed' }));
      })
      .finally(() => {
        setState((s) => ({ ...s, running: false }));
        // The batch writes the same rows the annotations platform serves (kind='addressed'),
        // so refresh the PR-wide annotations cache once when the run ends.
        void qc.invalidateQueries({ queryKey: ['pr-annotations'] });
      });
  }, [prId, qc]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { state, run, stop };
}
