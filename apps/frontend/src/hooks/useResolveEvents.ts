import { useEffect, useLayoutEffect, useRef } from 'react';
import { useMutationState } from '@tanstack/react-query';
import { RESOLVE_THREAD_MUTATION_KEY } from './usePrWrites.js';

export interface ResolveEvent {
  threadId: number;
  resolved: boolean;
}

/**
 * Every resolve/unresolve that SUCCEEDED on this PR since the caller mounted, delivered once each
 * and in the order they were made. Every resolve in the app shares `RESOLVE_THREAD_MUTATION_KEY`
 * (the Changes tab's inline cards and its Threads only view, the Claude Review tab, a Pending
 * card), so one subscription hears them all. The writes already in the cache when the caller
 * mounted are history, not news, and are never delivered.
 *
 * `onEvents` is read through a ref, so its identity never re-runs anything.
 */
export function useResolveEvents(
  prId: number | null | undefined,
  onEvents: (events: ResolveEvent[]) => void,
): void {
  const writes = useMutationState({
    filters: { mutationKey: RESOLVE_THREAD_MUTATION_KEY, status: 'success' },
    select: (m) => ({
      id: m.mutationId,
      at: m.state.submittedAt,
      vars: m.state.variables as { prId: number; threadId: number; resolved: boolean } | undefined,
    }),
  });
  const seenRef = useRef<Set<number> | null>(null);
  seenRef.current ??= new Set(writes.map((w) => w.id));
  const onEventsRef = useRef(onEvents);
  useLayoutEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);
  useEffect(() => {
    const seen = seenRef.current!;
    const fresh = writes.filter((w) => !seen.has(w.id)).sort((a, b) => a.at - b.at);
    if (fresh.length === 0) return;
    for (const w of fresh) seen.add(w.id);
    const events = fresh
      .filter((w) => w.vars != null && w.vars.prId === prId)
      .map((w) => ({ threadId: w.vars!.threadId, resolved: w.vars!.resolved }));
    if (events.length > 0) onEventsRef.current(events);
  }, [writes, prId]);
}

/**
 * A tiny per-thread signal for the Changes tab's inline pills. ONE `useResolveEvents` subscription
 * (in ChangesTab) fans out to the one pill that cares, so a resolve re-renders that pill and never
 * the memo'd diff — a context value that changed per resolve would repaint every row.
 */
export interface ThreadResolveBus {
  subscribe: (threadId: number, cb: (resolved: boolean) => void) => () => void;
  emit: (e: ResolveEvent) => void;
}

export function createThreadResolveBus(): ThreadResolveBus {
  const listeners = new Map<number, Set<(resolved: boolean) => void>>();
  return {
    subscribe(threadId, cb) {
      let set = listeners.get(threadId);
      if (set == null) {
        set = new Set();
        listeners.set(threadId, set);
      }
      set.add(cb);
      return () => {
        set.delete(cb);
        if (set.size === 0) listeners.delete(threadId);
      };
    },
    emit(e) {
      for (const cb of listeners.get(e.threadId) ?? []) cb(e.resolved);
    },
  };
}
