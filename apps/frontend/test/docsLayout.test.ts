// Activity → Docs' column ceilings (lib/docsLayout.ts): no drag may squeeze the viewer below its
// minimum, and the floors still win in a row too narrow for all three.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  DOCS_CHAT_W,
  DOCS_LIBRARY_STRIP_W,
  DOCS_LIBRARY_W,
  DOCS_SEPARATOR_W,
  DOCS_STRIP_GAP_W,
  DOCS_VIEWER_MIN_W,
  docsPaneBounds,
} from '../src/lib/docsLayout.js';
import { clampPaneWidth } from '../src/hooks/useResizablePane.js';

describe('docsPaneBounds', () => {
  it('returns the column maxima before the row is measured', () => {
    expect(docsPaneBounds({ rowWidth: null, libraryWidth: 288, chatWidth: 384 })).toEqual({
      libraryMax: DOCS_LIBRARY_W.max,
      chatMax: DOCS_CHAT_W.max,
    });
    expect(docsPaneBounds({ rowWidth: 0, libraryWidth: 288, chatWidth: 384 }).libraryMax).toBe(DOCS_LIBRARY_W.max);
    expect(docsPaneBounds({ rowWidth: Number.NaN, libraryWidth: 288, chatWidth: 384 }).chatMax).toBe(DOCS_CHAT_W.max);
  });

  it('caps at the column maxima on a very wide row', () => {
    expect(docsPaneBounds({ rowWidth: 4000, libraryWidth: 300, chatWidth: 400 })).toEqual({ libraryMax: 480, chatMax: 720 });
  });

  it('leaves the viewer its minimum whichever column is dragged', () => {
    const row = 1400;
    const lib = 300;
    const chat = 600;
    const { libraryMax, chatMax } = docsPaneBounds({ rowWidth: row, libraryWidth: lib, chatWidth: chat });
    // library at its ceiling, chat as is
    expect(row - libraryMax - chat - 2 * DOCS_SEPARATOR_W).toBeGreaterThanOrEqual(DOCS_VIEWER_MIN_W);
    // chat at its ceiling, library as is
    expect(row - lib - chatMax - 2 * DOCS_SEPARATOR_W).toBeGreaterThanOrEqual(DOCS_VIEWER_MIN_W);
    expect(libraryMax).toBe(row - DOCS_VIEWER_MIN_W - DOCS_SEPARATOR_W - chat - DOCS_SEPARATOR_W);
  });

  it('ignores the chat when it is not beside the viewer (narrow layout)', () => {
    expect(docsPaneBounds({ rowWidth: 900, libraryWidth: 300, chatWidth: null }).libraryMax).toBe(
      Math.min(DOCS_LIBRARY_W.max, 900 - DOCS_VIEWER_MIN_W - DOCS_SEPARATOR_W),
    );
  });

  it('gives the chat the library’s room when the library is collapsed to the strip', () => {
    const open = docsPaneBounds({ rowWidth: 1300, libraryWidth: 400, chatWidth: 384 }).chatMax;
    const collapsed = docsPaneBounds({ rowWidth: 1300, libraryWidth: null, chatWidth: 384 }).chatMax;
    expect(collapsed).toBeGreaterThan(open);
    expect(collapsed).toBe(Math.min(DOCS_CHAT_W.max, 1300 - DOCS_VIEWER_MIN_W - DOCS_SEPARATOR_W - DOCS_LIBRARY_STRIP_W - DOCS_STRIP_GAP_W));
  });

  it('lets the floor win in a row too narrow for all three', () => {
    const { libraryMax, chatMax } = docsPaneBounds({ rowWidth: 1000, libraryWidth: 400, chatWidth: 500 });
    expect(libraryMax).toBeLessThan(DOCS_LIBRARY_W.min);
    expect(chatMax).toBeLessThan(DOCS_CHAT_W.min);
    expect(clampPaneWidth(400, DOCS_LIBRARY_W.min, libraryMax, DOCS_LIBRARY_W.default)).toBe(DOCS_LIBRARY_W.min);
    expect(clampPaneWidth(500, DOCS_CHAT_W.min, chatMax, DOCS_CHAT_W.default)).toBe(DOCS_CHAT_W.min);
  });
});
