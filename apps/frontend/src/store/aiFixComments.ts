import { create } from 'zustand';
import {
  AI_FIX_MAX_COMMENT_TARGETS,
  type AiFixCommentTargetRef,
} from '@pierre-review/shared';

// The comments a user has dragged into an AI-Fix run's scope, PER PR, FOR THIS SESSION ONLY.
//
// A standalone store rather than a slice of store/filters.ts, deliberately:
//   • nothing here belongs in `FilterDefaults` — persistence and "Clear filters" share that one
//     list, so a basket in it would be wiped by the filter-bar reset and, worse, a per-PR map in
//     the persisted blob is a FILTER_STORAGE_VERSION landmine for a shape that changes per PR;
//   • it is not URL-serialized: a link carrying someone else's half-built basket would silently
//     seed a paid run.
// It IS a store rather than component state because AiFixTab is lazy and the tab body unmounts on
// a tab switch — React state would drop a carefully curated basket on a glance at the Changes tab.
// The RUN persists the targets it was given (`AiFix.commentTargets`), so a reload losing the
// basket loses only an unlaunched draft.

const refKey = (r: AiFixCommentTargetRef): string => `${r.kind}|${r.id}`;

/**
 * ⚠ MODULE-LEVEL, so `useAiFixSelection` can fall back to it with a STABLE reference. zustand v5
 * compares snapshots with `Object.is`; a selector returning a fresh `[]` each render either warns
 * or loops.
 */
const EMPTY: AiFixCommentTargetRef[] = [];

interface AiFixCommentsState {
  /** prId → the selected refs in INSERTION order (the order the report's C1/C2/… labels follow). */
  byPr: Record<number, AiFixCommentTargetRef[]>;
  add: (prId: number, refs: AiFixCommentTargetRef[]) => void;
  remove: (prId: number, refs: AiFixCommentTargetRef[]) => void;
  clear: (prId: number) => void;
}

/**
 * Exported like every other store in `store/` — the `.getState()` handle is how the transitions
 * below are pinned by `test/aiFixCommentModel.test.ts` without React. Components go through
 * `useAiFixSelection` / `useAiFixCommentActions`, never through this directly: a raw
 * `useAiFixComments((s) => s.byPr[id] ?? [])` at a call site is the zustand v5 snapshot trap.
 */
export const useAiFixComments = create<AiFixCommentsState>((set, get) => ({
  byPr: {},
  add: (prId, refs) => {
    const cur = get().byPr[prId] ?? EMPTY;
    const seen = new Set(cur.map(refKey));
    const next = cur.slice();
    for (const r of refs) {
      // ⚠ THE CAP IS ENFORCED HERE, not only in the UI. The server truncates at
      // AI_FIX_MAX_COMMENT_TARGETS, and a silently dropped tail is the worst version of this: the
      // user watches a paid run work through a scope that is missing the comments they cared most
      // about. Stopping at the boundary lets the picker say "scope is full" instead.
      if (next.length >= AI_FIX_MAX_COMMENT_TARGETS) break;
      const k = refKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      // Copied, never aliased — the caller's ref objects come out of a memoised render model.
      next.push({ kind: r.kind, id: r.id });
    }
    // No-op adds (already selected, or at the cap) must not replace the array: the reference IS
    // the render identity for every consumer of `useAiFixSelection`.
    if (next.length === cur.length) return;
    set({ byPr: { ...get().byPr, [prId]: next } });
  },
  remove: (prId, refs) => {
    const cur = get().byPr[prId];
    if (cur == null || cur.length === 0) return;
    const drop = new Set(refs.map(refKey));
    const next = cur.filter((r) => !drop.has(refKey(r)));
    if (next.length === cur.length) return;
    set({ byPr: { ...get().byPr, [prId]: next } });
  },
  clear: (prId) => {
    if (get().byPr[prId] == null) return;
    const next = { ...get().byPr };
    delete next[prId];
    set({ byPr: next });
  },
}));

/** This PR's selection, in insertion order. Stable reference while unchanged (see EMPTY). */
export function useAiFixSelection(prId: number): AiFixCommentTargetRef[] {
  return useAiFixComments((s) => s.byPr[prId] ?? EMPTY);
}

/**
 * The write surface. ONE frozen module-level object rather than a selector: a selector returning
 * `{add, remove, clear}` builds a new object every render, which under zustand v5 is the
 * "getSnapshot should be cached" trap. Nothing here subscribes, which is also what keeps a card's
 * `onClick` from re-rendering the whole picker.
 */
const ACTIONS = Object.freeze({
  add: (prId: number, refs: AiFixCommentTargetRef[]): void =>
    useAiFixComments.getState().add(prId, refs),
  remove: (prId: number, refs: AiFixCommentTargetRef[]): void =>
    useAiFixComments.getState().remove(prId, refs),
  clear: (prId: number): void => useAiFixComments.getState().clear(prId),
});

export function useAiFixCommentActions(): typeof ACTIONS {
  return ACTIONS;
}
