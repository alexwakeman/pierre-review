import type {
  SprintEdgeKind,
  SprintGraphEdge,
  SprintGraphNode,
  SprintGraphPr,
  SprintStage,
} from '@pierre-review/shared';
import { SPRINT_STAGE_LABEL, SPRINT_STAGES } from '@pierre-review/shared';
import { memberMatches, personNameKey, sprintMembers, type SprintMember } from '@pierre-review/shared';

// Activity → This Sprint as a GRAPH: the pure folds behind SprintGraph.tsx (test/sprintGraphModel.test.ts).
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

// Large enough that the status (ring, fill and centre mark) reads at Fit, not only zoomed in.
export const NODE_RADIUS_MIN = 14;
export const NODE_RADIUS_MAX = 34;
export const GHOST_RADIUS_MIN = 9;

/** A node's radius: by its number of links (degree), square-root so a hub does not swamp the page. */
export function nodeRadius(degree: number, ghost: boolean): number {
  const d = Math.max(0, Number.isFinite(degree) ? degree : 0);
  const r = Math.min(NODE_RADIUS_MAX, NODE_RADIUS_MIN + 5 * Math.sqrt(d));
  return ghost ? Math.max(GHOST_RADIUS_MIN, Math.round(r * 0.7 * 10) / 10) : r;
}

/** The status ring's stroke (layout units): thick enough that its colour reads at Fit. */
export function ringWidth(ghost: boolean, selected: boolean): number {
  return ghost ? 2.5 : selected ? 6 : 5;
}

/** The disc's ground under every ticket (lines pass BEHIND it). */
export const DISC_GROUND = '#0b1430';
/** How much of the status colour tints a sprint ticket's disc. */
export const DISC_TINT_ALPHA = 0.3;

/** A disc's fill: a dark tint of its status colour, so status reads as an area as well as a ring.
 *  An outside (ghost) ticket keeps the plain ground — it stays the dim one. */
export function discFill(stage: SprintStage | null, ghost: boolean): string {
  return ghost ? DISC_GROUND : blendHex(stageRing(stage), DISC_GROUND, DISC_TINT_ALPHA);
}

/** The centre mark per status, so status is a SHAPE as well as a colour (SprintGraph.tsx draws it from
 *  Icons.tsx): not started = an empty ring, in progress = a half-filled circle, in review = an eye,
 *  complete = a tick, unknown = a question mark. */
export type StatusGlyph = 'ring' | 'half' | 'eye' | 'tick' | 'question';
export function statusGlyph(stage: SprintStage | null): StatusGlyph {
  switch (stage) {
    case 'not_started':
      return 'ring';
    case 'in_progress':
      return 'half';
    case 'in_review':
      return 'eye';
    case 'done':
      return 'tick';
    default:
      return 'question';
  }
}

/** The centre mark's colour: the ring colour, except the unknown slate (too dark on the fill). */
export function glyphColour(stage: SprintStage | null): string {
  return stage == null ? STAGE_RING_UNKNOWN_LABEL : STAGE_RING[stage];
}

/** The centre mark's size (layout units) for a disc of radius `r`. */
export function glyphSize(r: number): number {
  return Math.round(r * 1.05 * 10) / 10;
}

// ── The assignee badge ──────────────────────────────────────────────────────────────────────────
// An avatar (or initials) badge sits OUTSIDE the disc's top-right rim, so it never covers the centre
// mark. It is drawn in layout units inside the disc's scaled body, and counter-scaled when zoomed out
// so it never drops below `BADGE_MIN_SCREEN_R` px on screen (an 18px picture).

/** The badge's radius at zoom 1 (layout units; the avatar image is this radius). */
export const BADGE_R = 9;
/** The badge's smallest radius on screen (px). */
export const BADGE_MIN_SCREEN_R = 9;

/** How much the badge is enlarged at zoom `k` (the disc is already scaled by `discScale(k)`). */
export function badgeScale(k: number): number {
  const onScreen = BADGE_R * discScale(k) * Math.max(1e-3, k);
  return Math.max(1, BADGE_MIN_SCREEN_R / onScreen);
}

/** The badge's centre relative to the disc's centre, in the disc's own (unscaled) units, for a badge
 *  scaled by `s`: anchored on the rim at 45° and pushed out by part of its own radius as it grows. */
export function badgeCentre(r: number, s: number): { x: number; y: number } {
  const d = r * Math.SQRT1_2 + BADGE_R * s * 0.45;
  return { x: d, y: -d };
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

/** How bright a node is drawn when nothing dims it: Complete fades; a ghost fades with its depth. */
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
  /** Angle on the orbit, radians (SVG: y down, 0 = right), evenly spaced over the free arc. */
  angle: number;
}

export function isFailingCi(ci: SprintGraphPr['ciState']): boolean {
  return ci === 'failure' || ci === 'error';
}

/** A PR dot's radius at zoom 1 (layout units). */
export const SATELLITE_R = 5.5;
/** Room between the ticket's ring and a dot, and between two dots (layout units). */
export const SATELLITE_GAP = 1.5;
/** The smallest radius a dot is drawn at on screen (px) when zoomed out... */
export const SATELLITE_MIN_SCREEN_R = 4;
/** ...up to this much enlargement, so the far view is not all dots. */
export const SATELLITE_SCALE_MAX = 2.5;

/** How much a dot is enlarged at zoom `k` (the disc is already scaled by `discScale(k)`): gently, so a
 *  dot never drops below `SATELLITE_MIN_SCREEN_R` px on screen until `SATELLITE_SCALE_MAX`. */
export function satelliteScale(k: number): number {
  const onScreen = SATELLITE_R * discScale(k) * Math.max(1e-3, k);
  return Math.min(SATELLITE_SCALE_MAX, Math.max(1, SATELLITE_MIN_SCREEN_R / onScreen));
}

/** The assignee badge's direction from the disc's centre (top right; `badgeCentre`). */
const BADGE_ANGLE = -Math.PI / 4;
/** The badge's own scale the dots keep clear of (it is drawn only at zoom ≥ the far threshold, where
 *  `badgeScale` is at most ~1.25). */
const BADGE_CLEAR_SCALE = 1.3;

/** Half the angle round the orbit the assignee badge blocks, for dots on an orbit of radius `orbit`
 *  round a disc of radius `r`. */
function badgeHalfAngle(r: number, orbit: number): number {
  const c = badgeCentre(r, BADGE_CLEAR_SCALE);
  const bd = Math.hypot(c.x, c.y);
  const need = (BADGE_R + 1) * BADGE_CLEAR_SCALE + SATELLITE_R + SATELLITE_GAP;
  const cos = (orbit * orbit + bd * bd - need * need) / (2 * orbit * bd);
  return Math.acos(Math.max(-1, Math.min(1, cos)));
}

/** The radius the PR dots sit on round a disc of radius `r`: just outside the (thickest) status ring,
 *  widened when `count` dots would touch on the free arc. */
export function satelliteOrbit(r: number, count: number, badge: boolean): number {
  const base = r + ringWidth(false, true) / 2 + SATELLITE_R + SATELLITE_GAP;
  const arc = badge ? 2 * Math.PI - 2 * badgeHalfAngle(r, base) : 2 * Math.PI;
  const needed = (Math.max(0, count) * (2 * SATELLITE_R + SATELLITE_GAP)) / arc;
  return Math.max(base, needed);
}

/** How far a ticket reaches, dots included (layout units, zoom 1): its label sits outside this. */
export function nodeExtent(r: number, count: number, badge: boolean): number {
  const disc = drawnRadius(r, 1);
  return count > 0 ? Math.max(disc, satelliteOrbit(r, count, badge) + SATELLITE_R) : disc;
}

/** The ticket's PR dots (at most SATELLITES_MAX, in the wire's order: open first). Evenly spaced round
 *  the whole orbit, or — when the ticket wears an assignee badge (`badge`) — over the arc the badge
 *  leaves free, so no dot sits under it. A draft is a HOLLOW dot (closed is filled slate). */
export function satellitesOf(prs: readonly SprintGraphPr[], opts: { r?: number; badge?: boolean } = {}): Satellite[] {
  const shown = prs.slice(0, SATELLITES_MAX);
  const n = Math.max(1, shown.length);
  const r = opts.r ?? NODE_RADIUS_MIN;
  const badge = opts.badge === true;
  const half = badge ? badgeHalfAngle(r, satelliteOrbit(r, shown.length, true)) : 0;
  const arc = 2 * Math.PI - 2 * half;
  return shown.map((p, i) => ({
    prId: p.prId,
    kind: p.state === 'merged' ? 'merged' : p.state === 'closed' ? 'closed' : p.draft ? 'draft' : 'open',
    // CI only matters on a PR that can still land.
    failing: p.state === 'open' && isFailingCi(p.ciState),
    angle: badge ? BADGE_ANGLE + half + (arc * (i + 0.5)) / n : (2 * Math.PI * i) / n,
  }));
}

// ── The storyline highlight ──────────────────────────────────────────────────────────────────────
// A card clicked (SprintPathsStrip) HIGHLIGHTS its tickets: a bright halo ring in a colour no
// status, PR dot or selection uses, their labels revealed, and everything else faded (a link stays
// full only when both its ends are highlighted). A VIEW state: it never re-lays the graph out.

/** The highlight ring (non-text, ≥ 3:1 on the canvas; test/textContrast.test.ts). */
export const STORY_HIGHLIGHT = '#f472b6';

/** The storyline's tickets that are drawn; null when none are (no highlight, nothing fades). */
export function storyHighlightSet(idents: readonly string[] | null | undefined, drawn: ReadonlySet<string> | ReadonlyMap<string, unknown>): Set<string> | null {
  if (idents == null) return null;
  const out = new Set(idents.filter((id) => drawn.has(id)));
  return out.size > 0 ? out : null;
}

/** Whether a node / link is set aside (faded). The open ticket's neighbourhood wins while a ticket is
 *  selected; otherwise the storyline highlight decides. A link is full only with both ends kept. */
export function fadedBy(
  focus: ReadonlySet<string> | null,
  story: ReadonlySet<string> | null,
): { node: (id: string) => boolean; edge: (from: string, to: string) => boolean } {
  const keep = focus ?? story;
  return {
    node: (id) => keep != null && !keep.has(id),
    edge: (from, to) => keep != null && !(keep.has(from) && keep.has(to)),
  };
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

// ── Curved links ─────────────────────────────────────────────────────────────────────────────────
// A link is a gentle quadratic curve that always bends to the LEFT of its own direction (from → to), so
// two links running opposite ways between one pair bow apart by construction. Two or more links between
// one pair in the SAME frame (A→B depends on, A→B built alongside) take lanes 1, −1, 2, −2… measured on
// the pair's canonical side, so they never lie on top of each other.

/** Each link's bend, in lanes on its OWN left (`edgeCurve`'s `lane`). Deterministic. Pure. */
export function edgeBends(edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to' | 'kind'>>): Map<string, number> {
  const byPair = new Map<string, Array<Pick<SprintGraphEdge, 'from' | 'to' | 'kind'>>>();
  for (const e of edges) {
    const k = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
    const l = byPair.get(k);
    if (l == null) byPair.set(k, [e]);
    else l.push(e);
  }
  const out = new Map<string, number>();
  for (const list of byPair.values()) {
    const only = list[0];
    if (list.length === 1 && only != null) {
      out.set(edgeId(only), 1);
      continue;
    }
    const sorted = [...list].sort((a, b) => edgeId(a).localeCompare(edgeId(b)));
    sorted.forEach((e, i) => {
      // Canonical lanes 1, −1, 2, −2…; a link running against the canonical direction has its left on
      // the other side, so its own lane flips sign.
      const lane = (i % 2 === 0 ? 1 : -1) * (Math.floor(i / 2) + 1);
      out.set(edgeId(e), e.from < e.to ? lane : -lane);
    });
  }
  return out;
}

/** How far one lane bows a link of length `len` (layout units): a gentle bend, capped. */
export function laneBow(len: number): number {
  return Math.min(34, Math.max(8, len * 0.14));
}

/** The curve from circle `a` to circle `b`: a quadratic Bézier bowed `lane` lanes to its left, cut back
 *  to each rim ALONG THE CURVE (its end tangents point at the control point), and `arrowGap` more at the
 *  end where an arrowhead sits. `d` is the SVG path; the arrowhead (`orient="auto"`) follows the end
 *  tangent. Pure. */
export function edgeCurve(
  a: { x: number; y: number; r: number },
  b: { x: number; y: number; r: number },
  lane = 1,
  arrowGap = 0,
): { d: string; x1: number; y1: number; cx: number; cy: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    const d = `M${a.x.toFixed(1)},${a.y.toFixed(1)}L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    return { d, x1: a.x, y1: a.y, cx: a.x, cy: a.y, x2: b.x, y2: b.y };
  }
  // The left normal of from → to (screen y points down, so "left" is (dy, −dx) / len).
  const nx = dy / len;
  const ny = -dx / len;
  const bow = laneBow(len) * lane;
  // A quadratic's apex sits half-way to its control point: the control point is twice the bow out.
  const cx = (a.x + b.x) / 2 + nx * bow * 2;
  const cy = (a.y + b.y) / 2 + ny * bow * 2;
  const cut = (p: { x: number; y: number }, by: number): { x: number; y: number } => {
    const tx = cx - p.x;
    const ty = cy - p.y;
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-6) return { x: p.x, y: p.y };
    const k = Math.min(by, tl * 0.9);
    return { x: p.x + (tx / tl) * k, y: p.y + (ty / tl) * k };
  };
  const s = cut(a, Math.min(a.r, len / 2));
  const e = cut(b, Math.min(b.r + arrowGap, len / 2));
  const d = `M${s.x.toFixed(1)},${s.y.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${e.x.toFixed(1)},${e.y.toFixed(1)}`;
  return { d, x1: s.x, y1: s.y, cx, cy, x2: e.x, y2: e.y };
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

/** The member select's "nobody" value. */
export const UNASSIGNED = '__unassigned__';
/** The epic select's "no epic" value. */
export const NO_EPIC = '__no_epic__';
/** The theme select's "no theme" value. */
export const NO_THEME = '__no_theme__';

export interface SprintGraphFilters {
  /** The four section chips; an empty set is never stored (all off reads as all on). */
  stages: ReadonlySet<SprintStage>;
  /** A member id (`SprintMember.id`), UNASSIGNED, or null = everyone. A bare assignee name still
   *  matches by name when no member list is given. */
  assignee: string | null;
  /** An epic key, NO_EPIC, or null = any. */
  epic: string | null;
  /** A theme name, NO_THEME, or null = any. The picker shows Theme while the graph groups by theme,
   *  Epic otherwise. */
  theme: string | null;
  hasPrs: boolean;
  hasDeps: boolean;
}

export const NO_FILTERS: SprintGraphFilters = {
  stages: new Set<SprintStage>(['not_started', 'in_progress', 'in_review', 'done']),
  assignee: null,
  epic: null,
  theme: null,
  hasPrs: false,
  hasDeps: false,
};

export function filtersActive(f: SprintGraphFilters): boolean {
  return f.stages.size < 4 || f.assignee != null || f.epic != null || f.theme != null || f.hasPrs || f.hasDeps;
}

// ── Members: one entry per person, across the tracker and GitHub ─────────────────────────────────
// The ONE mapping lives in shared `sprint-members.ts` (the server's `people` reads it too).
export { memberMatches, personNameKey, sprintMembers, type SprintMember };

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
  n: Pick<SprintGraphNode, 'ident' | 'stage' | 'assignee' | 'epic' | 'prs'> & Partial<Pick<SprintGraphNode, 'theme'>>,
  f: SprintGraphFilters,
  deps: ReadonlySet<string>,
  /** The member list by id (`sprintMembers`); without it a member value matches an assignee by name. */
  members?: ReadonlyMap<string, Pick<SprintMember, 'names' | 'logins'>>,
): boolean {
  if (f.stages.size < 4 && (n.stage == null || !f.stages.has(n.stage))) return false;
  if (f.assignee != null) {
    if (f.assignee === UNASSIGNED) {
      if (n.assignee != null) return false;
    } else {
      const m = members?.get(f.assignee);
      if (m != null ? !memberMatches(n, m) : n.assignee?.name !== f.assignee) return false;
    }
  }
  if (f.epic != null) {
    if (f.epic === NO_EPIC ? n.epic != null : n.epic?.key !== f.epic) return false;
  }
  if (f.theme != null) {
    const t = n.theme ?? null;
    if (f.theme === NO_THEME ? t != null : t !== f.theme) return false;
  }
  if (f.hasPrs && n.prs.length === 0) return false;
  if (f.hasDeps && !deps.has(n.ident)) return false;
  return true;
}

/** What a FILTER leaves on the canvas: the tickets that pass (`passesFilters`) and the links between
 *  them. A ticket that does not pass is HIDDEN, not faded — and so is an outside ticket no longer joined
 *  to a shown sprint ticket by a shown link (it would float alone). Degrees are KEPT, so a ticket keeps
 *  its size while the rest close up round it. Groups are then listed over what is left (`groupList`), so a
 *  halo with nothing left in it goes too. Pure. */
export function filterGraph(
  g: VisibleGraph,
  f: SprintGraphFilters,
  members?: ReadonlyMap<string, Pick<SprintMember, 'names' | 'logins'>>,
): VisibleGraph {
  if (!filtersActive(f)) return g;
  const deps = dependencyIdents(g.edges);
  // ⚠ An OUTSIDE ticket is held to the SECTION filter only: it has no epic or theme, and the person
  // filter is about the sprint's work — filtering to one person must keep the outside ticket blocking
  // their work. It still shows only while linked to a sprint ticket that is shown (below).
  const keep = new Set(
    g.nodes
      .filter((n) => (n.ghost ? f.stages.size >= 4 || (n.stage != null && f.stages.has(n.stage)) : passesFilters(n, f, deps, members)))
      .map((n) => n.ident),
  );
  const edges = g.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
  }
  const shown = new Set(g.nodes.filter((n) => !n.ghost && keep.has(n.ident)).map((n) => n.ident));
  let frontier = [...shown];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const m of adj.get(id) ?? []) {
        if (shown.has(m)) continue;
        shown.add(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return { nodes: g.nodes.filter((n) => shown.has(n.ident)), edges: edges.filter((e) => shown.has(e.from) && shown.has(e.to)) };
}

/** A key that changes exactly when what the filters SHOW changes (the layout re-packs on it). */
export function filterKey(f: SprintGraphFilters): string {
  if (!filtersActive(f)) return '';
  return [[...f.stages].sort().join(','), f.assignee ?? '', f.epic ?? '', f.theme ?? '', f.hasPrs ? 1 : 0, f.hasDeps ? 1 : 0].join('|');
}

/** Toggle one section chip; turning the LAST one off turns them all back on. */
export function toggleStage(stages: ReadonlySet<SprintStage>, s: SprintStage): Set<SprintStage> {
  const next = new Set(stages);
  if (next.has(s)) next.delete(s);
  else next.add(s);
  return next.size === 0 ? new Set(NO_FILTERS.stages) : next;
}

/** The select options: members (assignees and PR authors, one per person), epics and themes present
 *  on the sprint's tickets. Themes largest first, then by name. */
export function filterOptions(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ghost' | 'assignee' | 'epic' | 'prs'> & Partial<Pick<SprintGraphNode, 'theme'>>>,
): {
  members: SprintMember[];
  anyUnassigned: boolean;
  epics: Array<{ key: string; title: string | null }>;
  anyNoEpic: boolean;
  themes: string[];
  anyNoTheme: boolean;
} {
  const epics = new Map<string, string | null>();
  const themes = new Map<string, number>();
  let anyUnassigned = false;
  let anyNoEpic = false;
  let anyNoTheme = false;
  for (const n of nodes) {
    if (n.ghost) continue;
    if (n.assignee == null) anyUnassigned = true;
    if (n.epic != null) {
      if (!epics.has(n.epic.key) || epics.get(n.epic.key) == null) epics.set(n.epic.key, n.epic.title);
    } else anyNoEpic = true;
    if (n.theme != null) themes.set(n.theme, (themes.get(n.theme) ?? 0) + 1);
    else anyNoTheme = true;
  }
  return {
    members: sprintMembers(nodes),
    anyUnassigned,
    epics: [...epics.entries()]
      .map(([key, title]) => ({ key, title }))
      .sort((a, b) => (a.title ?? a.key).localeCompare(b.title ?? b.key)),
    anyNoEpic,
    themes: [...themes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t),
    anyNoTheme: anyNoTheme && themes.size > 0,
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

/** A layout-space box. */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The box round a set of circles (rims included); null for none. The seam for framing ANY set of
 *  nodes — a selection with its links, a filtered group — as well as the whole canvas. Pure. */
export function boundsOf(points: ReadonlyArray<{ x: number; y: number; r: number }>): Bounds | null {
  if (points.length === 0) return null;
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
  return { minX, minY, maxX, maxY };
}

/** The transform that fits a box into a w × h viewport, leaving SCREEN room for the labels (drawn at a
 *  fixed screen size under each circle): `pad.x` either side, `pad.top` above, `pad.bottom` below. The
 *  zoom is capped at `maxK` (1.6). Pure. */
export function fitBox(
  b: Bounds | null,
  w: number,
  h: number,
  pad: { x: number; top: number; bottom: number } = { x: 64, top: 28, bottom: 48 },
  maxK = 1.6,
): ViewTransform {
  if (b == null || w <= 0 || h <= 0) return { k: 1, x: w / 2, y: h / 2 };
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const k = Math.max(ZOOM_MIN, Math.min(maxK, Math.min((w - 2 * pad.x) / bw, (h - pad.top - pad.bottom) / bh)));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { k, x: w / 2 - cx * k, y: (h + pad.top - pad.bottom) / 2 - cy * k };
}

/** The transform that fits every circle into a w × h viewport (`fitBox` over `boundsOf`). */
export function fitTransform(
  points: ReadonlyArray<{ x: number; y: number; r: number }>,
  w: number,
  h: number,
  pad: { x: number; top: number; bottom: number } = { x: 64, top: 28, bottom: 48 },
): ViewTransform {
  return fitBox(boundsOf(points), w, h, pad);
}

/** The horizontal span of the canvas a reader can SEE (canvas px, `x0`…`x1`) when something covers the
 *  screen from `coverLeft` (viewport px) rightwards — the ticket drawer, which opens from the right.
 *  `null` = nothing covers it. When the uncovered strip is narrower than `minWidth` (a phone, where the
 *  drawer is full width) the whole canvas is used: there is nowhere beside the drawer to frame into.
 *  Pure. */
export function uncoveredSpan(
  canvas: { left: number; width: number },
  coverLeft: number | null,
  minWidth = 240,
): { x0: number; x1: number } {
  const whole = { x0: 0, x1: Math.max(0, canvas.width) };
  if (coverLeft == null) return whole;
  const x1 = Math.min(canvas.width, Math.max(0, coverLeft - canvas.left));
  return x1 < minWidth ? whole : { x0: 0, x1 };
}

/** `fitBox` into a horizontal SPAN of a viewport h tall (`uncoveredSpan`). Pure. */
export function fitBoxIn(
  b: Bounds | null,
  span: { x0: number; x1: number },
  h: number,
  pad: { x: number; top: number; bottom: number } = { x: 64, top: 28, bottom: 48 },
  maxK = 1.6,
): ViewTransform {
  const t = fitBox(b, Math.max(1, span.x1 - span.x0), h, pad, maxK);
  return { ...t, x: t.x + span.x0 };
}

/** The ids given plus every ticket one DRAWN edge away from any of them. Pure. */
export function withNeighbours(edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'>>, ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  const base = new Set(out);
  for (const e of edges) {
    if (base.has(e.from)) out.add(e.to);
    if (base.has(e.to)) out.add(e.from);
  }
  return out;
}

// ── Motion ───────────────────────────────────────────────────────────────────────────────────────
// The graph moves only for a while: after it loads, after a re-layout (a grouping or visibility
// change) and after a drag, then it is STILL (`SETTLE_MS`). Reduced motion: no motion at all.

/** How long the canvas may move after load, a re-layout or a drag release (ms). */
export const SETTLE_MS = 5000;
/** The opening animation: tickets travel from another grouping into the chosen one (ms). */
export const INTRO_MS = 2000;
/** A re-layout's travel (ms). */
export const RELAYOUT_MS = 1100;
/** An animated zoom / pan (a ticket opened, a filter picked) (ms). */
export const VIEW_MS = 650;
/** The drift fades to nothing over the last this-many ms before the canvas stills. */
export const DRIFT_FADE_MS = 2000;

/** Ease in and out (quadratic), p in [0, 1]. Pure. */
export function easeInOut(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  return q < 0.5 ? 2 * q * q : 1 - (-2 * q + 2) ** 2 / 2;
}

/** The view part-way from a to b. Pure. */
export function lerpView(a: ViewTransform, b: ViewTransform, e: number): ViewTransform {
  return { k: a.k + (b.k - a.k) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}

/** How strong the drift is at `now`: full until the last `DRIFT_FADE_MS` before `liveUntil`, then
 *  fading to 0, so the canvas comes to rest instead of stopping mid-turn. Pure. */
export function driftScale(now: number, liveUntil: number, fadeMs = DRIFT_FADE_MS): number {
  if (now >= liveUntil) return 0;
  return Math.min(1, (liveUntil - now) / Math.max(1, fadeMs));
}

// ── A re-layout that lands mid-animation ────────────────────────────────────────────────────────
// ⚠ THE BUG THIS PREVENTS: a re-layout caused by refetched data (`layoutIntent` unchanged — the graph
// refetches on every return to This Sprint, and every 15 s while briefs land) HOLDS every ticket where
// it is. Arriving while a layout was still ANIMATING IN (the 2 s opening animation, a re-layout), it held
// them at their MID-FLIGHT positions — tickets half-way between two groupings, halos ringing half the
// canvas — and cancelled the animation that would have brought them to rest. Nothing moved them again
// until a reload. So a layout arriving mid-flight starts from where the old one LANDS, and keeps
// animating from where each ticket is DRAWN.

/** Where every drawn ticket "is" for a new layout: where the layout still animating in (`landing`, its
 *  tween's targets; null = none) puts it, else where it is drawn. Pure. */
export function restPositions(
  drawn: ReadonlyMap<string, { x: number; y: number }>,
  landing: ReadonlyMap<string, { x: number; y: number }> | null,
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  for (const [id, p] of drawn) out.set(id, landing?.get(id) ?? p);
  return out;
}

/** Whether a new layout animates in: never with reduced motion; a quiet (data-driven) one only when it
 *  interrupts a layout still animating — it must finish that journey, not freeze mid-flight. Pure. */
export function layoutAnimates(o: { reducedMotion: boolean; quiet: boolean; interrupted: boolean }): boolean {
  if (o.reducedMotion) return false;
  return !o.quiet || o.interrupted;
}

/** The travel time left for a quiet layout that takes over an interrupted animation (ms): what the old
 *  one had left, at least `minMs`. Pure. */
export function continuedTweenMs(now: number, tween: { start: number; dur: number }, minMs = 450): number {
  return Math.max(minMs, tween.start + tween.dur - now);
}

/** True when no two circles overlap by more than `slack` of their radii (`(ra + rb) * (1 - slack)`). */
export function noOverlaps(points: ReadonlyArray<{ x: number; y: number; r: number }>, slack = 0.15): boolean {
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const a = points[i] as { x: number; y: number; r: number };
      const b = points[j] as { x: number; y: number; r: number };
      if (Math.hypot(a.x - b.x, a.y - b.y) < (a.r + b.r) * (1 - slack)) return false;
    }
  }
  return true;
}

// ── The refresh bar ──────────────────────────────────────────────────────────────────────────────
// A thin bar across the top of the canvas while the graph is being brought up to date. It says only
// what the page KNOWS: a sprint read was asked for and has not finished (`read.checkedAt` has not moved
// since Refresh), the first read is running, or the graph is refetching — an indeterminate bar, since
// none of those reports progress. Briefs report counts (`briefs.current` / `pending`), so while they
// are being written the bar is DETERMINATE: the share of tickets summarised.

export type SprintProgress = { kind: 'busy'; label: string } | { kind: 'share'; label: string; value: number } | null;

/** The refresh bar's state. Pure. */
export function sprintProgress(o: {
  /** Refresh pressed and the read it asked for has not finished. */
  awaitingRead: boolean;
  /** The first sprint read has not finished. */
  firstRead: boolean;
  /** The graph is refetching (debounced by the page, so a quick poll does not flash it). */
  fetching: boolean;
  /** Briefs, when AI is on. */
  briefs: { current: number; pending: number } | null;
  /** The sprint builder is running now (`pathsStatus.state === 'writing'`). */
  pathsWriting?: boolean;
}): SprintProgress {
  if (o.awaitingRead || o.firstRead) return { kind: 'busy', label: 'Reading the sprint' };
  if (o.fetching) return { kind: 'busy', label: 'Refreshing the graph' };
  const b = o.briefs;
  if (b != null && b.pending > 0) {
    const total = b.current + b.pending;
    return { kind: 'share', label: 'Summarising tickets', value: total > 0 ? b.current / total : 0 };
  }
  if (o.pathsWriting === true) return { kind: 'busy', label: 'Finding the critical paths' };
  return null;
}

/** The grouping the opening animation starts FROM: Epic, unless Epic is the chosen one — then Theme
 *  (when themes exist), else Section. Pure. */
export function introGroupMode(mode: SprintGroupMode, themesAvailable: boolean): SprintGroupMode {
  if (mode !== 'epic') return 'epic';
  return themesAvailable ? 'theme' : 'section';
}

/** Where each ticket starts the opening animation: seeded (sunflower) inside its group's anchor in the
 *  intro grouping (`introGroupMode`); a ticket in no group starts on a ring just outside them all.
 *  Deterministic. Pure. */
export function introSeeds(
  idents: readonly string[],
  groupOf: ReadonlyMap<string, string | null>,
  anchors: ReadonlyMap<string, GroupAnchor>,
): Map<string, { x: number; y: number }> {
  const count = new Map<string, number>();
  for (const id of idents) {
    const g = groupOf.get(id);
    if (g != null && anchors.has(g)) count.set(g, (count.get(g) ?? 0) + 1);
  }
  let extent = 120;
  for (const a of anchors.values()) extent = Math.max(extent, Math.hypot(a.x, a.y) + a.r);
  const seat = new Map<string, number>();
  const loose = idents.filter((id) => {
    const g = groupOf.get(id);
    return g == null || !anchors.has(g);
  });
  const out = new Map<string, { x: number; y: number }>();
  for (const id of idents) {
    const g = groupOf.get(id);
    const a = g != null ? anchors.get(g) : undefined;
    if (g == null || a == null) continue;
    const j = seat.get(g) ?? 0;
    seat.set(g, j + 1);
    const rr = a.r * 0.8 * Math.sqrt((j + 0.5) / Math.max(1, count.get(g) ?? 1));
    out.set(id, { x: Math.round(a.x + Math.cos(j * 2.39996) * rr), y: Math.round(a.y + Math.sin(j * 2.39996) * rr) });
  }
  loose.forEach((id, i) => {
    const t = (2 * Math.PI * i) / Math.max(1, loose.length);
    out.set(id, { x: Math.round(Math.cos(t) * (extent + 60)), y: Math.round(Math.sin(t) * (extent + 60)) });
  });
  return out;
}

/** How much a node's DISC is enlarged when zoomed out, so a far view still shows the tickets: 1 at
 *  zoom ≥ 0.75, growing as 0.75 / zoom, at most 2. */
export function discScale(k: number): number {
  return Math.min(DISC_SCALE_MAX, Math.max(1, 0.75 / Math.max(1e-3, k)));
}

/** The most a disc is ever enlarged (`discScale` far out). The forces that keep halos apart, and Fit,
 *  size halos at this scale, so halos drawn round the enlarged discs never overlap at any zoom. */
export const DISC_SCALE_MAX = 2;
export const HALO_LAYOUT_SCALE = DISC_SCALE_MAX;

/** A ticket's radius AS DRAWN at disc scale `s` (layout units): the disc plus half the thickest ring,
 *  both enlarged about the centre. Halos are sized from this, so they contain the drawn tickets. */
export function drawnRadius(r: number, s: number): number {
  return (r + ringWidth(false, true) / 2) * s;
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

export type SprintGroupMode = 'epic' | 'theme' | 'section' | 'dependencies' | 'none';
export const SPRINT_GROUP_MODES: readonly SprintGroupMode[] = ['epic', 'theme', 'section', 'dependencies', 'none'];
export const SPRINT_GROUP_MODE_LABEL: Record<SprintGroupMode, string> = {
  epic: 'Epic',
  theme: 'Theme',
  section: 'Section',
  dependencies: 'Dependencies',
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
  dependencies: 'Standalone',
};

/** The mode actually drawn: "Theme" without themes draws as Epic (derived, never written back — the
 *  stored choice, or the Theme default, survives until themes exist). */
export function effectiveGroupMode(choice: SprintGroupMode, themesAvailable: boolean): SprintGroupMode {
  return choice === 'theme' && !themesAvailable ? THEMELESS_GROUP_MODE : choice;
}

/** A SPRINT ticket's own group key (null when not grouping). A dependency chain is a property of the
 *  EDGES, not of one ticket: `assignGroups` works it out (`dependencyChains`); here it is Standalone. */
export function groupKeyOf(n: Pick<SprintGraphNode, 'epic' | 'theme' | 'stage'>, mode: SprintGroupMode): string | null {
  switch (mode) {
    case 'dependencies':
      return NO_GROUP;
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
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'ghost' | 'epic' | 'theme' | 'stage'> & Partial<Pick<SprintGraphNode, 'key'>>>,
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'> & Partial<Pick<SprintGraphEdge, 'kind'>>>,
  mode: SprintGroupMode,
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (mode === 'dependencies') {
    // Every ticket in a chain — an outside one too — is in its chain's group; the rest are Standalone.
    const { chainOf } = dependencyChains(nodes, edges);
    for (const n of nodes) out.set(n.ident, chainOf.get(n.ident) ?? NO_GROUP);
    return out;
  }
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
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'epic' | 'ghost'> & Partial<Pick<SprintGraphNode, 'key' | 'title'>>>,
  groupOf: ReadonlyMap<string, string | null>,
  mode: SprintGroupMode,
): SprintGroup[] {
  if (mode === 'none') return [];
  const counts = new Map<string, number>();
  const drawn = new Map<string, number>();
  const epicTitle = new Map<string, string | null>();
  const byIdent = new Map(nodes.map((n) => [n.ident, n]));
  for (const n of nodes) {
    const g = groupOf.get(n.ident);
    if (g == null) continue;
    drawn.set(g, (drawn.get(g) ?? 0) + 1);
    // A chain is its tickets, outside ones included (a chain may lie wholly outside the sprint).
    if (n.ghost && mode !== 'dependencies') continue;
    counts.set(g, (counts.get(g) ?? 0) + 1);
    if (n.epic != null && (epicTitle.get(n.epic.key) ?? null) == null) epicTitle.set(n.epic.key, n.epic.title);
  }
  const label = (k: string): string => {
    if (k === NO_GROUP) return NO_GROUP_LABEL[mode];
    if (mode === 'epic') return epicTitle.get(k) ?? k;
    if (mode === 'section') return SPRINT_STAGE_LABEL[k as SprintStage] ?? k;
    if (mode === 'dependencies') {
      const root = byIdent.get(chainRootOf(k) ?? '');
      return chainLabel(root?.title ?? '', root?.key ?? chainRootOf(k) ?? k);
    }
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

// ── Group by Dependencies: one halo per dependency CHAIN ──────────────────────────────────────────
//
// A chain is a connected set of tickets over `depends_on` links ONLY (either direction — a tracker
// blocking link is one), outside tickets included. Inside its halo a chain reads LEFT → RIGHT like a
// timeline: prerequisites first. A ticket's LAYER is the longest path down to a ticket that depends on
// nothing; a loop (A needs B needs A) is broken at the link that closes it, deterministically, so every
// ticket still gets a layer. Tickets in no chain sit together in one "Standalone" halo. The chain is
// named after the ticket most others in it depend on.

const CHAIN_PREFIX = 'chain:';

/** The key of the chain whose root is `root`. */
export function chainKey(root: string): string {
  return `${CHAIN_PREFIX}${root}`;
}

/** The root ident a chain key names; null for any other key. */
export function chainRootOf(key: string): string | null {
  return key.startsWith(CHAIN_PREFIX) ? key.slice(CHAIN_PREFIX.length) : null;
}

/** "Chain: Sign in with a magic link" (the root's title, else its key). The title keeps the WHOLE
 *  group-label budget — the prefix is extra (`groupLabelMax`) — because the name is the only thing
 *  saying what a chain is about. */
export function chainLabel(title: string, key: string): string {
  const t = title.trim();
  return `Chain: ${t !== '' ? truncateLabel(t, GROUP_LABEL_MAX) : key}`;
}

/** The drawn group name's character budget: a chain's "Chain: " prefix does not eat its title's room. */
export function groupLabelMax(groupKey: string): number {
  return chainRootOf(groupKey) != null ? GROUP_LABEL_MAX + 'Chain: '.length : GROUP_LABEL_MAX;
}

const natural = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });

/** Each ticket's layer within its depends_on links: 0 = depends on nothing; else one more than the
 *  deepest ticket it depends on. Loops are broken deterministically (tickets and links visited in
 *  `order`, a link back into the path being walked is dropped). Returns the layers and the links kept.
 *  Pure. */
export function dependencyLayers(
  idents: readonly string[],
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'>>,
  order: (a: string, b: string) => number = natural,
): { layer: Map<string, number>; kept: Array<{ from: string; to: string }> } {
  const set = new Set(idents);
  const needs = new Map<string, string[]>();
  for (const e of edges) {
    if (!set.has(e.from) || !set.has(e.to) || e.from === e.to) continue;
    const l = needs.get(e.from);
    if (l == null) needs.set(e.from, [e.to]);
    else if (!l.includes(e.to)) l.push(e.to);
  }
  for (const l of needs.values()) l.sort(order);
  const sorted = [...set].sort(order);
  // Drop back links (iterative DFS: white 0, on the path 1, done 2).
  const colour = new Map<string, number>();
  const kept: Array<{ from: string; to: string }> = [];
  for (const s of sorted) {
    if ((colour.get(s) ?? 0) !== 0) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: s, i: 0 }];
    colour.set(s, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: string; i: number };
      const next = needs.get(top.id)?.[top.i];
      if (next == null) {
        colour.set(top.id, 2);
        stack.pop();
        continue;
      }
      top.i += 1;
      const c = colour.get(next) ?? 0;
      if (c === 1) continue; // closes a loop: dropped
      kept.push({ from: top.id, to: next });
      if (c === 0) {
        colour.set(next, 1);
        stack.push({ id: next, i: 0 });
      }
    }
  }
  const keptNeeds = new Map<string, string[]>();
  for (const e of kept) keptNeeds.set(e.from, [...(keptNeeds.get(e.from) ?? []), e.to]);
  const layer = new Map<string, number>();
  const depth = (id: string): number => {
    const known = layer.get(id);
    if (known != null) return known;
    // Iterative post-order (a chain can be long).
    const stack = [id];
    while (stack.length > 0) {
      const cur = stack[stack.length - 1] as string;
      const pending = (keptNeeds.get(cur) ?? []).filter((p) => !layer.has(p));
      if (pending.length > 0) {
        stack.push(...pending);
        continue;
      }
      stack.pop();
      if (!layer.has(cur)) layer.set(cur, (keptNeeds.get(cur) ?? []).reduce((m, p) => Math.max(m, (layer.get(p) ?? 0) + 1), 0));
    }
    return layer.get(id) ?? 0;
  };
  for (const s of sorted) depth(s);
  return { layer, kept };
}

/** The dependency chains: every ticket in one (two or more tickets joined by `depends_on` links, either
 *  direction) → its chain key, named by its ROOT — the ticket most others in it depend on (ties: a
 *  sprint ticket, then the earliest layer, then the key). Pure. */
export function dependencyChains(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'ghost'> & Partial<Pick<SprintGraphNode, 'key'>>>,
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'> & Partial<Pick<SprintGraphEdge, 'kind'>>>,
): { chainOf: Map<string, string>; members: Map<string, string[]> } {
  const present = new Map(nodes.map((n) => [n.ident, n]));
  const deps = edges.filter((e) => (e.kind ?? 'depends_on') === 'depends_on' && e.from !== e.to && present.has(e.from) && present.has(e.to));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) != null && parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (c !== r) {
      const nx = parent.get(c) as string;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const e of deps) {
    if (!parent.has(e.from)) parent.set(e.from, e.from);
    if (!parent.has(e.to)) parent.set(e.to, e.to);
    const a = find(e.from);
    const b = find(e.to);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const comps = new Map<string, string[]>();
  for (const n of nodes) {
    if (!parent.has(n.ident)) continue;
    const r = find(n.ident);
    comps.set(r, [...(comps.get(r) ?? []), n.ident]);
  }
  const keyOf = (id: string): string => present.get(id)?.key ?? id;
  const order = (a: string, b: string): number => natural(keyOf(a), keyOf(b)) || natural(a, b);
  const chainOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const ids of comps.values()) {
    if (ids.length < 2) continue;
    const inSet = new Set(ids);
    const indeg = new Map<string, number>();
    for (const e of deps) if (inSet.has(e.to)) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const { layer } = dependencyLayers(ids, deps, order);
    const root = [...ids].sort(
      (a, b) =>
        (indeg.get(b) ?? 0) - (indeg.get(a) ?? 0) ||
        Number(present.get(a)?.ghost === true) - Number(present.get(b)?.ghost === true) ||
        (layer.get(a) ?? 0) - (layer.get(b) ?? 0) ||
        order(a, b),
    )[0] as string;
    const k = chainKey(root);
    members.set(k, [...ids].sort(order));
    for (const id of ids) chainOf.set(id, k);
  }
  return { chainOf, members };
}

/** Columns and rows of a chain's layout (layout units): wide enough for a ticket and its name. */
export const CHAIN_COL = 190;
export const CHAIN_ROW = 120;

export interface ChainLayout {
  /** The chain's room: a circle round its columns. */
  r: number;
  /** Each ticket's spot, as an offset from the chain's anchor. */
  offsets: Map<string, { x: number; y: number }>;
  layer: Map<string, number>;
}

/** A chain laid out as a timeline: one COLUMN per layer, prerequisites on the left, each column stacked
 *  top to bottom (ordered by where the tickets they depend on sit, so links cross less; then by key),
 *  centred on the anchor. Pure. */
export function chainLayout(
  idents: readonly string[],
  edges: ReadonlyArray<Pick<SprintGraphEdge, 'from' | 'to'> & Partial<Pick<SprintGraphEdge, 'kind'>>>,
  keyOf: (ident: string) => string = (id) => id,
): ChainLayout {
  const order = (a: string, b: string): number => natural(keyOf(a), keyOf(b)) || natural(a, b);
  const deps = edges.filter((e) => (e.kind ?? 'depends_on') === 'depends_on');
  const { layer, kept } = dependencyLayers(idents, deps, order);
  const cols: string[][] = [];
  for (const id of [...idents].sort(order)) {
    const l = layer.get(id) ?? 0;
    while (cols.length <= l) cols.push([]);
    (cols[l] as string[]).push(id);
  }
  const row = new Map<string, number>();
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const bary = (id: string): number => {
        const ps = kept.filter((e) => e.from === id && row.has(e.to)).map((e) => row.get(e.to) as number);
        return ps.length === 0 ? Infinity : ps.reduce((a, b) => a + b, 0) / ps.length;
      };
      const b = new Map(col.map((id) => [id, bary(id)]));
      col.sort((x, y) => (b.get(x) as number) - (b.get(y) as number) || order(x, y));
    }
    col.forEach((id, i) => row.set(id, i - (col.length - 1) / 2));
  });
  const offsets = new Map<string, { x: number; y: number }>();
  const mid = (cols.length - 1) / 2;
  for (const [id, r] of row) offsets.set(id, { x: Math.round(((layer.get(id) ?? 0) - mid) * CHAIN_COL), y: Math.round(r * CHAIN_ROW) });
  const tallest = cols.reduce((m, c) => Math.max(m, c.length), 1);
  const halfW = (mid * CHAIN_COL);
  const halfH = ((tallest - 1) / 2) * CHAIN_ROW;
  const r = Math.max(groupRadius(idents.length), Math.round(Math.hypot(halfW, halfH) + 70));
  return { r, offsets, layer };
}

/** A group's anchor radius: its AREA grows with its member count — room for `count` tickets at the
 *  in-group collide spacing (`collidePadding`), labels included. */
export function groupRadius(count: number): number {
  const n = Math.max(1, count);
  // Each ticket's share: a disc of (typical radius + collide padding), packed at ~75%.
  return Math.round(Math.sqrt(n / 0.75) * (collidePadding(true, n) + 20) + 16);
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
  groups: ReadonlyArray<Pick<SprintGroup, 'key' | 'count'> & { drawn?: number; radius?: number }>,
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
    place(g.key, g.radius ?? groupRadius(g.drawn ?? g.count), 0);
  }
  const noGroup = groups.find((g) => g.key === NO_GROUP);
  if (noGroup != null) {
    const r = noGroup.radius ?? groupRadius(noGroup.drawn ?? noGroup.count);
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
 *  rim plus a margin). `extras` (the assignee badges poking past their discs) widen the halo without moving
 *  its centre. null for no members. Pure. */
export function groupHalo(
  points: ReadonlyArray<{ x: number; y: number; r: number }>,
  margin = 16,
  extras: ReadonlyArray<{ x: number; y: number; r: number }> = [],
): { x: number; y: number; r: number } | null {
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
  for (const p of extras) r = Math.max(r, Math.hypot(p.x - x, p.y - y) + p.r);
  return { x, y, r: r + margin };
}

/** A ticket's assignee badge as a layout-space circle, at disc scale `s` and badge scale `bs`. Pure. */
export function badgeCircle(x: number, y: number, r: number, s: number, bs: number): { x: number; y: number; r: number } {
  const c = badgeCentre(r, bs);
  return { x: x + c.x * s, y: y + c.y * s, r: (BADGE_R + 1) * bs * s };
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

// ── Split by status: sub-groups inside each epic / theme ─────────────────────────────────────────
//
// "Split by status" (Epic or Theme only) divides each group into up to four SUB-GROUPS, one per section
// (Not started · In progress · In review · Complete), laid out LEFT TO RIGHT in that fixed order inside the
// group's room, each behind a faint halo tinted with its section's ring colour and named small. A ticket
// whose status is not known sits in a fifth, "Status unknown", after Complete (only when there is one). A
// ghost goes in its OWN status's sub-group of the group it inherits.

export type StatusSlot = SprintStage | 'unknown';
export const STATUS_SLOTS: readonly StatusSlot[] = [...SPRINT_STAGES, 'unknown'];
export const STATUS_SLOT_LABEL: Record<StatusSlot, string> = { ...SPRINT_STAGE_LABEL, unknown: 'Status unknown' };

/** Only an Epic or Theme grouping splits (a Section grouping already IS the statuses). */
export function canSplitByStatus(mode: SprintGroupMode): boolean {
  return mode === 'epic' || mode === 'theme';
}

export function statusSlotOf(stage: SprintStage | null): StatusSlot {
  return stage ?? 'unknown';
}

const SUB_SEP = '\u241f';

/** A sub-group's key: its group and its status. */
export function subGroupKey(group: string, slot: StatusSlot): string {
  return `${group}${SUB_SEP}${slot}`;
}

/** The DRAWN members per group, per status slot (ghosts included — they take room). Pure. */
export function subGroupCounts(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'stage'>>,
  groupOf: ReadonlyMap<string, string | null>,
): Map<string, Map<StatusSlot, number>> {
  const out = new Map<string, Map<StatusSlot, number>>();
  for (const n of nodes) {
    const g = groupOf.get(n.ident);
    if (g == null) continue;
    const slot = statusSlotOf(n.stage);
    let m = out.get(g);
    if (m == null) {
      m = new Map();
      out.set(g, m);
    }
    m.set(slot, (m.get(slot) ?? 0) + 1);
  }
  return out;
}

/** The gap (layout units) between two sub-groups' rooms. */
export const SUB_GAP = 28;

export interface StatusSplit {
  /** The group's whole room: a circle round the row of sub-groups. */
  r: number;
  /** Each present slot's room, as an offset from the group's anchor, left to right in slot order. */
  subs: Map<StatusSlot, GroupAnchor>;
}

/** The sub-groups' rooms inside one group: a row, in STATUS_SLOTS order, each sized like a group of its
 *  own count (`groupRadius`), centred on the group's anchor. Pure. */
export function statusSplitLayout(
  counts: ReadonlyMap<StatusSlot, number>,
  /** A slot's room when it is split again (by assignee): `PersonSplit.r`; else sized by its count. */
  roomOf?: (slot: StatusSlot) => number | undefined,
): StatusSplit {
  const present = STATUS_SLOTS.filter((s) => (counts.get(s) ?? 0) > 0);
  const radii = present.map((s) => roomOf?.(s) ?? groupRadius(counts.get(s) ?? 1));
  const width = radii.reduce((a, r) => a + 2 * r, 0) + SUB_GAP * Math.max(0, present.length - 1);
  const subs = new Map<StatusSlot, GroupAnchor>();
  let x = -width / 2;
  present.forEach((s, i) => {
    const r = radii[i] as number;
    subs.set(s, { x: Math.round(x + r), y: 0, r });
    x += 2 * r + SUB_GAP;
  });
  const tallest = radii.reduce((a, r) => Math.max(a, r), 0);
  return { r: Math.round(Math.max(width / 2, tallest) + 8), subs };
}

/** Every sub-group's anchor in layout space: its group's anchor plus its offset. Pure. */
export function subGroupAnchors(
  anchors: ReadonlyMap<string, GroupAnchor>,
  splits: ReadonlyMap<string, StatusSplit>,
): Map<string, GroupAnchor> {
  const out = new Map<string, GroupAnchor>();
  for (const [g, split] of splits) {
    const a = anchors.get(g);
    if (a == null) continue;
    for (const [slot, o] of split.subs) out.set(subGroupKey(g, slot), { x: a.x + o.x, y: a.y + o.y, r: o.r });
  }
  return out;
}

/** The circle round a set of circles (the group's halo round its sub-group halos), from the centre of
 *  their box, plus a margin. null for none. Pure. */
export function enclosingHalo(circles: ReadonlyArray<{ x: number; y: number; r: number }>, margin = 14): { x: number; y: number; r: number } | null {
  const b = boundsOf(circles);
  if (b == null) return null;
  const x = (b.minX + b.maxX) / 2;
  const y = (b.minY + b.maxY) / 2;
  let r = 0;
  for (const c of circles) r = Math.max(r, Math.hypot(c.x - x, c.y - y) + c.r);
  return { x, y, r: r + margin };
}

/** A sub-group halo's look: its section's ring colour, faint. The name is drawn in the ring colour
 *  (measured by textContrast.test against the ground lightened by both halos' fills). */
export const SUB_HALO = {
  fillAlpha: 0.05,
  strokeAlpha: 0.4,
} as const;

/** A sub-group halo's tint: its section's ring colour. */
export function subHaloColour(slot: StatusSlot): string {
  return slot === 'unknown' ? STAGE_RING_UNKNOWN : STAGE_RING[slot];
}

/** The unknown slot's name colour: the slate ring is too dark for 11px text on navy. */
export const STAGE_RING_UNKNOWN_LABEL = '#94a3b8';

/** A sub-group's NAME colour: the ring colour, except the unknown slot's (too dark for text). */
export function subLabelColour(slot: StatusSlot): string {
  return slot === 'unknown' ? STAGE_RING_UNKNOWN_LABEL : STAGE_RING[slot];
}

/** A sub-group name's box size on screen (11px semibold — the label floor). */
export function subLabelSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(textWidth(text, 11) + 6), h: 15 };
}

/** The slot a sub-group key names (`subGroupKey`), or null for a plain group key. */
export function slotOfSubKey(key: string): StatusSlot | null {
  const i = key.lastIndexOf(SUB_SEP);
  if (i < 0) return null;
  const s = key.slice(i + 1);
  return (STATUS_SLOTS as readonly string[]).includes(s) ? (s as StatusSlot) : null;
}

export const SPLIT_STORAGE_KEY = 'sprint-graph-split-status';

/** The stored "Split by status" choice (off by default); anything unreadable → off. */
export function readSplitStatus(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(SPLIT_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSplitStatus(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    if (on) storage?.setItem(SPLIT_STORAGE_KEY, '1');
    else storage?.removeItem(SPLIT_STORAGE_KEY);
  } catch {
    /* the choice lasts the visit */
  }
}

// ── Split by assignee: one small PERSON halo per assignee, one level deeper ──────────────────────
//
// "Assigned to" (any grouping but None) divides each group — or, with "Split by status" on too, each
// status sub-group — into one room per ASSIGNEE, each behind a faint NEUTRAL halo (so the status tint
// still reads) named with the person. A person is the Members filter's identity (`sprintMembers`, so
// "Johny Farrar" and "johny.farrar" are one halo) and named as it is there; a ticket with no assignee —
// or a ghost whose assignee is not known — sits in "Unassigned", always last.

/** Any grouping splits by person — Section too (status, then person); None has no circle to split, and
 *  a dependency chain is laid out in its own order (a timeline), which a person split would break. */
export function canSplitByAssignee(mode: SprintGroupMode): boolean {
  return mode !== 'none' && mode !== 'dependencies';
}

/** The person room key for "no assignee". */
export const PERSON_UNASSIGNED = 'unassigned';
export const PERSON_UNASSIGNED_LABEL = 'Unassigned';
/** A person halo's name, truncated past this many characters. */
export const PERSON_LABEL_MAX = 24;

/** A ticket's person: the member identity its assignee folds into (`p:<name key>`, as `sprintMembers`
 *  spells it) and that member's label; else the assignee's own name; none → Unassigned. Pure. */
export function personOf(
  assignee: { name: string } | null | undefined,
  members?: ReadonlyMap<string, Pick<SprintMember, 'label'>>,
): { key: string; label: string } {
  const name = assignee?.name.trim() ?? '';
  if (name === '') return { key: PERSON_UNASSIGNED, label: PERSON_UNASSIGNED_LABEL };
  const key = `p:${personNameKey(name)}`;
  return { key, label: members?.get(key)?.label ?? name };
}

const PERSON_SEP = '␞';

/** A person room's key: its parent room (a group, or a status sub-group) and the person. */
export function personRoomKey(parent: string, person: string): string {
  return `${parent}${PERSON_SEP}${person}`;
}

/** The parent room and person a person room key names; null for any other key. */
export function splitPersonRoomKey(key: string): { parent: string; person: string } | null {
  const i = key.lastIndexOf(PERSON_SEP);
  return i < 0 ? null : { parent: key.slice(0, i), person: key.slice(i + 1) };
}

/** The DRAWN members per parent room, per person (ghosts included — they take room). Pure. */
export function personGroupCounts(
  nodes: ReadonlyArray<Pick<SprintGraphNode, 'ident' | 'assignee'>>,
  parentOf: (ident: string) => string | null,
  members?: ReadonlyMap<string, Pick<SprintMember, 'label'>>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const n of nodes) {
    const p = parentOf(n.ident);
    if (p == null) continue;
    const { key } = personOf(n.assignee, members);
    let m = out.get(p);
    if (m == null) {
      m = new Map();
      out.set(p, m);
    }
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return out;
}

/** The gap (layout units) between two person rooms. */
export const PERSON_GAP = 22;

export interface PersonSplit {
  /** The parent's whole room: a circle round its person rooms. */
  r: number;
  /** Each person's room, as an offset from the parent's anchor. */
  subs: Map<string, GroupAnchor>;
}

/** The person rooms inside one parent: the busiest first, Unassigned last, in rows of about √n, each
 *  sized like a group of its own count (`groupRadius`), centred on the parent's anchor. Pure. */
export function personSplitLayout(counts: ReadonlyMap<string, number>, labelOf: (key: string) => string = (k) => k): PersonSplit {
  const keys = [...counts.keys()]
    .filter((k) => (counts.get(k) ?? 0) > 0)
    .sort((a, b) => {
      if ((a === PERSON_UNASSIGNED) !== (b === PERSON_UNASSIGNED)) return a === PERSON_UNASSIGNED ? 1 : -1;
      return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || labelOf(a).localeCompare(labelOf(b)) || a.localeCompare(b);
    });
  const subs = new Map<string, GroupAnchor>();
  if (keys.length === 0) return { r: 0, subs };
  const cols = Math.ceil(Math.sqrt(keys.length));
  const rows: string[][] = [];
  for (let i = 0; i < keys.length; i += cols) rows.push(keys.slice(i, i + cols));
  const radius = (k: string): number => groupRadius(counts.get(k) ?? 1);
  const rowH = rows.map((row) => row.reduce((a, k) => Math.max(a, radius(k)), 0));
  const height = rowH.reduce((a, h) => a + 2 * h, 0) + PERSON_GAP * (rows.length - 1);
  let y = -height / 2;
  rows.forEach((row, ri) => {
    const h = rowH[ri] as number;
    const width = row.reduce((a, k) => a + 2 * radius(k), 0) + PERSON_GAP * (row.length - 1);
    let x = -width / 2;
    for (const k of row) {
      const r = radius(k);
      subs.set(k, { x: Math.round(x + r), y: Math.round(y + h), r });
      x += 2 * r + PERSON_GAP;
    }
    y += 2 * h + PERSON_GAP;
  });
  let r = 0;
  for (const o of subs.values()) r = Math.max(r, Math.hypot(o.x, o.y) + o.r);
  return { r: Math.round(r + 8), subs };
}

/** Every person room's anchor in layout space: its parent's anchor plus its offset. Pure. */
export function personRoomAnchors(
  parentAnchors: ReadonlyMap<string, GroupAnchor>,
  splits: ReadonlyMap<string, PersonSplit>,
): Map<string, GroupAnchor> {
  const out = new Map<string, GroupAnchor>();
  for (const [p, split] of splits) {
    const a = parentAnchors.get(p);
    if (a == null) continue;
    for (const [person, o] of split.subs) out.set(personRoomKey(p, person), { x: a.x + o.x, y: a.y + o.y, r: o.r });
  }
  return out;
}

/** A person halo's look: neutral and fainter than a status halo, so the status tint still reads. The
 *  name is measured by textContrast.test against the ground lightened by all three halos' fills. */
export const PERSON_HALO = {
  fill: '#ffffff',
  fillAlpha: 0.03,
  stroke: '#cbd5e1',
  strokeAlpha: 0.3,
  label: '#cbd5e1',
} as const;

/** A person name's box size on screen (11px semibold — the label floor). */
export function personLabelSize(text: string): { w: number; h: number } {
  return { w: Math.ceil(textWidth(text, 11) + 6), h: 15 };
}

export const SPLIT_ASSIGNEE_STORAGE_KEY = 'sprint-graph-split-assignee';

/** The stored "Split by assignee" choice (off by default); anything unreadable → off. */
export function readSplitAssignee(storage: StorageLike | null | undefined): boolean {
  try {
    return storage?.getItem(SPLIT_ASSIGNEE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSplitAssignee(storage: StorageLike | null | undefined, on: boolean): void {
  try {
    if (on) storage?.setItem(SPLIT_ASSIGNEE_STORAGE_KEY, '1');
    else storage?.removeItem(SPLIT_ASSIGNEE_STORAGE_KEY);
  } catch {
    /* the choice lasts the visit */
  }
}

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
// zoom. ⚠ Hover, focus and selection only REVEAL a hidden label (`LabelItem.reveal`) — they never
// change a shown label's side or anyone's priority, so nothing jumps under the pointer.

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
  /** Hovered, focused or selected: REVEALED if it has no spot, never moved and never given priority.
   *  Its side is decided exactly as if it were not revealed; only a label that would be hidden is
   *  then shown — after every other label is placed, so none of them moves — at the side it had
   *  (else the first side clear of the others). Hover must never move a label (a promoted label
   *  placed FIRST took the best free side and jumped, and pushed others out of theirs). */
  reveal?: boolean;
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
  // Revealed labels with no spot: shown ON TOP (the canvas draws them last), without moving any other.
  for (const { it } of order) {
    if (it.reveal !== true || out.get(it.id) !== 'none') continue;
    const prev = it.prev != null && it.prev !== 'none' ? it.prev : null;
    let chosen: LabelSide | null = prev;
    if (chosen == null) {
      for (const shrink of [1, 0.55, 0]) {
        const s = LABEL_SIDES.find((side) => free(labelBox(it, side), it.id, shrink));
        if (s != null) {
          chosen = s;
          break;
        }
      }
    }
    const side = chosen ?? 'below';
    out.set(it.id, side);
    placed.push(labelBox(it, side));
  }
  return out;
}

// ── The wheel and touch: the wheel zooms ─────────────────────────────────────────────────────────

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

// ── Halo names: inside the top of their own halo ─────────────────────────────────────────────────
//
// Every halo's name (a group's, a status sub-group's, a person room's) sits JUST INSIDE THE TOP of its own
// halo, centred on the chord, so a zoom into one group keeps its name on screen. The halo makes ROOM for
// it: its top is raised by the name's height plus the depth where the chord is wide enough (`haloNameRoom`),
// so the name never sits on a ticket or on a child halo. The name is drawn at a constant SCREEN size, so the
// room is worked out in screen px and converted to layout units at each zoom (the halos are recomputed per
// zoom anyway). A long name is cut with an ellipsis to the chord; a halo too small on screen for even a
// short name makes no room and shows no name until a zoom gives it one.

/** px between the name's box and the halo's contents below it. */
export const HALO_NAME_GAP = 3;
/** px between the rim and the box's top corners (the dashed stroke, and breathing room). */
export const HALO_NAME_RIM = 2;
/** The deepest the box's top may sit below the rim, as a fraction of the halo's radius: a wider name is
 *  cut, rather than the halo bulging for it. */
export const HALO_NAME_DEPTH = 0.3;
/** A chord narrower than this shows no name at all (and the halo makes no room). */
export const HALO_NAME_MIN_W = 44;
/** The most room a halo makes, as a fraction of its radius on screen: a halo too small on screen for its
 *  name hides the name rather than ballooning round it (the halos nest, so a bulge compounds). */
export const HALO_NAME_MAX_PAD = 0.75;
/** The zoom the FORCES make room at for the GROUP names (about Fit's, so the groups' names show there):
 *  the room is screen px over the zoom, so it is largest zoomed out. */
export const HALO_NAME_LAYOUT_ZOOM = 0.4;
/** …and for the status and person names inside a group, which show once zoomed in: room for them at
 *  Fit's zoom would balloon every nested halo (the room compounds level by level). */
export const HALO_SUBNAME_LAYOUT_ZOOM = 1;

/** The room a halo makes for its name, in screen px: `pad` raises the halo's top (`withNameRoom`); the
 *  name's box top sits `depth` below the new rim, `width` wide at most (the chord there). */
export interface HaloNameRoom {
  pad: number;
  depth: number;
  width: number;
}

/** The room for a `w`×`h` name inside the top of a halo of screen radius `r` (before the room). null when
 *  even a short name cannot fit. The box always fits the chord at its depth and ends `HALO_NAME_GAP` above
 *  the old halo's top, which holds every ticket and child halo. Pure. */
export function haloNameRoom(r: number, w: number, h: number): HaloNameRoom | null {
  if (!(r > 0) || !(w > 0)) return null;
  // The deepest the box may sit and still leave the room within `HALO_NAME_MAX_PAD`.
  const deepest = HALO_NAME_MAX_PAD * r - h - HALO_NAME_GAP;
  if (deepest < HALO_NAME_RIM) return null;
  const rimOf = (R: number, depth: number): number => {
    const inner = (R - HALO_NAME_RIM) ** 2 - (R - depth) ** 2;
    return inner > 0 ? 2 * Math.sqrt(inner) : 0;
  };
  let depth = HALO_NAME_RIM;
  for (let i = 0; i < 8; i += 1) {
    const R = r + (depth + h + HALO_NAME_GAP) / 2;
    const inner = (R - HALO_NAME_RIM) ** 2 - (w / 2) ** 2;
    // +1px: the depth moves R, so a box sized exactly at the last R could miss the chord by a hair.
    const need = inner > 0 ? R - Math.sqrt(inner) + 1 : Infinity;
    depth = Math.max(HALO_NAME_RIM, Math.min(need, HALO_NAME_DEPTH * R, deepest));
  }
  const pad = depth + h + HALO_NAME_GAP;
  const width = Math.min(w, rimOf(r + pad / 2, depth));
  return width < HALO_NAME_MIN_W ? null : { pad, depth, width };
}

/** The halo raised by `pad` (layout units) at the top: same bottom, so it still holds everything. Pure. */
export function withNameRoom<T extends { x: number; y: number; r: number }>(h: T, pad: number): T {
  return pad > 0 ? { ...h, y: h.y - pad / 2, r: h.r + pad / 2 } : h;
}

/** The longest start of `text` (ellipsis added) whose measured width fits `maxW`. Pure. */
export function fitLabelText(text: string, maxW: number, widthOf: (t: string) => number): string {
  if (widthOf(text) <= maxW) return text;
  const chars = [...text];
  for (let n = chars.length - 1; n > 0; n -= 1) {
    const t = `${chars.slice(0, n).join('').replace(/[\s,.;:–—-]+$/, '')}…`;
    if (widthOf(t) <= maxW) return t;
  }
  return '…';
}

/** A halo's name as drawn: the (possibly cut) text, its box size and the room it takes. */
export interface HaloName {
  text: string;
  w: number;
  h: number;
  room: HaloNameRoom;
}

/** The name for a halo of screen radius `r`: a group's (12px) or a status / person room's (11px). null
 *  when the halo is too small on screen for one. Pure. */
export function haloName(text: string, size: 'group' | 'sub', r: number): HaloName | null {
  const measure = size === 'group' ? groupLabelSize : subLabelSize;
  const full = measure(text);
  const room = haloNameRoom(r, full.w, full.h);
  if (room == null) return null;
  const cut = fitLabelText(text, room.width, (t) => measure(t).w);
  return { text: cut, w: Math.min(room.width, measure(cut).w), h: full.h, room };
}

/** The name's screen box inside the top of its halo (`x`/`y`/`r`: the halo WITH its room, screen px). */
export function haloNameBox(halo: { x: number; y: number; r: number }, name: Pick<HaloName, 'w' | 'h' | 'room'>): ScreenBox {
  const t = halo.y - halo.r + name.room.depth;
  return { l: halo.x - name.w / 2, t, r: halo.x + name.w / 2, b: t + name.h };
}

export interface HaloNameItem {
  key: string;
  box: ScreenBox;
  /** Higher places first (the group's size). */
  priority: number;
}

/** Which names show: each in its place inside its halo, in priority order, unless it would cover a name
 *  already shown (`fixed` first) or a ticket / badge (`discs`, screen circles). Its own halo's contents sit
 *  below the room by construction, so in practice only a neighbouring halo crowding in hides one. Pure. */
export function placeHaloNames(
  items: readonly HaloNameItem[],
  discs: ReadonlyArray<{ x: number; y: number; R: number }> = [],
  fixed: readonly ScreenBox[] = [],
): Map<string, boolean> {
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.priority - a.it.priority || a.i - b.i);
  const placed: ScreenBox[] = [...fixed];
  const out = new Map<string, boolean>();
  for (const { it } of order) {
    const clear = !placed.some((p) => boxesOverlap(p, it.box)) && !discs.some((d) => boxHitsDisc(it.box, d.x, d.y, d.R));
    const show = clear || it.priority >= LABEL_ALWAYS;
    out.set(it.key, show);
    if (show) placed.push(it.box);
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
