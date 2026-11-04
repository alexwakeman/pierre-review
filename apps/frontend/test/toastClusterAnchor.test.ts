// Where the expanded toast panel sits, how far the cluster rises over a pinned action bar, and how the
// cluster orders its circles.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend toastClusterAnchor
import { describe, expect, it } from 'vitest';
import {
  TOAST_GUTTER,
  TOAST_PANEL_GAP,
  TOAST_PANEL_MAX_H,
  TOAST_PANEL_MIN_H,
  TOAST_PANEL_MIN_W,
  anchorClusterPanel,
  toastLift,
  toastRank,
} from '../src/lib/toastAnchor.js';

// The cluster at the bottom right of a 1440×900 viewport: its top at 856, its right edge at 1428.
const DESK = { top: 856, right: 1428 };

describe('anchorClusterPanel — the panel grows UP and LEFT from the cluster', () => {
  it('pins its bottom-right corner to the cluster top-right corner', () => {
    const p = anchorClusterPanel(DESK, 232, 1440, 900);
    expect(p.right).toBe(12);
    expect(p.bottom).toBe(900 - 856 + TOAST_PANEL_GAP);
  });

  it('never grows past the main content left edge', () => {
    const p = anchorClusterPanel(DESK, 232, 1440, 900);
    // left edge at its widest = vw - right - maxWidth
    expect(1440 - p.right - p.maxWidth).toBe(232 + TOAST_GUTTER);
  });

  it('uses the viewport gutter when the sidebar is a drawer', () => {
    const p = anchorClusterPanel({ top: 776, right: 378 }, 0, 390, 844);
    expect(390 - p.right - p.maxWidth).toBe(TOAST_GUTTER);
    expect(p.minWidth).toBe(TOAST_PANEL_MIN_W);
  });

  it('shrinks the minimum when the room is narrower than it', () => {
    const p = anchorClusterPanel({ top: 800, right: 300 }, 0, 300, 900);
    expect(p.minWidth).toBe(p.maxWidth);
    expect(p.maxWidth).toBeLessThan(TOAST_PANEL_MIN_W);
  });

  it('never grows past the viewport top, and scrolls past the max height', () => {
    // Tall viewport: the cap.
    expect(anchorClusterPanel({ top: 1956, right: 1428 }, 0, 1440, 2000).maxHeight).toBe(TOAST_PANEL_MAX_H);
    // Short viewport: the room above the cluster, less the gap and the top gutter — so its top edge
    // at its tallest is the gutter below the viewport top.
    const p = anchorClusterPanel({ top: 356, right: 1428 }, 0, 1440, 400);
    expect(p.maxHeight).toBe(356 - TOAST_PANEL_GAP - TOAST_GUTTER);
    expect(400 - p.bottom - p.maxHeight).toBe(TOAST_GUTTER);
  });

  it('keeps a usable minimum height when almost no room is left', () => {
    expect(anchorClusterPanel({ top: 60, right: 1428 }, 0, 1440, 900).maxHeight).toBe(TOAST_PANEL_MIN_H);
  });
});

describe('toastLift — the cluster rises over an action bar pinned at the bottom right', () => {
  it('rises to the top of a bar that reaches the corner', () => {
    expect(toastLift([{ top: 840, bottom: 900, right: 1440, height: 60 }], 1440, 900)).toBe(60);
  });
  it('ignores a bar that stops short of the corner, or does not sit at the bottom', () => {
    expect(toastLift([{ top: 840, bottom: 900, right: 900, height: 60 }], 1440, 900)).toBe(0);
    expect(toastLift([{ top: 400, bottom: 460, right: 1440, height: 60 }], 1440, 900)).toBe(0);
    expect(toastLift([{ top: 0, bottom: 0, right: 0, height: 0 }], 1440, 900)).toBe(0);
  });
  it('takes the highest of several', () => {
    expect(
      toastLift(
        [
          { top: 840, bottom: 900, right: 1440, height: 60 },
          { top: 780, bottom: 900, right: 1440, height: 120 },
        ],
        1440,
        900,
      ),
    ).toBe(120);
  });
});

describe('toastRank — most urgent, then newest, on top', () => {
  const plain = { alert: false, action: false, progress: false };
  it('puts an alert above everything, however old', () => {
    expect(toastRank({ ...plain, alert: true }, 1)).toBeGreaterThan(toastRank({ ...plain, action: true }, 999));
    expect(toastRank({ ...plain, action: true }, 1)).toBeGreaterThan(toastRank({ ...plain, progress: true }, 999));
    expect(toastRank({ ...plain, progress: true }, 1)).toBeGreaterThan(toastRank(plain, 999));
  });
  it('puts the newer of two equals on top', () => {
    expect(toastRank(plain, 5)).toBeGreaterThan(toastRank(plain, 4));
  });
});
