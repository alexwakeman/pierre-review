// THE STORY VIEW'S WIDE LAYOUT, its pure half (components/Ticket/StoryLayout.tsx draws it;
// test/storyLayout.test.ts; docs/FRONTEND.md § The story view → Wide layout).

/** The container width at which the story view goes to two columns. Measured on real stories: at this
 *  width the reading column is ≥ ~47rem beside the 18rem rail, so a criterion card keeps its verdict
 *  chip and title on one line; below it (a 1280px window with the sidebar) one capped column reads
 *  better than two cramped ones. */
export const STORY_TWO_COLUMN_MIN_PX = 1080;
/** The space kept between the wide block and a rail segment. */
export const SEGMENT_GAP_PX = 24;
/** Above this little room the top segment would be a scroll box beside the summary: no split then. */
export const MIN_TOP_SEGMENT_PX = 260;

export function storyTwoColumn(containerWidth: number): boolean {
  return containerWidth >= STORY_TWO_COLUMN_MIN_PX;
}

export interface RailSegments {
  /** Pixels from the reading column's top. `end` null = to the bottom. */
  top: { start: number; end: number | null };
  /** The segment under the wide block; null = one segment. */
  bottom: { start: number } | null;
}

/**
 * Where the rail's segments sit. `start` is the Story section's top; `block` the wide block's top and
 * bottom (null = none), all relative to the reading column. With a wide block AND room above it for the
 * top segment (at least MIN_TOP_SEGMENT_PX and its own content's height), the rail splits around the block (which then breaks out across the rail); otherwise it
 * is one segment and the block stays in the reading column (`breakout` false).
 */
export function railSegments(
  start: number,
  block: { top: number; bottom: number } | null,
  /** The top segment's own content height (status, criteria, actions, nav): it must fit unscrolled. */
  topContent = 0,
): { segments: RailSegments; breakout: boolean } {
  const s = Math.max(0, start);
  if (block == null || block.top - SEGMENT_GAP_PX - s < Math.max(MIN_TOP_SEGMENT_PX, topContent)) {
    return { segments: { top: { start: s, end: null }, bottom: null }, breakout: false };
  }
  return {
    segments: { top: { start: s, end: block.top - SEGMENT_GAP_PX }, bottom: { start: block.bottom + SEGMENT_GAP_PX } },
    breakout: true,
  };
}
