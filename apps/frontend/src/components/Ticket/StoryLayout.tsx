// THE STORY VIEW'S TWO-COLUMN LAYOUT (docs/FRONTEND.md § The story view → Wide layout). The story body
// (StoryViewBody.tsx) wraps its content in <StoryLayout>: the shared rail layout (../RailLayout.tsx —
// the measuring, portals, split around the design and section nav live there) with the story's slots,
// sections and words. It MEASURES ITS OWN CONTAINER — never the window: This Sprint's tray and the PR
// view's Story tab are narrow on a wide screen.
//
//   NARROW   (container < STORY_TWO_COLUMN_MIN_PX) one column, capped at max-w-5xl.
//   WIDE     a reading column and a RIGHT RAIL: status + criteria (`check`), the Story actions, the
//            section nav, "What each PR adds", the Merged panel, the docs summary.
//   <StoryWide> (the story design) spans the rail; the rail is then two sticky segments around it.
import type { ReactNode } from 'react';
import {
  PaneWide,
  RailLayout,
  RailPiece,
  RailSectionNav,
  RailWide,
  useRailLayout,
  useRailWide,
  type RailLayoutConfig,
} from '../RailLayout.js';

export { PaneWide };

/** The rail's slots, top to bottom. The first three form the top segment when a wide block splits it. */
export const STORY_RAIL_SLOTS = ['check', 'actions', 'nav', 'prs', 'merged', 'docs'] as const;
export type StoryRailSlot = (typeof STORY_RAIL_SLOTS)[number];
/** The sections the nav can reach, in page order, and their words. */
export const STORY_SECTIONS = [
  { id: 'story', label: 'Story' },
  { id: 'design', label: 'Design' },
  { id: 'missing', label: 'Outside the criteria' },
  { id: 'not-asked', label: 'Not asked for' },
  { id: 'docs', label: 'Docs' },
] as const;
export type StorySectionId = (typeof STORY_SECTIONS)[number]['id'];

export const STORY_RAIL: RailLayoutConfig = {
  name: 'story',
  slots: STORY_RAIL_SLOTS,
  topSlots: ['check', 'actions', 'nav'],
  sections: STORY_SECTIONS,
  sectionAttr: 'data-story-section',
  startSection: 'story',
  railLabel: 'Story facts and actions',
  narrowClassName: 'max-w-5xl',
  wideClassName: 'relative z-10 rounded-ui bg-ui-surface pr-4',
};

/** The story layout around this component (null outside the story view, e.g. the PR pane). */
export function useStoryLayout(): ReturnType<typeof useRailLayout> {
  const layout = useRailLayout();
  return layout?.config.name === 'story' ? layout : null;
}

/** The PR view's Story tab: no card around the story (as the story tab), so the rail starts at the
 *  story's top — beside the ticket's header, as the AI Review tab's rail does. */
export const STORY_RAIL_EMBEDDED: RailLayoutConfig = { ...STORY_RAIL, startSection: null };

export function StoryLayout({
  oneColumn = false,
  embedded = false,
  children,
}: {
  oneColumn?: boolean;
  /** The PR view's Story tab (`STORY_RAIL_EMBEDDED`). */
  embedded?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <RailLayout config={embedded ? STORY_RAIL_EMBEDDED : STORY_RAIL} oneColumn={oneColumn}>
      {children}
    </RailLayout>
  );
}

/**
 * A piece of the story rail. Wide: rendered into its slot (a portal). Narrow, or outside the story view:
 * rendered in place when `inline`, else nothing (a rail-only extra).
 */
export function InRail({ slot, inline = false, children }: { slot: StoryRailSlot; inline?: boolean; children: ReactNode }): JSX.Element | null {
  const layout = useStoryLayout();
  // Outside the story layout (another layout around it) the piece is drawn as if narrow.
  if (layout == null) return inline ? <>{children}</> : null;
  return (
    <RailPiece slot={slot} inline={inline}>
      {children}
    </RailPiece>
  );
}

/** True when this component's content is drawn in the story rail instead of in place. */
export function useInRail(): boolean {
  return useRailWide('story');
}

/** Wide content (the story design): spans the rail in the two-column layout; a plain block elsewhere. */
export function StoryWide({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <RailWide className={className}>{children}</RailWide>;
}

/** The rail's "On this page". */
export function StorySectionNav(): JSX.Element | null {
  return <RailSectionNav />;
}
