// The bounds behind Activity → Docs' three resizable columns (library | viewer | chat).
// Pure, so the arithmetic is pinned by test/docsLayout.test.ts; DocsView.tsx measures the row
// and hands the ceilings to `useResizablePane`, whose `clampPaneWidth` applies them.

export const DOCS_LIBRARY_W = { min: 200, max: 480, default: 288 } as const; // 288 = the old `lg:w-72`
export const DOCS_CHAT_W = { min: 280, max: 720, default: 384 } as const; // 384 = the old `xl:w-96`
/** The viewer never gets narrower than this from a drag (the floor of a column still wins). */
export const DOCS_VIEWER_MIN_W = 360;
/** One separator's footprint: a 6px handle plus 4px each side (`w-1.5 mx-1`). */
export const DOCS_SEPARATOR_W = 14;
/** The collapsed library: a slim strip, no separator after it (it is not resizable). */
export const DOCS_LIBRARY_STRIP_W = 40;
export const DOCS_STRIP_GAP_W = 12; // `gap-3` between the strip and the viewer

export interface DocsPaneBoundsInput {
  /** The measured row width; null before the first measure (the column maxima stand). */
  rowWidth: number | null;
  /** The library's current width, or null while it is collapsed to the strip. */
  libraryWidth: number | null;
  /** The chat's current width, or null when it is not beside the viewer (narrow layout). */
  chatWidth: number | null;
}

/**
 * Each column's CEILING, so dragging one can never squeeze the viewer under
 * DOCS_VIEWER_MIN_W. Each bound reads the OTHER column's current width; a ceiling below its
 * column's floor is passed through as-is — `clampPaneWidth` lets the floor win there.
 */
export function docsPaneBounds({ rowWidth, libraryWidth, chatWidth }: DocsPaneBoundsInput): {
  libraryMax: number;
  chatMax: number;
} {
  if (rowWidth == null || !Number.isFinite(rowWidth) || rowWidth <= 0) {
    return { libraryMax: DOCS_LIBRARY_W.max, chatMax: DOCS_CHAT_W.max };
  }
  const chatTaken = chatWidth == null ? 0 : chatWidth + DOCS_SEPARATOR_W;
  const libraryTaken = libraryWidth == null ? DOCS_LIBRARY_STRIP_W + DOCS_STRIP_GAP_W : libraryWidth + DOCS_SEPARATOR_W;
  return {
    libraryMax: Math.round(Math.min(DOCS_LIBRARY_W.max, rowWidth - DOCS_VIEWER_MIN_W - DOCS_SEPARATOR_W - chatTaken)),
    chatMax: Math.round(Math.min(DOCS_CHAT_W.max, rowWidth - DOCS_VIEWER_MIN_W - DOCS_SEPARATOR_W - libraryTaken)),
  };
}
