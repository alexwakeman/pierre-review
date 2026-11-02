// THE CHANGES TAB'S REVEAL SCROLL, held until the layout SETTLES.
//
// The tab mounts its code lazily (`diffChunks` + FileDiffView's `LazyMount`): a file or a stretch of
// a file that has never been near the screen is a placeholder of ESTIMATED height. A reveal into the
// last file therefore scrolls through, and lands beside, placeholders that turn into real rows of a
// slightly different height as they mount — the target moves AFTER `scrollIntoView` has picked its
// offset. A single call lands a few hundred pixels off. So a reveal scrolls, waits for the scroll to
// stop, and re-issues the SAME scroll (instant) whenever the target moves under a pane
// that did not — until it holds still.
//
// ⚠ ONLY THE PANE SCROLLS. `scrollIntoView` scrolls EVERY scrollable ancestor — the document and
// the app shell's `overflow: hidden` boxes too — so any stray overflow outside the pane (the
// sr-only spans once, FileDiffView § `relative`) moved the whole app: a second scroll bar and a
// shell that jumped. A reveal now sets the pane's own `scrollTop` (`paneScrollTarget`, honouring
// the target's `scroll-margin`), and falls back to `scrollIntoView` only with no pane. The gated
// programmatic-scroll rules are the vis TIMELINE's, not this.
// ⚠ The READER WINS. Any wheel, touch, pointer or key input stops the settle at once, and so does a
// frame where the pane scrolled by exactly the distance the target moved (a scrollbar drag, which
// sends none of those events). A newer reveal cancels an older one (one settle at a time).

/** How a frame moved, judged from the pane's scroll delta and the target's on-screen delta. */
export type SettleFrame = 'still' | 'reader' | 'shift';

/**
 * - `still`: the target did not move on screen (nothing happened, or the browser's scroll
 *   anchoring absorbed a layout change above it by moving the pane).
 * - `reader`: the pane scrolled and the target moved WITH it — someone scrolled.
 * - `shift`: the target moved and the pane did not — content above it changed height.
 */
export function classifySettleFrame(dScroll: number, dTop: number): SettleFrame {
  if (Math.abs(dTop) < 1) return 'still';
  if (Math.abs(dScroll) >= 1 && Math.abs(dScroll + dTop) < 2) return 'reader';
  return 'shift';
}

/**
 * Smooth only for a short hop. A long smooth scroll through a lazily-mounted diff passes over
 * placeholders that mount mid-flight (each one a burst of work, each one moving the target), and
 * reads as a slow blur anyway; past ~1.5 panes the jump is instant and then settles.
 */
export function revealBehavior(distancePx: number, paneHeightPx: number): ScrollBehavior {
  return Math.abs(distancePx) <= paneHeightPx * 1.5 ? 'smooth' : 'auto';
}

/**
 * The pane `scrollTop` that puts a target where `scrollIntoView({block})` would, inside that pane
 * only. `top` is the target's offset from the pane's top edge NOW, `height` its height, `margin` its
 * `scroll-margin-top`. 'nearest' leaves the pane alone when the target is already in full view.
 */
export function paneScrollTarget(
  block: ScrollLogicalPosition,
  scrollTop: number,
  paneHeight: number,
  top: number,
  height: number,
  margin: number,
): number {
  const at = scrollTop + top;
  switch (block) {
    case 'start':
      return at - margin;
    case 'end':
      return at + height - paneHeight;
    case 'nearest':
      if (top >= margin && top + height <= paneHeight) return scrollTop;
      return top < margin ? at - margin : at + height - paneHeight;
    default:
      return at - (paneHeight - height) / 2;
  }
}

/** The nearest scrolling ancestor, or null for the document. */
export function scrollParentOf(el: Element): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p != null) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') return p;
    p = p.parentElement;
  }
  return null;
}

// Wait this long for the first (possibly smooth) scroll to stop on its own.
const FIRST_SCROLL_CAP_MS = 1200;
// A smooth scroll that has not visibly started by now is not going to.
const START_GRACE_MS = 150;
// Stop once the target has held still this long since the last correction…
const QUIET_MS = 700;
// …and never run longer than this.
const SETTLE_CAP_MS = 4000;

let current: (() => void) | null = null;

/**
 * Scroll `el`'s pane so `el` sits at `block` (as `scrollIntoView` would, pane only), then keep it
 * there while the layout around it settles. Returns a cancel function (safe to call twice). A newer call cancels this one.
 */
export function revealIntoView(el: Element, block: ScrollLogicalPosition): () => void {
  current?.();
  const pane = scrollParentOf(el);
  const paneTop = (): number => (pane != null ? pane.getBoundingClientRect().top : 0);
  const paneH = pane != null ? pane.clientHeight : window.innerHeight;
  const scrollTop = (): number =>
    pane != null ? pane.scrollTop : (document.scrollingElement?.scrollTop ?? 0);
  const top = (): number => el.getBoundingClientRect().top - paneTop();

  // A HIDDEN target (the code under the Threads only view is `display: none`) measures 0×0 at the
  // pane's corner: never scroll for it — that sent the pane to the top and fought the thread list.
  const hidden = (): boolean => {
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0;
  };
  const scrollTo = (behavior: ScrollBehavior): void => {
    if (hidden()) return;
    if (pane == null) return el.scrollIntoView({ block, behavior });
    const r = el.getBoundingClientRect();
    const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
    const target = paneScrollTarget(block, pane.scrollTop, pane.clientHeight, r.top - paneTop(), r.height, margin);
    pane.scrollTo({ top: Math.max(0, target), behavior });
  };

  scrollTo(revealBehavior(top() - paneH / 2, paneH));
  if (typeof requestAnimationFrame !== 'function') return () => undefined;

  const start = performance.now();
  let lastMove = start;
  let lastCorrection = start;
  let settled = false; // the first scroll has stopped
  let stableFrames = 0;
  let sawMove = false;
  let prevScroll = scrollTop();
  let prevTop = top();
  let raf = 0;
  let done = false;

  const stop = (): void => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    for (const t of INPUT_EVENTS) window.removeEventListener(t, stop, true);
    if (current === stop) current = null;
  };
  const correct = (): void => {
    scrollTo('auto');
    lastCorrection = performance.now();
    prevScroll = scrollTop();
    prevTop = top();
  };
  const frame = (): void => {
    if (done) return;
    const now = performance.now();
    if (!el.isConnected || hidden() || now - start > SETTLE_CAP_MS) return stop();
    const s = scrollTop();
    const t = top();
    if (!settled) {
      // Phase 1: let the first scroll (smooth or not) finish, then correct once.
      // A smooth scroll may not have started on the first frames: stillness counts only once the
      // pane has moved, or after a short grace (a target already in place never moves).
      if (Math.abs(s - prevScroll) >= 1) {
        stableFrames = 0;
        lastMove = now;
        sawMove = true;
      } else if (sawMove || now - start > START_GRACE_MS) stableFrames += 1;
      prevScroll = s;
      prevTop = t;
      if (stableFrames >= 3 || now - lastMove > FIRST_SCROLL_CAP_MS || now - start > FIRST_SCROLL_CAP_MS) {
        settled = true;
        correct();
      }
    } else {
      // Phase 2: hold the target while the placeholders around it mount.
      const kind = classifySettleFrame(s - prevScroll, t - prevTop);
      if (kind === 'reader') return stop();
      if (kind === 'shift') correct();
      else {
        prevScroll = s;
        prevTop = t;
      }
      if (now - lastCorrection > QUIET_MS) return stop();
    }
    raf = requestAnimationFrame(frame);
  };
  for (const t of INPUT_EVENTS) window.addEventListener(t, stop, { capture: true, passive: true });
  raf = requestAnimationFrame(frame);
  current = stop;
  return stop;
}

const INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
