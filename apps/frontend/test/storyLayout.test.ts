// THE STORY VIEW'S WIDE LAYOUT (docs/FRONTEND.md § The story view → Wide layout;
// components/Ticket/StoryLayout.tsx, lib/storyLayout.ts).
//
// Pins:
//   1. Two columns from the CONTAINER's width (never the window's): the tray stays one column.
//   2. The rail splits around the wide block (the story design) only when there is room above it;
//      otherwise one segment and the block stays in the reading column.
//   3. The wiring: the body mounts StoryLayout; the tab no longer caps the width itself; each section
//      the nav reaches carries its `data-story-section`; the rail's pieces go through InRail.
//   4. The data-flow figure: lanes never narrower than 12rem (9rem in a phone-sized box), the lane cards
//      sticky with the visible scrollbar, and an overflowing step box is a named, focusable region.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/storyLayout.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_TOP_SEGMENT_PX, SEGMENT_GAP_PX, STORY_TWO_COLUMN_MIN_PX, railSegments, storyTwoColumn } from '../src/lib/storyLayout.js';
import { FLOW_LANE_MIN_REM, FLOW_LANE_MIN_REM_PHONE } from '../src/lib/dataFlow.js';

const src = (rel: string): string => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

describe('two columns', () => {
  it('turns on at the container breakpoint', () => {
    expect(storyTwoColumn(STORY_TWO_COLUMN_MIN_PX - 1)).toBe(false);
    expect(storyTwoColumn(STORY_TWO_COLUMN_MIN_PX)).toBe(true);
    // The This Sprint tray (~620–800px) never goes to two columns, however wide the window.
    expect(storyTwoColumn(800)).toBe(false);
  });
  it('measures the container, not the window', () => {
    // The measuring lives in the shared rail layout (the story view and the AI Review tab).
    const layout = src('components/RailLayout.tsx') + src('components/Ticket/StoryLayout.tsx');
    expect(layout).not.toMatch(/window\.innerWidth|useIsDesktop|matchMedia\('\(min-width/);
    expect(layout).toMatch(/ResizeObserver/);
  });
});

describe('rail segments', () => {
  it('is one segment with no wide block', () => {
    expect(railSegments(40, null)).toEqual({ segments: { top: { start: 40, end: null }, bottom: null }, breakout: false });
  });
  it('splits around the block when there is room above it', () => {
    const r = railSegments(40, { top: 2000, bottom: 3000 });
    expect(r.breakout).toBe(true);
    expect(r.segments).toEqual({ top: { start: 40, end: 2000 - SEGMENT_GAP_PX }, bottom: { start: 3000 + SEGMENT_GAP_PX } });
  });
  it('keeps the block in the column when the top segment would be too short', () => {
    const top = 40 + SEGMENT_GAP_PX + MIN_TOP_SEGMENT_PX - 1;
    expect(railSegments(40, { top, bottom: top + 900 })).toEqual({
      segments: { top: { start: 40, end: null }, bottom: null },
      breakout: false,
    });
  });
});

describe('rail segments: the top content must fit', () => {
  it('no split when the facts, actions and nav are taller than the room above the block', () => {
    const block = { top: 40 + SEGMENT_GAP_PX + 400, bottom: 2000 };
    expect(railSegments(40, block, 380).breakout).toBe(true);
    expect(railSegments(40, block, 460).breakout).toBe(false);
  });
});

describe('wiring', () => {
  it('the body mounts the layout and the tab does not cap the width', () => {
    expect(src('components/Ticket/StoryViewBody.tsx')).toMatch(/<StoryLayout oneColumn=\{oneColumn\} embedded=\{embedded\}>/);
    // The PR view's Story tab: the rail starts at the story's top (beside the header), no card while wide.
    expect(src('components/pr/PrStoryTab.tsx')).toMatch(/<StoryViewBody [^>]*\bembedded\b/);
    expect(src('components/Ticket/StoryLayout.tsx')).toMatch(/STORY_RAIL_EMBEDDED: RailLayoutConfig = \{ \.\.\.STORY_RAIL, startSection: null \}/);
    expect(src('components/Activity/OpenPrsCards.tsx')).toMatch(/single && \(page \|\| \(embedded && railWide\)\) \? ''/);
    expect(src('components/Ticket/TicketTabView.tsx')).not.toMatch(/max-w-5xl/);
  });
  it('every section the nav lists is marked where it renders', () => {
    const marks: Record<string, string> = {
      story: 'components/Activity/TicketStorySection.tsx',
      design: 'components/Activity/StoryDesignSection.tsx',
      missing: 'components/TicketReviewParts.tsx',
      'not-asked': 'components/TicketReviewParts.tsx',
      docs: 'components/Activity/StoryDocsAlignment.tsx',
    };
    for (const [id, file] of Object.entries(marks)) expect(src(file)).toContain(`data-story-section="${id}"`);
  });
  it('the rail pieces go through InRail, and the design is wide content', () => {
    expect(src('components/Activity/TicketStorySection.tsx')).toMatch(/InRail slot="actions" inline/);
    expect(src('components/Activity/TicketStorySection.tsx')).toMatch(/InRail slot="prs" inline/);
    expect(src('components/Activity/OpenPrsCards.tsx')).toMatch(/InRail slot="merged" inline/);
    expect(src('components/Activity/OpenPrsCards.tsx')).toMatch(/InRail slot="check"/);
    expect(src('components/Activity/StoryDesignSection.tsx')).toMatch(/<StoryWide>/);
  });
});

describe('the data-flow figure', () => {
  it('lanes keep a readable minimum', () => {
    expect(FLOW_LANE_MIN_REM).toBeGreaterThanOrEqual(12);
    expect(FLOW_LANE_MIN_REM_PHONE).toBeLessThan(FLOW_LANE_MIN_REM);
  });
  it('sticky lane cards, a visible scrollbar, a focusable named region when it overflows', () => {
    const flow = src('components/FlowDiagram.tsx');
    expect(flow).toMatch(/sticky top-0/);
    expect(flow).toMatch(/scroll-x-visible/);
    expect(flow).toMatch(/role: 'region', tabIndex: 0, 'aria-label'/);
    expect(flow).toMatch(/max-w-\[26rem\]/);
  });
});
