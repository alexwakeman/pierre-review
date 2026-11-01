// THE STORY VIEW'S WIDE LAYOUT, its pure half (components/Ticket/StoryLayout.tsx draws it;
// test/storyLayout.test.ts; docs/FRONTEND.md § The story view → Wide layout).

/** The container width at which the story view goes to two columns. Measured on real stories: at this
 *  width the reading column is ≥ ~47rem beside the 18rem rail, so a criterion card keeps its verdict
 *  chip and title on one line; below it (a 1280px window with the sidebar) one capped column reads
 *  better than two cramped ones. */
export const STORY_TWO_COLUMN_MIN_PX = 1080;

export function storyTwoColumn(containerWidth: number): boolean {
  return containerWidth >= STORY_TWO_COLUMN_MIN_PX;
}
