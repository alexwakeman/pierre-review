// The bounds behind the Changes tab's draggable file-list rail. Everything that can set a
// width — the pointer drag, the arrow keys, Home/End, the double-click reset and the value
// restored from localStorage — goes through this ONE function, so the invariants below hold
// for every path rather than for whichever one someone remembered to guard.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { clampPaneWidth } from '../src/hooks/useResizablePane.js';

const MIN = 140;
const MAX = 720;
const DEFAULT = 224;

describe('clampPaneWidth', () => {
  it('passes an in-range width through, rounded to whole pixels', () => {
    expect(clampPaneWidth(300, MIN, MAX, DEFAULT)).toBe(300);
    expect(clampPaneWidth(300.4, MIN, MAX, DEFAULT)).toBe(300);
    expect(clampPaneWidth(300.6, MIN, MAX, DEFAULT)).toBe(301);
  });

  it('holds the floor so the rail can never be dragged to nothing', () => {
    expect(clampPaneWidth(0, MIN, MAX, DEFAULT)).toBe(MIN);
    expect(clampPaneWidth(-9999, MIN, MAX, DEFAULT)).toBe(MIN);
  });

  it('holds the ceiling so the diff can never be dragged to nothing', () => {
    expect(clampPaneWidth(9999, MIN, MAX, DEFAULT)).toBe(MAX);
  });

  it('yields the FLOOR, not an inverted range, when the container is too narrow for both panes', () => {
    // A 380px pane minus the diff's 320px minimum leaves 60 — below the rail's own floor.
    // The rail keeps its minimum and overflows; it must NOT collapse to 60 (max winning) or
    // to some value between the two bounds.
    expect(clampPaneWidth(500, MIN, 60, DEFAULT)).toBe(MIN);
    expect(clampPaneWidth(10, MIN, 60, DEFAULT)).toBe(MIN);
  });

  it('clamps a stored width restored on a smaller screen rather than rejecting it', () => {
    // Chosen at 640 on a wide monitor, reopened in a 700px pane whose ceiling is 380.
    expect(clampPaneWidth(640, MIN, 380, DEFAULT)).toBe(380);
  });

  it('falls back to the default on a non-finite stored value instead of emitting NaN', () => {
    expect(clampPaneWidth(Number.NaN, MIN, MAX, DEFAULT)).toBe(DEFAULT);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY, MIN, MAX, DEFAULT)).toBe(DEFAULT);
    // The fallback is clamped too — it is not a bypass of the bounds.
    expect(clampPaneWidth(Number.NaN, MIN, 180, DEFAULT)).toBe(180);
  });
});
