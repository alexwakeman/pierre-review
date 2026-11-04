// Where the expanded toast panel sits (components/HeaderToasts.tsx). Pure, so it can be tested.
//
// ⚠ IT ANCHORS AT THE CLUSTER'S TOP-RIGHT CORNER AND GROWS UP AND LEFT. The collapsed toasts are a
// cluster of circles at the bottom right of the main content; the panel opens just above it, its
// BOTTOM-RIGHT corner on the cluster's top-right corner. It grows LEFTWARDS as far as its content
// needs — never past the main content's left edge (the docked sidebar's right edge, or the viewport's
// left gutter when the sidebar is a drawer) — and UPWARDS, never past the viewport's top less a
// gutter. Past that width the content wraps or truncates; past the height it scrolls inside the
// panel (its scroll bar on the right).

/** The narrowest an expanded panel gets, when the room allows. */
export const TOAST_PANEL_MIN_W = 320;
/** Space kept clear between an expanded panel and the edges it must not cross. */
export const TOAST_GUTTER = 8;
/** The gap between the cluster and the panel above it. */
export const TOAST_PANEL_GAP = 6;
/** The tallest an expanded panel gets; past it the panel scrolls inside itself. */
export const TOAST_PANEL_MAX_H = 560;
/** The shortest an expanded panel's max height gets, however little room is above the cluster. */
export const TOAST_PANEL_MIN_H = 120;

export interface ToastPanelBox {
  /** Distance from the viewport's BOTTOM edge (CSS `bottom`). */
  bottom: number;
  /** Distance from the viewport's RIGHT edge (CSS `right`). */
  right: number;
  minWidth: number;
  maxWidth: number;
  maxHeight: number;
}

export function anchorClusterPanel(
  cluster: { top: number; right: number },
  /** The main content's left edge in viewport px (0 when the sidebar is not docked). */
  contentLeft: number,
  viewportWidth: number,
  viewportHeight: number,
): ToastPanelBox {
  const right = Math.max(TOAST_GUTTER, viewportWidth - cluster.right);
  const leftLimit = Math.max(0, contentLeft) + TOAST_GUTTER;
  const maxWidth = Math.max(0, viewportWidth - right - leftLimit);
  const bottom = Math.max(0, viewportHeight - cluster.top) + TOAST_PANEL_GAP;
  return {
    bottom,
    right,
    minWidth: Math.min(TOAST_PANEL_MIN_W, maxWidth),
    maxWidth,
    maxHeight: Math.max(TOAST_PANEL_MIN_H, Math.min(TOAST_PANEL_MAX_H, viewportHeight - bottom - TOAST_GUTTER)),
  };
}

/** Where a job's circle sits in the cluster: higher = further right, painted on top, and listed
 *  first in the expanded panel. Attention beats a time-critical action beats a running job; within
 *  a rank the newest wins. */
export function toastRank(
  t: { alert: boolean; action: boolean; progress: boolean },
  seq: number,
): number {
  const tier = t.alert ? 3 : t.action ? 2 : t.progress ? 1 : 0;
  return tier * 100_000 + (seq % 100_000);
}

/**
 * How far the cluster must rise so it never sits on a panel's action bar pinned to the bottom right
 * (a SidePanel's footer — docked at lg+, a sheet below). `obstacles` are those bars' rects; one
 * counts only when it reaches the cluster's corner (its right edge within `reach` of the viewport's
 * right) and sits at the viewport's bottom. Returns the px from the viewport bottom to the highest
 * such bar's top, or 0.
 */
export function toastLift(
  obstacles: ReadonlyArray<{ top: number; bottom: number; right: number; height: number }>,
  viewportWidth: number,
  viewportHeight: number,
  reach = 160,
): number {
  let lift = 0;
  for (const r of obstacles) {
    if (r.height <= 0) continue;
    if (r.right < viewportWidth - reach) continue;
    if (r.bottom < viewportHeight - 24) continue;
    lift = Math.max(lift, Math.round(viewportHeight - r.top));
  }
  return lift;
}
