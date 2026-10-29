import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { HeaderToastTone } from '../HeaderToasts.js';
import { MOTION, prefersReducedMotion } from './media.js';

// OPTIMISTIC REMOVAL + UNDO (docs/redesign/DESIGN.md § Feedback).
//
// A row the reader acted on (merged, dismissed, approved off the list) leaves AT ONCE: it slides out
// (170ms, instant with reduced motion), the counts drop, and an Undo card appears in the ONE header
// toast strip (`UndoToast`, mounted in App.tsx — never a toast of its own). `z` undoes too.
//
// Two modes, because not every write can be taken back:
//  • 'immediate' — the write runs now; Undo runs an INVERSE write (`undo`, e.g. restore a dismissal).
//    Use when the server has an inverse. `undo` is required.
//  • 'deferred'  — the write waits for the toast to expire (or a newer offer, or the card's ×), and
//    Undo simply cancels it. Use for a write with no inverse (merge). ⚠ A deferred write that never
//    fired because the page closed simply did not happen — say "Merging in 8s" rather than "Merged".
//
// A FAILED write puts the row back and calls `onError` (show the reason where the row is). Never a
// silent loss: optimistic means "assume success, repair on failure", not "ignore failure".
//
// The hidden set is per SCOPE (a list) and per KEY (a row id). A key stays hidden until the list's
// own data no longer has it (`useOptimisticList` prunes), so a refetch that still contains the row
// cannot flash it back before the server catches up.

export const UNDO_TOAST_MS = 8_000;

export interface RemovalRequest {
  /** Which list ("pending:my_turn"). */
  scope: string;
  /** Which row (stable id). */
  key: string;
  /** Toast label: what happened, in a word or two ("Merged", "Dismissed"). */
  label: string;
  /** Toast summary: which thing ("acme/api #12"). */
  summary: string;
  mode: 'immediate' | 'deferred';
  /** The write. In 'deferred' mode it runs when the offer expires. */
  commit: () => unknown;
  /** The inverse write ('immediate' mode). */
  undo?: () => unknown;
  /** The write failed: the row is back; tell the reader why. */
  onError?: (err: unknown) => void;
  tone?: HeaderToastTone;
  /** How long the Undo offer stays (and, deferred, how long the write waits). */
  ms?: number;
}

export interface UndoOffer {
  id: number;
  label: string;
  summary: string;
  tone: HeaderToastTone;
  pending: boolean;
}

interface Internal {
  offerId: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Deferred commit not yet fired. */
  fire: (() => void) | null;
  /** Restore + inverse. */
  revert: (() => void) | null;
}

interface UndoState {
  offer: UndoOffer | null;
  leaving: Record<string, readonly string[]>;
  removed: Record<string, readonly string[]>;
  setPending: (pending: boolean) => void;
}

const internal: Internal = { offerId: 0, timer: null, fire: null, revert: null };

export const useUndoStore = create<UndoState>((set) => ({
  offer: null,
  leaving: {},
  removed: {},
  setPending: (pending) => set((s) => (s.offer ? { offer: { ...s.offer, pending } } : {})),
}));

function withKey(map: Record<string, readonly string[]>, scope: string, key: string, on: boolean): Record<string, readonly string[]> {
  const cur = map[scope] ?? [];
  const has = cur.includes(key);
  if (on === has) return map;
  return { ...map, [scope]: on ? [...cur, key] : cur.filter((k) => k !== key) };
}

function restore(scope: string, key: string): void {
  useUndoStore.setState((s) => ({
    leaving: withKey(s.leaving, scope, key, false),
    removed: withKey(s.removed, scope, key, false),
  }));
}

/** Settle the current offer: fire a waiting deferred write, drop the toast. */
export function finalizeUndoOffer(): void {
  if (internal.timer) clearTimeout(internal.timer);
  internal.timer = null;
  const fire = internal.fire;
  internal.fire = null;
  internal.revert = null;
  useUndoStore.setState({ offer: null });
  fire?.();
}

/** Take the current offer back (the Undo button, the `z` key). No-op when there is none. */
export function undoLast(): void {
  const revert = internal.revert;
  if (!revert) return;
  if (internal.timer) clearTimeout(internal.timer);
  internal.timer = null;
  internal.fire = null;
  internal.revert = null;
  useUndoStore.setState({ offer: null });
  revert();
}

/** Remove a row now and offer Undo. See the header for the two modes. */
export function removeOptimistically(req: RemovalRequest): void {
  // A newer action settles the older one first (its deferred write goes now).
  finalizeUndoOffer();
  const { scope, key } = req;
  const ms = req.ms ?? UNDO_TOAST_MS;

  useUndoStore.setState((s) => ({ leaving: withKey(s.leaving, scope, key, true) }));
  const leaveMs = prefersReducedMotion() ? 0 : MOTION.leave;
  setTimeout(() => {
    useUndoStore.setState((s) => {
      if (!(s.leaving[scope] ?? []).includes(key)) return {}; // undone during the slide
      return {
        leaving: withKey(s.leaving, scope, key, false),
        removed: withKey(s.removed, scope, key, true),
      };
    });
  }, leaveMs);

  const fail = (err: unknown): void => {
    restore(scope, key);
    req.onError?.(err);
  };
  const runCommit = (): void => {
    try {
      Promise.resolve(req.commit()).catch(fail);
    } catch (err) {
      fail(err);
    }
  };

  const id = ++internal.offerId;
  if (req.mode === 'immediate') {
    runCommit();
    internal.revert = () => {
      restore(scope, key);
      try {
        Promise.resolve(req.undo?.()).catch((err) => req.onError?.(err));
      } catch (err) {
        req.onError?.(err);
      }
    };
  } else {
    internal.fire = runCommit;
    internal.revert = () => restore(scope, key);
  }
  internal.timer = setTimeout(() => {
    if (internal.offerId === id) finalizeUndoOffer();
  }, ms);
  useUndoStore.setState({
    offer: { id, label: req.label, summary: req.summary, tone: req.tone ?? 'neutral', pending: false },
  });
}

/**
 * A list's view of the optimistic state: the rows still shown, and which are sliding out. Prunes a
 * hidden key once `items` no longer contains it (the server agrees), so a later return shows again.
 */
export function useOptimisticList<T>(
  scope: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): { visible: T[]; isLeaving: (item: T) => boolean } {
  const leaving = useUndoStore((s) => s.leaving[scope]);
  const removed = useUndoStore((s) => s.removed[scope]);

  useEffect(() => {
    if (!removed || removed.length === 0) return;
    const present = new Set(items.map(keyOf));
    const gone = removed.filter((k) => !present.has(k));
    if (gone.length === 0) return;
    useUndoStore.setState((s) => ({
      removed: { ...s.removed, [scope]: (s.removed[scope] ?? []).filter((k) => !gone.includes(k)) },
    }));
    // keyOf is expected to be stable in behaviour; items/removed drive the prune.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, removed, scope]);

  return useMemo(() => {
    const hidden = new Set(removed ?? []);
    const sliding = new Set(leaving ?? []);
    return {
      visible: items.filter((it) => !hidden.has(keyOf(it))),
      isLeaving: (it: T) => sliding.has(keyOf(it)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, removed, leaving]);
}

/** Test seam: forget everything (timers included). */
export function resetUndoForTests(): void {
  if (internal.timer) clearTimeout(internal.timer);
  internal.timer = null;
  internal.fire = null;
  internal.revert = null;
  useUndoStore.setState({ offer: null, leaving: {}, removed: {} });
}
