// Where the expanded header toast panel sits, and how the cluster orders its circles.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend toastClusterAnchor
import { describe, expect, it } from 'vitest';
import {
  TOAST_GUTTER,
  TOAST_PANEL_GAP,
  TOAST_PANEL_MAX_H,
  TOAST_PANEL_MIN_W,
  anchorClusterPanel,
  toastRank,
} from '../src/lib/toastAnchor.js';

describe('anchorClusterPanel — the panel grows LEFT from the cluster', () => {
  it('pins its right edge to the cluster and sits just under it', () => {
    const p = anchorClusterPanel({ bottom: 40, right: 1412 }, 260, 1440, 900);
    expect(p.right).toBe(28);
    expect(p.top).toBe(40 + TOAST_PANEL_GAP);
  });

  it('never grows past the main content left edge', () => {
    const p = anchorClusterPanel({ bottom: 40, right: 1412 }, 260, 1440, 900);
    // left edge at its widest = vw - right - maxWidth
    expect(1440 - p.right - p.maxWidth).toBe(260 + TOAST_GUTTER);
  });

  it('uses the viewport gutter when the sidebar is a drawer', () => {
    const p = anchorClusterPanel({ bottom: 40, right: 760 }, 0, 768, 900);
    expect(768 - p.right - p.maxWidth).toBe(TOAST_GUTTER);
    expect(p.minWidth).toBe(TOAST_PANEL_MIN_W);
  });

  it('shrinks the minimum when the room is narrower than it', () => {
    const p = anchorClusterPanel({ bottom: 40, right: 300 }, 0, 300, 900);
    expect(p.minWidth).toBe(p.maxWidth);
    expect(p.maxWidth).toBeLessThan(TOAST_PANEL_MIN_W);
  });

  it('scrolls past the max height, and past the viewport bottom', () => {
    expect(anchorClusterPanel({ bottom: 40, right: 1412 }, 0, 1440, 2000).maxHeight).toBe(TOAST_PANEL_MAX_H);
    expect(anchorClusterPanel({ bottom: 40, right: 1412 }, 0, 1440, 400).maxHeight).toBe(
      400 - 40 - TOAST_PANEL_GAP - TOAST_GUTTER,
    );
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
