// THE TWO-COLUMN RAIL LAYOUT — one mechanism for every view that reads as CONTENT beside a rail
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
//   WIDE     a reading column (minmax(0, 70rem)) and a RIGHT RAIL (18–24rem) that flows with the page
//            (part of it, never sticky; decided 2026-11-01). The rail's pieces render
//            through <RailPiece slot=…> (a portal, so React context still reaches them). Narrow, the
//            same piece renders its children in place (`inline`) or nothing (a rail-only extra).
//
//   WIDE BLOCKS  <RailWide> (a design diagram) stays IN the reading column, scrolling sideways when it is
//            wider (decided 2026-11-01: a block spanning the rail split it into two sticky segments and
//            left a tall empty gap beside the block). Its "Expand" button (<RailWideToggle>, in the
//            block's own header) lays it over the rail, to the container's right edge, until
//            "Collapse" or Escape. The rail is ONE column.
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
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { storyTwoColumn } from '../lib/storyLayout.js';
import { CollapseWideIcon, ExpandWideIcon } from './Icons.js';

export interface RailLayoutConfig {
  /** The test-id prefix and the layout's identity (`story` → `story-layout`, `story-rail`, …). */
  name: string;
  /** The rail's slots, top to bottom. */
  slots: readonly string[];
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
  /** The wide block's paint while it is expanded over the rail (it sits over the rail's column). */
  wideClassName: string;
}

interface RailLayoutValue {
  config: RailLayoutConfig;
  wide: boolean;
  slots: Partial<Record<string, HTMLElement>>;
  sections: readonly string[];
  root: HTMLElement | null;
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
  // The rail's top: the start section's top, from the reading column's top.
  const [railTop, setRailTop] = useState(0);
  const [sections, setSections] = useState<readonly string[]>([]);
  const [slots, setSlots] = useState<Partial<Record<string, HTMLElement>>>({});
  const wide = !oneColumn && storyTwoColumn(width);
  const { slots: slotNames, sections: sectionDefs, sectionAttr, startSection } = config;

  // The container's width (the tab's pane, the tray, the PR drawer).
  useIsoLayoutEffect(() => {
    if (root == null) return;
    setWidth(root.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(root.clientWidth));
    ro.observe(root);
    return () => ro.disconnect();
  }, [root]);

  // Where the rail starts, and which sections the nav can reach: re-read whenever the reading column
  // changes size.
  const measure = useCallback(() => {
    const main = mainRef.current;
    if (main == null) return;
    const present = sectionDefs.filter((s) => main.querySelector(`[${sectionAttr}="${s.id}"]`) != null).map((s) => s.id);
    setSections((prev) => (prev.length === present.length && prev.every((p, i) => p === present[i]) ? prev : present));
    if (!wide) return;
    const startEl = startSection != null ? main.querySelector(`[${sectionAttr}="${startSection}"]`) : null;
    const start = startEl != null ? Math.max(0, startEl.getBoundingClientRect().top - main.getBoundingClientRect().top) : 0;
    setRailTop((prev) => (prev === start ? prev : start));
  }, [wide, sectionDefs, sectionAttr, startSection]);

  useIsoLayoutEffect(() => {
    const main = mainRef.current;
    measure();
    if (main == null || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(main);
    // A section appearing without a size change (rare) is caught on the next DOM change.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure());
    mo?.observe(main, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, [measure]);

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
  const value = useMemo<RailLayoutValue>(
    () => ({ config, wide, slots: wide ? slots : {}, sections, root }),
    [config, wide, slots, sections, root],
  );

  const n = config.name;
  return (
    <Ctx.Provider value={value}>
      <div ref={setRoot} data-testid={`${n}-layout`} data-wide={wide ? 'true' : 'false'}>
        <div className={wide ? 'grid grid-cols-[minmax(0,70rem)_minmax(18rem,24rem)] gap-x-10' : ''}>
          <div ref={mainRef} className={wide ? 'min-w-0' : config.narrowClassName}>
            {children}
          </div>
          {wide && (
            // The rail is PART OF THE PAGE (2026-11-01): it flows and scrolls with the content, never
            // sticky in its own scroll box.
            <aside aria-label={config.railLabel} className="min-w-0" data-testid={`${n}-rail`} style={{ paddingTop: railTop }}>
              <div className="flex flex-col gap-5" data-testid={`${n}-rail-top`}>
                {slotNames.map((s) => (
                  <div key={s} ref={refs[s]} data-rail-slot={s} className="empty:hidden" />
                ))}
              </div>
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

// The expand control of the enclosing <RailWide> (null outside one, or while it cannot expand).
const WideCtx = createContext<{ expanded: boolean; toggle: () => void } | null>(null);

/**
 * Wide content (a design diagram). It stays in the reading column (a wider figure scrolls sideways).
 * In the two-column layout its header's <RailWideToggle> lays it over the rail, to the container's
 * right edge, until "Collapse" or Escape. Elsewhere (narrow, the tray, outside a layout) a plain block.
 */
export function RailWide({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  const layout = useRailLayout();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const root = layout?.root ?? null;
  const can = layout?.wide === true;
  const on = can && expanded;
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
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
  const ctx = useMemo(() => (can ? { expanded: on, toggle: () => setExpanded((v) => !v) } : null), [can, on]);
  const name = layout?.config.name ?? 'rail';
  const over = on && width != null && layout != null;
  return (
    <WideCtx.Provider value={ctx}>
      <div
        ref={setEl}
        data-rail-wide={over ? 'true' : 'false'}
        {...{ [`data-${name}-wide`]: over ? 'true' : 'false' }}
        className={`${className}${over ? ` ${layout.config.wideClassName} shadow-[-12px_0_16px_-12px_rgb(0_0_0/0.25)]` : ''}`}
        style={over ? { width } : undefined}
      >
        {children}
      </div>
    </WideCtx.Provider>
  );
}

/** The widest a <RailWideLeft> grows: a comfortable reading measure, not the whole page. */
const RAIL_LEFT_MAX_PX = 768;

/**
 * Rail content that can WIDEN LEFTWARDS over the reading column (an open "What each PR adds" card,
 * decided 2026-11-01): the mirror of <RailWide>. It stays in the rail's column; its <RailWideToggle>
 * lays it over the reading column — keeping its right edge, up to RAIL_LEFT_MAX_PX wide — until
 * "Collapse" or Escape. Outside the rail (narrow, inline, outside a layout) a plain block.
 */
export function RailWideLeft({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  const layout = useRailLayout();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [box, setBox] = useState<{ width: number; shift: number } | null>(null);
  const root = layout?.root ?? null;
  const can = layout?.wide === true && el != null && el.closest('[data-rail-slot]') != null;
  const on = can && expanded;
  useIsoLayoutEffect(() => {
    const host = el?.parentElement ?? null;
    if (!on || host == null || root == null) {
      setBox(null);
      return;
    }
    const read = (): void => {
      const own = host.getBoundingClientRect();
      const width = Math.floor(Math.min(RAIL_LEFT_MAX_PX, own.right - root.getBoundingClientRect().left));
      const next = { width, shift: Math.max(0, width - Math.floor(own.width)) };
      setBox((prev) => (prev?.width === next.width && prev.shift === next.shift ? prev : next));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(root);
    return () => ro.disconnect();
  }, [on, el, root]);
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
  const ctx = useMemo(() => (can ? { expanded: on, toggle: () => setExpanded((v) => !v) } : null), [can, on]);
  const over = on && box != null;
  return (
    <WideCtx.Provider value={ctx}>
      <div
        ref={setEl}
        data-rail-wide-left={over ? 'true' : 'false'}
        // z-30: above the reading column's sticky diagram lanes (FlowDiagram, z-20).
        className={`${className}${over ? ' relative z-30 shadow-lg ring-1 ring-ui-line' : ''}`}
        style={over ? { width: box.width, marginLeft: -box.shift } : undefined}
      >
        {children}
      </div>
    </WideCtx.Provider>
  );
}

/** The enclosing <RailWide>'s Expand / Collapse button, for its header. Nothing when it cannot expand. */
export function RailWideToggle({
  className = '',
  expandTitle = 'Show over the side panel',
}: {
  className?: string;
  /** The Expand button's tooltip (a <RailWideLeft> widens over the main column instead). */
  expandTitle?: string;
}): JSX.Element | null {
  const wide = useContext(WideCtx);
  if (wide == null) return null;
  return (
    <button
      type="button"
      onClick={wide.toggle}
      aria-pressed={wide.expanded}
      title={wide.expanded ? 'Back to the column (Esc)' : expandTitle}
      className={`hit inline-flex items-center gap-1 rounded-ui px-1.5 py-0.5 text-meta text-ui-mute hover:bg-ui-hover hover:text-ui-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent ${className}`}
    >
      {wide.expanded ? <CollapseWideIcon size={14} /> : <ExpandWideIcon size={14} />}
      {wide.expanded ? 'Collapse' : 'Expand'}
    </button>
  );
}

/** The rail's "On this page": the sections present, each a link that scrolls to it. */
export function RailSectionNav(): JSX.Element | null {
  const layout = useRailLayout();
  if (layout == null || !layout.wide || layout.sections.length < 2) return null;
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
 * <RailWide> around the section expands it there, on the reader's press.
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
