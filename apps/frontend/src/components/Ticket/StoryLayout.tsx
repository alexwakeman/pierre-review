// THE STORY VIEW'S TWO-COLUMN LAYOUT (docs/FRONTEND.md § The story view → Wide layout). The story body
// (StoryViewBody.tsx) wraps its content in <StoryLayout>, which MEASURES ITS OWN CONTAINER — never the
// window: This Sprint's tray is narrow on a wide screen.
//
//   NARROW   (container < STORY_TWO_COLUMN_MIN_PX: a laptop, a phone, the tray) one column, capped at
//            max-w-5xl — the view as it always was. Everything a rail would hold renders in place.
//   WIDE     a reading column (minmax(0, 60rem)) and a RIGHT RAIL (18–22rem). The rail holds the facts and
//            actions; the pieces that live there render through <InRail slot=…> (a portal, so React
//            context — the PR-ref provider, the start mutations — still reaches them). In narrow mode
//            the same <InRail> renders its children in place (`inline`) or nothing (rail-only extras:
//            the criteria counts, the section nav, the docs summary).
//
//   WIDE BLOCKS  <StoryWide> (the story design) breaks out of the reading column to the container's
//            right edge, spanning the rail. The rail is therefore TWO sticky segments measured around
//            it: the facts / actions / section nav from the Story section's top down to the block, and
//            the PR lists / docs summary from below the block to the end. With no wide block (or too
//            little room above it for the top segment) the rail is one segment and the block stays in
//            the reading column.
//
//   SECTION NAV  every section the nav can reach carries `data-story-section="<id>"`; the nav lists the
//            ones present (re-read on every measure) and scrolls to them.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { railSegments, storyTwoColumn, type RailSegments } from '../../lib/storyLayout.js';

/** The rail's slots, top to bottom. The first three form the top segment when a wide block splits it. */
export const STORY_RAIL_SLOTS = ['check', 'actions', 'nav', 'prs', 'merged', 'docs'] as const;
export type StoryRailSlot = (typeof STORY_RAIL_SLOTS)[number];
const TOP_SLOTS: readonly StoryRailSlot[] = ['check', 'actions', 'nav'];
/** The gap between rail blocks (`gap-5`). */
const RAIL_GAP_PX = 20;
/** The sections the nav can reach, in page order, and their words. */
export const STORY_SECTIONS = [
  { id: 'story', label: 'Story' },
  { id: 'design', label: 'Design' },
  { id: 'missing', label: 'Outside the criteria' },
  { id: 'not-asked', label: 'Not asked for' },
  { id: 'docs', label: 'Docs' },
] as const;
export type StorySectionId = (typeof STORY_SECTIONS)[number]['id'];

interface StoryLayoutValue {
  wide: boolean;
  /** The wide block may break out (there is room above it for the rail's top segment). */
  breakout: boolean;
  slots: Partial<Record<StoryRailSlot, HTMLElement>>;
  sections: readonly StorySectionId[];
  root: HTMLElement | null;
  setWideBlock: (el: HTMLElement | null) => void;
}

const Ctx = createContext<StoryLayoutValue | null>(null);

/** The story layout around this component (null outside the story view, e.g. the PR pane). */
export function useStoryLayout(): StoryLayoutValue | null {
  return useContext(Ctx);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function StoryLayout({ children }: { children: ReactNode }): JSX.Element {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const topRailRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [wideBlock, setWideBlock] = useState<HTMLElement | null>(null);
  const [segments, setSegments] = useState<RailSegments>({ top: { start: 0, end: null }, bottom: null });
  const [breakout, setBreakout] = useState(false);
  const [sections, setSections] = useState<readonly StorySectionId[]>([]);
  const [slots, setSlots] = useState<Partial<Record<StoryRailSlot, HTMLElement>>>({});
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const wide = storyTwoColumn(width);

  // The container's width (the tab's pane, or the tray).
  useIsoLayoutEffect(() => {
    if (root == null) return;
    setWidth(root.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(root.clientWidth));
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  // Where the rail's segments sit, and which sections the nav can reach: re-read whenever the
  // reading column or the wide block changes size.
  const measure = useCallback(() => {
    const main = mainRef.current;
    if (main == null) return;
    const present = STORY_SECTIONS.filter((s) => main.querySelector(`[data-story-section="${s.id}"]`) != null).map((s) => s.id);
    setSections((prev) => (prev.length === present.length && prev.every((p, i) => p === present[i]) ? prev : present));
    if (!wide) return;
    const base = main.getBoundingClientRect().top;
    const startEl = main.querySelector('[data-story-section="story"]');
    const start = startEl != null ? Math.max(0, startEl.getBoundingClientRect().top - base) : 0;
    let block: { top: number; bottom: number } | null = null;
    if (wideBlock != null && main.contains(wideBlock)) {
      const r = wideBlock.getBoundingClientRect();
      block = { top: r.top - base, bottom: r.bottom - base };
    }
    // The top segment's content (status … nav) must fit in the room above the block, unscrolled.
    const tops = TOP_SLOTS.map((n) => slotsRef.current[n]).filter((el): el is HTMLElement => el != null && el.offsetHeight > 0);
    const topContent = tops.reduce((sum, el) => sum + el.offsetHeight, 0) + Math.max(0, tops.length - 1) * RAIL_GAP_PX;
    const { segments: next, breakout: canBreak } = railSegments(start, block, topContent);
    setBreakout(canBreak);
    setSegments((prev) =>
      prev.top.start === next.top.start && prev.top.end === next.top.end && prev.bottom?.start === next.bottom?.start ? prev : next,
    );
  }, [wide, wideBlock]);

  useIsoLayoutEffect(() => {
    const main = mainRef.current;
    measure();
    if (main == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(main);
    if (wideBlock != null) ro.observe(wideBlock);
    for (const n of TOP_SLOTS) {
      const el = slots[n];
      if (el != null) ro.observe(el);
    }
    // A section appearing without a size change (rare) is caught on the next DOM change.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure());
    mo?.observe(main, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [measure, wideBlock, slots]);

  const split = wide && breakout && segments.bottom != null;
  const slotRef = useCallback(
    (name: StoryRailSlot) => (el: HTMLDivElement | null) => {
      setSlots((prev) => (prev[name] === (el ?? undefined) ? prev : { ...prev, [name]: el ?? undefined }));
    },
    [],
  );
  // Stable callback refs per slot (a new function every render would detach and re-attach each time).
  const refs = useMemo(
    () => Object.fromEntries(STORY_RAIL_SLOTS.map((s) => [s, slotRef(s)])) as Record<StoryRailSlot, (el: HTMLDivElement | null) => void>,
    [slotRef],
  );
  const slotDivs = (names: readonly StoryRailSlot[]): ReactNode =>
    names.map((s) => <div key={`${s}:${split ? 's' : 'o'}`} ref={refs[s]} data-rail-slot={s} className="empty:hidden" />);

  const value = useMemo<StoryLayoutValue>(
    () => ({ wide, breakout: wide && breakout, slots: wide ? slots : {}, sections, root, setWideBlock }),
    [wide, breakout, slots, sections, root],
  );

  const segStyle = (start: number, end: number | null): CSSProperties => ({ top: start, ...(end != null ? { height: Math.max(0, end - start) } : { bottom: 0 }) });
  return (
    <Ctx.Provider value={value}>
      <div ref={setRoot} data-testid="story-layout" data-wide={wide ? 'true' : 'false'}>
        <div className={wide ? 'grid grid-cols-[minmax(0,60rem)_minmax(18rem,22rem)] gap-x-10' : ''}>
          <div ref={mainRef} className={wide ? 'min-w-0' : 'max-w-5xl'}>
            {children}
          </div>
          {wide && (
            <aside aria-label="Story facts and actions" className="relative" data-testid="story-rail">
              <div className="absolute inset-x-0" style={segStyle(segments.top.start, split ? segments.top.end : null)}>
                <div
                  ref={topRailRef}
                  className="sticky top-4 max-h-[calc(100dvh-6rem)] -mx-2 flex flex-col gap-5 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2"
                  data-testid="story-rail-top"
                >
                  {slotDivs(split ? TOP_SLOTS : STORY_RAIL_SLOTS)}
                </div>
              </div>
              {split && segments.bottom != null && (
                <div className="absolute inset-x-0 bottom-0" style={{ top: segments.bottom.start }}>
                  <div
                    className="sticky top-4 max-h-[calc(100dvh-6rem)] -mx-2 flex flex-col gap-5 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2"
                    data-testid="story-rail-bottom"
                  >
                    {slotDivs(STORY_RAIL_SLOTS.filter((s) => !TOP_SLOTS.includes(s)))}
                  </div>
                </div>
              )}
            </aside>
          )}
        </div>
      </div>
    </Ctx.Provider>
  );
}

/**
 * A piece of the rail. Wide: rendered into its slot (a portal). Narrow, or outside the story view:
 * rendered in place when `inline`, else nothing (a rail-only extra).
 */
export function InRail({ slot, inline = false, children }: { slot: StoryRailSlot; inline?: boolean; children: ReactNode }): JSX.Element | null {
  const layout = useStoryLayout();
  if (layout?.wide) {
    const target = layout.slots[slot];
    return target != null ? createPortal(children, target) : null;
  }
  return inline ? <>{children}</> : null;
}

/** True when this component's content is drawn in the rail instead of in place. */
export function useInRail(): boolean {
  return useStoryLayout()?.wide === true;
}

/**
 * Wide content (the story design): in the two-column layout it breaks out of the reading column to the
 * container's right edge, across the rail. Elsewhere (narrow, the tray, the PR pane) it is a plain block.
 */
export function StoryWide({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  const layout = useStoryLayout();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const register = layout?.setWideBlock;
  useEffect(() => {
    if (register == null || el == null) return;
    register(el);
    return () => register(null);
  }, [register, el]);
  const root = layout?.root ?? null;
  const on = layout?.breakout === true;
  useIsoLayoutEffect(() => {
    if (!on || el == null || root == null) {
      setWidth(null);
      return;
    }
    const read = (): void => {
      // From this block's left edge to the container's right edge.
      const w = Math.floor(root.getBoundingClientRect().right - el.getBoundingClientRect().left);
      setWidth((prev) => (prev === w ? prev : w));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(root);
    return () => ro.disconnect();
  }, [on, el, root]);
  return (
    <div
      ref={setEl}
      data-story-wide={width != null ? 'true' : 'false'}
      className={`${className}${width != null ? ' relative z-10 rounded-ui bg-ui-surface pr-4' : ''}`}
      style={width != null ? { width } : undefined}
    >
      {children}
    </div>
  );
}

/** The rail's "On this page": the sections present, each a link that scrolls to it. */
export function StorySectionNav(): JSX.Element | null {
  const layout = useStoryLayout();
  if (layout == null || !layout.wide || layout.sections.length < 2) return null;
  const go = (id: StorySectionId): void => {
    const el = layout.root?.querySelector<HTMLElement>(`[data-story-section="${id}"]`);
    if (el == null) return;
    const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    // Move focus with the scroll, so a keyboard reader continues from the section.
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  };
  return (
    <nav aria-label="On this page" data-testid="story-section-nav">
      <p className="mb-1 text-meta text-ui-mute">On this page</p>
      <ul className="space-y-0.5">
        {STORY_SECTIONS.filter((s) => layout.sections.includes(s.id)).map((s) => (
          <li key={s.id}>
            <a
              href={`#story-${s.id}`}
              onClick={(e) => {
                e.preventDefault();
                go(s.id);
              }}
              className="hit -mx-1.5 block rounded-ui px-1.5 py-0.5 text-body text-ui-ink hover:bg-ui-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The gap PaneWide keeps from the scroll pane's right edge (the panes pad their content by ~20px). */
const PANE_EDGE_PX = 20;

/**
 * Wide content OUTSIDE the story view (the PR pane's AI Review design, the story build's planned
 * design): it breaks out of its capped reading column to the right edge of the scroll pane it sits in,
 * so a many-lane data flow gets the screen's width before it has to scroll sideways. A block narrower
 * than its column (a phone) is left alone.
 */
export function PaneWide({ children }: { children: ReactNode }): JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useIsoLayoutEffect(() => {
    if (el == null) return;
    let pane: HTMLElement | null = null;
    for (let node = el.parentElement; node != null; node = node.parentElement) {
      const oy = getComputedStyle(node).overflowY;
      if (oy === 'auto' || oy === 'scroll') {
        pane = node;
        break;
      }
    }
    if (pane == null) return;
    const host = pane;
    const read = (): void => {
      const paneRect = host.getBoundingClientRect();
      const own = el.parentElement?.getBoundingClientRect();
      if (own == null) return;
      const right = paneRect.left + host.clientWidth - PANE_EDGE_PX;
      const w = Math.floor(right - own.left);
      // Only ever wider than the column it sits in.
      setWidth((prev) => {
        const next = w > own.width + 1 ? w : null;
        return prev === next ? prev : next;
      });
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(host);
    if (el.parentElement != null) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [el]);
  return (
    <div ref={setEl} data-pane-wide={width != null ? 'true' : 'false'} className="relative" style={width != null ? { width } : undefined}>
      {children}
    </div>
  );
}
