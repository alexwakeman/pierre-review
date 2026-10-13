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
import { CheckIcon, EyeIcon, MinusIcon, PlusIcon, QuestionIcon, StageInProgressIcon, StageNotStartedIcon } from '../Icons.js';
import {
  BADGE_R,
  DIMMED_OPACITY,
  FILTERED_OPACITY,
  DISC_GROUND,
  badgeCentre,
  badgeScale,
  discFill,
  glyphColour,
  glyphSize,
  ringWidth,
  statusGlyph,
  type StatusGlyph,
  INTRO_MS,
  RELAYOUT_MS,
  SETTLE_MS,
  VIEW_MS,
  assignGroups,
  boundsOf,
  driftScale,
  easeInOut,
  fitBoxIn,
  groupList,
  introGroupMode,
  introSeeds,
  lerpView,
  uncoveredSpan,
  withNeighbours,
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
  drawnRadius,
  HALO_LAYOUT_SCALE,
  HALO_NAME_LAYOUT_ZOOM,
  HALO_SUBNAME_LAYOUT_ZOOM,
  edgeStyle,
  enclosingHalo,
  badgeCircle,
  fitTransform,
  groupAnchors,
  groupHalo,
  haloSeparation,
  haloName,
  haloNameBox,
  labelOffset,
  labelPriority,
  placeHaloNames,
  withNameRoom,
  labelSize,
  orbitRadius,
  labelOpacity,
  neighbourhood,
  nodeAriaLabel,
  nodeBaseOpacity,
  nodeRadius,
  passesFilters,
  pinchTransform,
  personGroupCounts,
  personOf,
  personRoomAnchors,
  personRoomKey,
  personSplitLayout,
  splitPersonRoomKey,
  PERSON_HALO,
  PERSON_LABEL_MAX,
  placeLabels,
  readPinned,
  safeLocalStorage,
  satellitesOf,
  stageRing,
  starField,
  statusSlotOf,
  statusSplitLayout,
  STATUS_SLOT_LABEL,
  SUB_HALO,
  slotOfSubKey,
  subGroupAnchors,
  subGroupCounts,
  subGroupKey,
  subHaloColour,
  subLabelColour,
  truncateLabel,
  wheelZoomFactor,
  writePinned,
  zoomAbout,
  type HaloName,
  type LabelItem,
  type LabelSide,
  type PersonSplit,
  type PinnedPositions,
  type ScreenBox,
  type SprintGraphFilters,
  type SprintGroup,
  type SprintGroupMode,
  type SprintMember,
  type StatusSplit,
  type ViewTransform,
} from './sprintGraphModel.js';

// THE SPRINT GRAPH (Activity → This Sprint): the sprint's tickets and the GHOST tickets they reach, on an
// always-navy "space" canvas. d3-force is the physics ONLY; the SVG is drawn here by hand.
//
// ⚠ POSITIONS NEVER GO THROUGH REACT. React renders each node / edge ONCE (and again only when what it
// SHOWS changes — a hover, the selection, a filter); the simulation's positions are written straight to
// the DOM (`transform`, `x1…y2`) from one requestAnimationFrame loop. 125 nodes re-rendered at 60 fps
// was the jank this avoids. So no JSX here may set a node's `transform` or an edge's coordinates.
//
// MOTION IS BRIEF, THEN THE CANVAS IS STILL. Every layout is computed to rest before it is shown. On
// first load the tickets TRAVEL there from another grouping (Epic, or Theme when Epic is chosen —
// `introGroupMode`), with the group halos fading in as they arrive; a re-layout (a grouping or
// visibility change) animates each ticket from where it was. For `SETTLE_MS` after load, a re-layout or
// a drag release the forces run and a slow drift turns the graph (fading out, `driftScale`); then the
// animation loop STOPS — nothing moves until the next one. The drift pauses under the pointer, and
// everything pauses while a ticket is selected. `prefers-reduced-motion`: no animation, no loop — each
// layout jumps to rest.
// Opening a ticket animates the view to it and its linked tickets, framed in the strip of canvas the
// drawer leaves visible (`uncoveredSpan`); picking an epic or theme in the filter frames those tickets.
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
// "SPLIT BY STATUS" (Epic / Theme only) divides each group's room into a ROW of sub-groups, one per
// section in fixed order (`statusSplitLayout`): tickets are pulled to their SUB-anchor, each sub-group
// gets its own faint halo tinted with its section's ring colour and a small name, the group's halo
// encloses its sub-halos (`enclosingHalo`), and sub-halos inside one group are pushed apart like groups.
// "SPLIT BY ASSIGNEE" goes one level deeper: inside each group (or each status sub-group) one room per
// person (`personSplitLayout`), a faint NEUTRAL halo named with the person, pushed apart within its
// parent ('separate-people'); the parent's halo encloses its person halos.
//
// LABELS keep a fixed screen size, so which ones fit is decided on SCREEN (`placeLabels`): after every
// zoom and, throttled, while the canvas moves. A label takes the free side of its ticket, or hides until
// hover, focus or zoom gives it room. The side is written as CSS variables on `.sg-label`, never by React.
//
// THE VIEW: the wheel (and a trackpad pinch) zooms about the pointer — the page is short, so the canvas
// may take the wheel. On touch one finger scrolls the page unless it starts on a ticket (a drag), and
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
  /** The status sub-group key (`subGroupKey`) while "Split by status" is on; else null. */
  sub: string | null;
  /** The person room key (`personRoomKey`) while "Split by assignee" is on; else null. */
  person: string | null;
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
/** The most a framing (a ticket opened, an epic / theme picked) zooms in. */
const FRAME_ZOOM_MAX = 1.4;
const STARS = starField(140);
// Far (small, dim) stars drift slowly, near ones a little faster — the parallax is the depth.
const STAR_LAYERS = [STARS.filter((s) => s.r < 0.85), STARS.filter((s) => s.r >= 0.85)];
/** The drawer's width when it cannot be measured (Tailwind `max-w-2xl`, capped at the window). */
const DRAWER_MAX_PX = 672;

/** A layout animating in: each ticket's start and end, and the view's (null = the reader moved it). */
interface LayoutTween {
  from: Map<string, { x: number; y: number }>;
  to: Map<string, { x: number; y: number }>;
  start: number;
  dur: number;
  viewFrom: ViewTransform | null;
  viewTo: ViewTransform | null;
  /** The group halos fade in as the tickets arrive (a new grouping, the opening animation). */
  fadeHalos: boolean;
}

/** A halo with the room it made for its name (null: too small on screen for one). Layout units. */
interface NamedHalo {
  x: number;
  y: number;
  r: number;
  name: HaloName | null;
}

/** A halo's name sits just inside the top of its halo, centred: the label's anchor is the rim's top point
 *  (layout units); the text, drawn at a constant screen size, sits `depth` px below it, cut to the chord. */
function writeHaloName(
  els: { label: SVGGElement | null; text: SVGTextElement | null } | undefined,
  h: NamedHalo | undefined,
  baseline: number,
): void {
  if (els?.label == null || h == null) return;
  els.label.setAttribute('transform', `translate(${h.x.toFixed(1)},${(h.y - h.r).toFixed(1)})`);
  if (h.name == null || els.text == null) return;
  const y = (h.name.room.depth + baseline).toFixed(1);
  if (els.text.getAttribute('y') !== y) els.text.setAttribute('y', y);
  if (els.text.textContent !== h.name.text) els.text.textContent = h.name.text;
}

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
  splitStatus = false,
  splitAssignee = false,
  members,
  faintShown,
  layoutIntent = '',
  drawerOpen = false,
  frameRequest = 0,
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
  /** "Split by status" is on AND the mode can split (`canSplitByStatus`) — resolved by the page. */
  splitStatus?: boolean;
  /** "Split by assignee" is on AND the mode can split (`canSplitByAssignee`) — resolved by the page. */
  splitAssignee?: boolean;
  /** The Members filter's people by id (`sprintMembers`), so a member matches tickets AND PRs. */
  members?: ReadonlyMap<string, SprintMember>;
  /** "Show builds on / replaces" is on (the key lists the faint line). */
  faintShown: boolean;
  /** The READER's layout choices (grouping, split, visibility toggles). A re-layout animates only when
   *  this changed; a re-layout caused by refetched DATA (a sync, the sprint re-read, briefs or themes
   *  landing) keeps every ticket on screen exactly where it is — no tween, no view move, no drift. */
  layoutIntent?: string;
  /** localStorage key for pinned positions (`pinnedStorageKey`). */
  pinKey: string;
  filters: SprintGraphFilters;
  /** The selected node (the drawer's ticket, and kept after it closes); null = none. */
  selected: string | null;
  hops: 1 | 2;
  /** The ticket drawer is open (it covers the canvas from the right). */
  drawerOpen?: boolean;
  /** Bumped on every ticket OPEN (click, Enter, a link in the drawer): frame `selected` and its links. */
  frameRequest?: number;
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
  const subHaloEls = useRef(
    new Map<string, { g: SVGGElement | null; circle: SVGCircleElement | null; label: SVGGElement | null; text: SVGTextElement | null }>(),
  );
  const personHaloEls = useRef(
    new Map<string, { g: SVGGElement | null; circle: SVGCircleElement | null; label: SVGGElement | null; text: SVGTextElement | null }>(),
  );
  /** A layout animating in (the opening animation, a re-layout). */
  const tween = useRef<LayoutTween | null>(null);
  /** An animated zoom / pan (a ticket opened, a filter picked). */
  const viewAnim = useRef<{ from: ViewTransform; to: ViewTransform; start: number; dur: number } | null>(null);
  /** A framing asked for while a layout animates in: run when it lands, so it measures where the
   *  tickets and halos END (mid-flight the halos are skipped and the positions are the old layout's).
   *  The reader's own zoom, pan or Fit cancels it. */
  const pendingFrame = useRef<(() => void) | null>(null);
  const runPendingFrame = (): void => {
    const run = pendingFrame.current;
    pendingFrame.current = null;
    run?.();
  };
  /** The canvas may move until this time (performance.now ms); then the loop stops. */
  const liveUntil = useRef(0);
  /** The drift's strength this frame (read by the 'drift' force). */
  const drift = useRef(0);
  const rafId = useRef(0);
  const running = useRef(false);
  const lastT = useRef(0);
  const frameRef = useRef<(t: number) => void>(() => undefined);
  const haloLayerRef = useRef<SVGGElement | null>(null);
  const reducedRef = useRef(false);
  const labelEls = useRef(new Map<string, SVGGElement>());
  /** Each label's positioned wrapper in the LABEL LAYER (drawn above every disc). */
  const labelAnchorEls = useRef(new Map<string, SVGGElement>());
  const labelSides = useRef(new Map<string, { side: LabelSide; sig: string }>());
  const labelFrame = useRef(0);
  /** The reader has zoomed / panned since the last Fit: the view stops following Fit. */
  const viewTouched = useRef(false);
  const [aspect, setAspect] = useState<number | null>(null);
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
    for (const n of nodes) m.set(n.ident, passesFilters(n, filters, deps, members));
    return m;
  }, [nodes, filters, deps, members]);
  const focusSet = useMemo(() => (selected != null && byId.has(selected) ? neighbourhood(edges, selected, hops) : null), [
    selected,
    byId,
    edges,
    hops,
  ]);
  const hoverNode = hover?.type === 'node' ? hover.id : null;

  // "Split by status": each group's sub-group rooms (a row, in section order), sized by the DRAWN
  // members per status — ghosts included, so "Show shipped history" re-spaces them.
  // "Split by assignee": inside each group — or each status sub-group — one room per person, sized by
  // the DRAWN members per person. Worked out first: a split status sub-group's room is round its people.
  const persons = useMemo((): { splits: Map<string, PersonSplit>; roomOf: Map<string, string>; labels: Map<string, string> } | null => {
    if (!splitAssignee || groupMode === 'none') return null;
    const byId = new Map(nodes.map((n) => [n.ident, n]));
    const parentOf = (ident: string): string | null => {
      const g = groupOf.get(ident);
      if (g == null) return null;
      return splitStatus ? subGroupKey(g, statusSlotOf(byId.get(ident)?.stage ?? null)) : g;
    };
    const labels = new Map<string, string>();
    const roomOf = new Map<string, string>();
    for (const n of nodes) {
      const parent = parentOf(n.ident);
      if (parent == null) continue;
      const p = personOf(n.assignee, members);
      if (!labels.has(p.key)) labels.set(p.key, p.label);
      roomOf.set(n.ident, personRoomKey(parent, p.key));
    }
    const splits = new Map<string, PersonSplit>();
    for (const [parent, c] of personGroupCounts(nodes, parentOf, members)) {
      splits.set(parent, personSplitLayout(c, (k) => labels.get(k) ?? k));
    }
    return { splits, roomOf, labels };
  }, [splitAssignee, splitStatus, groupMode, nodes, groupOf, members]);
  const splits = useMemo((): Map<string, StatusSplit> | null => {
    if (!splitStatus || groupMode === 'none') return null;
    const out = new Map<string, StatusSplit>();
    for (const [g, c] of subGroupCounts(nodes, groupOf)) {
      out.set(g, statusSplitLayout(c, (slot) => persons?.splits.get(subGroupKey(g, slot))?.r));
    }
    return out;
  }, [splitStatus, groupMode, nodes, groupOf, persons]);
  const personRoomOf = useCallback((ident: string): string | null => persons?.roomOf.get(ident) ?? null, [persons]);
  const personSize = useMemo(() => {
    const m = new Map<string, number>();
    if (persons == null) return m;
    for (const k of persons.roomOf.values()) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  }, [persons]);
  const personSizeRef = useRef(personSize);
  personSizeRef.current = personSize;
  const subOf = useCallback(
    (ident: string, stage: SprintGraphNode['stage']): string | null => {
      const g = groupOf.get(ident);
      return splits != null && g != null && splits.has(g) ? subGroupKey(g, statusSlotOf(stage)) : null;
    },
    [splits, groupOf],
  );
  const subSize = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of nodes) {
      const k = subOf(n.ident, n.stage);
      if (k != null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [nodes, subOf]);
  const subSizeRef = useRef(subSize);
  subSizeRef.current = subSize;

  // What label placement reads (refs: it runs from the rAF loop, outside React).
  const labelCtx = useRef({
    byId,
    promoted: new Set<string>(),
    faded: new Set<string>(),
    groupLabels: new Map<string, string>(),
    groupDrawn: new Map<string, number>(),
    subDrawn: new Map<string, number>(),
    personLabels: new Map<string, string>(),
    personDrawn: new Map<string, number>(),
  });
  labelCtx.current = {
    byId,
    groupDrawn: new Map(groups.map((g) => [g.key, g.drawn])),
    promoted: new Set([selected, hoverNode, focusId].filter((x): x is string => x != null)),
    faded: new Set(nodes.filter((n) => passes.get(n.ident) === false || (focusSet != null && !focusSet.has(n.ident))).map((n) => n.ident)),
    groupLabels: new Map(groupMode === 'none' ? [] : groups.map((g) => [g.key, truncateLabel(g.label, GROUP_LABEL_MAX)])),
    subDrawn: subSizeRef.current,
    personLabels: new Map(
      [...personSizeRef.current.keys()].map((k) => {
        const person = splitPersonRoomKey(k)?.person ?? k;
        return [k, truncateLabel(persons?.labels.get(person) ?? person, PERSON_LABEL_MAX)];
      }),
    ),
    personDrawn: personSizeRef.current,
  };

  // ── Writing positions to the DOM ────────────────────────────────────────────────────────────────
  // Every halo is round the tickets as DRAWN: zoomed out, each disc (and its ring) is enlarged by
  // `discScale(k)` about its centre, so a halo sized from the layout radius let the tickets spill out of
  // it at Fit. `s` is that enlargement: the view's own when drawing, the largest one (`HALO_LAYOUT_SCALE`)
  // for the forces that keep halos apart and for Fit, so no two halos overlap at any zoom.
  // The person rooms' halos (empty unless "Split by assignee" is on), round their members. `parent` is
  // the room they sit in: the status sub-group, else the group.
  // Every halo also makes ROOM at its top for its own name (`haloName`): the name is drawn at a constant
  // screen size, so the room depends on the zoom `k` — the view's own when drawing; for the forces,
  // `HALO_NAME_LAYOUT_ZOOM` for the groups and `HALO_SUBNAME_LAYOUT_ZOOM` for the status and person rooms
  // inside them (`kInner`). A parent's halo is sized round its children's ROOMY halos, so the nesting holds.
  // A ticket's assignee badge pokes past its disc (top right): the halos hold it too.
  // Zoomed far out (the whole sprint) the assignee badges are not drawn (CSS `data-zoom='far'`), so
  // they reserve no room in a halo and block no name.
  const hasBadge = (id: string, k: number): boolean => {
    if (k < FAR_ZOOM) return false;
    const node = labelCtx.current.byId.get(id);
    return node != null && !node.ghost && node.assignee != null;
  };
  const currentPersonHalos = useCallback(
    (s: number = discScale(view.current.k), k: number = view.current.k): Map<string, NamedHalo & { parent: string; group: string }> => {
      const pts = new Map<string, { parent: string; group: string; l: Array<{ x: number; y: number; r: number }>; b: Array<{ x: number; y: number; r: number }> }>();
      const bs = badgeScale(k);
      for (const n of simNodes.current.values()) {
        if (n.person == null || n.group == null || n.x == null || n.y == null) continue;
        let e = pts.get(n.person);
        if (e == null) {
          e = { parent: n.sub ?? n.group, group: n.group, l: [], b: [] };
          pts.set(n.person, e);
        }
        e.l.push({ x: n.x, y: n.y, r: drawnRadius(n.r, s) });
        if (hasBadge(n.id, k)) e.b.push(badgeCircle(n.x, n.y, n.r, s, bs));
      }
      const out = new Map<string, NamedHalo & { parent: string; group: string }>();
      for (const [key, e] of pts) {
        const h = groupHalo(e.l, 8, e.b);
        if (h == null) continue;
        const text = labelCtx.current.personLabels.get(key);
        const name = text == null ? null : haloName(text, 'sub', h.r * k);
        out.set(key, { ...withNameRoom(h, name == null ? 0 : name.room.pad / k), name, parent: e.parent, group: e.group });
      }
      return out;
    },
    [],
  );
  // The status sub-groups' halos (empty unless "Split by status" is on), round their members — or, split
  // by assignee too, round their person halos.
  const currentSubHalos = useCallback(
    (s: number = discScale(view.current.k), k: number = view.current.k): Map<string, NamedHalo & { group: string }> => {
      const pts = new Map<string, { group: string; l: Array<{ x: number; y: number; r: number }>; b: Array<{ x: number; y: number; r: number }> }>();
      const entry = (key: string, group: string): { group: string; l: Array<{ x: number; y: number; r: number }>; b: Array<{ x: number; y: number; r: number }> } => {
        let e = pts.get(key);
        if (e == null) {
          e = { group, l: [], b: [] };
          pts.set(key, e);
        }
        return e;
      };
      const bs = badgeScale(k);
      const people = currentPersonHalos(s, k);
      for (const h of people.values()) if (h.parent !== h.group) entry(h.parent, h.group).l.push({ x: h.x, y: h.y, r: h.r });
      for (const n of simNodes.current.values()) {
        if (n.sub == null || n.person != null || n.group == null || n.x == null || n.y == null) continue;
        const e = entry(n.sub, n.group);
        e.l.push({ x: n.x, y: n.y, r: drawnRadius(n.r, s) });
        if (hasBadge(n.id, k)) e.b.push(badgeCircle(n.x, n.y, n.r, s, bs));
      }
      const out = new Map<string, NamedHalo & { group: string }>();
      for (const [key, e] of pts) {
        const h = people.size > 0 ? enclosingHalo(e.l.concat(e.b), 10) : groupHalo(e.l, 10, e.b);
        if (h == null) continue;
        const slot = slotOfSubKey(key);
        const name = slot == null ? null : haloName(STATUS_SLOT_LABEL[slot], 'sub', h.r * k);
        out.set(key, { ...withNameRoom(h, name == null ? 0 : name.room.pad / k), name, group: e.group });
      }
      return out;
    },
    [currentPersonHalos],
  );

  // Each group's halo: round its members, or — split by status — round its sub-groups' halos.
  const currentHalos = useCallback(
    (s: number = discScale(view.current.k), k: number = view.current.k, kInner: number = k): Map<string, NamedHalo> => {
      const pts = new Map<string, Array<{ x: number; y: number; r: number }>>();
      const badges = new Map<string, Array<{ x: number; y: number; r: number }>>();
      const add = (key: string, p: { x: number; y: number; r: number }, into = pts): void => {
        const l = into.get(key);
        if (l == null) into.set(key, [p]);
        else l.push(p);
      };
      const bs = badgeScale(k);
      const subs = currentSubHalos(s, kInner);
      for (const h of subs.values()) add(h.group, { x: h.x, y: h.y, r: h.r });
      // Split by assignee alone: the person halos sit straight inside the group.
      const people = subs.size > 0 ? null : currentPersonHalos(s, kInner);
      if (people != null) for (const h of people.values()) add(h.group, { x: h.x, y: h.y, r: h.r });
      for (const n of simNodes.current.values()) {
        if (n.group == null || n.sub != null || n.person != null || n.x == null || n.y == null) continue;
        add(n.group, { x: n.x, y: n.y, r: drawnRadius(n.r, s) });
        if (hasBadge(n.id, k)) add(n.group, badgeCircle(n.x, n.y, n.r, s, bs), badges);
      }
      const out = new Map<string, NamedHalo>();
      for (const [key, l] of pts) {
        const b = badges.get(key) ?? [];
        const h = subs.size > 0 || (people != null && people.size > 0) ? enclosingHalo(l.concat(b), 14) : groupHalo(l, 16, b);
        if (h == null) continue;
        const text = labelCtx.current.groupLabels.get(key);
        const name = text == null ? null : haloName(text, 'group', h.r * k);
        out.set(key, { ...withNameRoom(h, name == null ? 0 : name.room.pad / k), name });
      }
      return out;
    },
    [currentSubHalos, currentPersonHalos],
  );

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
        R: drawnRadius(n.r, disc) * t.k,
        w: d.w,
        h: d.h,
        // Hover / focus / selection only REVEALS a hidden label; it never re-ranks or moves one.
        priority: labelPriority({ degree: n.degree, ghost: node.ghost, faded: ctx.faded.has(id), pinned: false, r: n.r }),
        prev: labelSides.current.get(id)?.side,
        reveal: ctx.promoted.has(id),
      });
    }
    // The assignee badges stick out past their discs (screen circles): no name may cover one.
    const bs = badgeScale(t.k);
    const badges: Array<{ x: number; y: number; R: number; group: string | null; sub: string | null; person: string | null }> = [];
    for (const n of simNodes.current.values()) {
      const node = ctx.byId.get(n.id);
      if (far || node == null || node.ghost || node.assignee == null || n.x == null || n.y == null) continue;
      const c = badgeCentre(n.r, bs);
      const f = disc * t.k;
      badges.push({ x: n.x * t.k + t.x + c.x * f, y: n.y * t.k + t.y + c.y * f, R: (BADGE_R + 1) * bs * f, group: n.group, sub: n.sub, person: n.person });
    }
    // The halo names: each inside the top of its own halo (the halo made room for it), shown unless it
    // would cover a name already shown or a ticket — the group names first, then the status names, then
    // the person names; then no ticket label may cover a name that is shown.
    // ⚠ No hover / focus / selection promotion here: a promoted name used to jump and push its neighbours'
    // names round, under the pointer. Nothing below reads the pointer.
    const obstacles: ScreenBox[] = [];
    if (ctx.groupLabels.size > 0) {
      const discs = [...simNodes.current.values()]
        .filter((n) => n.x != null && n.y != null)
        .map((n) => ({ x: (n.x as number) * t.k + t.x, y: (n.y as number) * t.k + t.y, R: drawnRadius(n.r, disc) * t.k }))
        .concat(badges.map((bd) => ({ x: bd.x, y: bd.y, R: bd.R })));
      const place = (
        halos: ReadonlyMap<string, NamedHalo>,
        els: ReadonlyMap<string, { label: SVGGElement | null }>,
        priority: ReadonlyMap<string, number>,
      ): void => {
        const items = [];
        for (const [key, h] of halos) {
          if (h.name == null) continue;
          const box = haloNameBox({ x: h.x * t.k + t.x, y: h.y * t.k + t.y, r: h.r * t.k }, h.name);
          items.push({ key, box, priority: priority.get(key) ?? 0 });
        }
        const shown = placeHaloNames(items, discs, obstacles);
        for (const it of items) if (shown.get(it.key) === true) obstacles.push(it.box);
        for (const [key, e] of els) {
          const v = shown.get(key) === true ? 'inside' : 'none';
          if (e.label != null && e.label.getAttribute('data-place') !== v) e.label.setAttribute('data-place', v);
        }
      };
      place(currentHalos(), haloEls.current, ctx.groupDrawn);
      const subHalos = currentSubHalos();
      if (subHalos.size > 0 || subHaloEls.current.size > 0) place(subHalos, subHaloEls.current, ctx.subDrawn);
      const personHalos = currentPersonHalos();
      if (personHalos.size > 0 || personHaloEls.current.size > 0) place(personHalos, personHaloEls.current, ctx.personDrawn);
    }
    for (const bd of badges) obstacles.push({ l: bd.x - bd.R, t: bd.y - bd.R, r: bd.x + bd.R, b: bd.y + bd.R });
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
  }, [currentHalos, currentSubHalos, currentPersonHalos]);

  // The halos' DOM: round the tickets as drawn at the current zoom, so a zoom re-sizes them too — and
  // the room each makes for its name, with the name in it (`writeHaloName`).
  const applyHalos = useCallback((): void => {
    const write = (
      halos: ReadonlyMap<string, NamedHalo>,
      els: ReadonlyMap<string, { g: SVGGElement | null; circle: SVGCircleElement | null; label: SVGGElement | null; text: SVGTextElement | null }>,
      baseline: number,
    ): void => {
      for (const [key, e] of els) {
        const h = halos.get(key);
        if (e.g == null) continue;
        if (h == null) {
          e.g.setAttribute('display', 'none');
          continue;
        }
        e.g.removeAttribute('display');
        e.circle?.setAttribute('cx', h.x.toFixed(1));
        e.circle?.setAttribute('cy', h.y.toFixed(1));
        e.circle?.setAttribute('r', h.r.toFixed(1));
        writeHaloName(e, h, baseline);
        // Too small on screen for a name: hidden at once (placement only runs every few frames).
        if (h.name == null && e.label != null && e.label.getAttribute('data-place') !== 'none') e.label.setAttribute('data-place', 'none');
      }
    };
    if (haloEls.current.size > 0) write(currentHalos(), haloEls.current, 12);
    if (subHaloEls.current.size > 0) write(currentSubHalos(), subHaloEls.current, 11);
    if (personHaloEls.current.size > 0) write(currentPersonHalos(), personHaloEls.current, 11);
  }, [currentHalos, currentSubHalos, currentPersonHalos]);

  const applyView = useCallback((): void => {
    const t = view.current;
    viewRef.current?.setAttribute('transform', `translate(${t.x},${t.y}) scale(${t.k})`);
    const svg = svgRef.current;
    if (svg != null) {
      svg.style.setProperty('--sg-inv', String(1 / t.k));
      svg.style.setProperty('--sg-disc', String(discScale(t.k)));
      svg.style.setProperty('--sg-badge', badgeScale(t.k).toFixed(3));
      svg.setAttribute('data-zoom', t.k < FAR_ZOOM ? 'far' : 'near');
    }
    applyHalos();
    placeLabelsNow();
  }, [applyHalos, placeLabelsNow]);

  const applyPositions = useCallback((): void => {
    for (const [id, el] of nodeEls.current) {
      const n = simNodes.current.get(id);
      if (n?.x == null || n.y == null) continue;
      el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    for (const [id, el] of labelAnchorEls.current) {
      const n = simNodes.current.get(id);
      if (n?.x == null || n.y == null) continue;
      el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    applyHalos();
    const sim = simRef.current;
    if (sim == null) return;
    const links = (sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined)?.links() ?? [];
    for (const l of links) {
      const els = edgeEls.current.get(l.id);
      if (els == null) continue;
      const a = l.source as SimNode;
      const b = l.target as SimNode;
      if (a.x == null || a.y == null || b.x == null || b.y == null) continue;
      const p = edgeEndpoints({ x: a.x, y: a.y, r: a.r + 4 }, { x: b.x, y: b.y, r: b.r + 4 }, l.kind === 'depends_on' ? 2 : 0);
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
  }, [applyHalos, placeLabelsNow]);

  const applyOrbit = useCallback((): void => {
    const deg = ((orbit.current * 180) / Math.PI) % 360;
    for (const el of satEls.current.values()) el.setAttribute('transform', `rotate(${deg.toFixed(2)})`);
  }, []);

  // The open key covers the bottom-left corner: leave it room.
  const fitPad = useCallback(
    (): { x: number; top: number; bottom: number } => ({
      x: Math.min(64, size.current.w * 0.08),
      top: 28,
      bottom: legendOpenRef.current ? 110 : 48,
    }),
    [],
  );

  const fitTarget = useCallback((): ViewTransform => {
    const pts = [...simNodes.current.values()]
      .filter((n) => n.x != null && n.y != null)
      .map((n) => ({ x: n.x as number, y: n.y as number, r: n.r }));
    // Frame what is DRAWN: the visible nodes and their groups' halos, with the room each makes for its
    // name AT THE FITTED ZOOM — which the framing decides, so it is framed twice: once with the room at
    // the layout's zoom, then again with the room at the zoom that gave.
    const at = (k: number): ViewTransform => {
      const all = [...pts];
      for (const h of currentHalos(HALO_LAYOUT_SCALE, k).values()) all.push({ x: h.x, y: h.y, r: h.r });
      return fitTransform(all, size.current.w, size.current.h, fitPad());
    };
    return at(at(HALO_NAME_LAYOUT_ZOOM).k);
  }, [currentHalos, fitPad]);

  // ── The animation loop: runs only while something moves, then stops ─────────────────────────────
  const ensureLoop = useCallback((): void => {
    if (reducedRef.current || running.current) return;
    running.current = true;
    lastT.current = performance.now();
    rafId.current = requestAnimationFrame((t) => frameRef.current(t));
  }, []);
  /** Let the canvas move for `ms` more (the forces and the drift), then still. */
  const wake = useCallback(
    (ms = SETTLE_MS): void => {
      liveUntil.current = Math.max(liveUntil.current, performance.now() + ms);
      ensureLoop();
    },
    [ensureLoop],
  );
  /** Animate the view to `to` (jump, with reduced motion). `touched`: the reader's own framing, so the
   *  view stops following Fit. */
  const animateView = useCallback(
    (to: ViewTransform, touched = true): void => {
      viewTouched.current = touched;
      if (reducedRef.current) {
        viewAnim.current = null;
        view.current = to;
        applyView();
        return;
      }
      viewAnim.current = { from: view.current, to, start: performance.now(), dur: VIEW_MS };
      ensureLoop();
    },
    [applyView, ensureLoop],
  );

  const fit = useCallback((): void => {
    viewAnim.current = null;
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
  // Split: a group's room is the circle round its row of sub-groups.
  const anchors = useMemo(
    () => groupAnchors(groups.map((g) => ({ ...g, radius: splits?.get(g.key)?.r ?? persons?.splits.get(g.key)?.r })), aspect ?? 1),
    [groups, aspect, splits, persons],
  );
  const subAnchors = useMemo(() => (splits != null ? subGroupAnchors(anchors, splits) : new Map<string, { x: number; y: number; r: number }>()), [
    anchors,
    splits,
  ]);
  // Split by assignee: each person room's anchor, inside its status sub-group (or its group).
  const personAnchors = useMemo(
    () => (persons != null ? personRoomAnchors(splits != null ? subAnchors : anchors, persons.splits) : new Map<string, { x: number; y: number; r: number }>()),
    [persons, splits, subAnchors, anchors],
  );
  const groupSize = useMemo(() => new Map(groups.map((g) => [g.key, g.drawn])), [groups]);
  const layoutMode = `${groupMode}${splits != null ? ':split' : ''}${persons != null ? ':person' : ''}`;
  const lastMode = useRef<string | null>(null);
  const lastIntent = useRef<string | null>(null);
  const grouping = useMemo(
    () =>
      `${aspect == null ? '?' : 'm'}#${layoutMode}#${[...anchors].map(([k, a]) => `${k}:${a.x},${a.y}`).join('|')}#${[...subAnchors]
        .map(([k, a]) => `${k}:${a.x},${a.y}`)
        .join('|')}#${[...personAnchors].map(([k, a]) => `${k}:${a.x},${a.y}`).join('|')}#${nodes
        .map((n) => `${n.ident}=${groupOf.get(n.ident) ?? ''}/${subOf(n.ident, n.stage) ?? ''}/${personRoomOf(n.ident) ?? ''}`)
        .join('|')}`,
    [layoutMode, anchors, subAnchors, personAnchors, nodes, groupOf, subOf, personRoomOf, aspect],
  );

  useLayoutEffect(() => {
    // Wait for the canvas's measured shape: the group anchors are laid out in it.
    if (aspect == null) return;
    const prev = simNodes.current;
    const first = prev.size === 0;
    // A new grouping is a new arrangement: the view follows Fit again while it settles, and the
    // tickets start from their new groups (not from the old arrangement, which would have to pass
    // through itself and could jam).
    const modeChanged = lastMode.current != null && lastMode.current !== layoutMode;
    // Data-driven (not first, not a reader choice): hold every ticket already drawn in place.
    // (A resize that changes the canvas's shape re-lays the groups, so it still animates.)
    const intent = `${layoutIntent}@${aspect}`;
    const quiet = !first && !modeChanged && lastIntent.current === intent;
    lastIntent.current = intent;
    if (modeChanged) viewTouched.current = false;
    lastMode.current = layoutMode;
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
    // Sunflower seeds inside each group's (or sub-group's) anchor (a new grouping, or a ticket new to
    // the canvas).
    const seatInGroup = new Map<string, number>();
    const groupCount = new Map<string, number>();
    for (const n of nodes) {
      const g = (grouped ? personRoomOf(n.ident) : null) ?? subOf(n.ident, n.stage) ?? groupOf.get(n.ident);
      if (g == null) continue;
      seatInGroup.set(n.ident, groupCount.get(g) ?? 0);
      groupCount.set(g, (groupCount.get(g) ?? 0) + 1);
    }
    const fresh = new Map<string, SimNode>();
    nodes.forEach((n, i) => {
      const old = modeChanged ? undefined : prev.get(n.ident);
      const pin = pins.current[n.ident];
      const group = groupOf.get(n.ident) ?? null;
      const sub = grouped ? subOf(n.ident, n.stage) : null;
      const person = grouped ? personRoomOf(n.ident) : null;
      const seat = person ?? sub ?? group;
      const anchor =
        person != null ? personAnchors.get(person) : sub != null ? subAnchors.get(sub) : group != null ? anchors.get(group) : undefined;
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
          const rr = anchor.r * 0.8 * Math.sqrt((j + 0.5) / Math.max(1, groupCount.get(seat as string) ?? 1));
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
        sub,
        person,
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
    const anchorOf = (d: SimNode): { x: number; y: number } | undefined =>
      d.person != null
        ? personAnchors.get(d.person)
        : d.sub != null
          ? subAnchors.get(d.sub)
          : d.group != null
            ? anchors.get(d.group)
            : undefined;
    // The room a ticket shares: its person room, else its status sub-group, else its group.
    const roomOf = (d: SimNode): string | null => d.person ?? d.sub ?? d.group;
    const split = (d: SimNode): boolean => d.sub != null || d.person != null;

    const sim = forceSimulation<SimNode, SimLink>([...fresh.values()])
      .force(
        'link',
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) => 56 + (l.source as SimNode).r + (l.target as SimNode).r)
          // Grouped: a link BETWEEN groups pulls lightly, so the clusters hold and the line crosses. Split
          // by status, a link between two statuses of ONE group pulls more lightly still the more links its
          // busier end has, so a hub ticket's many links cannot drag it out of its own status.
          .strength((l) => {
            const a = l.source as SimNode;
            const b = l.target as SimNode;
            if (!grouped || roomOf(a) === roomOf(b)) return l.kind === 'depends_on' ? 0.5 : 0.25;
            if (split(a) && a.group === b.group) return 0.03 * Math.min(1, 2 / Math.max(1, a.degree, b.degree));
            return 0.03;
          }),
      )
      .force('charge', forceManyBody<SimNode>().strength((d) => -90 - d.r * 5).distanceMax(grouped ? 260 : 500))
      .force(
        'collide',
        forceCollide<SimNode>(
          (d) =>
            d.r +
            collidePadding(
              grouped,
              d.person != null
                ? personSize.get(d.person) ?? 1
                : d.sub != null
                  ? subSize.get(d.sub) ?? 1
                  : d.group != null
                    ? groupSize.get(d.group) ?? 1
                    : 1,
            ),
        ).strength(0.9),
      )
      .force(
        'x',
        forceX<SimNode>((d) => anchorOf(d)?.x ?? 0).strength((d) =>
          grouped ? (anchorOf(d) != null ? (d.person != null ? 0.14 : d.sub != null ? 0.12 : 0.1) : 0.02) : d.degree > 0 ? 0.045 : 0,
        ),
      )
      .force(
        'y',
        forceY<SimNode>((d) => anchorOf(d)?.y ?? 0).strength((d) =>
          grouped ? (anchorOf(d) != null ? (d.person != null ? 0.14 : d.sub != null ? 0.12 : 0.1) : 0.02) : d.degree > 0 ? 0.045 : 0,
        ),
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
        const halos = currentHalos(HALO_LAYOUT_SCALE, HALO_NAME_LAYOUT_ZOOM, HALO_SUBNAME_LAYOUT_ZOOM);
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
    // Split by status: the sub-halos inside one group are pushed apart the same way, each sub-group as a
    // whole (only against its own group's others — the group halos already keep the groups apart).
    if (grouped && splits != null) {
      sim.force('separate-subs', () => {
        const byGroup = new Map<string, Map<string, { x: number; y: number; r: number }>>();
        for (const [k, h] of currentSubHalos(HALO_LAYOUT_SCALE, HALO_SUBNAME_LAYOUT_ZOOM)) {
          let m = byGroup.get(h.group);
          if (m == null) {
            m = new Map();
            byGroup.set(h.group, m);
          }
          m.set(k, h);
        }
        const push = new Map<string, { dx: number; dy: number }>();
        for (const m of byGroup.values()) {
          if (m.size < 2) continue;
          for (const [k, p] of haloSeparation(m, 16)) push.set(k, p);
        }
        if (push.size === 0) return;
        for (const n of fresh.values()) {
          if (n.sub == null || n.fx != null) continue;
          const p = push.get(n.sub);
          if (p == null) continue;
          n.vx = (n.vx ?? 0) + p.dx * 0.06;
          n.vy = (n.vy ?? 0) + p.dy * 0.06;
        }
      });
    }
    // Split by assignee: the person halos inside one room (a status sub-group, else the group) are pushed
    // apart the same way, each person room as a whole.
    if (grouped && persons != null) {
      sim.force('separate-people', () => {
        const byParent = new Map<string, Map<string, { x: number; y: number; r: number }>>();
        for (const [k, h] of currentPersonHalos(HALO_LAYOUT_SCALE, HALO_SUBNAME_LAYOUT_ZOOM)) {
          let m = byParent.get(h.parent);
          if (m == null) {
            m = new Map();
            byParent.set(h.parent, m);
          }
          m.set(k, h);
        }
        const push = new Map<string, { dx: number; dy: number }>();
        for (const m of byParent.values()) {
          if (m.size < 2) continue;
          for (const [k, p] of haloSeparation(m, 12)) push.set(k, p);
        }
        if (push.size === 0) return;
        for (const n of fresh.values()) {
          if (n.person == null || n.fx != null) continue;
          const p = push.get(n.person);
          if (p == null) continue;
          n.vx = (n.vx ?? 0) + p.dx * 0.06;
          n.vy = (n.vy ?? 0) + p.dy * 0.06;
        }
      });
    }
    // Every layout is computed to rest before it is shown, then ANIMATED in: on first load from another
    // grouping (`introGroupMode`), on a re-layout from where each ticket was. Reduced motion: it appears.
    const animate = !reducedRef.current && !quiet;
    const from = new Map<string, { x: number; y: number }>();
    if (first) {
      const introMode = introGroupMode(groupMode, nodes.some((n) => !n.ghost && n.theme != null));
      const introGroupOf = assignGroups(nodes, edges, introMode);
      const introAnchors = groupAnchors(groupList(nodes, introGroupOf, introMode), aspect);
      const seeds = introSeeds(
        nodes.map((n) => n.ident),
        introGroupOf,
        introAnchors,
      );
      for (const [id, n] of fresh) {
        // A pinned ticket stays where it was pinned.
        from.set(id, n.fx != null && n.fy != null ? { x: n.fx, y: n.fy } : seeds.get(id) ?? { x: n.x as number, y: n.y as number });
      }
    } else {
      for (const [id, n] of fresh) {
        const old = prev.get(id);
        from.set(id, old?.x != null && old.y != null ? { x: old.x, y: old.y } : { x: n.x as number, y: n.y as number });
      }
    }
    // Quiet: the tickets already drawn are held where they are while only new ones find a place.
    const held: SimNode[] = [];
    if (quiet) {
      for (const [id, n] of fresh) {
        if (n.fx != null || !prev.has(id)) continue;
        n.fx = n.x;
        n.fy = n.y;
        held.push(n);
      }
    }
    sim.alpha(first || modeChanged ? 1 : quiet ? 0.3 : 0.7);
    for (let i = 0; i < (first ? 420 : quiet ? 120 : 320); i += 1) sim.tick();
    for (const n of held) {
      n.fx = null;
      n.fy = null;
    }
    for (const n of fresh.values()) {
      n.vx = 0;
      n.vy = 0;
    }
    sim.alpha(0.02).alphaTarget(0);
    // The drift: a slow rotation about the centre, for the few seconds the canvas moves (`drift` fades it).
    sim.force('drift', () => {
      const k = drift.current;
      if (k <= 0) return;
      for (const n of fresh.values()) {
        if (n.fx != null || n.x == null || n.y == null) continue;
        n.vx = (n.vx ?? 0) - n.y * DRIFT_ROTATION * 0.4 * k;
        n.vy = (n.vy ?? 0) + n.x * DRIFT_ROTATION * 0.4 * k;
      }
    });
    simRef.current = sim;
    viewAnim.current = null;
    if (animate) {
      const to = new Map<string, { x: number; y: number }>();
      for (const [id, n] of fresh) to.set(id, { x: n.x as number, y: n.y as number });
      // Where the view ends: Fit over the landed layout (unless the reader framed it themselves).
      const viewTo = first || !viewTouched.current ? fitTarget() : null;
      for (const [id, n] of fresh) {
        const f = from.get(id);
        if (f == null) continue;
        n.x = f.x;
        n.y = f.y;
      }
      // The opening animation starts framed on where the tickets start.
      const viewFrom = first
        ? fitTransform(
            [...from.entries()].map(([id, p]) => ({ ...p, r: fresh.get(id)?.r ?? 10 })),
            size.current.w,
            size.current.h,
            fitPad(),
          )
        : view.current;
      if (first) {
        viewTouched.current = false;
        view.current = viewFrom;
        applyView();
      }
      tween.current = { from, to, start: performance.now(), dur: first ? INTRO_MS : RELAYOUT_MS, viewFrom, viewTo, fadeHalos: first || modeChanged };
      if (tween.current.fadeHalos && haloLayerRef.current != null) haloLayerRef.current.style.opacity = '0';
      applyPositions();
      wake(SETTLE_MS);
    } else {
      tween.current = null;
      if (haloLayerRef.current != null) haloLayerRef.current.style.opacity = '';
      applyPositions();
      if (first || (!quiet && !viewTouched.current)) fit();
      else if (quiet) placeLabelsNow();
      runPendingFrame();
    }
    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt on STRUCTURE / GROUPING, not on every refetch
  }, [structure, grouping, pinKey]);

  // Promoting a label (hover, focus, selection) or fading one (a filter) re-decides who shows.
  useEffect(() => {
    placeLabelsNow();
  }, [placeLabelsNow, hoverNode, focusId, selected, passes, focusSet, groupMode]);

  // ── The loop: one frame of whatever is moving; it stops itself when nothing is ───────────────────
  frameRef.current = (t: number): void => {
    const dt = Math.min(0.1, Math.max(0, (t - lastT.current) / 1000));
    lastT.current = t;
    let moved = false;
    const tw = tween.current;
    if (tw != null) {
      // A layout animating in: every ticket eases from where it was to where it lands; the forces wait.
      const p = (t - tw.start) / tw.dur;
      const e = easeInOut(p);
      for (const [id, n] of simNodes.current) {
        const a = tw.from.get(id);
        const b = tw.to.get(id);
        if (a == null || b == null) continue;
        n.x = a.x + (b.x - a.x) * e;
        n.y = a.y + (b.y - a.y) * e;
        n.vx = 0;
        n.vy = 0;
      }
      // The halos appear as the tickets arrive (the last 40%): mid-flight they would ring the whole canvas.
      if (tw.fadeHalos && haloLayerRef.current != null) {
        haloLayerRef.current.style.opacity = p >= 1 ? '' : (Math.max(0, (e - 0.6) / 0.4) ** 2).toFixed(3);
      }
      if (tw.viewFrom != null && tw.viewTo != null && !viewTouched.current && viewAnim.current == null) {
        view.current = lerpView(tw.viewFrom, tw.viewTo, e);
        applyView();
      }
      if (p >= 1) {
        tween.current = null;
        runPendingFrame();
      }
      moved = true;
    } else if (t < liveUntil.current && !frozen.current) {
      // The settling seconds: the forces finish, and the drift turns the graph (not under the pointer).
      drift.current = pointerInside.current ? 0 : driftScale(t, liveUntil.current);
      simRef.current?.tick();
      moved = true;
    }
    if (moved) {
      orbit.current += dt * ORBIT_SPEED;
      applyPositions();
      applyOrbit();
      // After a layout lands, an untouched view eases toward Fit while the forces finish.
      if (tw == null && !viewTouched.current && viewAnim.current == null && size.current.w > 0) {
        view.current = lerpView(view.current, fitTarget(), 0.06);
        applyView();
      }
    }
    const va = viewAnim.current;
    if (va != null) {
      const p = (t - va.start) / va.dur;
      view.current = lerpView(va.from, va.to, easeInOut(p));
      applyView();
      if (p >= 1) viewAnim.current = null;
    }
    if (tween.current != null || viewAnim.current != null || t < liveUntil.current) {
      rafId.current = requestAnimationFrame((tt) => frameRef.current(tt));
    } else {
      // Still: nothing moves until the next load, re-layout, drag or framing.
      running.current = false;
      drift.current = 0;
      placeLabelsNow();
    }
  };

  // Reduced motion switched on mid-animation: jump to the end and stop. (Unmount: stop, below.)
  useEffect(() => {
    if (reducedMotion) {
      cancelAnimationFrame(rafId.current);
      running.current = false;
      liveUntil.current = 0;
      const tw = tween.current;
      if (tw != null) {
        for (const [id, n] of simNodes.current) {
          const b = tw.to.get(id);
          if (b != null) {
            n.x = b.x;
            n.y = b.y;
          }
        }
        if (tw.viewTo != null && !viewTouched.current) view.current = tw.viewTo;
        tween.current = null;
        runPendingFrame();
      }
      if (viewAnim.current != null) {
        view.current = viewAnim.current.to;
        viewAnim.current = null;
      }
      if (haloLayerRef.current != null) haloLayerRef.current.style.opacity = '';
      applyPositions();
      applyOrbit();
      applyView();
    }
  }, [reducedMotion, applyPositions, applyOrbit, applyView]);
  useEffect(
    () => () => {
      cancelAnimationFrame(rafId.current);
      running.current = false;
    },
    [],
  );

  // ── Framing a set of tickets (a ticket opened, a filter picked) ────────────────────────────────
  const frameTarget = useCallback(
    (ids: ReadonlySet<string>, besideDrawer: boolean, extra: ReadonlyArray<{ x: number; y: number; r: number }> = []): ViewTransform | null => {
      const tw = tween.current;
      const pts: Array<{ x: number; y: number; r: number }> = [...extra];
      for (const id of ids) {
        const n = simNodes.current.get(id);
        // Mid-animation, frame where the ticket LANDS.
        const p = tw?.to.get(id) ?? (n?.x != null && n.y != null ? { x: n.x, y: n.y } : null);
        if (n == null || p == null) continue;
        pts.push({ x: p.x, y: p.y, r: n.r + 8 });
      }
      const b = boundsOf(pts);
      const wrap = wrapRef.current;
      if (b == null || wrap == null || size.current.w <= 0) return null;
      const rect = wrap.getBoundingClientRect();
      let coverLeft: number | null = null;
      if (besideDrawer) {
        const panel = document.querySelector<HTMLElement>('[data-testid="sprint-drawer"] [role="dialog"]');
        const w = panel?.getBoundingClientRect().width ?? Math.min(window.innerWidth, DRAWER_MAX_PX);
        coverLeft = window.innerWidth - w;
      }
      const span = uncoveredSpan({ left: rect.left, width: rect.width }, coverLeft);
      const pad = fitPad();
      // Side room for the ticket names (drawn at a fixed screen size beside their circles).
      const padX = Math.min(150, (span.x1 - span.x0) / 4);
      return fitBoxIn(b, span, size.current.h, { x: padX, top: 44, bottom: pad.bottom }, FRAME_ZOOM_MAX);
    },
    [fitPad],
  );
  const frameIdents = useCallback(
    (ids: ReadonlySet<string>, besideDrawer: boolean, extra: ReadonlyArray<{ x: number; y: number; r: number }> = []): void => {
      const t = frameTarget(ids, besideDrawer, extra);
      if (t != null) animateView(t);
    },
    [animateView, frameTarget],
  );

  // A ticket opened (click, Enter, a link in the drawer): it and its linked tickets, beside the drawer.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;
  useEffect(() => {
    const id = selectedRef.current;
    if (frameRequest === 0 || id == null || !simNodes.current.has(id)) return;
    frameIdents(withNeighbours(edgesRef.current, [id]), drawerOpenRef.current);
  }, [frameRequest, frameIdents]);

  // An epic or theme picked in the filter: its tickets and their linked tickets. Cleared: Fit.
  const groupFilter = filters.theme ?? filters.epic;
  const lastGroupFilter = useRef(groupFilter);
  useEffect(() => {
    if (lastGroupFilter.current === groupFilter) return;
    lastGroupFilter.current = groupFilter;
    pendingFrame.current = null;
    if (groupFilter == null) {
      // A grouping switch cleared it: the re-layout's own view tween already ends on Fit over the
      // LANDED layout — a second animation measured now would read the old positions and fight it.
      if (tween.current != null && !viewTouched.current) return;
      const toFit = (): void => animateView(fitTarget(), false);
      if (tween.current != null) pendingFrame.current = toFit;
      else toFit();
      return;
    }
    const ids = nodes.filter((n) => passes.get(n.ident) === true).map((n) => n.ident);
    if (ids.length === 0) return;
    // The picked epic / theme is a group on screen (the picker follows the grouping): frame its halo,
    // with its name inside it — measured once the layout has landed. (Zooming in only shrinks the room the
    // name needs, so the halo measured now holds the one drawn at the framed zoom.)
    // The room the halo makes for its name depends on the zoom the framing picks: framed with the room
    // at the closest zoom, then again with the room at the zoom that gave (as Fit does).
    const frame = (): void => {
      const want = withNeighbours(edges, ids);
      const haloAt = (k: number): Array<{ x: number; y: number; r: number }> => {
        const h = currentHalos(discScale(k), k).get(groupFilter);
        return h != null ? [{ x: h.x, y: h.y, r: h.r }] : [];
      };
      const first = frameTarget(want, false, haloAt(FRAME_ZOOM_MAX));
      if (first == null) return;
      const t = frameTarget(want, false, haloAt(first.k)) ?? first;
      animateView(t);
    };
    if (tween.current != null) pendingFrame.current = frame;
    else frame();
  }, [groupFilter, nodes, edges, passes, frameTarget, animateView, fitTarget, currentHalos]);

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

  // ── Wheel: zooms about the pointer (a pinch arrives as Ctrl + wheel and zooms the same way) ───────
  // A native listener, because React's wheel listener is passive (it could not stop the page scroll).
  useEffect(() => {
    const svg = svgRef.current;
    if (svg == null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      viewTouched.current = true;
      viewAnim.current = null;
      pendingFrame.current = null;
      view.current = zoomAbout(view.current, wheelZoomFactor(e.deltaY, e.deltaMode), e.clientX - rect.left, e.clientY - rect.top);
      applyView();
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
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
    viewAnim.current = null;
    pendingFrame.current = null;
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
        viewAnim.current = null;
        pendingFrame.current = null;
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
      viewAnim.current = null;
      pendingFrame.current = null;
      view.current = { ...view.current, x: g.vx + dx, y: g.vy + dy };
      applyView();
      return;
    }
    const n = g.id != null ? simNodes.current.get(g.id) : undefined;
    if (n == null) return;
    if (dragging.current == null) {
      dragging.current = n.id;
      setHover(null);
      wake(SETTLE_MS);
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
    // The neighbours settle round the pinned ticket for a few seconds, then the canvas stills again.
    const sim = simRef.current;
    if (sim != null) sim.alpha(Math.max(sim.alpha(), 0.1));
    wake(SETTLE_MS);
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
    registerLabelAnchor: (id: string, el: SVGGElement | null): void => {
      if (el == null) labelAnchorEls.current.delete(id);
      else {
        labelAnchorEls.current.set(id, el);
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
  const registerSubHalo = useCallback(
    (key: string, part: 'g' | 'circle' | 'label' | 'text', el: SVGGElement | SVGCircleElement | SVGTextElement | null): void => {
      const cur = subHaloEls.current.get(key) ?? { g: null, circle: null, label: null, text: null };
      if (part === 'circle') cur.circle = el as SVGCircleElement | null;
      else if (part === 'text') cur.text = el as SVGTextElement | null;
      else cur[part] = el as SVGGElement | null;
      if (cur.g == null && cur.circle == null && cur.label == null && cur.text == null) {
        subHaloEls.current.delete(key);
      } else subHaloEls.current.set(key, cur);
    },
    [],
  );
  const registerPersonHalo = useCallback(
    (key: string, part: 'g' | 'circle' | 'label' | 'text', el: SVGGElement | SVGCircleElement | SVGTextElement | null): void => {
      const cur = personHaloEls.current.get(key) ?? { g: null, circle: null, label: null, text: null };
      if (part === 'circle') cur.circle = el as SVGCircleElement | null;
      else if (part === 'text') cur.text = el as SVGTextElement | null;
      else cur[part] = el as SVGGElement | null;
      if (cur.g == null && cur.circle == null && cur.label == null && cur.text == null) {
        personHaloEls.current.delete(key);
      } else personHaloEls.current.set(key, cur);
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
  // The label layer's order: the promoted labels last (drawn on top).
  const labelOrder = useMemo(() => {
    const top = [selected, focusId, hoverNode].filter((x): x is string => x != null);
    if (top.length === 0) return nodes;
    const set = new Set(top);
    return [...nodes.filter((n) => !set.has(n.ident)), ...top.flatMap((id) => (byId.get(id) != null ? [byId.get(id) as SprintGraphNode] : []))].filter(
      (n, i, a) => a.findIndex((m) => m.ident === n.ident) === i,
    );
  }, [nodes, byId, selected, focusId, hoverNode]);
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
      {/* The star field: never zoomed or panned. Two layers drift sideways at different speeds, by a
          CSS transform animation only (index.css `.sg-stars`), so the browser's compositor slides two
          already-drawn layers — no JS, no layout, no repaint per frame. Each layer is two canvases
          wide with its stars drawn twice (x and x + 1), so the -50% loop is seamless. */}
      {STAR_LAYERS.map((layer, li) => (
        <div key={li} aria-hidden="true" className={`sg-stars sg-stars-${li} pointer-events-none absolute inset-y-0 left-0`}>
          <svg className="h-full w-full">
            {layer.flatMap((s, i) =>
              [0, 1].map((copy) => (
                <circle
                  key={`${i}-${copy}`}
                  cx={`${((s.x + copy) * 50).toFixed(2)}%`}
                  cy={`${(s.y * 100).toFixed(2)}%`}
                  r={s.r}
                  fill="#ffffff"
                  opacity={s.o}
                />
              )),
            )}
          </svg>
        </div>
      ))}

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
            <g ref={haloLayerRef} pointerEvents="none" aria-hidden="true">
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
                  <g ref={(el) => registerHalo(g.key, 'label', el)} className="sg-group-name" data-place="none">
                    <g className="sg-group-label">
                      <text
                        ref={(el) => registerHalo(g.key, 'text', el)}
                        y={12}
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
              {/* Split by status: a faint halo per status inside each group, tinted with its ring colour. */}
              {splits != null &&
                [...splits].flatMap(([g, split]) =>
                  [...split.subs.keys()].map((slot) => {
                    const key = subGroupKey(g, slot);
                    const c = subHaloColour(slot);
                    return (
                      <g key={`${layoutMode}:${key}`} ref={(el) => registerSubHalo(key, 'g', el)} display="none">
                        <circle
                          ref={(el) => registerSubHalo(key, 'circle', el)}
                          fill={c}
                          fillOpacity={SUB_HALO.fillAlpha}
                          stroke={c}
                          strokeOpacity={SUB_HALO.strokeAlpha}
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                        <g ref={(el) => registerSubHalo(key, 'label', el)} className="sg-group-name" data-place="none">
                          <g className="sg-group-label">
                            <text
                              ref={(el) => registerSubHalo(key, 'text', el)}
                              y={11}
                              textAnchor="middle"
                              fontSize={11}
                              fontWeight={600}
                              fill={subLabelColour(slot)}
                              stroke={SPRINT_CANVAS.groundEdge}
                              strokeWidth={3}
                              paintOrder="stroke"
                            >
                              {STATUS_SLOT_LABEL[slot]}
                            </text>
                          </g>
                        </g>
                      </g>
                    );
                  }),
                )}
              {/* Split by assignee: a faint neutral halo per person inside each group or status, named. */}
              {persons != null &&
                [...persons.splits].flatMap(([parent, split]) =>
                  [...split.subs.keys()].map((person) => {
                    const key = personRoomKey(parent, person);
                    return (
                      <g
                        key={`${layoutMode}:${key}`}
                        ref={(el) => registerPersonHalo(key, 'g', el)}
                        display="none"
                        data-sg-person-room={parent}
                      >
                        <circle
                          ref={(el) => registerPersonHalo(key, 'circle', el)}
                          fill={PERSON_HALO.fill}
                          fillOpacity={PERSON_HALO.fillAlpha}
                          stroke={PERSON_HALO.stroke}
                          strokeOpacity={PERSON_HALO.strokeAlpha}
                          strokeWidth={1}
                          vectorEffect="non-scaling-stroke"
                        />
                        <g ref={(el) => registerPersonHalo(key, 'label', el)} className="sg-group-name" data-place="none">
                          <g className="sg-group-label">
                            <text
                              ref={(el) => registerPersonHalo(key, 'text', el)}
                              y={11}
                              textAnchor="middle"
                              fontSize={11}
                              fontWeight={600}
                              fill={PERSON_HALO.label}
                              stroke={SPRINT_CANVAS.groundEdge}
                              strokeWidth={3}
                              paintOrder="stroke"
                            >
                              {truncateLabel(persons.labels.get(person) ?? person, PERSON_LABEL_MAX)}
                            </text>
                          </g>
                        </g>
                      </g>
                    );
                  }),
                )}
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
          {/* THE LABEL LAYER: above every disc, so a label is never under a ticket. A hovered, focused or
              selected ticket's label is drawn LAST (on top) — raised, never moved. */}
          <g pointerEvents="none">
            {labelOrder.map((n) => {
              const ok = passes.get(n.ident) !== false;
              const inFocus = focusSet == null || focusSet.has(n.ident);
              return (
                <LabelView
                  key={n.ident}
                  node={n}
                  opacity={!ok ? FILTERED_OPACITY : !inFocus ? DIMMED_OPACITY : labelOpacity(n)}
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

      {/* Canvas controls, top right. */}
      <div className="absolute right-2 top-2 flex items-center gap-1">
        <CanvasButton label="Zoom in" onClick={() => zoomBy(1.25)}>
          <PlusIcon size={12} />
        </CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => zoomBy(0.8)}>
          <MinusIcon size={12} />
        </CanvasButton>
        <CanvasButton
          onClick={() => {
            pendingFrame.current = null;
            fit();
          }}
        >
          Fit
        </CanvasButton>
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
  registerLabelAnchor: (id: string, el: SVGGElement | null) => void;
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
  glow,
  selected,
  focusable,
  avatarFailed,
  dimmed,
  handlers,
}: {
  node: SprintGraphNode;
  bodyOpacity: number;
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
  const orbitR = r + 7;
  const avatarUrl = safeExternalUrl(n.assignee?.avatarUrl ?? null) ?? null;
  const showAvatar = !n.ghost && n.assignee != null;
  const ar = BADGE_R;
  // The badge's anchor: the disc's top-right rim; it grows OUTWARD from there (`badgeCentre`).
  const rim = r * Math.SQRT1_2;
  const off = ar * 0.45;
  const gs = glyphSize(r);
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
        {/* The disc: an opaque fill (a dark tint of its status) so lines pass BEHIND the ticket, the
            status ring around it, and the status's centre mark — status is colour AND shape. */}
        <circle
          r={r}
          fill={discFill(n.stage, n.ghost)}
          stroke={ring}
          strokeWidth={ringWidth(n.ghost, selected)}
          strokeDasharray={n.ghost ? '3 2.5' : undefined}
          filter={glow && !dimmed ? 'url(#sg-glow)' : undefined}
        />
        <g transform={`translate(${(-gs / 2).toFixed(1)},${(-gs / 2).toFixed(1)})`} color={glyphColour(n.stage)} aria-hidden="true">
          <StatusMark glyph={statusGlyph(n.stage)} size={gs} />
        </g>
        {sats.length > 0 && (
          <g ref={(el) => handlers.registerSat(n.ident, el)}>
            {sats.map((s) => (
              <circle
                key={s.prId}
                cx={Math.cos(s.angle) * orbitR}
                cy={Math.sin(s.angle) * orbitR}
                r={2.8}
                fill={SATELLITE_FILL[s.kind]}
                stroke={s.failing ? SATELLITE_FAILING_RING : DISC_GROUND}
                strokeWidth={s.failing ? 1.4 : 0.6}
              />
            ))}
          </g>
        )}
        {showAvatar && (
          <g transform={`translate(${rim.toFixed(1)},${(-rim).toFixed(1)})`}>
            {/* Counter-scaled when zoomed out (CSS `--sg-badge`), so the person stays readable. */}
            <g className="sg-badge">
              <g transform={`translate(${off.toFixed(1)},${(-off).toFixed(1)})`}>
                <circle r={ar + 1} fill={DISC_GROUND} stroke={ring} strokeWidth={1.5} />
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
                  <text textAnchor="middle" dy="0.35em" fontSize={9} fontWeight={700} fill={SPRINT_CANVAS.labelKey}>
                    {initialsOf(n.assignee?.name ?? '')}
                  </text>
                )}
              </g>
            </g>
          </g>
        )}
        {/* The keyboard focus ring (CSS shows it on :focus-visible). */}
        <circle className="sg-focus" r={r + 6} fill="none" stroke="#f8fafc" strokeWidth={1.5} strokeDasharray="2 2" />
      </g>
    </g>
  );
});

/** A status's centre mark (Icons.tsx), sized in layout units. */
function StatusMark({ glyph, size }: { glyph: StatusGlyph; size: number }): JSX.Element {
  switch (glyph) {
    case 'ring':
      return <StageNotStartedIcon size={size} />;
    case 'half':
      return <StageInProgressIcon size={size} />;
    case 'eye':
      return <EyeIcon size={size} />;
    case 'tick':
      return <CheckIcon size={size} />;
    case 'question':
      return <QuestionIcon size={size} />;
  }
}

/** A ticket's label in the LABEL LAYER: positioned on its ticket by the rAF loop (`registerLabelAnchor`),
 *  its side written as CSS variables by `placeLabelsNow`. Kept the SAME SIZE on screen at any zoom (CSS
 *  scales it by 1/zoom, `--sg-inv`); zoomed far out, only the key shows (`data-zoom="far"`).
 *  ⚠ The refs are STABLE: a ref callback re-run on every render passes null first, which dropped the
 *  label's remembered side — so a hover re-render made it jump. */
const LabelView = memo(function LabelView({
  node: n,
  opacity,
  handlers,
}: {
  node: SprintGraphNode;
  opacity: number;
  handlers: Handlers;
}): JSX.Element {
  const r = nodeRadius(n.degree, n.ghost);
  const id = n.ident;
  const anchorRef = useCallback((el: SVGGElement | null) => handlers.registerLabelAnchor(id, el), [handlers, id]);
  const labelRef = useCallback((el: SVGGElement | null) => handlers.registerLabel(id, el), [handlers, id]);
  return (
    <g ref={anchorRef}>
      <g opacity={opacity}>
        <g ref={labelRef} data-sg-label={id} className="sg-label" style={{ '--r': drawnRadius(r, 1) } as CSSProperties}>
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
        {n.stage != null && n.stage !== 'done' && n.status?.name !== SPRINT_STAGE_LABEL[n.stage] && ` · ${SPRINT_STAGE_LABEL[n.stage]}`}
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
                <svg width="18" height="18" aria-hidden="true">
                  <circle cx="9" cy="9" r="7.5" fill={discFill(s, false)} stroke={stageRing(s)} strokeWidth="2.5" />
                  <g transform="translate(4,4)" color={glyphColour(s)}>
                    <StatusMark glyph={statusGlyph(s)} size={10} />
                  </g>
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
