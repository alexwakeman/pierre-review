import {
  SPRINT_EDGE_KINDS,
  SPRINT_GHOST_DEPTH_MAX,
  SPRINT_GHOST_MAX,
  SPRINT_STAGES,
  canonicalTicketKey,
  isBlockingRelation,
  isSprintEdgeRelation,
  trackerTicketIdent,
  type JiraStatusCategory,
  type SprintBrief,
  type SprintBriefState,
  type SprintEdgeKind,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintGraphPr,
  type SprintStage,
  type TicketLinkBlocker,
  type TrackerProvider,
} from '@pierre-review/shared';

// THE SPRINT GRAPH FOLD — pure (sprint-graph-fold.test.ts). ONE fold, three callers: the graph route
// (db/sprint-graph.ts), the brief pass (which ghosts are nodes and need a brief) and the sprint read's
// ghost-chain lookup (tracker/sprint/ref-status.ts: which keys a node points at that nothing stored
// holds yet — `missing`). So the ghosts the page draws, the ghosts that get briefed and the ghosts the
// tracker is asked for are the same population.
//
//   • AN EDGE OUT of a ticket is either a BLOCKING tracker link (`isBlockingRelation`; kind
//     `depends_on`, source 'tracker') or a CURRENT brief reference whose relation draws an edge
//     (`isSprintEdgeRelation`: depends_on, concurrent, builds_on, supersedes; source 'text'). A
//     reference `out_of_scope` / `context` draws none.
//   • NODES: every sprint ticket (depth 0), then GHOSTS reached breadth-first along OUTWARD edges from
//     the sprint, ≤ SPRINT_GHOST_DEPTH_MAX hops, ≤ SPRINT_GHOST_MAX in all (depth order, then key —
//     deterministic). A ghost row nothing reaches (a ticket named only as context) is not a node.
//   • EDGES between nodes only, ONE per ordered pair (the strongest kind, SPRINT_EDGE_KINDS order; a
//     tracker edge beats a text edge of the same kind), and ONE per unordered pair for `concurrent`
//     (it is symmetric). `degree` counts them.
//   • `missing`: targets of a node at depth < SPRINT_GHOST_DEPTH_MAX that resolve to NO stored row —
//     what the read may fetch next, at depth + 1, bounded by the ghost cap.

export interface GraphTicketInput {
  ident: string;
  key: string;
  title: string;
  url: string | null;
  status: { name: string; category: JiraStatusCategory | null } | null;
  issueType: string | null;
  assignee: { name: string; avatarUrl: string | null } | null;
  epic: { key: string; title: string | null } | null;
  links: readonly TicketLinkBlocker[] | null;
  /** The CURRENT brief only (null when pending / off). */
  brief: SprintBrief | null;
  briefState: SprintBriefState;
}

export interface GraphFoldInput {
  provider: TrackerProvider;
  apiRoot: string;
  sprint: readonly GraphTicketInput[];
  ghosts: readonly GraphTicketInput[];
  stageOf: (status: GraphTicketInput['status']) => SprintStage | null;
  prs?: ReadonlyMap<string, SprintGraphPr[]>;
  /** Sprint ticket ident → its theme name (the current theme pass); ghosts never carry one. */
  themes?: ReadonlyMap<string, string>;
  ghostMax?: number;
  depthMax?: number;
}

export interface GraphFoldResult {
  nodes: SprintGraphNode[];
  edges: SprintGraphEdge[];
  ghostsTruncated: boolean;
  /** Unresolved targets (keys no row holds), with the depth they would sit at. */
  missing: Array<{ key: string; depth: number }>;
}

export interface EdgeOut {
  toKey: string;
  toIdent: string;
  kind: SprintEdgeKind;
  source: 'tracker' | 'text';
  quote: string | null;
}

/** A key on this site → its ident (the ONE shared spelling). null for a key that is not a key. */
export function identOfKey(provider: TrackerProvider, apiRoot: string, raw: string): { key: string; ident: string } | null {
  const c = canonicalTicketKey(raw);
  if (c == null) return null;
  const key = provider === 'github' ? c : c.toUpperCase();
  try {
    return { key, ident: trackerTicketIdent(provider, apiRoot, key) };
  } catch {
    return null;
  }
}

/** The edges OUT of one ticket (unfiltered by node membership). Pure. */
export function edgesOutOf(t: Pick<GraphTicketInput, 'ident' | 'links' | 'brief'>, provider: TrackerProvider, apiRoot: string): EdgeOut[] {
  const out: EdgeOut[] = [];
  for (const l of t.links ?? []) {
    if (!isBlockingRelation(l.relation)) continue;
    const id = identOfKey(provider, apiRoot, l.key);
    if (id == null || id.ident === t.ident) continue;
    out.push({ toKey: id.key, toIdent: id.ident, kind: 'depends_on', source: 'tracker', quote: null });
  }
  for (const r of t.brief?.references ?? []) {
    if (!isSprintEdgeRelation(r.relation)) continue;
    const id = identOfKey(provider, apiRoot, r.ticketKey);
    if (id == null || id.ident === t.ident) continue;
    out.push({ toKey: id.key, toIdent: id.ident, kind: r.relation, source: 'text', quote: r.quote });
  }
  return out;
}

const KIND_RANK = Object.fromEntries(SPRINT_EDGE_KINDS.map((k, i) => [k, i])) as Record<SprintEdgeKind, number>;
const STAGE_RANK = Object.fromEntries(SPRINT_STAGES.map((k, i) => [k, i])) as Record<SprintStage, number>;
const byKey = (a: { key: string }, b: { key: string }): number => a.key.localeCompare(b.key, undefined, { numeric: true });

/** THE fold. Pure. */
export function foldSprintGraph(input: GraphFoldInput): GraphFoldResult {
  const ghostMax = input.ghostMax ?? SPRINT_GHOST_MAX;
  const depthMax = input.depthMax ?? SPRINT_GHOST_DEPTH_MAX;
  const sprintById = new Map(input.sprint.map((t) => [t.ident, t]));
  const ghostById = new Map<string, GraphTicketInput>();
  for (const g of input.ghosts) if (!sprintById.has(g.ident)) ghostById.set(g.ident, g);
  const outOf = new Map<string, EdgeOut[]>();
  const edgesFor = (t: GraphTicketInput): EdgeOut[] => {
    let e = outOf.get(t.ident);
    if (e == null) {
      e = edgesOutOf(t, input.provider, input.apiRoot);
      outOf.set(t.ident, e);
    }
    return e;
  };

  // ---- breadth-first from the sprint ----
  const depth = new Map<string, number>();
  for (const t of [...input.sprint].sort(byKey)) depth.set(t.ident, 0);
  let frontier = [...input.sprint].sort(byKey);
  let ghostCount = 0;
  let truncated = false;
  const missing = new Map<string, { key: string; depth: number }>();
  for (let d = 0; d < depthMax && frontier.length > 0; d += 1) {
    const reached = new Map<string, GraphTicketInput>();
    for (const t of frontier) {
      for (const e of edgesFor(t)) {
        if (depth.has(e.toIdent) || reached.has(e.toIdent)) continue;
        const g = ghostById.get(e.toIdent);
        if (g == null) {
          if (!missing.has(e.toIdent)) missing.set(e.toIdent, { key: e.toKey, depth: d + 1 });
          continue;
        }
        reached.set(g.ident, g);
      }
    }
    const next: GraphTicketInput[] = [];
    for (const g of [...reached.values()].sort(byKey)) {
      if (ghostCount >= ghostMax) {
        truncated = true;
        break;
      }
      depth.set(g.ident, d + 1);
      ghostCount += 1;
      next.push(g);
    }
    frontier = next;
  }
  const missingList = [...missing.values()].sort((a, b) => a.depth - b.depth || a.key.localeCompare(b.key, undefined, { numeric: true }));

  // ---- edges between nodes ----
  const best = new Map<string, SprintGraphEdge>();
  const better = (a: SprintGraphEdge, b: SprintGraphEdge): boolean =>
    KIND_RANK[a.kind] < KIND_RANK[b.kind] || (a.kind === b.kind && a.source === 'tracker' && b.source === 'text');
  for (const [ident] of depth) {
    const t = sprintById.get(ident) ?? ghostById.get(ident)!;
    for (const e of edgesFor(t)) {
      if (!depth.has(e.toIdent)) continue;
      const edge: SprintGraphEdge = { from: ident, to: e.toIdent, kind: e.kind, source: e.source, quote: e.quote };
      // `concurrent` is symmetric: one per unordered pair. Every other kind: one per ordered pair.
      const k = `${ident}\u0000${e.toIdent}`;
      const rev = `${e.toIdent}\u0000${ident}`;
      if (edge.kind === 'concurrent' && best.get(rev)?.kind === 'concurrent') continue;
      const prev = best.get(k);
      if (prev == null || better(edge, prev)) best.set(k, edge);
    }
  }
  const edges = [...best.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // ---- nodes ----
  const node = (t: GraphTicketInput, ghost: boolean): SprintGraphNode => ({
    ident: t.ident,
    key: t.key,
    title: t.title,
    url: t.url,
    provider: input.provider,
    ghost,
    depth: depth.get(t.ident) ?? 0,
    status: t.status,
    stage: input.stageOf(t.status),
    issueType: t.issueType,
    assignee: t.assignee,
    epic: ghost ? null : t.epic,
    brief: {
      state: t.briefState,
      summary: t.brief?.summary ?? null,
      criteriaCount: t.brief?.criteria.length ?? 0,
      criteriaDerived: t.brief?.criteriaDerived ?? false,
    },
    prs: input.prs?.get(t.ident) ?? [],
    degree: degree.get(t.ident) ?? 0,
    theme: ghost ? null : (input.themes?.get(t.ident) ?? null),
  });
  const sprintNodes = input.sprint
    .map((t) => node(t, false))
    .sort((a, b) => (a.stage == null ? 9 : STAGE_RANK[a.stage]) - (b.stage == null ? 9 : STAGE_RANK[b.stage]) || byKey(a, b));
  const ghostNodes = [...ghostById.values()]
    .filter((g) => depth.has(g.ident))
    .map((g) => node(g, true))
    .sort((a, b) => a.depth - b.depth || byKey(a, b));
  return { nodes: [...sprintNodes, ...ghostNodes], edges, ghostsTruncated: truncated, missing: missingList };
}
