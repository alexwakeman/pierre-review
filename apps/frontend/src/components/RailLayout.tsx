// THE TWO-COLUMN RAIL LAYOUT — one mechanism for every view that reads as CONTENT beside a sticky rail
// of FACTS AND ACTIONS (docs/FRONTEND.md § The story view → Wide layout, § The AI Review tab → Wide
// layout). Two hosts today: the story view (Ticket/StoryLayout.tsx, `STORY_RAIL`) and the PR pane's AI
// Review tab (`REVIEW_RAIL`, ClaudeReviewTab.tsx). Each passes its own config (slots, sections, words);
// the measuring, the portals, the split around a wide block and the section nav are this file's.
//
// It MEASURES ITS OWN CONTAINER — never the window: This Sprint's tray and the PR drawer are narrow on a
// wide screen.
//
//   NARROW   (container < TWO_COLUMN_MIN_PX) one column, capped at the config's `narrowClassName` — the
//            view as it always was. Everything a rail would hold renders in place.
//   WIDE     a reading column (minmax(0, 60rem)) and a RIGHT RAIL (18–22rem). The rail's pieces render
//            through <RailPiece slot=…> (a portal, so React context still reaches them). Narrow, the
//            same piece renders its children in place (`inline`) or nothing (a rail-only extra).
//
//   WIDE BLOCKS  <RailWide> (a design diagram) breaks out of the reading column to the container's right
//            edge, spanning the rail. The rail is then TWO sticky segments measured around it: the
//            config's `topSlots` from the start section's top down to the block, the rest from below
//            the block to the end. With no wide block (or too little room above it for the top
//            segment) the rail is one segment and the block stays in the reading column.
//
//   SECTION NAV  every section the nav can reach carries `<sectionAttr>="<id>"`; the nav lists the ones
//            present (re-read on every measure) and scrolls to them.
//
// ⚠ A PIECE NAMES A SLOT OF ITS OWN LAYOUT. A slot the enclosing layout does not have (a story piece
// inside the review layout) renders as if narrow — in place or nothing — never into a missing portal.
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
import { railSegments, storyTwoColumn, type RailSegments } from '../lib/storyLayout.js';

export interface RailLayoutConfig {
  /** The test-id prefix and the layout's identity (`story` → `story-layout`, `story-rail`, …). */
  name: string;
  /** The rail's slots, top to bottom. */
  slots: readonly string[];
  /** The slots of the top segment when a wide block splits the rail. */
  topSlots: readonly string[];
  /** The sections the nav can reach, in page order, and their words. */
  sections: readonly { id: string; label: string }[];
  /** The attribute each reachable section carries (`data-story-section`). */
  sectionAttr: string;
  /** The section whose top the rail starts at (null = the column's top). */
  startSection: string | null;
  /** The rail's accessible name. */
  railLabel: string;
  /** The single column's cap below the breakpoint. */
  narrowClassName: string;
  /** The wide block's paint while it spans the rail (it sits over the rail's column). */
  wideClassName: string;
}

/** The gap between rail blocks (`gap-5`). */
const RAIL_GAP_PX = 20;

interface RailLayoutValue {
  config: RailLayoutConfig;
  wide: boolean;
  /** The wide block may break out (there is room above it for the rail's top segment). */
  breakout: boolean;
  /** The rail is two segments (a wide block broke out). */
  split: boolean;
  slots: Partial<Record<string, HTMLElement>>;
  sections: readonly string[];
  root: HTMLElement | null;
  setWideBlock: (el: HTMLElement | null) => void;
}

const Ctx = createContext<RailLayoutValue | null>(null);

/** The rail layout around this component (null outside one, e.g. the PR drawer's Overview). */
export function useRailLayout(): RailLayoutValue | null {
  return useContext(Ctx);
}

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function RailLayout({
  config,
  oneColumn = false,
  children,
}: {
  config: RailLayoutConfig;
  /** Always the single column, whatever the width (the PR drawer: a short, wide strip under the
   *  timeline, where a sticky rail would have no height to stick in). */
  oneColumn?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const mainRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [wideBlock, setWideBlock] = useState<HTMLElement | null>(null);
  const [segments, setSegments] = useState<RailSegments>({ top: { start: 0, end: null }, bottom: null });
  const [breakout, setBreakout] = useState(false);
  const [sections, setSections] = useState<readonly string[]>([]);
  const [slots, setSlots] = useState<Partial<Record<string, HTMLElement>>>({});
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const wide = !oneColumn && storyTwoColumn(width);
  const { slots: slotNames, topSlots, sections: sectionDefs, sectionAttr, startSection } = config;

  // The container's width (the tab's pane, the tray, the PR drawer).
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
    const present = sectionDefs.filter((s) => main.querySelector(`[${sectionAttr}="${s.id}"]`) != null).map((s) => s.id);
    setSections((prev) => (prev.length === present.length && prev.every((p, i) => p === present[i]) ? prev : present));
    if (!wide) return;
    const base = main.getBoundingClientRect().top;
    const startEl = startSection != null ? main.querySelector(`[${sectionAttr}="${startSection}"]`) : null;
    const start = startEl != null ? Math.max(0, startEl.getBoundingClientRect().top - base) : 0;
    let block: { top: number; bottom: number } | null = null;
    if (wideBlock != null && main.contains(wideBlock)) {
      const r = wideBlock.getBoundingClientRect();
      // An empty block (its section rendered nothing) splits nothing.
      if (r.height > 0) block = { top: r.top - base, bottom: r.bottom - base };
    }
    // The top segment's content must fit in the room above the block, unscrolled.
    const tops = topSlots.map((n) => slotsRef.current[n]).filter((el): el is HTMLElement => el != null && el.offsetHeight > 0);
    const topContent = tops.reduce((sum, el) => sum + el.offsetHeight, 0) + Math.max(0, tops.length - 1) * RAIL_GAP_PX;
    const { segments: next, breakout: canBreak } = railSegments(start, block, topContent);
    setBreakout(canBreak);
    setSegments((prev) =>
      prev.top.start === next.top.start && prev.top.end === next.top.end && prev.bottom?.start === next.bottom?.start ? prev : next,
    );
  }, [wide, wideBlock, sectionDefs, sectionAttr, startSection, topSlots]);

  useIsoLayoutEffect(() => {
    const main = mainRef.current;
    measure();
    if (main == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(main);
    if (wideBlock != null) ro.observe(wideBlock);
    for (const n of topSlots) {
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
  }, [measure, wideBlock, slots, topSlots]);

  const split = wide && breakout && segments.bottom != null;
  const slotRef = useCallback(
    (name: string) => (el: HTMLDivElement | null) => {
      setSlots((prev) => (prev[name] === (el ?? undefined) ? prev : { ...prev, [name]: el ?? undefined }));
    },
    [],
  );
  // Stable callback refs per slot (a new function every render would detach and re-attach each time).
  const refs = useMemo(
    () => Object.fromEntries(slotNames.map((s) => [s, slotRef(s)])) as Record<string, (el: HTMLDivElement | null) => void>,
    [slotRef, slotNames],
  );
  const slotDivs = (names: readonly string[]): ReactNode =>
    names.map((s) => <div key={`${s}:${split ? 's' : 'o'}`} ref={refs[s]} data-rail-slot={s} className="empty:hidden" />);

  const value = useMemo<RailLayoutValue>(
    () => ({ config, wide, breakout: wide && breakout, split, slots: wide ? slots : {}, sections, root, setWideBlock }),
    [config, wide, breakout, split, slots, sections, root],
  );

  const segStyle = (start: number, end: number | null): CSSProperties => ({ top: start, ...(end != null ? { height: Math.max(0, end - start) } : { bottom: 0 }) });
  const segClass =
    'sticky top-4 max-h-[calc(100dvh-6rem)] -mx-2 flex flex-col gap-5 overflow-y-auto overflow-x-hidden overscroll-contain px-2 pb-2';
  const n = config.name;
  return (
    <Ctx.Provider value={value}>
      <div ref={setRoot} data-testid={`${n}-layout`} data-wide={wide ? 'true' : 'false'}>
        <div className={wide ? 'grid grid-cols-[minmax(0,60rem)_minmax(18rem,22rem)] gap-x-10' : ''}>
          <div ref={mainRef} className={wide ? 'min-w-0' : config.narrowClassName}>
            {children}
          </div>
          {wide && (
            <aside aria-label={config.railLabel} className="relative" data-testid={`${n}-rail`}>
              <div className="absolute inset-x-0" style={segStyle(segments.top.start, split ? segments.top.end : null)}>
                <div className={segClass} data-testid={`${n}-rail-top`}>
                  {slotDivs(split ? topSlots : slotNames)}
                </div>
              </div>
              {split && segments.bottom != null && (
                <div className="absolute inset-x-0 bottom-0" style={{ top: segments.bottom.start }}>
                  <div className={segClass} data-testid={`${n}-rail-bottom`}>
                    {slotDivs(slotNames.filter((s) => !topSlots.includes(s)))}
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

/** True when the layout named `name` is around this component and draws its rail. */
export function useRailWide(name: string): boolean {
  const layout = useRailLayout();
  return layout?.wide === true && layout.config.name === name;
}

/**
 * A piece of the rail. Wide: rendered into its slot (a portal). Narrow, outside a layout, or a slot this
 * layout does not have: rendered in place when `inline`, else nothing (a rail-only extra).
 */
export function RailPiece({ slot, inline = false, children }: { slot: string; inline?: boolean; children: ReactNode }): JSX.Element | null {
  const layout = useRailLayout();
  if (layout?.wide && layout.config.slots.includes(slot)) {
    const target = layout.slots[slot];
    return target != null ? createPortal(children, target) : null;
  }
  return inline ? <>{children}</> : null;
}

/**
 * Wide content (a design diagram): in the two-column layout it breaks out of the reading column to the
 * container's right edge, across the rail. Elsewhere (narrow, the tray, outside a layout) a plain block.
 */
export function RailWide({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  const layout = useRailLayout();
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
  const name = layout?.config.name ?? 'rail';
  return (
    <div
      ref={setEl}
      data-rail-wide={width != null ? 'true' : 'false'}
      {...{ [`data-${name}-wide`]: width != null ? 'true' : 'false' }}
      className={`${className}${width != null && layout != null ? ` ${layout.config.wideClassName}` : ''}`}
      style={width != null ? { width } : undefined}
    >
      {children}
    </div>
  );
}

/**
 * The rail's "On this page": the sections present, each a link that scrolls to it. `whenSplit` draws it
 * only while the rail is two segments (the bottom segment's copy, beside what follows a wide block).
 */
export function RailSectionNav({ whenSplit = false }: { whenSplit?: boolean }): JSX.Element | null {
  const layout = useRailLayout();
  if (layout == null || !layout.wide || layout.sections.length < 2) return null;
  if (whenSplit && !layout.split) return null;
  const { name } = layout.config;
  const go = (id: string): void => scrollToSection(layout, id);
  return (
    <nav aria-label="On this page" data-testid={`${name}-section-nav`}>
      <p className="mb-1 text-meta text-ui-mute">On this page</p>
      <ul className="space-y-0.5">
        {layout.config.sections
          .filter((s) => layout.sections.includes(s.id))
          .map((s) => (
            <li key={s.id}>
              <a
                href={`#${name}-${s.id}`}
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

function scrollToSection(layout: RailLayoutValue, id: string): void {
  const el = layout.root?.querySelector<HTMLElement>(`[${layout.config.sectionAttr}="${id}"]`);
  if (el == null) return;
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  // Move focus with the scroll, so a keyboard reader continues from the section.
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

/** Scrolls the enclosing layout to one of its sections (a rail count that names a section); null
 *  outside a layout. */
export function useScrollToRailSection(): ((id: string) => void) | null {
  const layout = useRailLayout();
  if (layout == null) return null;
  return (id: string) => scrollToSection(layout, id);
}

/** The gap PaneWide keeps from the scroll pane's right edge (the panes pad their content by ~20px). */
const PANE_EDGE_PX = 20;

/**
 * Wide content OUTSIDE a two-column layout (the story build's planned design, the PR drawer's AI Review
 * design): it breaks out of its capped reading column to the right edge of the scroll pane it sits in,
 * so a many-lane data flow gets the screen's width before it has to scroll sideways. A block narrower
 * than its column (a phone) is left alone. Inside a WIDE rail layout it stays put — the layout's
 * <RailWide> around the section does the breaking out there, and must not be overlapped.
 */
export function PaneWide({ children }: { children: ReactNode }): JSX.Element {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const inWideLayout = useRailLayout()?.wide === true;
  useIsoLayoutEffect(() => {
    if (el == null || inWideLayout) {
      setWidth(null);
      return;
    }
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
  }, [el, inWideLayout]);
  return (
    <div ref={setEl} data-pane-wide={width != null ? 'true' : 'false'} className="relative" style={width != null ? { width } : undefined}>
      {children}
    </div>
  );
}
