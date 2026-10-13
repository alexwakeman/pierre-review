import type {
  SprintReferenceRelation,
  SprintTicketReference,
  SprintEdgeKind,
  SprintGraphEdge,
  SprintGraphNode,
  SprintGraphPr,
  SprintStage,
} from '@pierre-review/shared';
import { SPRINT_EDGE_LABEL, SPRINT_STAGE_LABEL, SPRINT_STAGES, STORY_REFERENCE_RELATION_LABEL, isSprintEdgeRelation } from '@pierre-review/shared';

// Reports → This sprint as a GRAPH: the pure folds behind SprintGraph.tsx (test/sprintGraphModel.test.ts).
// Sizes, colours, which nodes a filter or a selection keeps, edge styling, label truncation and the
// pinned-position store. Nothing here ranks tickets or people.
//
// ⚠ THE CANVAS IS ALWAYS DEEP NAVY, in both themes, so every colour here is chosen for THAT ground and
// none of them goes through the page's light/dark tokens. The label colours are measured against the
// canvas's LIGHTEST point (the gradient's centre) by test/textContrast.test.ts.

// ── The canvas ───────────────────────────────────────────────────────────────────────────────────

export const SPRINT_CANVAS = {
  /** The radial gradient: centre → edge. The centre is the lightest ground a label can sit on. */
  groundCentre: '#0f1b3d',
  groundEdge: '#050a1a',
  /** A ticket's key (bold) and its title. */
  labelKey: '#f1f5f9',
  labelTitle: '#cbd5e1',
  /** The lowest opacity a LEGIBLE label is drawn at (a done or a ghost ticket); dimming by a filter or
   *  a selection goes lower on purpose — that text is set aside, not meant to be read. */
  labelMinAlpha: 0.8,
  /** The legend's and tooltip's text. */
  legendText: '#e2e8f0',
} as const;

/** Blend a foreground over the ground at an opacity — the colour a reader actually sees. */
export function blendHex(fg: string, bg: string, alpha: number): string {
  const p = (h: string, i: number): number => parseInt(h.replace('#', '').slice(i, i + 2), 16);
  const ch = (i: number): string =>
    Math.round(p(fg, i) * alpha + p(bg, i) * (1 - alpha))
      .toString(16)
      .padStart(2, '0');
  return `#${ch(0)}${ch(2)}${ch(4)}`;
}

// ── Nodes ────────────────────────────────────────────────────────────────────────────────────────

export const NODE_RADIUS_MIN = 9;
export const NODE_RADIUS_MAX = 26;
export const GHOST_RADIUS_MIN = 6;

/** A node's radius: by its number of links (degree), square-root so a hub does not swamp the page. */
export function nodeRadius(degree: number, ghost: boolean): number {
  const d = Math.max(0, Number.isFinite(degree) ? degree : 0);
  const r = Math.min(NODE_RADIUS_MAX, NODE_RADIUS_MIN + 4 * Math.sqrt(d));
  return ghost ? Math.max(GHOST_RADIUS_MIN, Math.round(r * 0.7 * 10) / 10) : r;
}

/** The ring colour per stage (four hues on navy); an unknown stage is slate. */
export const STAGE_RING: Record<SprintStage, string> = {
  not_started: '#94a3b8',
  in_progress: '#38bdf8',
  in_review: '#fbbf24',
  done: '#34d399',
};
export const STAGE_RING_UNKNOWN = '#64748b';

export function stageRing(stage: SprintStage | null): string {
  return stage == null ? STAGE_RING_UNKNOWN : STAGE_RING[stage];
}

/** How bright a node is drawn when nothing dims it: Done fades; a ghost fades with its depth. */
export function nodeBaseOpacity(n: Pick<SprintGraphNode, 'ghost' | 'depth' | 'stage'>): number {
  let o = 1;
  if (n.stage === 'done') o *= 0.55;
  if (n.ghost) o *= n.depth <= 1 ? 0.6 : n.depth === 2 ? 0.45 : 0.35;
  return Math.round(o * 1000) / 1000;
}

/** The label's opacity: never below `labelMinAlpha` while the node is shown (legible on the canvas). */
export function labelOpacity(n: Pick<SprintGraphNode, 'ghost' | 'depth' | 'stage'>): number {
  return n.stage === 'done' || n.ghost ? SPRINT_CANVAS.labelMinAlpha : 1;
}

/** Opacity of a node / label set aside by a filter, and of one outside the selection's neighbourhood. */
export const FILTERED_OPACITY = 0.07;
export const DIMMED_OPACITY = 0.16;

export const LABEL_TITLE_MAX = 26;

/** A title cut to `max` characters at a word boundary where one is near, with "…". */
export function truncateLabel(title: string, max = LABEL_TITLE_MAX): string {
  const t = title.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp >= max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "BMD-12 Sign in with a magic link, In progress, 2 PRs" — the node's accessible name. */
export function nodeAriaLabel(n: Pick<SprintGraphNode, 'key' | 'title' | 'status' | 'stage' | 'prs' | 'ghost'>): string {
  const status = n.status?.name ?? (n.stage != null ? SPRINT_STAGE_LABEL[n.stage] : 'status unknown');
  const parts = [`${n.key}${n.title !== '' ? ` ${n.title}` : ''}`, status, plural(n.prs.length, 'PR')];
  if (n.ghost) parts.push('outside the sprint');
  return parts.join(', ');
}

// ── PR satellites ────────────────────────────────────────────────────────────────────────────────

export const SATELLITES_MAX = 12;

export type SatelliteKind = 'open' | 'draft' | 'merged' | 'closed';

export const SATELLITE_FILL: Record<SatelliteKind, string> = {
  open: '#4ade80',
  draft: '#94a3b8',
  merged: '#a78bfa',
  closed: '#64748b',
};
export const SATELLITE_FAILING_RING = '#f87171';

export interface Satellite {
  prId: number;
  kind: SatelliteKind;
  failing: boolean;
  /** Angle on the orbit, radians, evenly spaced. */
  angle: number;
}

export function isFailingCi(ci: SprintGraphPr['ciState']): boolean {
  return ci === 'failure' || ci === 'error';
}

/** The ticket's PR dots (at most SATELLITES_MAX, in the wire's order: open first), evenly spaced. */
export function satellitesOf(prs: readonly SprintGraphPr[]): Satellite[] {
  const shown = prs.slice(0, SATELLITES_MAX);
  return shown.map((p, i) => ({
    prId: p.prId,
    kind: p.state === 'merged' ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
    // CI only matters on a PR that can still land.
    failing: p.state === 'open' && isFailingCi(p.ciState),
    angle: (2 * Math.PI * i) / Math.max(1, shown.length),
  }));
}

// ── Edges ────────────────────────────────────────────────────────────────────────────────────────

export interface EdgeStyle {
  stroke: string;
  width: number;
  /** SVG stroke-dasharray, or null for solid. */
  dash: string | null;
  opacity: number;
  arrow: boolean;
}

export function edgeStyle(kind: SprintEdgeKind): EdgeStyle {
  switch (kind) {
    case 'depends_on':
      return { stroke: '#93c5fd', width: 1.6, dash: null, opacity: 0.85, arrow: true };
    case 'concurrent':
      return { stroke: '#c4b5fd', width: 1.4, dash: '5 4', opacity: 0.6, arrow: false };
    case 'builds_on':
    case 'supersedes':
      return { stroke: '#cbd5e1', width: 0.8, dash: null, opacity: 0.28, arrow: false };
  }
}

export function edgeId(e: Pick<SprintGraphEdge, 'from' | 'to' | 'kind'>): string {
  return `${e.from}→${e.to}→${e.kind}`;
}

/** The segment between two circles, cut back to their rims (and a little more where an arrowhead sits). */
export function edgeEndpoints(
  a: { x: number; y: number; r: number },
  b: { x: number; y: number; r: number },
  arrowGap = 0,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  const ux = dx / len;
  const uy = dy / len;
  const start = Math.min(a.r, len / 2);
  const end = Math.min(b.r + arrowGap, len / 2);
  return { x1: a.x + ux * start, y1: a.y + uy * start, x2: b.x - ux * end, y2: b.y - uy * end };
}

// ── Selection: the neighbourhood ─────────────────────────────────────────────────────────────────

/** Every node within `hops` links of `start` (either direction), `start` included. */
export function neighbourhood(
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'>>,
  start: string,
  hops: number,
): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const l = adj.get(a);
    if (l == null) adj.set(a, [b]);
    else l.push(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let h = 0; h < hops && frontier.length > 0; h += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        if (!seen.has(m)) {
          seen.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// ── Filters ──────────────────────────────────────────────────────────────────────────────────────

/** The assignee select's "nobody" value. */
export const UNASSIGNED = '__unassigned__';
/** The epic select's "no epic" value. */
export const NO_EPIC = '__no_epic__';

export interface SprintGraphFilters {
  /** The four section chips; an empty set is never stored (all off reads as all on). */
  stages: ReadonlySet<SprintStage>;
  /** An assignee name, UNASSIGNED, or null = everyone. */
  assignee: string | null;
  /** An epic key, NO_EPIC, or null = any. */
  epic: string | null;
  hasPrs: boolean;
  hasDeps: boolean;
}

export const NO_FILTERS: SprintGraphFilters = {
  stages: new Set<SprintStage>(['not_started', 'in_progress', 'in_review', 'done']),
  assignee: null,
  epic: null,
  hasPrs: false,
  hasDeps: false,
};

export function filtersActive(f: SprintGraphFilters): boolean {
  return f.stages.size < 4 || f.assignee != null || f.epic != null || f.hasPrs || f.hasDeps;
}

/** Nodes touching a `depends_on` edge, either end. */
export function dependencyIdents(edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to' | 'kind'>>): Set<string> {
  const out = new Set<string>();
  for (const e of edges) {
    if (e.kind !== 'depends_on') continue;
    out.add(e.from);
    out.add(e.to);
  }
  return out;
}

/** Does the node pass the filters? A node with an unknown stage passes the section chips only when
 *  all four are on. A ghost's epic is not read, so an epic filter sets every ghost aside. */
export function passesFilters(
  n: Pick<SprintGraphNode, 'ident' | 'stage' | 'assignee' | 'epic' | 'prs'>,
  f: SprintGraphFilters,
  deps: ReadonlySet<string>,
): boolean {
  if (f.stages.size < 4 && (n.stage == null || !f.stages.has(n.stage))) return false;
  if (f.assignee != null) {
    if (f.assignee === UNASSIGNED ? n.assignee != null : n.assignee?.name !== f.assignee) return false;
  }
  if (f.epic != null) {
    if (f.epic === NO_EPIC ? n.epic != null : n.epic?.key !== f.epic) return false;
  }
  if (f.hasPrs && n.prs.length === 0) return false;
  if (f.hasDeps && !deps.has(n.ident)) return false;
  return true;
}

/** Toggle one section chip; turning the LAST one off turns them all back on. */
export function toggleStage(stages: ReadonlySet<SprintStage>, s: SprintStage): Set<SprintStage> {
  const next = new Set(stages);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  return next.size === 0 ? new Set(NO_FILTERS.stages) : next;
}

/** The select options: assignees and epics present on the sprint's tickets, by name. */
export function filterOptions(nodes: ReadonlyArray<Pick<SprintGraphNode, 'ghost' | 'assignee' | 'epic'>>): {
  assignees: string[];
  anyUnassigned: boolean;
  epics: Array<{ key: string; title: string | null }>;
  anyNoEpic: boolean;
} {
  const names = new Set<string>();
  const epics = new Map<string, string | null>();
  let anyUnassigned = false;
  let anyNoEpic = false;
  for (const n of nodes) {
    if (n.ghost) continue;
    if (n.assignee != null) names.add(n.assignee.name);
    else anyUnassigned = true;
    if (n.epic != null) {
      if (!epics.has(n.epic.key) || epics.get(n.epic.key) == null) epics.set(n.epic.key, n.epic.title);
    } else anyNoEpic = true;
  }
  return {
    assignees: [...names].sort((a, b) => a.localeCompare(b)),
    anyUnassigned,
    epics: [...epics.entries()]
      .map(([key, title]) => ({ key, title }))
      .sort((a, b) => (a.title ?? a.key).localeCompare(b.title ?? b.key)),
    anyNoEpic,
  };
}

/** The drawn opacity of a node: its base, unless a filter or the selection sets it aside. */
export function nodeOpacity(base: number, passes: boolean, inFocus: boolean): number {
  if (!passes) return FILTERED_OPACITY;
  if (!inFocus) return DIMMED_OPACITY;
  return base;
}

// ── Pinned positions (per browser, per workspace and sprint) ─────────────────────────────────────

export type PinnedPositions = Record<string, { x: number; y: number }>;

/** Storage key: one per workspace and per sprint SOURCE (a new sprint starts clean). */
export function pinnedStorageKey(workspaceId: number, sourceTitle: string): string {
  return `sprint-graph-pins:${workspaceId}:${sourceTitle}`;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Read pinned positions; anything unreadable (no storage, blocked, malformed) → {}. */
export function readPinned(storage: StorageLike | null | undefined, key: string): PinnedPositions {
  try {
    const raw = storage?.getItem(key);
    if (raw == null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: PinnedPositions = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v == null || typeof v !== 'object') continue;
      const { x, y } = v as { x?: unknown; y?: unknown };
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) out[id] = { x, y };
    }
    return out;
  } catch {
    return {};
  }
}

/** Write pinned positions; a failure (quota, blocked storage) is swallowed — pins then last the visit. */
export function writePinned(storage: StorageLike | null | undefined, key: string, pins: PinnedPositions): void {
  try {
    if (storage == null) return;
    if (Object.keys(pins).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(pins));
  } catch {
    /* pins last the visit */
  }
}

/** The browser's localStorage, or null where reading it throws. */
export function safeLocalStorage(): StorageLike | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

// ── The star field ───────────────────────────────────────────────────────────────────────────────

/** A fixed, faint star field (seeded, so it never moves between renders): positions in 0–1. */
export function starField(count: number, seed = 7): Array<{ x: number; y: number; r: number; o: number }> {
  let s = seed >>> 0;
  const rnd = (): number => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: rnd(),
    y: rnd(),
    r: 0.4 + rnd() * 0.9,
    o: 0.15 + rnd() * 0.45,
  }));
}

// ── Fitting the view ─────────────────────────────────────────────────────────────────────────────

export interface ViewTransform {
  k: number;
  x: number;
  y: number;
}

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

/** The transform that fits every circle into a w × h viewport, leaving SCREEN room for the labels
 *  (drawn at a fixed screen size under each circle): `padX` either side, `padTop` above, `padBottom`
 *  below. The zoom is capped at 1.6. */
export function fitTransform(
  points: ReadonlyArray<{ x: number; y: number; r: number }>,
  w: number,
  h: number,
  pad: { x: number; top: number; bottom: number } = { x: 64, top: 28, bottom: 48 },
): ViewTransform {
  if (points.length === 0 || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  const bw = Math.max(1, maxX - minX);
  const bh = Math.max(1, maxY - minY);
  const k = Math.max(ZOOM_MIN, Math.min(1.6, Math.min((w - 2 * pad.x) / bw, (h - pad.top - pad.bottom) / bh)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: w / 2 - cx * k, y: (h + pad.top - pad.bottom) / 2 - cy * k };
}

/** How much a node's DISC is enlarged when zoomed out, so a far view still shows the tickets: 1 at
 *  zoom ≥ 0.75, growing as 0.75 / zoom, at most 2. */
export function discScale(k: number): number {
  return Math.min(2, Math.max(1, 0.75 / Math.max(1e-3, k)));
}

/** The radius each UNLINKED ticket orbits at: two staggered rings just outside the linked cluster,
 *  wide enough that the unlinked tickets sit about `spacing` apart. */
export function orbitRadius(index: number, linked: number, unlinked: number, spacing = 80): number {
  const cluster = Math.sqrt(Math.max(1, linked)) * 40 + 80;
  const around = (unlinked * spacing) / (4 * Math.PI);
  const base = Math.max(cluster, around, 160);
  return base + (index % 2) * 70;
}

/** Zoom by `factor` about the screen point (px, py). */
export function zoomAbout(t: ViewTransform, factor: number, px: number, py: number): ViewTransform {
  const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, t.k * factor));
  const f = k / t.k;
  return { k, x: px - (px - t.x) * f, y: py - (py - t.y) * f };
}

// ── The drawer's references ──────────────────────────────────────────────────────────────────────

/** The order the drawer lists references in: what blocks it first, loose mentions last. */
export const REFERENCE_ORDER: readonly SprintReferenceRelation[] = [
  'blocked_by',
  'depends_on',
  'concurrent',
  'builds_on',
  'supersedes',
  'linked',
  'out_of_scope',
  'context',
];

export function referenceRelationLabel(r: SprintReferenceRelation): string {
  if (r === 'blocked_by') return 'Blocked by';
  if (r === 'linked') return 'Linked';
  return isSprintEdgeRelation(r) ? SPRINT_EDGE_LABEL[r] : STORY_REFERENCE_RELATION_LABEL[r];
}

/** References grouped by relation, in REFERENCE_ORDER; within a group, not-done first, then by key. */
export function groupReferences(
  refs: readonly SprintTicketReference[],
): Array<{ relation: SprintReferenceRelation; label: string; refs: SprintTicketReference[] }> {
  const out: Array<{ relation: SprintReferenceRelation; label: string; refs: SprintTicketReference[] }> = [];
  for (const relation of REFERENCE_ORDER) {
    const list = refs
      .filter((r) => r.relation === relation)
      .sort((a, b) => Number(a.done === true) - Number(b.done === true) || a.key.localeCompare(b.key, undefined, { numeric: true }));
    if (list.length > 0) out.push({ relation, label: referenceRelationLabel(relation), refs: list });
  }
  return out;
}

// ── What is DRAWN: the toolbar's two toggles ─────────────────────────────────────────────────────
//
// The wire carries every ghost and every edge; the page draws a calmer subset. Hidden nodes are
// REMOVED (not faded), so the layout only has to place what is shown, and a node's size counts only the
// edges it draws.
//
//   • OUTSIDE TICKETS: by default only ghosts that are NOT done (status category not 'done'; unknown
//     counts as open). "Show shipped history" adds the Done ghosts back — and the chains behind them.
//   • LINKS: by default only `depends_on` and `concurrent`. "Show builds on / replaces" adds the faint
//     two kinds.
//   • A ghost is drawn only while a drawn edge chain connects it to a sprint ticket — one whose only
//     links are hidden kinds, or that sits behind a hidden Done ghost, would float alone.

export const FAINT_EDGE_KINDS: ReadonlySet<SprintEdgeKind> = new Set<SprintEdgeKind>(['builds_on', 'supersedes']);

export interface SprintGraphVisibility {
  /** "Show shipped history": Done ghosts too. */
  history: boolean;
  /** "Show builds on / replaces". */
  faint: boolean;
}

export const DEFAULT_VISIBILITY: SprintGraphVisibility = { history: false, faint: false };

/** A ghost whose status category is done. Unknown status counts as open. */
export function isShippedGhost(n: Pick<SprintGraphNode, 'ghost' | 'status'>): boolean {
  return n.ghost && n.status?.category === 'done';
}

export interface VisibleGraph {
  /** The drawn nodes, wire order, each with `degree` RECOUNTED over the drawn edges. */
  nodes: SprintGraphNode[];
  edges: SprintGraphEdge[];
}

/** The drawn subset for these toggles. Pure. */
export function visibleGraph(
  nodes: readonly SprintGraphNode[],
  edges: readonly SprintGraphEdge[],
  vis: SprintGraphVisibility,
): VisibleGraph {
  const allowed = new Set(nodes.filter((n) => !n.ghost || vis.history || !isShippedGhost(n)).map((n) => n.ident));
  const kindOk = (e: SprintGraphEdge): boolean => vis.faint || !FAINT_EDGE_KINDS.has(e.kind);
  const candidate = edges.filter((e) => kindOk(e) && allowed.has(e.from) && allowed.has(e.to));
  // Reachability from the sprint over the candidate edges (either direction).
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const l = adj.get(a);
    if (l == null) adj.set(a, [b]);
    else l.push(b);
  };
  for (const e of candidate) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const shown = new Set(nodes.filter((n) => !n.ghost).map((n) => n.ident));
  let frontier = [...shown];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        if (!shown.has(m)) {
          shown.add(m);
          next.push(m);
        }
      }
    }
    frontier = next;
  }
  const drawnEdges = candidate.filter((e) => shown.has(e.from) && shown.has(e.to));
  const degree = new Map<string, number>();
  for (const e of drawnEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  return {
    nodes: nodes.filter((n) => shown.has(n.ident)).map((n) => ((degree.get(n.ident) ?? 0) === n.degree ? n : { ...n, degree: degree.get(n.ident) ?? 0 })),
    edges: drawnEdges,
  };
}

// ── Grouping: soft clusters ──────────────────────────────────────────────────────────────────────
//
// "Group by" pulls each group's tickets toward its own ANCHOR (a weak forceX / forceY), so a group reads
// as a cluster behind a faint labelled halo while links still cross between groups. Anchors sit on a
// spiral, largest group first, each sized by its member count; the "no epic / no theme" group is placed
// OUTWARD, beyond the others. A ghost follows the group of the sprint ticket it is linked to (the
// nearest one, through drawn edges).

export type SprintGroupMode = 'epic' | 'theme' | 'section' | 'none';
export const SPRINT_GROUP_MODES: readonly SprintGroupMode[] = ['epic', 'theme', 'section', 'none'];
export const SPRINT_GROUP_MODE_LABEL: Record<SprintGroupMode, string> = {
  epic: 'Epic',
  theme: 'Theme',
  section: 'Section',
  none: 'None',
};
/** The default view: by THEME — the sprint's areas of work as Claude named them. */
export const DEFAULT_GROUP_MODE: SprintGroupMode = 'theme';
/** What "Theme" draws as while the sprint has no themes yet. */
export const THEMELESS_GROUP_MODE: SprintGroupMode = 'epic';

/** The group of tickets with no epic / theme / known section. */
export const NO_GROUP = '__no_group__';

const NO_GROUP_LABEL: Record<Exclude<SprintGroupMode, 'none'>, string> = {
  epic: 'No epic',
  theme: 'No theme',
  section: 'Status unknown',
};

/** The mode actually drawn: "Theme" without themes draws as Epic (derived, never written back — the
 *  stored choice, or the Theme default, survives until themes exist). */
export function effectiveGroupMode(choice: SprintGroupMode, themesAvailable: boolean): SprintGroupMode {
  return choice === 'theme' && !themesAvailable ? THEMELESS_GROUP_MODE : choice;
}

/** A SPRINT ticket's own group key (null when not grouping). */
export function groupKeyOf(n: Pick<SprintGraphNode, 'epic' | 'theme' | 'stage'>, mode: SprintGroupMode): string | null {
  switch (mode) {
    case 'epic':
      return n.epic?.key ?? NO_GROUP;
    case 'theme':
      return n.theme ?? NO_GROUP;
    case 'section':
      return n.stage ?? NO_GROUP;
    case 'none':
      return null;
  }
}

/** Every drawn node's group: sprint tickets their own; a ghost the group of the NEAREST sprint ticket
 *  through the drawn edges (ties: the sprint ticket listed first). A ghost no sprint ticket reaches, and
 *  every node when not grouping, → null. Pure. */
export function assignGroups(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'ghost' | 'epic' | 'theme' | 'stage'>>,
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'>>,
  mode: SprintGroupMode,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const n of nodes) out.set(n.ident, n.ghost ? null : groupKeyOf(n, mode));
  if (mode === 'none') return out;
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const l = adj.get(a);
    if (l == null) adj.set(a, [b]);
    else l.push(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const ghost = new Set(nodes.filter((n) => n.ghost).map((n) => n.ident));
  const reached = new Set(nodes.filter((n) => !n.ghost).map((n) => n.ident));
  let frontier = nodes.filter((n) => !n.ghost).map((n) => n.ident);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        if (!ghost.has(m) || reached.has(m)) continue;
        reached.add(m);
        out.set(m, out.get(id) ?? null);
        next.push(m);
      }
    }
    frontier = next;
  }
  return out;
}

export interface SprintGroup {
  key: string;
  label: string;
  /** SPRINT tickets in it — ghosts are left out, so a toggle never RE-ORDERS the groups. */
  count: number;
  /** Every DRAWN member, ghosts included — what the group's room is sized by (`groupAnchors`), so
   *  "Show shipped history" re-spaces the groups instead of pushing one halo into the next. */
  drawn: number;
}

/** The groups present, in placement order: sections in stage order, otherwise largest first (then by
 *  label); the no-group group last. Pure. */
export function groupList(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'epic' | 'ghost'>>,
  groupOf: ReadonlyMap<string, string | null>,
  mode: SprintGroupMode,
): SprintGroup[] {
  if (mode === 'none') return [];
  const counts = new Map<string, number>();
  const drawn = new Map<string, number>();
  const epicTitle = new Map<string, string | null>();
  for (const n of nodes) {
    const g = groupOf.get(n.ident);
    if (g == null) continue;
    drawn.set(g, (drawn.get(g) ?? 0) + 1);
    if (n.ghost) continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
    if (n.epic != null && (epicTitle.get(n.epic.key) ?? null) == null) epicTitle.set(n.epic.key, n.epic.title);
  }
  const label = (k: string): string => {
    if (k === NO_GROUP) return NO_GROUP_LABEL[mode];
    if (mode === 'epic') return epicTitle.get(k) ?? k;
    if (mode === 'section') return SPRINT_STAGE_LABEL[k as SprintStage] ?? k;
    return k;
  };
  const list = [...counts.entries()]
    .filter(([k]) => k !== NO_GROUP)
    .map(([key, count]) => ({ key, label: label(key), count, drawn: drawn.get(key) ?? count }));
  if (mode === 'section') {
    const rank = (k: string): number => SPRINT_STAGES.indexOf(k as SprintStage);
    list.sort((a, b) => rank(a.key) - rank(b.key));
  } else {
    list.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }
  const none = counts.get(NO_GROUP);
  if (none != null) list.push({ key: NO_GROUP, label: label(NO_GROUP), count: none, drawn: drawn.get(NO_GROUP) ?? none });
  return list;
}

/** A group's anchor radius: its AREA grows with its member count — room for `count` tickets at the
 *  in-group collide spacing (`collidePadding`), labels included. */
export function groupRadius(count: number): number {
  const n = Math.max(1, count);
  // Each ticket's share: a disc of (typical radius + collide padding), packed at ~75%.
  return Math.round(Math.sqrt(n / 0.75) * (collidePadding(true, n) + 12) + 16);
}

/** The collide padding round a ticket (added to its radius): wider when grouped, and wider again in a
 *  LARGE group, which is laid out as a spread disc so its inner labels have room (a small group's
 *  labels can spill outward). */
export function collidePadding(grouped: boolean, groupSize: number): number {
  if (!grouped) return 20;
  const big = Math.min(1, Math.max(0, (groupSize - 8) / 24));
  return Math.round(32 + 8 * big);
}

export interface GroupAnchor {
  x: number;
  y: number;
  r: number;
}

const ANCHOR_GAP = 40;

/** Each group's anchor: placed in order along a spiral at the first spot that overlaps no group
 *  already placed; the no-group group starts beyond everything else (outward). Sized by the DRAWN
 *  members when given (else the sprint count). `aspect` (canvas width ÷ height) stretches the spiral
 *  into an ellipse of the canvas's shape, so Fit fills a wide canvas instead of a square in its middle.
 *  Re-centred on the origin (the drift turns about it). Deterministic. Pure. */
export function groupAnchors(
  groups: ReadonlyArray<Pick<SprintGroup, 'key' | 'count'> & { drawn?: number }>,
  aspect = 1,
): Map<string, GroupAnchor> {
  const sx = Math.sqrt(Math.min(3, Math.max(1 / 3, Number.isFinite(aspect) && aspect > 0 ? aspect : 1)));
  const placed: Array<{ key: string } & GroupAnchor> = [];
  const fits = (x: number, y: number, r: number): boolean =>
    placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.r + r + ANCHOR_GAP);
  const place = (key: string, r: number, minRho: number): void => {
    // Archimedean spiral ρ = 14·θ, from the first θ that reaches `minRho`.
    let theta = minRho / 14;
    for (let i = 0; i < 20000; i += 1, theta += 0.12) {
      const rho = 14 * theta;
      const x = rho * Math.cos(theta) * sx;
      const y = (rho * Math.sin(theta)) / sx;
      if (fits(x, y, r)) {
        placed.push({ key, x, y, r });
        return;
      }
    }
    placed.push({ key, x: 0, y: 0, r });
  };
  for (const g of groups) {
    if (g.key === NO_GROUP) continue;
    place(g.key, groupRadius(g.drawn ?? g.count), 0);
  }
  const noGroup = groups.find((g) => g.key === NO_GROUP);
  if (noGroup != null) {
    const r = groupRadius(noGroup.drawn ?? noGroup.count);
    // Outward: beyond the furthest placed group, measured in the spiral's own (unstretched) terms.
    const extent = placed.reduce((m, p) => Math.max(m, Math.hypot(p.x / sx, p.y * sx) + p.r), 0);
    place(NO_GROUP, r, placed.length === 0 ? 0 : extent + r + ANCHOR_GAP);
  }
  if (placed.length === 0) return new Map();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    minY = Math.min(minY, p.y - p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return new Map(placed.map((p) => [p.key, { x: Math.round(p.x - cx), y: Math.round(p.y - cy), r: p.r }]));
}

/** The halo drawn behind a group: around its members' CURRENT positions (centroid, out to the furthest
 *  rim plus a margin). null for no members. Pure. */
export function groupHalo(points: ReadonlyArray<{ x: number; y: number; r: number }>, margin = 16): { x: number; y: number; r: number } | null {
  if (points.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const x = sx / points.length;
  const y = sy / points.length;
  let r = 0;
  for (const p of points) r = Math.max(r, Math.hypot(p.x - x, p.y - y) + p.r);
  return { x, y, r: r + margin };
}

/** How far each group must move so no two halos overlap (with `gap` between rims): every overlapping
 *  pair is pushed apart along the line between their centres, the SMALLER halo moving more. Returns a
 *  displacement per group that needs one (summed over its pairs). Pure. */
export function haloSeparation(
  halos: ReadonlyMap<string, { x: number; y: number; r: number }>,
  gap = 24,
): Map<string, { dx: number; dy: number }> {
  const list = [...halos.entries()];
  const out = new Map<string, { dx: number; dy: number }>();
  const add = (k: string, dx: number, dy: number): void => {
    const cur = out.get(k);
    if (cur == null) out.set(k, { dx, dy });
    else {
      cur.dx += dx;
      cur.dy += dy;
    }
  };
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [ka, a] = list[i] as [string, { x: number; y: number; r: number }];
      const [kb, b] = list[j] as [string, { x: number; y: number; r: number }];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.hypot(dx, dy);
      const need = a.r + b.r + gap;
      if (d >= need) continue;
      if (d < 1e-6) {
        // Coincident: split them deterministically along x.
        dx = 1;
        dy = 0;
        d = 1;
      }
      const overlap = need - Math.max(d, 0);
      const ux = dx / d;
      const uy = dy / d;
      const wa = (b.r * b.r) / Math.max(1e-6, a.r * a.r + b.r * b.r);
      const wb = 1 - wa;
      add(ka, -ux * overlap * wa, -uy * overlap * wa);
      add(kb, ux * overlap * wb, uy * overlap * wb);
    }
  }
  return out;
}

/** The halo's look on the navy canvas: a faint fill and rim; the label is measured (textContrast.test)
 *  against the ground lightened by the fill. */
export const GROUP_HALO = {
  fill: '#ffffff',
  fillAlpha: 0.035,
  stroke: '#94a3b8',
  strokeAlpha: 0.28,
  label: '#e2e8f0',
} as const;

export const GROUP_LABEL_MAX = 30;

// ── The view choices, per browser ────────────────────────────────────────────────────────────────

export const GROUP_MODE_STORAGE_KEY = 'sprint-graph-group';

/** The stored "Group by" choice; anything unreadable → the default. */
export function readGroupMode(storage: StorageLike | null | undefined): SprintGroupMode {
  try {
    const v = storage?.getItem(GROUP_MODE_STORAGE_KEY);
    return v != null && (SPRINT_GROUP_MODES as readonly string[]).includes(v) ? (v as SprintGroupMode) : DEFAULT_GROUP_MODE;
  } catch {
    return DEFAULT_GROUP_MODE;
  }
}

export function writeGroupMode(storage: StorageLike | null | undefined, mode: SprintGroupMode): void {
  try {
    storage?.setItem(GROUP_MODE_STORAGE_KEY, mode);
  } catch {
    /* the choice lasts the visit */
  }
}

// ── Labels: which side of its ticket each label sits, and which give way ─────────────────────────
//
// A label is drawn at a FIXED SCREEN SIZE (CSS scales it by 1/zoom), so whether two labels collide is a
// question about the SCREEN, not the layout: it is answered after every zoom and (throttled) while the
// canvas moves. Each label tries below its ticket, then above, right, left and the four corners — keeping the side it had
// when that is still free, so labels do not flicker as the canvas drifts — and takes the first spot that
// overlaps no label already placed and no other ticket's disc. Placed in PRIORITY order (the selected,
// hovered or focused ticket first, then the better-connected, sprint tickets before outside ones,
// readable before faded); a label with no free spot is HIDDEN, and shows again on hover, focus or
// zoom — when it is promoted, or the screen has room.

export type LabelSide = 'below' | 'above' | 'right' | 'left' | 'below-right' | 'below-left' | 'above-right' | 'above-left' | 'none';
/** The order a label tries its sides in: straight below / above first, then beside, then the corners. */
export const LABEL_SIDES: readonly Exclude<LabelSide, 'none'>[] = [
  'below',
  'above',
  'right',
  'left',
  'below-right',
  'below-left',
  'above-right',
  'above-left',
];
const DIAG = Math.SQRT1_2;

/** The gap (px) between a disc's rim and its label. */
export const LABEL_GAP = 3;

/** A label's box on screen (px), estimated from its text: the key in 11px bold mono, the title (when
 *  shown) in 11px sans on a second line. Includes the 3px halo stroke. */
export function labelSize(key: string, title: string, withTitle: boolean): { w: number; h: number } {
  const keyW = key.length * 6.9;
  const t = withTitle && title.trim() !== '' ? truncateLabel(title) : '';
  const titleW = textWidth(t, 11);
  return { w: Math.ceil(Math.max(keyW, titleW) + 4), h: t !== '' ? 28 : 15 };
}

/** Where a label sits for a side, as the CSS reads it: (`sx`, `sy`) multiples of the disc's radius in
 *  layout units, then (`lx`, `ly`) screen px for the label block's top-centre. */
export function labelOffset(side: Exclude<LabelSide, 'none'>, w: number, h: number, gap = LABEL_GAP): { sx: number; sy: number; lx: number; ly: number } {
  switch (side) {
    case 'below':
      return { sx: 0, sy: 1, lx: 0, ly: gap };
    case 'above':
      return { sx: 0, sy: -1, lx: 0, ly: -(h + gap) };
    case 'right':
      return { sx: 1, sy: 0, lx: w / 2 + gap + 1, ly: -h / 2 };
    case 'left':
      return { sx: -1, sy: 0, lx: -(w / 2 + gap + 1), ly: -h / 2 };
    case 'below-right':
      return { sx: DIAG, sy: DIAG, lx: w / 2 + 1, ly: 1 };
    case 'below-left':
      return { sx: -DIAG, sy: DIAG, lx: -(w / 2 + 1), ly: 1 };
    case 'above-right':
      return { sx: DIAG, sy: -DIAG, lx: w / 2 + 1, ly: -(h + 1) };
    case 'above-left':
      return { sx: -DIAG, sy: -DIAG, lx: -(w / 2 + 1), ly: -(h + 1) };
  }
}

export interface ScreenBox {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface LabelItem {
  id: string;
  /** The ticket's centre and its disc's radius, in screen px. */
  x: number;
  y: number;
  R: number;
  w: number;
  h: number;
  /** Higher places first; at or above LABEL_ALWAYS the label is always shown. */
  priority: number;
  /** The side it had last time (tried first, so labels hold still). */
  prev?: LabelSide;
}

/** A label at or above this priority is always shown (the selected / hovered / focused ticket). */
export const LABEL_ALWAYS = 1e6;

/** The label's screen box for a side. */
export function labelBox(it: Pick<LabelItem, 'x' | 'y' | 'R' | 'w' | 'h'>, side: Exclude<LabelSide, 'none'>): ScreenBox {
  const o = labelOffset(side, it.w, it.h);
  const cx = it.x + o.sx * it.R + o.lx;
  const t = it.y + o.sy * it.R + o.ly;
  return { l: cx - it.w / 2, t, r: cx + it.w / 2, b: t + it.h };
}

export function boxesOverlap(a: ScreenBox, b: ScreenBox): boolean {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

function boxHitsDisc(b: ScreenBox, x: number, y: number, R: number): boolean {
  const px = Math.max(b.l, Math.min(x, b.r));
  const py = Math.max(b.t, Math.min(y, b.b));
  return (px - x) ** 2 + (py - y) ** 2 < R * R;
}

/** A label's priority: the selected / hovered / focused ticket always wins; then readable before faded,
 *  sprint before outside, more links first, larger first. */
export function labelPriority(n: { degree: number; ghost: boolean; faded: boolean; pinned: boolean; r: number }): number {
  if (n.pinned) return LABEL_ALWAYS;
  return (n.faded ? 0 : 100000) + (n.ghost ? 0 : 10000) + Math.min(999, n.degree) * 10 + Math.min(9, n.r / 4);
}

/** Each label's side, or 'none' (hidden). Greedy in priority order (ties: input order); `obstacles`
 *  are fixed boxes (the group names) no label may cover. Pure. */
export function placeLabels(items: readonly LabelItem[], obstacles: readonly ScreenBox[] = []): Map<string, LabelSide> {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.priority - a.it.priority || a.i - b.i);
  const placed: ScreenBox[] = [];
  const out = new Map<string, LabelSide>();
  // A cheap grid over the discs keeps this linear-ish (136 tickets, re-run while the canvas moves).
  const CELL = 64;
  const grid = new Map<string, LabelItem[]>();
  for (const it of items) {
    const x0 = Math.floor((it.x - it.R) / CELL);
    const x1 = Math.floor((it.x + it.R) / CELL);
    const y0 = Math.floor((it.y - it.R) / CELL);
    const y1 = Math.floor((it.y + it.R) / CELL);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        const k = `${gx},${gy}`;
        const l = grid.get(k);
        if (l == null) grid.set(k, [it]);
        else l.push(it);
      }
    }
  }
  const hitsDisc = (b: ScreenBox, self: string, shrink: number): boolean => {
    for (let gx = Math.floor(b.l / CELL); gx <= Math.floor(b.r / CELL); gx += 1) {
      for (let gy = Math.floor(b.t / CELL); gy <= Math.floor(b.b / CELL); gy += 1) {
        for (const d of grid.get(`${gx},${gy}`) ?? []) {
          if (d.id !== self && boxHitsDisc(b, d.x, d.y, d.R * shrink)) return true;
        }
      }
    }
    return false;
  };
  const free = (b: ScreenBox, self: string, shrink: number): boolean =>
    !placed.some((p) => boxesOverlap(p, b)) && !obstacles.some((o) => boxesOverlap(o, b)) && (shrink === 0 || !hitsDisc(b, self, shrink));
  for (const { it } of order) {
    const prev = it.prev != null && it.prev !== 'none' ? it.prev : null;
    const sides = prev != null ? [prev, ...LABEL_SIDES.filter((s) => s !== prev)] : [...LABEL_SIDES];
    let chosen: LabelSide = 'none';
    // Clear of every label AND every other disc first; failing that, it may graze a disc's rim (never its
    // middle — text under a ticket is unreadable). Only an always-shown label ignores the discs.
    const passes = it.priority >= LABEL_ALWAYS ? [1, 0.55, 0] : [1, 0.55];
    for (const shrink of passes) {
      for (const s of sides) {
        if (free(labelBox(it, s), it.id, shrink)) {
          chosen = s;
          break;
        }
      }
      if (chosen !== 'none') break;
    }
    if (chosen === 'none' && it.priority >= LABEL_ALWAYS) chosen = prev ?? 'below';
    out.set(it.id, chosen);
    if (chosen !== 'none') placed.push(labelBox(it, chosen));
  }
  return out;
}

// ── The wheel and touch: the page scrolls, Ctrl/⌘ zooms ──────────────────────────────────────────

/** What a wheel event over the canvas does: a plain wheel SCROLLS THE PAGE (the canvas is not a trap);
 *  Ctrl or ⌘ + wheel zooms — and a trackpad pinch, which the browser sends as a Ctrl + wheel. */
export function wheelIntent(e: { ctrlKey: boolean; metaKey: boolean }): 'zoom' | 'scroll' {
  return e.ctrlKey || e.metaKey ? 'zoom' : 'scroll';
}

/** The zoom factor for one zooming wheel event: lines and pages converted to pixels, each event capped
 *  so a mouse notch is a step (≈1.28×) while a pinch's small deltas zoom smoothly. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const capped = Math.max(-25, Math.min(25, Number.isFinite(px) ? px : 0));
  return Math.exp(-capped * 0.01);
}

/** A two-finger pinch: the transform that keeps the content under the fingers' midpoint while the
 *  zoom follows the fingers' spread. Pure. */
export function pinchTransform(
  start: ViewTransform,
  a0: { x: number; y: number },
  b0: { x: number; y: number },
  a1: { x: number; y: number },
  b1: { x: number; y: number },
): ViewTransform {
  const d0 = Math.max(1, Math.hypot(b0.x - a0.x, b0.y - a0.y));
  const d1 = Math.max(1, Math.hypot(b1.x - a1.x, b1.y - a1.y));
  const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, start.k * (d1 / d0)));
  const m0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
  const m1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  // The graph point under the first midpoint stays under the current one.
  const gx = (m0.x - start.x) / start.k;
  const gy = (m0.y - start.y) / start.k;
  return { k, x: m1.x - gx * k, y: m1.y - gy * k };
}

// ── Group names: one per halo, the bigger group's first ──────────────────────────────────────────

export type GroupLabelPlace = 'top' | 'bottom' | 'none';

export interface GroupLabelItem {
  key: string;
  /** The halo's centre and radius, in screen px. */
  x: number;
  y: number;
  r: number;
  /** The name's box size (px). */
  w: number;
  h: number;
  /** Higher places first (the group's size; a hovered / selected member's group first of all). */
  priority: number;
}

/** The name's box for a place: centred above the halo's top, or below its bottom. */
export function groupLabelBox(it: Pick<GroupLabelItem, 'x' | 'y' | 'r' | 'w' | 'h'>, place: Exclude<GroupLabelPlace, 'none'>): ScreenBox {
  const t = place === 'top' ? it.y - it.r - it.h - 1 : it.y + it.r + 1;
  return { l: it.x - it.w / 2, t, r: it.x + it.w / 2, b: t + it.h };
}

/** Where each group's name goes: above its halo, else below it, clear of every name already placed and
 *  of OTHER groups' tickets (`discs`, tagged with their group); a name with no clear place is hidden
 *  (a zoom, or hovering one of its tickets, brings it back). Pure. */
export function placeGroupLabels(
  items: readonly GroupLabelItem[],
  discs: ReadonlyArray<{ x: number; y: number; R: number; group: string | null }> = [],
): Map<string, GroupLabelPlace> {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.priority - a.it.priority || a.i - b.i);
  const placed: ScreenBox[] = [];
  const out = new Map<string, GroupLabelPlace>();
  for (const { it } of order) {
    let chosen: GroupLabelPlace = 'none';
    for (const place of ['top', 'bottom'] as const) {
      const b = groupLabelBox(it, place);
      if (placed.some((p) => boxesOverlap(p, b))) continue;
      if (discs.some((d) => d.group !== it.key && boxHitsDisc(b, d.x, d.y, d.R))) continue;
      chosen = place;
      break;
    }
    if (chosen === 'none' && it.priority >= LABEL_ALWAYS) chosen = 'top';
    out.set(it.key, chosen);
    if (chosen !== 'none') placed.push(groupLabelBox(it, chosen));
  }
  return out;
}

/** A group name's box size on screen (12px semibold). */
export function groupLabelSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(textWidth(text, 12) + 8), h: 17 };
}

/** A sans-serif string's rough width at `px`: capitals and digits wider, spaces narrower — epic names
 *  are often SHOUTED ("F06 - UPLOAD POST INTERVENTION"), and a per-character average under-reads them. */
export function textWidth(text: string, px: number): number {
  let w = 0;
  for (const ch of text) {
    if (ch === ' ') w += 0.28;
    else if (/[A-Z0-9]/.test(ch)) w += 0.68;
    else if (/[a-z]/.test(ch)) w += 0.54;
    else w += 0.5;
  }
  return w * px;
}
