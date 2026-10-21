import { describe, expect, it } from 'vitest';
import {
  TOAST_GUTTER,
  TOAST_PANEL_MAX_H,
  TOAST_PANEL_MIN_W,
  anchorToastPanel,
} from '../src/lib/toastAnchor.js';

describe('anchorToastPanel — an expanded header toast anchors at the card top-left', () => {
  it('puts the panel top-left exactly on the card top-left and grows right', () => {
    const p = anchorToastPanel({ top: 7.5, left: 374, width: 256 }, 1440, 900);
    expect(p.top).toBe(7.5);
    expect(p.left).toBe(374);
    expect(p.width).toBe(TOAST_PANEL_MIN_W);
  });

  it('keeps a card wider than the minimum at its own width', () => {
    expect(anchorToastPanel({ top: 8, left: 100, width: 400 }, 1440, 900).width).toBe(400);
  });

  it('shifts left only as far as the right gutter demands', () => {
    const p = anchorToastPanel({ top: 8, left: 1200, width: 256 }, 1440, 900);
    expect(p.left + p.width).toBe(1440 - TOAST_GUTTER);
    expect(p.left).toBe(1440 - TOAST_GUTTER - TOAST_PANEL_MIN_W);
  });

  it('never leaves the left gutter, and never outgrows a narrow viewport', () => {
    const p = anchorToastPanel({ top: 8, left: 2, width: 96 }, 300, 900);
    expect(p.left).toBe(TOAST_GUTTER);
    expect(p.width).toBe(300 - TOAST_GUTTER * 2);
  });

  it('caps the height at the viewport bottom and at the panel maximum', () => {
    expect(anchorToastPanel({ top: 8, left: 0, width: 256 }, 1440, 300).maxHeight).toBe(300 - 8 - TOAST_GUTTER);
    expect(anchorToastPanel({ top: 8, left: 0, width: 256 }, 1440, 2000).maxHeight).toBe(TOAST_PANEL_MAX_H);
  });
});
