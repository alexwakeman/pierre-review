import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceRadial,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import {
  SPRINT_EDGE_LABEL,
  SPRINT_STAGE_LABEL,
  SPRINT_STAGES,
  type SprintGraphEdge,
  type SprintGraphNode,
} from '@pierre-review/shared';
import { initialsOf } from '../../lib/openPrsStacks.js';
import { safeExternalUrl } from '../../lib/ui.js';
import { MinusIcon, PlusIcon } from '../Icons.js';
import {
  DIMMED_OPACITY,
  FILTERED_OPACITY,
  GROUP_HALO,
  GROUP_LABEL_MAX,
  SATELLITE_FAILING_RING,
  SATELLITE_FILL,
  SPRINT_CANVAS,
  collidePadding,
  dependencyIdents,
  edgeEndpoints,
  edgeId,
  discScale,
  edgeStyle,
  fitTransform,
  groupAnchors,
  groupHalo,
  haloSeparation,
  LABEL_ALWAYS,
  groupLabelSize,
  groupLabelBox,
  labelOffset,
  labelPriority,
  placeGroupLabels,
  labelSize,
  orbitRadius,
  labelOpacity,
  neighbourhood,
  nodeAriaLabel,
  nodeBaseOpacity,
  nodeRadius,
  passesFilters,
  pinchTransform,
  placeLabels,
  readPinned,
  safeLocalStorage,
  satellitesOf,
  stageRing,
  starField,
  truncateLabel,
  wheelIntent,
  wheelZoomFactor,
  writePinned,
  zoomAbout,
  type GroupLabelPlace,
  type LabelItem,
  type LabelSide,
  type PinnedPositions,
  type ScreenBox,
  type SprintGraphFilters,
  type SprintGroup,
  type SprintGroupMode,
  type ViewTransform,
} from './sprintGraphModel.js';

// THE SPRINT GRAPH (Reports → This sprint): the sprint's tickets and the GHOST tickets they reach, on an
// always-navy "space" canvas. d3-force is the physics ONLY; the SVG is drawn here by hand.
//
// ⚠ POSITIONS NEVER GO THROUGH REACT. React renders each node / edge ONCE (and again only when what it
// SHOWS changes — a hover, the selection, a filter); the simulation's positions are written straight to
// the DOM (`transform`, `x1…y2`) from one requestAnimationFrame loop. 125 nodes re-rendered at 60 fps
// was the jank this avoids. So no JSX here may set a node's `transform` or an edge's coordinates.
//
// MOTION: a slow perpetual drift (a tiny rotation about the centre plus the forces at a low
// `alphaTarget`), FROZEN while the pointer is over the canvas or a node is selected — a reader never has
// to chase what they are pointing at. `prefers-reduced-motion` simulates to rest once and stays still.
// Drag a node to PIN it (fx/fy); pins are remembered per browser for this workspace and sprint
// (localStorage, try/catch — the page works without it); "Reset layout" clears them.
//
// WHAT IS DRAWN is decided by the page (SprintView → `visibleGraph`): hidden ghosts and edge kinds are
// not in `nodes` / `edges` at all, so the simulation only places what is shown. A toggle REBUILDS the
// simulation from the current positions: a returning node starts beside a drawn neighbour (or its
// group's anchor), and the canvas animates to rest for a few seconds even while frozen.
//
// GROUPS ("Group by"): each group's tickets are pulled weakly toward the group's ANCHOR
// (`groupAnchors`, laid out in the canvas's shape and sized by the DRAWN members), and a faint labelled
// HALO is drawn behind them, recomputed from their positions on every frame (`groupHalo`). Links between
// groups pull less, so the clusters hold while the lines still cross; a large group is a spread disc
// (`collidePadding`), and halos that touch are pushed apart (`haloSeparation`).
//
// LABELS keep a fixed screen size, so which ones fit is decided on SCREEN (`placeLabels`): after every
// zoom and, throttled, while the canvas moves. A label takes the free side of its ticket, or hides until
// hover, focus or zoom gives it room. The side is written as CSS variables on `.sg-label`, never by React.
//
// THE VIEW: a plain wheel scrolls the PAGE (with a brief "Hold Ctrl/⌘ to zoom" hint); Ctrl/⌘ + wheel and
// a trackpad pinch zoom. On touch one finger scrolls the page unless it starts on a ticket (a drag), and
// two fingers pinch-zoom. Until the reader moves the view themselves, it FOLLOWS Fit while a re-layout
// animates (a grouping switch re-arms that), so a new arrangement opens framed.
//
// Every node is a focusable `<g role="button">` (Enter / Space opens the drawer), and a visually hidden
// list repeats the tickets for screen readers.

interface SimNode extends SimulationNodeDatum {
  id: string;
  r: number;
  degree: number;
  /** The group key (null when not grouping, or a ghost no sprint ticket reaches). */
  group: string | null;
}

type SimLink = SimulationLinkDatum<SimNode> & { id: string; kind: SprintGraphEdge['kind'] };

/** Radians per tick of the drift's rotation (about one turn in ten minutes at 60 fps). */
const DRIFT_ROTATION = 1.75e-4;
/** Radians per second the PR satellites orbit their ticket. */
const ORBIT_SPEED = 0.25;
/** Below this zoom only ticket keys are labelled. */
const FAR_ZOOM = 0.8;
/** Placing labels while the canvas moves: once every this many frames. */
const LABEL_EVERY = 5;
/** How long the "Hold Ctrl/⌘ to zoom" hint stays after the last plain wheel (ms). */
const WHEEL_HINT_MS = 1400;
const STARS = starField(140);
/** Frames a re-layout animates for (each ticket eases from where it was to where it lands), even while
 *  the canvas is frozen — the change is seen. */
const SETTLE_FRAMES = 70;
/** Frames an untouched view keeps easing toward Fit after a re-layout (the forces' last settling). */
const FOLLOW_FRAMES = 240;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

type Hover =
  | { type: 'node'; id: string }
  | { type: 'edge'; id: string; x: number; y: number }
  | null;

export function SprintGraph({
  nodes,
  edges,
  pinKey,
  filters,
  selected,
  hops,
  groupMode,
  groupOf,
  groups,
  faintShown,
  onOpen,
  onClearSelection,
}: {
  /** The DRAWN nodes (degree counted over the drawn edges) and edges — `visibleGraph`. */
  nodes: SprintGraphNode[];
  edges: SprintGraphEdge[];
  groupMode: SprintGroupMode;
  /** Every drawn node's group (`assignGroups`). */
  groupOf: ReadonlyMap<string, string | null>;
  /** The groups, in placement order (`groupList`). */
  groups: SprintGroup[];
  /** "Show builds on / replaces" is on (the key lists the faint line). */
  faintShown: boolean;
  /** localStorage key for pinned positions (`pinnedStorageKey`). */
  pinKey: string;
  filters: SprintGraphFilters;
  /** The selected node (the drawer's ticket, and kept after it closes); null = none. */
  selected: string | null;
  hops: 1 | 2;
  onOpen: (ident: string) => void;
  onClearSelection: () => void;
}): JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef<SVGGElement | null>(null);
  const nodeEls = useRef(new Map<string, SVGGElement>());
  const satEls = useRef(new Map<string, SVGGElement>());
  const edgeEls = useRef(new Map<string, { line: SVGLineElement | null; hit: SVGLineElement | null }>());
  const haloEls = useRef(
    new Map<string, { g: SVGGElement | null; circle: SVGCircleElement | null; label: SVGGElement | null; text: SVGTextElement | null }>(),
  );
  const groupPlace = useRef(new Map<string, GroupLabelPlace>());
  const settle = useRef(0);
  const follow = useRef(0);
  /** A re-layout in progress: each ticket's start and end (eased over SETTLE_FRAMES). */
  const tween = useRef<{ from: Map<string, { x: number; y: number }>; to: Map<string, { x: number; y: number }>; frame: number } | null>(null);
  const reducedRef = useRef(false);
  const labelEls = useRef(new Map<string, SVGGElement>());
  const labelSides = useRef(new Map<string, { side: LabelSide; sig: string }>());
  const labelFrame = useRef(0);
  /** The reader has zoomed / panned since the last Fit: the view stops following Fit. */
  const viewTouched = useRef(false);
  const [aspect, setAspect] = useState<number | null>(null);
  const [wheelHint, setWheelHint] = useState(false);
  const wheelHintTimer = useRef<number | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const simNodes = useRef(new Map<string, SimNode>());
  const view = useRef<ViewTransform>({ k: 1, x: 0, y: 0 });
  const size = useRef({ w: 0, h: 0 });
  const pointerInside = useRef(false);
  const dragging = useRef<string | null>(null);
  const orbit = useRef(0);
  const pins = useRef<PinnedPositions>({});
  const [hasPins, setHasPins] = useState(false);
  const [hover, setHover] = useState<Hover>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [failedAvatars, setFailedAvatars] = useState<ReadonlySet<string>>(() => new Set());
  const [legendOpen, setLegendOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 640 : true));
  const legendOpenRef = useRef(legendOpen);
  legendOpenRef.current = legendOpen;

  const frozen = useRef(false);
  frozen.current = selected != null;
  reducedRef.current = reducedMotion;

  const byId = useMemo(() => new Map(nodes.map((n) => [n.ident, n])), [nodes]);
  const deps = useMemo(() => dependencyIdents(edges), [edges]);
  const passes = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const n of nodes) m.set(n.ident, passesFilters(n, filters, deps));
    return m;
  }, [nodes, filters, deps]);
  const focusSet = useMemo(() => (selected != null && byId.has(selected) ? neighbourhood(edges, selected, hops) : null), [
    selected,
    byId,
    edges,
    hops,
  ]);
  const hoverNode = hover?.type === 'node' ? hover.id : null;

  // What label placement reads (refs: it runs from the rAF loop, outside React).
  const labelCtx = useRef({
    byId,
    promoted: new Set<string>(),
    faded: new Set<string>(),
    groupLabels: new Map<string, string>(),
    groupDrawn: new Map<string, number>(),
  });
  labelCtx.current = {
    byId,
    groupDrawn: new Map(groups.map((g) => [g.key, g.drawn])),
    promoted: new Set([selected, hoverNode, focusId].filter((x): x is string => x != null)),
    faded: new Set(nodes.filter((n) => passes.get(n.ident) === false || (focusSet != null && !focusSet.has(n.ident))).map((n) => n.ident)),
    groupLabels: new Map(groupMode === 'none' ? [] : groups.map((g) => [g.key, truncateLabel(g.label, GROUP_LABEL_MAX)])),
  };

  // ── Writing positions to the DOM ────────────────────────────────────────────────────────────────
  const currentHalos = useCallback((): Map<string, { x: number; y: number; r: number }> => {
    const pts = new Map<string, Array<{ x: number; y: number; r: number }>>();
    for (const n of simNodes.current.values()) {
      if (n.group == null || n.x == null || n.y == null) continue;
      const l = pts.get(n.group);
      const p = { x: n.x, y: n.y, r: n.r };
      if (l == null) pts.set(n.group, [p]);
      else l.push(p);
    }
    const out = new Map<string, { x: number; y: number; r: number }>();
    for (const [k, l] of pts) {
      const h = groupHalo(l);
      if (h != null) out.set(k, h);
    }
    return out;
  }, []);

  // Which side of its ticket each label sits on, or hidden — decided on SCREEN (`placeLabels`).
  const placeLabelsNow = useCallback((): void => {
    const t = view.current;
    const { w: W, h: H } = size.current;
    if (W <= 0 || labelEls.current.size === 0) return;
    const far = t.k < FAR_ZOOM;
    const disc = discScale(t.k);
    const ctx = labelCtx.current;
    const items: LabelItem[] = [];
    const dims = new Map<string, { w: number; h: number }>();
    for (const id of labelEls.current.keys()) {
      const n = simNodes.current.get(id);
      const node = ctx.byId.get(id);
      if (n?.x == null || n.y == null || node == null) continue;
      const x = n.x * t.k + t.x;
      const y = n.y * t.k + t.y;
      // Off screen: nothing to decide (it keeps its side).
      if (x < -160 || x > W + 160 || y < -80 || y > H + 80) continue;
      const d = labelSize(node.key, node.title, !far);
      dims.set(id, d);
      items.push({
        id,
        x,
        y,
        R: n.r * disc * t.k,
        w: d.w,
        h: d.h,
        priority: labelPriority({ degree: n.degree, ghost: node.ghost, faded: ctx.faded.has(id), pinned: ctx.promoted.has(id), r: n.r }),
        prev: labelSides.current.get(id)?.side,
      });
    }
    // The group names first: above (else below) each halo, clear of each other and of other groups'
    // tickets; then no ticket label may cover a name that is shown.
    const obstacles: ScreenBox[] = [];
    if (ctx.groupLabels.size > 0) {
      const promotedGroups = new Set<string>();
      for (const id of ctx.promoted) {
        const g = simNodes.current.get(id)?.group;
        if (g != null) promotedGroups.add(g);
      }
      const gItems = [];
      const boxOf = new Map<string, { x: number; y: number; r: number; w: number; h: number }>();
      for (const [key, h] of currentHalos()) {
        const text = ctx.groupLabels.get(key);
        if (text == null) continue;
        const sz = groupLabelSize(text);
        const it = { key, x: h.x * t.k + t.x, y: h.y * t.k + t.y, r: h.r * t.k, w: sz.w, h: sz.h };
        boxOf.set(key, it);
        gItems.push({ ...it, priority: promotedGroups.has(key) ? LABEL_ALWAYS : ctx.groupDrawn.get(key) ?? 0 });
      }
      const discs = [...simNodes.current.values()]
        .filter((n) => n.x != null && n.y != null)
        .map((n) => ({ x: (n.x as number) * t.k + t.x, y: (n.y as number) * t.k + t.y, R: n.r * disc * t.k, group: n.group }));
      const places = placeGroupLabels(gItems, discs);
      for (const [key, place] of places) {
        groupPlace.current.set(key, place);
        const els = haloEls.current.get(key);
        els?.label?.setAttribute('data-place', place);
        els?.text?.setAttribute('y', place === 'bottom' ? '13' : '-7');
        const it = boxOf.get(key);
        if (place !== 'none' && it != null) obstacles.push(groupLabelBox(it, place));
      }
    }
    const sides = placeLabels(items, obstacles);
    for (const [id, side] of sides) {
      const el = labelEls.current.get(id);
      const d = dims.get(id);
      if (el == null || d == null) continue;
      const sig = `${side}:${d.w}:${d.h}`;
      if (labelSides.current.get(id)?.sig === sig) continue;
      labelSides.current.set(id, { side, sig });
      el.setAttribute('data-side', side);
      if (side === 'none') continue;
      const o = labelOffset(side, d.w, d.h);
      el.style.setProperty('--sx', String(o.sx));
      el.style.setProperty('--sy', String(o.sy));
      el.style.setProperty('--lx', o.lx.toFixed(1));
      el.style.setProperty('--ly', o.ly.toFixed(1));
    }
  }, [currentHalos]);

  const applyView = useCallback((): void => {
    const t = view.current;
    viewRef.current?.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    const svg = svgRef.current;
    if (svg != null) {
      svg.style.setProperty('--sg-inv', String(1 / t.k));
      svg.style.setProperty('--sg-disc', String(discScale(t.k)));
      svg.setAttribute('data-zoom', t.k < FAR_ZOOM ? 'far' : 'near');
    }
    placeLabelsNow();
  }, [placeLabelsNow]);

  const applyPositions = useCallback((): void => {
    for (const [id, el] of nodeEls.current) {
      const n = simNodes.current.get(id);
      if (n?.x == null || n.y == null) continue;
      el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    if (haloEls.current.size > 0) {
      const halos = currentHalos();
      for (const [key, els] of haloEls.current) {
        const h = halos.get(key);
        if (els.g == null) continue;
        if (h == null) {
          els.g.setAttribute('display', 'none');
          continue;
        }
        els.g.removeAttribute('display');
        els.circle?.setAttribute('cx', h.x.toFixed(1));
        els.circle?.setAttribute('cy', h.y.toFixed(1));
        els.circle?.setAttribute('r', h.r.toFixed(1));
        const below = groupPlace.current.get(key) === 'bottom';
        els.label?.setAttribute('transform', `translate(${h.x.toFixed(1)},${(below ? h.y + h.r : h.y - h.r).toFixed(1)})`);
      }
    }
    const sim = simRef.current;
    if (sim == null) return;
    const links = (sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined)?.links() ?? [];
    for (const l of links) {
      const els = edgeEls.current.get(l.id);
      if (els == null) continue;
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      if (a.x == null || a.y == null || b.x == null || b.y == null) continue;
      const p = edgeEndpoints({ x: a.x, y: a.y, r: a.r + 2 }, { x: b.x, y: b.y, r: b.r + 2 }, l.kind === 'depends_on' ? 2 : 0);
      for (const line of [els.line, els.hit]) {
        if (line == null) continue;
        line.setAttribute('x1', p.x1.toFixed(1));
        line.setAttribute('y1', p.y1.toFixed(1));
        line.setAttribute('x2', p.x2.toFixed(1));
        line.setAttribute('y2', p.y2.toFixed(1));
      }
    }
    labelFrame.current += 1;
    if (labelFrame.current % LABEL_EVERY === 0) placeLabelsNow();
  }, [currentHalos, placeLabelsNow]);

  const applyOrbit = useCallback((): void => {
    const deg = ((orbit.current * 180) / Math.PI) % 360;
    for (const el of satEls.current.values()) el.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  }, []);

  const fitTarget = useCallback((): ViewTransform => {
    const pts = [...simNodes.current.values()]
      .filter((n) => n.x != null && n.y != null)
      .map((n) => ({ x: n.x as number, y: n.y as number, r: n.r }));
    // Frame what is DRAWN: the visible nodes and their groups' halos (and the names above them).
    for (const h of currentHalos().values()) pts.push({ x: h.x, y: h.y - 14, r: h.r + 14 });
    const padX = Math.min(64, size.current.w * 0.08);
    // The open key covers the bottom-left corner: leave it room.
    return fitTransform(pts, size.current.w, size.current.h, { x: padX, top: 28, bottom: legendOpenRef.current ? 110 : 48 });
  }, [currentHalos]);

  const fit = useCallback((): void => {
    view.current = fitTarget();
    viewTouched.current = false;
    applyView();
  }, [applyView, fitTarget]);

  // ── The simulation: rebuilt when what is DRAWN or how it is GROUPED changes ────────────────────
  const structure = useMemo(
    () =>
      `${nodes.map((n) => `${n.ident}:${n.degree}:${n.ghost ? 1 : 0}`).join('|')}#${edges.map((e) => edgeId(e)).join('|')}`,
    [nodes, edges],
  );
  const anchors = useMemo(() => groupAnchors(groups, aspect ?? 1), [groups, aspect]);
  const groupSize = useMemo(() => new Map(groups.map((g) => [g.key, g.drawn])), [groups]);
  const lastMode = useRef<SprintGroupMode | null>(null);
  const grouping = useMemo(
    () =>
      `${aspect == null ? '?' : 'm'}#${groupMode}#${[...anchors].map(([k, a]) => `${k}:${a.x},${a.y}`).join('|')}#${nodes
        .map((n) => `${n.ident}=${groupOf.get(n.ident) ?? ''}`)
        .join('|')}`,
    [groupMode, anchors, nodes, groupOf, aspect],
  );

  useLayoutEffect(() => {
    // Wait for the canvas's measured shape: the group anchors are laid out in it.
    if (aspect == null) return;
    const prev = simNodes.current;
    const first = prev.size === 0;
    // A new grouping is a new arrangement: the view follows Fit again while it settles, and the
    // tickets start from their new groups (not from the old arrangement, which would have to pass
    // through itself and could jam).
    const modeChanged = lastMode.current != null && lastMode.current !== groupMode;
    if (modeChanged) viewTouched.current = false;
    lastMode.current = groupMode;
    pins.current = readPinned(safeLocalStorage(), pinKey);
    setHasPins(Object.keys(pins.current).length > 0);
    const grouped = groupMode !== 'none';
    const count = nodes.length;
    const linked = nodes.filter((n) => n.degree > 0).length;
    const unlinked = count - linked;
    const ring = orbitRadius(0, linked, unlinked);
    const orbitOf = new Map<string, number>();
    nodes.filter((n) => n.degree === 0).forEach((n, i) => orbitOf.set(n.ident, orbitRadius(i, linked, unlinked)));
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
      adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
    }
    // Sunflower seeds inside each group's anchor (a new grouping, or a ticket new to the canvas).
    const seatInGroup = new Map<string, number>();
    const groupCount = new Map<string, number>();
    for (const n of nodes) {
      const g = groupOf.get(n.ident);
      if (g == null) continue;
      seatInGroup.set(n.ident, groupCount.get(g) ?? 0);
      groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
    }
    const fresh = new Map<string, SimNode>();
    nodes.forEach((n, i) => {
      const old = modeChanged ? undefined : prev.get(n.ident);
      const pin = pins.current[n.ident];
      const group = groupOf.get(n.ident) ?? null;
      const anchor = group != null ? anchors.get(group) : undefined;
      // A node already on the canvas stays where it is; a returning one starts beside a drawn
      // neighbour that is already placed, else inside its group, else on the ring.
      let x: number;
      let y: number;
      const a = (2 * Math.PI * i) / Math.max(1, count);
      if (old?.x != null && old.y != null) {
        x = old.x;
        y = old.y;
      } else {
        const nb = (adj.get(n.ident) ?? []).map((id) => prev.get(id)).find((m) => m?.x != null && m.y != null);
        if (nb != null) {
          x = (nb.x as number) + Math.cos(i * 2.4) * 34;
          y = (nb.y as number) + Math.sin(i * 2.4) * 34;
        } else if (grouped && anchor != null) {
          const j = seatInGroup.get(n.ident) ?? 0;
          const rr = anchor.r * 0.8 * Math.sqrt((j + 0.5) / Math.max(1, groupCount.get(group as string) ?? 1));
          x = anchor.x + Math.cos(j * 2.39996) * rr;
          y = anchor.y + Math.sin(j * 2.39996) * rr;
        } else {
          x = Math.cos(a) * ring * 0.6;
          y = Math.sin(a) * ring * 0.6;
        }
      }
      fresh.set(n.ident, {
        id: n.ident,
        r: nodeRadius(n.degree, n.ghost),
        degree: n.degree,
        group: grouped ? group : null,
        x: pin?.x ?? x,
        y: pin?.y ?? y,
        vx: 0,
        vy: 0,
        fx: pin?.x ?? null,
        fy: pin?.y ?? null,
      });
    });
    simNodes.current = fresh;
    const links: SimLink[] = edges
      .filter((e) => fresh.has(e.from) && fresh.has(e.to))
      .map((e) => ({ id: edgeId(e), source: e.from, target: e.to, kind: e.kind }));
    const anchorOf = (d: SimNode): { x: number; y: number } | undefined => (d.group != null ? anchors.get(d.group) : undefined);

    const sim = forceSimulation<SimNode, SimLink>([...fresh.values()])
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => 56 + (l.source as SimNode).r + (l.target as SimNode).r)
          // Grouped: a link BETWEEN groups pulls lightly, so the clusters hold and the line crosses.
          .strength((l) =>
            grouped && (l.source as SimNode).group !== (l.target as SimNode).group ? 0.03 : l.kind === 'depends_on' ? 0.5 : 0.25,
          ),
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => -90 - d.r * 5).distanceMax(grouped ? 260 : 500))
      .force('collide', forceCollide<SimNode>((d) => d.r + collidePadding(grouped, d.group != null ? groupSize.get(d.group) ?? 1 : 1)).strength(0.9))
      .force(
        'x',
        forceX<SimNode>((d) => anchorOf(d)?.x ?? 0).strength((d) => (grouped ? (anchorOf(d) != null ? 0.1 : 0.02) : d.degree > 0 ? 0.045 : 0)),
      )
      .force(
        'y',
        forceY<SimNode>((d) => anchorOf(d)?.y ?? 0).strength((d) => (grouped ? (anchorOf(d) != null ? 0.1 : 0.02) : d.degree > 0 ? 0.045 : 0)),
      )
      // Ungrouped: tickets with no links orbit loosely on a wide ring around the linked ones.
      .force(
        'radial',
        forceRadial<SimNode>((d) => orbitOf.get(d.id) ?? ring, 0, 0).strength((d) => (!grouped && d.degree === 0 ? 0.08 : 0)),
      )
      .velocityDecay(0.4)
      .stop();
    // Halos that touch are pushed apart (each group as a whole), so no group sits inside another.
    if (grouped) {
      sim.force('separate', () => {
        const halos = currentHalos();
        if (halos.size < 2) return;
        const push = haloSeparation(halos, 28);
        if (push.size === 0) return;
        for (const n of fresh.values()) {
          if (n.group == null || n.fx != null) continue;
          const p = push.get(n.group);
          if (p == null) continue;
          n.vx = (n.vx ?? 0) + p.dx * 0.06;
          n.vy = (n.vy ?? 0) + p.dy * 0.06;
        }
      });
    }
    // Every layout is computed to rest before it is shown. A toggle then ANIMATES each ticket from where
    // it was to where it lands (`tween`), for a moment even while frozen; without motion it just appears.
    const from = new Map<string, { x: number; y: number }>();
    if (!first) {
      for (const [id, n] of fresh) {
        const old = prev.get(id);
        from.set(id, old?.x != null && old.y != null ? { x: old.x, y: old.y } : { x: n.x as number, y: n.y as number });
      }
    }
    sim.alpha(first || modeChanged ? 1 : 0.7);
    for (let i = 0; i < (first ? 420 : 320); i += 1) sim.tick();
    if (!first && !reducedRef.current) {
      const to = new Map<string, { x: number; y: number }>();
      for (const [id, n] of fresh) {
        to.set(id, { x: n.x as number, y: n.y as number });
        const f = from.get(id);
        if (f != null) {
          n.x = f.x;
          n.y = f.y;
        }
      }
      tween.current = { from, to, frame: 0 };
      settle.current = SETTLE_FRAMES;
      follow.current = SETTLE_FRAMES + FOLLOW_FRAMES;
    } else {
      tween.current = null;
      settle.current = 0;
    }
    sim.alpha(0.02);
    // The drift: a slow rotation about the centre, unscaled by alpha so it never stops on its own.
    sim.force('drift', () => {
      for (const n of fresh.values()) {
        if (n.fx != null || n.x == null || n.y == null) continue;
        n.vx = (n.vx ?? 0) - n.y * DRIFT_ROTATION * 0.4;
        n.vy = (n.vy ?? 0) + n.x * DRIFT_ROTATION * 0.4;
      }
    });
    sim.alphaTarget(0.02);
    simRef.current = sim;
    applyPositions();
    if (first || (reducedRef.current && !viewTouched.current)) fit();
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on STRUCTURE / GROUPING, not on every refetch
  }, [structure, grouping, pinKey]);

  // Promoting a label (hover, focus, selection) or fading one (a filter) re-decides who shows.
  useEffect(() => {
    placeLabelsNow();
  }, [placeLabelsNow, hoverNode, focusId, selected, passes, focusSet, groupMode]);

  // ── The loop ────────────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (reducedMotion) {
      applyOrbit();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const loop = (t: number): void => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const settling = settle.current > 0;
      if (settling) settle.current -= 1;
      const still = !settling && (frozen.current || (pointerInside.current && dragging.current == null));
      const tw = tween.current;
      if (tw != null && settling) {
        // The re-layout: ease every ticket from where it was to where it lands; the forces wait.
        tw.frame += 1;
        const p = Math.min(1, tw.frame / SETTLE_FRAMES);
        const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
        for (const [id, n] of simNodes.current) {
          const a = tw.from.get(id);
          const b = tw.to.get(id);
          if (a == null || b == null) continue;
          n.x = a.x + (b.x - a.x) * e;
          n.y = a.y + (b.y - a.y) * e;
          n.vx = 0;
          n.vy = 0;
        }
        if (settle.current === 0) tween.current = null;
      } else if (!still) simRef.current?.tick();
      if (!still) {
        orbit.current += dt * ORBIT_SPEED;
        applyPositions();
        applyOrbit();
        // While a re-layout animates (and for a few seconds after, as the forces finish), an untouched
        // view eases toward Fit, so it ends framed.
        if (follow.current > 0) follow.current -= 1;
        if ((settling || follow.current > 0) && !viewTouched.current && size.current.w > 0) {
          const to = fitTarget();
          const v = view.current;
          const e = settling ? (settle.current === 0 ? 1 : 0.1) : 0.05;
          view.current = { k: v.k + (to.k - v.k) * e, x: v.x + (to.x - v.x) * e, y: v.y + (to.y - v.y) * e };
          applyView();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, applyPositions, applyOrbit, applyView, fitTarget]);

  // ── Size ────────────────────────────────────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (el == null) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      const first = size.current.w === 0;
      size.current = { w: r.width, h: r.height };
      // The canvas's shape, in quarter steps (a small resize does not re-lay the groups).
      if (r.width > 0 && r.height > 0) setAspect(Math.round(Math.min(2.4, Math.max(0.5, r.width / r.height)) * 4) / 4);
      if (first) fit();
      else placeLabelsNow();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, placeLabelsNow]);

  // ── Wheel: a plain wheel scrolls the PAGE; Ctrl/⌘ + wheel (or a pinch) zooms ───────────────────
  // A native listener, because React's wheel listener is passive (it could not stop the page zoom).
  useEffect(() => {
    const svg = svgRef.current;
    if (svg == null) return;
    const onWheel = (e: WheelEvent): void => {
      if (wheelIntent(e) === 'scroll') {
        setWheelHint(true);
        if (wheelHintTimer.current != null) window.clearTimeout(wheelHintTimer.current);
        wheelHintTimer.current = window.setTimeout(() => setWheelHint(false), WHEEL_HINT_MS);
        return;
      }
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      viewTouched.current = true;
      view.current = zoomAbout(view.current, wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - rect.left, e.clientY - rect.top);
      applyView();
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
      if (wheelHintTimer.current != null) window.clearTimeout(wheelHintTimer.current);
    };
  }, [applyView]);

  // Touch: the page keeps one-finger scrolling (CSS `touch-action: pan-x pan-y`), EXCEPT a touch that
  // starts on a ticket (a drag) and a two-finger pinch, which the canvas takes.
  useEffect(() => {
    const svg = svgRef.current;
    if (svg == null) return;
    const onTouch = (e: TouchEvent): void => {
      if (e.touches.length >= 2 || (e.target instanceof Element && e.target.closest('[data-sg-node]') != null)) {
        if (e.cancelable) e.preventDefault();
      }
    };
    svg.addEventListener('touchstart', onTouch, { passive: false });
    svg.addEventListener('touchmove', onTouch, { passive: false });
    return () => {
      svg.removeEventListener('touchstart', onTouch);
      svg.removeEventListener('touchmove', onTouch);
    };
  }, []);

  const zoomBy = (factor: number): void => {
    viewTouched.current = true;
    view.current = zoomAbout(view.current, factor, size.current.w / 2, size.current.h / 2);
    applyView();
  };

  // ── Pointer: pan the background, drag a node to pin it, click to open ──────────────────────────
  const gesture = useRef<{ kind: 'pan' | 'node' | 'tap'; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  /** Touches down on the canvas background (for the two-finger pinch). */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ start: ViewTransform; a: number; b: number; a0: { x: number; y: number }; b0: { x: number; y: number } } | null>(null);
  const local = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const toGraph = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = svgRef.current?.getBoundingClientRect();
    const t = view.current;
    return { x: (clientX - (rect?.left ?? 0) - t.x) / t.k, y: (clientY - (rect?.top ?? 0) - t.y) / t.k };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const nodeEl = target.closest('[data-sg-node]');
    const id = nodeEl?.getAttribute('data-sg-node') ?? null;
    const touch = e.pointerType === 'touch';
    if (touch && id == null) {
      // One finger on the background is the PAGE's scroll; a second finger starts a pinch.
      touches.current.set(e.pointerId, local(e.clientX, e.clientY));
      if (touches.current.size === 2) {
        const [[a, a0], [b, b0]] = [...touches.current.entries()] as [[number, { x: number; y: number }], [number, { x: number; y: number }]];
        pinch.current = { start: view.current, a, b, a0, b0 };
        gesture.current = null;
        return;
      }
      gesture.current = { kind: 'tap', sx: e.clientX, sy: e.clientY, vx: 0, vy: 0, moved: false };
      return;
    }
    gesture.current = {
      kind: id != null ? 'node' : 'pan',
      ...(id != null ? { id } : {}),
      sx: e.clientX,
      sy: e.clientY,
      vx: view.current.x,
      vy: view.current.y,
      moved: false,
    };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (touches.current.has(e.pointerId)) {
      touches.current.set(e.pointerId, local(e.clientX, e.clientY));
      const p = pinch.current;
      const a1 = p != null ? touches.current.get(p.a) : undefined;
      const b1 = p != null ? touches.current.get(p.b) : undefined;
      if (p != null && a1 != null && b1 != null) {
        viewTouched.current = true;
        view.current = pinchTransform(p.start, p.a0, p.b0, a1, b1);
        applyView();
      }
    }
    const g = gesture.current;
    if (g == null) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    if (g.kind === 'tap') return;
    if (g.kind === 'pan') {
      viewTouched.current = true;
      view.current = { ...view.current, x: g.vx + dx, y: g.vy + dy };
      applyView();
      return;
    }
    const n = g.id != null ? simNodes.current.get(g.id) : undefined;
    if (n == null) return;
    if (dragging.current == null) {
      dragging.current = n.id;
      setHover(null);
    }
    const p = toGraph(e.clientX, e.clientY);
    n.fx = p.x;
    n.fy = p.y;
    const sim = simRef.current;
    if (sim != null) {
      sim.alpha(Math.max(sim.alpha(), 0.12));
      sim.tick();
    }
    applyPositions();
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (touches.current.delete(e.pointerId)) {
      if (pinch.current != null && touches.current.size < 2) {
        pinch.current = null;
        return;
      }
    }
    const g = gesture.current;
    gesture.current = null;
    // A cancelled pointer (the browser took the touch for a page scroll) is not a click.
    if (e.type === 'pointercancel') {
      if (g?.kind === 'node') dragging.current = null;
      return;
    }
    if (g?.kind === 'tap') {
      if (!g.moved) onClearSelection();
      return;
    }
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (g == null) return;
    if (g.kind === 'pan') {
      if (!g.moved) onClearSelection();
      return;
    }
    if (g.id == null) return;
    if (!g.moved) {
      onOpen(g.id);
      return;
    }
    dragging.current = null;
    const n = simNodes.current.get(g.id);
    if (n?.fx != null && n.fy != null) {
      pins.current = { ...pins.current, [g.id]: { x: Math.round(n.fx), y: Math.round(n.fy) } };
      writePinned(safeLocalStorage(), pinKey, pins.current);
      setHasPins(true);
    }
  };

  const resetLayout = (): void => {
    pins.current = {};
    writePinned(safeLocalStorage(), pinKey, {});
    setHasPins(false);
    const sim = simRef.current;
    if (sim == null) return;
    for (const n of simNodes.current.values()) {
      n.fx = null;
      n.fy = null;
    }
    sim.alpha(0.8);
    for (let i = 0; i < 200; i += 1) sim.tick();
    applyPositions();
    fit();
  };

  // ── Hover / focus ──────────────────────────────────────────────────────────────────────────────
  const handlers = useRef({
    enterNode: (id: string): void => {
      if (dragging.current == null) setHover({ type: 'node', id });
    },
    leave: (): void => setHover(null),
    enterEdge: (id: string, clientX: number, clientY: number): void => {
      if (dragging.current != null) return;
      const rect = wrapRef.current?.getBoundingClientRect();
      setHover({ type: 'edge', id, x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) });
    },
    focus: (id: string): void => setFocusId(id),
    blur: (): void => setFocusId(null),
    key: (id: string): void => onOpenRef.current(id),
    avatarFailed: (url: string): void =>
      setFailedAvatars((s) => {
        if (s.has(url)) return s;
        const next = new Set(s);
        next.add(url);
        return next;
      }),
    registerNode: (id: string, el: SVGGElement | null): void => {
      if (el == null) nodeEls.current.delete(id);
      else {
        nodeEls.current.set(id, el);
        const n = simNodes.current.get(id);
        if (n?.x != null && n.y != null) el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
      }
    },
    registerLabel: (id: string, el: SVGGElement | null): void => {
      if (el == null) {
        labelEls.current.delete(id);
        labelSides.current.delete(id);
      } else labelEls.current.set(id, el);
    },
    registerSat: (id: string, el: SVGGElement | null): void => {
      if (el == null) satEls.current.delete(id);
      else satEls.current.set(id, el);
    },
    registerEdge: (id: string, part: 'line' | 'hit', el: SVGLineElement | null): void => {
      const cur = edgeEls.current.get(id) ?? { line: null, hit: null };
      cur[part] = el;
      if (cur.line == null && cur.hit == null) edgeEls.current.delete(id);
      else edgeEls.current.set(id, cur);
    },
  });
  const registerHalo = useCallback(
    (key: string, part: 'g' | 'circle' | 'label' | 'text', el: SVGGElement | SVGCircleElement | SVGTextElement | null): void => {
    const cur = haloEls.current.get(key) ?? { g: null, circle: null, label: null, text: null };
    if (part === 'circle') cur.circle = el as SVGCircleElement | null;
    else if (part === 'text') cur.text = el as SVGTextElement | null;
    else cur[part] = el as SVGGElement | null;
    if (cur.g == null && cur.circle == null && cur.label == null && cur.text == null) haloEls.current.delete(key);
    else haloEls.current.set(key, cur);
    },
    [],
  );
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  // A node / edge registered after the simulation ran gets its coordinates on the next frame; with
  // reduced motion there is no next frame, so write them now.
  useLayoutEffect(() => {
    applyPositions();
    applyOrbit();
  });

  // The tooltip's anchor: a node's screen position (stable — the canvas is frozen under the pointer).
  const tipNodeId = hoverNode ?? (focusId != null && dragging.current == null ? focusId : null);
  const tipPos = (() => {
    if (tipNodeId == null) return null;
    const n = simNodes.current.get(tipNodeId);
    if (n?.x == null || n.y == null) return null;
    const t = view.current;
    return { x: n.x * t.k + t.x, y: (n.y - n.r) * t.k + t.y, below: (n.y + n.r) * t.k + t.y };
  })();

  const edgeById = useMemo(() => new Map(edges.map((e) => [edgeId(e), e])), [edges]);
  const hovered = hover?.type === 'edge' ? edgeById.get(hover.id) : undefined;

  return (
    <div
      ref={wrapRef}
      className="sprint-canvas relative h-[70vh] min-h-[480px] w-full overflow-hidden rounded-xl"
      data-testid="sprint-graph"
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        setHover(null);
      }}
    >
      {/* The star field: fixed to the canvas, never zoomed or panned. */}
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full">
        {STARS.map((s, i) => (
          <circle key={i} cx={`${(s.x * 100).toFixed(2)}%`} cy={`${(s.y * 100).toFixed(2)}%`} r={s.r} fill="#ffffff" opacity={s.o} />
        ))}
      </svg>

      <svg
        ref={svgRef}
        className="sg-surface absolute inset-0 h-full w-full select-none"
        role="group"
        aria-label="Sprint graph"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && selected != null) onClearSelection();
        }}
      >
        <defs>
          <marker id="sg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={edgeStyle('depends_on').stroke} />
          </marker>
          <filter id="sg-glow" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="4" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <clipPath id="sg-avatar-clip" clipPathUnits="objectBoundingBox">
            <circle cx="0.5" cy="0.5" r="0.5" />
          </clipPath>
        </defs>
        <g ref={viewRef}>
          {/* The group halos: behind everything, placed from the members' positions every frame. */}
          {groupMode !== 'none' && (
            <g pointerEvents="none" aria-hidden="true">
              {groups.map((g) => (
                <g key={`${groupMode}:${g.key}`} ref={(el) => registerHalo(g.key, 'g', el)} display="none">
                  <circle
                    ref={(el) => registerHalo(g.key, 'circle', el)}
                    fill={GROUP_HALO.fill}
                    fillOpacity={GROUP_HALO.fillAlpha}
                    stroke={GROUP_HALO.stroke}
                    strokeOpacity={GROUP_HALO.strokeAlpha}
                    strokeWidth={1}
                    strokeDasharray="2 4"
                    vectorEffect="non-scaling-stroke"
                  />
                  <g ref={(el) => registerHalo(g.key, 'label', el)} className="sg-group-name">
                    <g className="sg-group-label">
                      <text
                        ref={(el) => registerHalo(g.key, 'text', el)}
                        y={-7}
                        textAnchor="middle"
                        fontSize={12}
                        fontWeight={600}
                        fill={GROUP_HALO.label}
                        stroke={SPRINT_CANVAS.groundEdge}
                        strokeWidth={3}
                        paintOrder="stroke"
                      >
                        {truncateLabel(g.label, GROUP_LABEL_MAX)}
                      </text>
                    </g>
                  </g>
                </g>
              ))}
            </g>
          )}
          <g>
            {edges.map((e) => {
              const id = edgeId(e);
              const st = edgeStyle(e.kind);
              const ok = passes.get(e.from) !== false && passes.get(e.to) !== false;
              const inFocus = focusSet == null || (focusSet.has(e.from) && focusSet.has(e.to));
              const lit = hoverNode != null && (e.from === hoverNode || e.to === hoverNode);
              const isHover = hover?.type === 'edge' && hover.id === id;
              const opacity = !ok ? 0.03 : !inFocus ? 0.06 : lit || isHover ? 1 : st.opacity;
              return (
                <EdgeView
                  key={id}
                  id={id}
                  stroke={st.stroke}
                  width={isHover ? st.width + 1 : st.width}
                  dash={st.dash}
                  arrow={st.arrow}
                  opacity={opacity}
                  interactive={ok && inFocus}
                  handlers={handlers.current}
                />
              );
            })}
          </g>
          <g>
            {nodes.map((n) => {
              const ok = passes.get(n.ident) !== false;
              const inFocus = focusSet == null || focusSet.has(n.ident);
              const shown = ok && inFocus;
              return (
                <NodeView
                  key={n.ident}
                  node={n}
                  bodyOpacity={!ok ? FILTERED_OPACITY : !inFocus ? DIMMED_OPACITY : nodeBaseOpacity(n)}
                  textOpacity={!ok ? FILTERED_OPACITY : !inFocus ? DIMMED_OPACITY : labelOpacity(n)}
                  glow={n.ident === selected || n.ident === hoverNode || n.ident === focusId}
                  selected={n.ident === selected}
                  focusable={ok}
                  avatarFailed={n.assignee?.avatarUrl != null && failedAvatars.has(safeExternalUrl(n.assignee.avatarUrl) ?? '')}
                  dimmed={!shown}
                  handlers={handlers.current}
                />
              );
            })}
          </g>
        </g>
      </svg>

      {/* The tooltip-popover: a node's status and links, or an edge's relation and quote. */}
      {tipNodeId != null && tipPos != null && byId.get(tipNodeId) != null && (
        <NodeTip node={byId.get(tipNodeId) as SprintGraphNode} edges={edges} byId={byId} pos={tipPos} size={size.current} />
      )}
      {hovered != null && hover?.type === 'edge' && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 max-w-[18rem] rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg"
          style={{ left: Math.min(hover.x + 12, Math.max(8, size.current.w - 300)), top: Math.max(8, hover.y + 12), color: SPRINT_CANVAS.legendText }}
        >
          <div>
            <span className="font-mono font-semibold">{byId.get(hovered.from)?.key ?? ''}</span>{' '}
            {SPRINT_EDGE_LABEL[hovered.kind].toLowerCase()}{' '}
            <span className="font-mono font-semibold">{byId.get(hovered.to)?.key ?? ''}</span>
          </div>
          {hovered.quote != null && hovered.quote !== '' && <div className="mt-0.5 italic">“{hovered.quote}”</div>}
          {hovered.source === 'tracker' && <div className="mt-0.5">A blocking link in the tracker</div>}
        </div>
      )}

      {/* A plain wheel scrolled the page: say how to zoom (fades; the pointer's hint, so aria-hidden). */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-md border border-white/15 bg-slate-950/90 px-3 py-1.5 text-xs font-medium shadow-lg transition-opacity duration-300 ${
          wheelHint ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ color: SPRINT_CANVAS.legendText }}
        data-testid="sprint-graph-wheel-hint"
      >
        Hold Ctrl/⌘ to zoom
      </div>

      {/* Canvas controls, top right. */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <CanvasButton label="Zoom in" onClick={() => zoomBy(1.25)}>
          <PlusIcon size={12} />
        </CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => zoomBy(0.8)}>
          <MinusIcon size={12} />
        </CanvasButton>
        <CanvasButton onClick={fit}>Fit</CanvasButton>
        {hasPins && <CanvasButton onClick={resetLayout}>Reset layout</CanvasButton>}
      </div>

      <Legend open={legendOpen} onToggle={() => setLegendOpen((o) => !o)} faintShown={faintShown} groupMode={groupMode} />

      {/* The screen-reader alternative: every ticket, in the wire's order. */}
      <ul className="sr-only" aria-label="Tickets in the graph">
        {nodes.map((n) => (
          <li key={n.ident}>
            <button type="button" tabIndex={-1} onClick={() => onOpen(n.ident)}>
              {nodeAriaLabel(n)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Handlers = {
  enterNode: (id: string) => void;
  leave: () => void;
  enterEdge: (id: string, x: number, y: number) => void;
  focus: (id: string) => void;
  blur: () => void;
  key: (id: string) => void;
  avatarFailed: (url: string) => void;
  registerNode: (id: string, el: SVGGElement | null) => void;
  registerSat: (id: string, el: SVGGElement | null) => void;
  registerLabel: (id: string, el: SVGGElement | null) => void;
  registerEdge: (id: string, part: 'line' | 'hit', el: SVGLineElement | null) => void;
};

const EdgeView = memo(function EdgeView({
  id,
  stroke,
  width,
  dash,
  arrow,
  opacity,
  interactive,
  handlers,
}: {
  id: string;
  stroke: string;
  width: number;
  dash: string | null;
  arrow: boolean;
  opacity: number;
  interactive: boolean;
  handlers: Handlers;
}): JSX.Element {
  return (
    <g>
      <line
        ref={(el) => handlers.registerEdge(id, 'line', el)}
        stroke={stroke}
        strokeWidth={width}
        strokeDasharray={dash ?? undefined}
        strokeLinecap="round"
        opacity={opacity}
        markerEnd={arrow ? 'url(#sg-arrow)' : undefined}
        vectorEffect="non-scaling-stroke"
        pointerEvents="none"
      />
      {interactive && (
        <line
          ref={(el) => handlers.registerEdge(id, 'hit', el)}
          stroke="transparent"
          strokeWidth={10}
          vectorEffect="non-scaling-stroke"
          onPointerEnter={(e) => handlers.enterEdge(id, e.clientX, e.clientY)}
          onPointerLeave={handlers.leave}
        />
      )}
    </g>
  );
});

const NodeView = memo(function NodeView({
  node: n,
  bodyOpacity,
  textOpacity,
  glow,
  selected,
  focusable,
  avatarFailed,
  dimmed,
  handlers,
}: {
  node: SprintGraphNode;
  bodyOpacity: number;
  textOpacity: number;
  glow: boolean;
  selected: boolean;
  focusable: boolean;
  avatarFailed: boolean;
  dimmed: boolean;
  handlers: Handlers;
}): JSX.Element {
  const r = nodeRadius(n.degree, n.ghost);
  const ring = stageRing(n.stage);
  const sats = satellitesOf(n.prs);
  const orbitR = r + 6;
  const avatarUrl = safeExternalUrl(n.assignee?.avatarUrl ?? null) ?? null;
  const showAvatar = !n.ghost && n.assignee != null;
  const ar = 7;
  const ax = r * 0.72;
  const ay = -r * 0.72;
  return (
    <g
      ref={(el) => handlers.registerNode(n.ident, el)}
      data-sg-node={n.ident}
      role="button"
      tabIndex={focusable ? 0 : -1}
      aria-hidden={focusable ? undefined : true}
      aria-label={nodeAriaLabel(n)}
      aria-pressed={selected}
      className="sg-node cursor-pointer outline-none"
      onPointerEnter={() => handlers.enterNode(n.ident)}
      onPointerLeave={handlers.leave}
      onFocus={() => handlers.focus(n.ident)}
      onBlur={handlers.blur}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handlers.key(n.ident);
        }
      }}
    >
      <g opacity={bodyOpacity} className="sg-body">
        {/* The disc: a dark fill so lines pass BEHIND the ticket, the stage ring around it. */}
        <circle
          r={r}
          fill="#0b1430"
          stroke={ring}
          strokeWidth={n.ghost ? 1.5 : selected ? 3.5 : 2.5}
          strokeDasharray={n.ghost ? '3 2.5' : undefined}
          filter={glow && !dimmed ? 'url(#sg-glow)' : undefined}
        />
        <circle r={Math.max(2, r * 0.38)} fill={ring} opacity={0.35} />
        {sats.length > 0 && (
          <g ref={(el) => handlers.registerSat(n.ident, el)}>
            {sats.map((s) => (
              <circle
                key={s.prId}
                cx={Math.cos(s.angle) * orbitR}
                cy={Math.sin(s.angle) * orbitR}
                r={2.4}
                fill={SATELLITE_FILL[s.kind]}
                stroke={s.failing ? SATELLITE_FAILING_RING : '#0b1430'}
                strokeWidth={s.failing ? 1.4 : 0.6}
              />
            ))}
          </g>
        )}
        {showAvatar && (
          <g transform={`translate(${ax.toFixed(1)},${ay.toFixed(1)})`}>
            <circle r={ar + 1} fill="#0b1430" stroke={ring} strokeWidth={1} />
            {avatarUrl != null && !avatarFailed ? (
              <image
                href={avatarUrl}
                x={-ar}
                y={-ar}
                width={ar * 2}
                height={ar * 2}
                clipPath="url(#sg-avatar-clip)"
                preserveAspectRatio="xMidYMid slice"
                onError={() => handlers.avatarFailed(avatarUrl)}
              />
            ) : (
              <text textAnchor="middle" dy="0.35em" fontSize={7} fontWeight={700} fill={SPRINT_CANVAS.labelKey}>
                {initialsOf(n.assignee?.name ?? '')}
              </text>
            )}
          </g>
        )}
        {/* The keyboard focus ring (CSS shows it on :focus-visible). */}
        <circle className="sg-focus" r={r + 5} fill="none" stroke="#f8fafc" strokeWidth={1.5} strokeDasharray="2 2" />
      </g>
      {/* The label: kept the SAME SIZE on screen at any zoom (CSS scales it by 1/zoom, `--sg-inv`);
          zoomed far out, only the key shows (`data-zoom="far"` hides the titles). */}
      <g opacity={textOpacity} pointerEvents="none">
        <g ref={(el) => handlers.registerLabel(n.ident, el)} className="sg-label" style={{ '--r': r } as CSSProperties}>
          <text
            y={11}
            textAnchor="middle"
            fontSize={11}
            fontWeight={700}
            fill={SPRINT_CANVAS.labelKey}
            stroke={SPRINT_CANVAS.groundEdge}
            strokeWidth={3}
            paintOrder="stroke"
            className="font-mono"
          >
            {n.key}
          </text>
          {n.title !== '' && (
            <text
              y={24}
              textAnchor="middle"
              fontSize={11}
              fill={SPRINT_CANVAS.labelTitle}
              stroke={SPRINT_CANVAS.groundEdge}
              strokeWidth={3}
              paintOrder="stroke"
              className="sg-title"
            >
              {truncateLabel(n.title)}
            </text>
          )}
        </g>
      </g>
    </g>
  );
});

function NodeTip({
  node: n,
  edges,
  byId,
  pos,
  size,
}: {
  node: SprintGraphNode;
  edges: SprintGraphEdge[];
  byId: Map<string, SprintGraphNode>;
  pos: { x: number; y: number; below: number };
  size: { w: number; h: number };
}): JSX.Element {
  // Its links, by relation: "Depends on BMD-2, BMD-3" (outgoing) and "BMD-4 depends on this" (incoming).
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === n.ident) {
      const l = SPRINT_EDGE_LABEL[e.kind];
      out.set(l, [...(out.get(l) ?? []), byId.get(e.to)?.key ?? '']);
    } else if (e.to === n.ident) {
      const l = SPRINT_EDGE_LABEL[e.kind].toLowerCase();
      inc.set(l, [...(inc.get(l) ?? []), byId.get(e.from)?.key ?? '']);
    }
  }
  const list = (keys: string[]): string => (keys.length <= 3 ? keys.join(', ') : `${keys.slice(0, 3).join(', ')} and ${keys.length - 3} more`);
  const width = 288;
  const left = Math.max(8, Math.min(pos.x - width / 2, size.w - width - 8));
  const above = pos.y > 150;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 space-y-0.5 rounded-md border border-white/15 bg-slate-950/95 px-2.5 py-1.5 text-xs shadow-lg"
      style={{
        left,
        width,
        color: SPRINT_CANVAS.legendText,
        ...(above ? { bottom: size.h - pos.y + 8 } : { top: pos.below + 34 }),
      }}
    >
      <div className="font-semibold">
        <span className="font-mono">{n.key}</span>
        {n.title !== '' && <span className="font-normal"> {n.title}</span>}
      </div>
      <div>
        {n.status?.name ?? 'Status unknown'}
        {n.stage != null && n.status?.name !== SPRINT_STAGE_LABEL[n.stage] && ` · ${SPRINT_STAGE_LABEL[n.stage]}`}
        {n.assignee != null && ` · ${n.assignee.name}`}
        {n.prs.length > 0 && ` · ${n.prs.length} ${n.prs.length === 1 ? 'PR' : 'PRs'}`}
        {n.ghost && ' · Outside the sprint'}
      </div>
      {[...out.entries()].map(([l, keys]) => (
        <div key={`o${l}`}>
          {l} {list(keys)}
        </div>
      ))}
      {[...inc.entries()].map(([l, keys]) => (
        <div key={`i${l}`}>
          {list(keys)} {l} this
        </div>
      ))}
    </div>
  );
}

function CanvasButton({ label, onClick, children }: { label?: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded border border-white/20 bg-slate-900/80 px-2 text-xs font-medium text-slate-100 hover:border-white/40 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
    >
      {children}
    </button>
  );
}

const GROUP_KEY_TEXT: Record<Exclude<SprintGroupMode, 'none'>, string> = {
  epic: 'Tickets in one epic',
  theme: 'Tickets in one theme',
  section: 'Tickets in one section',
};

function Legend({
  open,
  onToggle,
  faintShown,
  groupMode,
}: {
  open: boolean;
  onToggle: () => void;
  faintShown: boolean;
  groupMode: SprintGroupMode;
}): JSX.Element {
  const swatchText = { color: SPRINT_CANVAS.legendText };
  return (
    <div className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)]">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="mb-1 rounded border border-white/20 bg-slate-900/80 px-2 py-0.5 text-[11px] font-medium text-slate-100 hover:border-white/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
      >
        {open ? 'Hide key' : 'Key'}
      </button>
      {open && (
        <div className="space-y-1 rounded-md border border-white/10 bg-slate-950/80 px-2.5 py-2 text-[11px]" style={swatchText}>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {SPRINT_STAGES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1">
                <svg width="12" height="12" aria-hidden="true">
                  <circle cx="6" cy="6" r="4.5" fill="none" stroke={stageRing(s)} strokeWidth="2" />
                </svg>
                {SPRINT_STAGE_LABEL[s]}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <svg width="12" height="12" aria-hidden="true">
                <circle cx="6" cy="6" r="4.5" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="2 1.5" />
              </svg>
              Outside the sprint
            </span>
            {groupMode !== 'none' && (
              <span className="inline-flex items-center gap-1">
                <svg width="14" height="14" aria-hidden="true">
                  <circle cx="7" cy="7" r="6" fill={GROUP_HALO.fill} fillOpacity={0.12} stroke={GROUP_HALO.stroke} strokeOpacity={0.7} strokeDasharray="2 2" />
                </svg>
                {GROUP_KEY_TEXT[groupMode]}
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(faintShown ? (['depends_on', 'concurrent', 'builds_on'] as const) : (['depends_on', 'concurrent'] as const)).map((k) => {
              const st = edgeStyle(k);
              return (
                <span key={k} className="inline-flex items-center gap-1">
                  <svg width="22" height="8" aria-hidden="true">
                    <line x1="1" y1="4" x2={st.arrow ? 16 : 21} y2="4" stroke={st.stroke} strokeWidth={Math.max(1, st.width)} strokeDasharray={st.dash ?? undefined} opacity={Math.max(0.6, st.opacity)} />
                    {st.arrow && <path d="M15,1 L21,4 L15,7 z" fill={st.stroke} />}
                  </svg>
                  {k === 'builds_on' ? 'Builds on or replaces' : SPRINT_EDGE_LABEL[k]}
                </span>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {(['open', 'draft', 'merged'] as const).map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <svg width="8" height="8" aria-hidden="true">
                  <circle cx="4" cy="4" r="3" fill={SATELLITE_FILL[k]} />
                </svg>
                {k === 'open' ? 'Open PR' : k === 'draft' ? 'Draft PR' : 'Merged PR'}
              </span>
            ))}
            <span className="inline-flex items-center gap-1">
              <svg width="10" height="10" aria-hidden="true">
                <circle cx="5" cy="5" r="3" fill={SATELLITE_FILL.open} stroke={SATELLITE_FAILING_RING} strokeWidth="1.5" />
              </svg>
              Checks failing
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
