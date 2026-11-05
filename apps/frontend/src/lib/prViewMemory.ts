// WHERE THE READER WAS IN EACH PR — the PR detail's last tab and the scroll position of its
// scrolling pane per tab, so reopening a PR (a tab click, the sidebar's open tabs, a link that names
// no tab) lands where they left it.
//
// ⚠ THIS SESSION ONLY, IN MEMORY. A plain module Map, never localStorage or the store: a reload
// starts every PR on Overview, as before. Not the Zustand store either — the store's URL-owned keys
// are reset by every pop, and this is not something the address bar names.
//
// ⚠ A MEMORY, NEVER AN INSTRUCTION. PrDetail reads it only when a PR's pane ARRIVES on screen and
// nothing else asked for a place: an explicit `?prTab=` (the `{prId, tab}` pair already names this
// PR), a `?thread=`, a comment / activity / review / fix / changes deep link — each of those wins.
// Bounded (least recently used out) so a long session cannot grow it without limit.

import type { PrDetailTab } from '../store/filters.js';

interface PrView {
  tab: PrDetailTab;
  scroll: Map<PrDetailTab, number>;
}

/** How many PRs are remembered; the least recently touched one goes first. */
export const PR_VIEW_MEMORY_CAP = 50;

const memory = new Map<number, PrView>();

function touch(prId: number): PrView {
  const existing = memory.get(prId);
  const view: PrView = existing ?? { tab: 'overview', scroll: new Map() };
  // Re-insert so Map order is recency order.
  memory.delete(prId);
  memory.set(prId, view);
  while (memory.size > PR_VIEW_MEMORY_CAP) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  return view;
}

export function rememberPrTab(prId: number, tab: PrDetailTab): void {
  touch(prId).tab = tab;
}

export function rememberPrScroll(prId: number, tab: PrDetailTab, top: number): void {
  if (!Number.isFinite(top)) return;
  touch(prId).scroll.set(tab, Math.max(0, Math.round(top)));
}

/** The PR's last tab, or null when this session has not seen the PR. */
export function rememberedPrTab(prId: number): PrDetailTab | null {
  return memory.get(prId)?.tab ?? null;
}

/** The pane's last scroll position on that tab, or null. */
export function rememberedPrScroll(prId: number, tab: PrDetailTab): number | null {
  return memory.get(prId)?.scroll.get(tab) ?? null;
}

/** Tests only. */
export function forgetAllPrViews(): void {
  memory.clear();
}

// ── RESTORING THE SCROLL ───────────────────────────────────────────────────────────────────────
//
// The Changes tab mounts its code lazily and the pane's content grows for a while after the tab
// renders, so one `scrollTop =` lands short. The restore re-applies the target each frame until the
// pane can hold it and its height has stopped moving — and gives up on reader input, a newer
// navigation (the caller cancels), or a cap.

/** One frame's decision, pure for its test. */
export type RestoreStep = 'apply' | 'wait' | 'done';

/**
 * - `apply`: the pane is off the target and can reach it (or closer to it) — set `scrollTop`.
 * - `wait`: at (or as near as the content allows to) the target, but the content is still growing.
 * - `done`: at the target and the height has held still for `stableMs`.
 */
export function restoreStep(args: {
  scrollTop: number;
  maxScrollTop: number;
  target: number;
  heightStableForMs: number;
  stableMs?: number;
}): RestoreStep {
  const { scrollTop, maxScrollTop, target, heightStableForMs, stableMs = 400 } = args;
  const reachable = Math.min(target, Math.max(0, maxScrollTop));
  if (Math.abs(scrollTop - reachable) > 1) return 'apply';
  if (reachable >= target - 1 && heightStableForMs >= stableMs) return 'done';
  return 'wait';
}

const RESTORE_CAP_MS = 5000;
const INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Scroll `getPane()` to `target` and hold it there while the content settles. `getPane` is read
 * each frame (the pane mounts after the PR loads). Returns a cancel function (safe to call twice).
 */
export function restorePaneScroll(getPane: () => HTMLElement | null, target: number): () => void {
  if (typeof requestAnimationFrame !== 'function' || target <= 0) return () => undefined;
  const start = performance.now();
  let lastHeight = -1;
  let heightSince = start;
  let raf = 0;
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    for (const t of INPUT_EVENTS) window.removeEventListener(t, stop, true);
  };
  const frame = (): void => {
    if (done) return;
    const now = performance.now();
    if (now - start > RESTORE_CAP_MS) return stop();
    const pane = getPane();
    if (pane != null && pane.isConnected) {
      if (pane.scrollHeight !== lastHeight) {
        lastHeight = pane.scrollHeight;
        heightSince = now;
      }
      const step = restoreStep({
        scrollTop: pane.scrollTop,
        maxScrollTop: pane.scrollHeight - pane.clientHeight,
        target,
        heightStableForMs: now - heightSince,
      });
      if (step === 'done') return stop();
      if (step === 'apply') pane.scrollTop = target;
    }
    raf = requestAnimationFrame(frame);
  };
  for (const t of INPUT_EVENTS) window.addEventListener(t, stop, { capture: true, passive: true });
  raf = requestAnimationFrame(frame);
  return stop;
}
