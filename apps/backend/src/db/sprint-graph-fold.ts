import { createHash } from 'node:crypto';
import {
  SPRINT_EDGE_KINDS,
  SPRINT_GHOST_DEPTH_MAX,
  SPRINT_GHOST_MAX,
  SPRINT_STAGES,
  canonicalTicketKey,
  isBlockingRelation,
  isSprintEdgeRelation,
  sprintCodeAsked,
  trackerTicketIdent,
  type JiraStatusCategory,
  type SprintBrief,
  type SprintBriefState,
  type SprintCodeJudgement,
  type SprintEdgeKind,
  type SprintGraphEdge,
  type SprintGraphNode,
  type SprintGraphPr,
  type SprintStage,
  type SprintTicketCheck,
  type TicketLinkBlocker,
  type TrackerProvider,
} from '@pierre-review/shared';
import { sprintColumnOf } from './sprint-status-layout.js';

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
  /** The status layout's placement (`sprintPlacementOf`): bucket + its meaning. Given → it decides
   *  `stage` too (stageOf is then unused); absent → `bucketId` and `column` are null. */
  placeOf?: (status: GraphTicketInput['status']) => { stage: SprintStage; bucketId: string } | null;
  /** Where the merge rule moves a Code review ticket whose PRs have all merged: the first Product
   *  review bucket's id (`mergeRuleTarget`); null / absent = the rule is off (`sprintColumnOf`). */
  productReviewId?: string | null;
  prs?: ReadonlyMap<string, SprintGraphPr[]>;
  /** Sprint ticket ident → its theme name (the current theme pass); ghosts never carry one. */
  themes?: ReadonlyMap<string, string>;
  /** Sprint ticket ident → its ticket check (db/sprint-ticket-checks.ts); ghosts never carry one. */
  checks?: ReadonlyMap<string, { check: SprintTicketCheck | null; running: boolean }>;
  /** The "needs code" judgement of a ticket the judgement is ASKED about (`sprintCodeAsked`: a sprint
   *  ticket in Not started with no pull request). Given → every node carries `codeJudgement` (null when
   *  not asked); absent → the field is left off. */
  codeJudgementOf?: (ident: string) => SprintCodeJudgement;
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
  /** The brief's one-sentence reason (null: none given). */
  why: string | null;
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
  const linkWhy = new Map((t.brief?.linkReasons ?? []).map((l) => [l.ticketKey.toUpperCase(), l.why] as const));
  for (const l of t.links ?? []) {
    if (!isBlockingRelation(l.relation)) continue;
    const id = identOfKey(provider, apiRoot, l.key);
    if (id == null || id.ident === t.ident) continue;
    out.push({ toKey: id.key, toIdent: id.ident, kind: 'depends_on', source: 'tracker', quote: null, why: linkWhy.get(l.key.toUpperCase()) ?? null });
  }
  for (const r of t.brief?.references ?? []) {
    if (!isSprintEdgeRelation(r.relation)) continue;
    const id = identOfKey(provider, apiRoot, r.ticketKey);
    if (id == null || id.ident === t.ident) continue;
    out.push({ toKey: id.key, toIdent: id.ident, kind: r.relation, source: 'text', quote: r.quote, why: r.why ?? null });
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
      const edge: SprintGraphEdge = { from: ident, to: e.toIdent, kind: e.kind, source: e.source, quote: e.quote, why: e.why };
      // `concurrent` is symmetric: one per unordered pair. Every other kind: one per ordered pair.
      const k = `${ident}\u0000${e.toIdent}`;
      const rev = `${e.toIdent}\u0000${ident}`;
      if (edge.kind === 'concurrent' && best.get(rev)?.kind === 'concurrent') continue;
      const prev = best.get(k);
      // ONE edge per tie: the stronger one wins, and when both read the SAME kind the winner without a
      // reason of its own keeps the loser's (a tracker link the text also explains).
      const winner = prev == null || better(edge, prev) ? edge : prev;
      const loser = winner === edge ? prev : edge;
      best.set(k, winner.why == null && loser != null && loser.kind === winner.kind && loser.why != null ? { ...winner, why: loser.why } : winner);
    }
  }
  const edges = [...best.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // ---- nodes ----
  // THE COLUMN is computed here, ONCE (`sprintColumnOf`), so every view draws the same x axis.
  const node = (t: GraphTicketInput, ghost: boolean): SprintGraphNode => {
    const place = input.placeOf?.(t.status) ?? null;
    const prs = input.prs?.get(t.ident) ?? [];
    const stage = input.placeOf != null ? (place?.stage ?? null) : input.stageOf(t.status);
    const judge = input.codeJudgementOf;
    return {
    ident: t.ident,
    key: t.key,
    title: t.title,
    url: t.url,
    provider: input.provider,
    ghost,
    depth: depth.get(t.ident) ?? 0,
    status: t.status,
    stage,
    bucketId: place?.bucketId ?? null,
    column: sprintColumnOf(place, prs, input.productReviewId ?? null),
    issueType: t.issueType,
    assignee: t.assignee,
    epic: ghost ? null : t.epic,
    brief: {
      state: t.briefState,
      summary: t.brief?.summary ?? null,
      oneLiner: t.brief?.oneLiner ?? null,
      criteriaCount: t.brief?.criteria.length ?? 0,
      criteriaDerived: t.brief?.criteriaDerived ?? false,
    },
    check: ghost ? null : (input.checks?.get(t.ident)?.check ?? null),
    checkRunning: ghost ? false : (input.checks?.get(t.ident)?.running ?? false),
    prs,
    degree: degree.get(t.ident) ?? 0,
    theme: ghost ? null : (input.themes?.get(t.ident) ?? null),
    ...(judge != null ? { codeJudgement: sprintCodeAsked({ ghost, stage, prs }) ? judge(t.ident) : null } : {}),
    };
  };
  const sprintNodes = input.sprint
    .map((t) => node(t, false))
    .sort((a, b) => (a.stage == null ? 9 : STAGE_RANK[a.stage]) - (b.stage == null ? 9 : STAGE_RANK[b.stage]) || byKey(a, b));
  const ghostNodes = [...ghostById.values()]
    .filter((g) => depth.has(g.ident))
    .map((g) => node(g, true))
    .sort((a, b) => a.depth - b.depth || byKey(a, b));
  return { nodes: [...sprintNodes, ...ghostNodes], edges, ghostsTruncated: truncated, missing: missingList };
}

/**
 * THE CHANGE TOKEN (`SprintGraphResponse.changeToken`, `GET /api/sprint-graph/token`): 16 hex of a sha256
 * over what the CARDS show — per node (sorted by ident): its column, bucket, status, assignee, theme,
 * brief state + one-liner + criteria count, ticket check counts / staleness / running, the "needs code"
 * judgement's state, and each PR's
 * id, state, draft flag and CI; plus every edge. ⚠ CLOCK-FREE: nothing derived from `Date.now()` (pace,
 * signals, dates) and not the read's time either — a sprint read that changed nothing must not suggest a
 * refresh. Pure.
 */
export function sprintChangeTokenOf(g: Pick<GraphFoldResult, 'nodes' | 'edges'>): string {
  const nodes = [...g.nodes]
    .sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0))
    .map((n) => [
      n.ident,
      n.ghost,
      n.title,
      n.column,
      n.bucketId,
      n.status?.name ?? null,
      n.assignee?.name ?? null,
      n.theme,
      n.brief.state,
      n.brief.oneLiner,
      n.brief.criteriaCount,
      n.check == null ? null : [n.check.met, n.check.partlyMet, n.check.notMet, n.check.total, n.check.stale, n.check.checkedAt],
      n.checkRunning,
      n.codeJudgement?.state ?? null,
      n.prs.map((p) => [p.prId, p.state, p.draft, p.ciState]),
    ]);
  const edges = g.edges.map((e) => [e.from, e.to, e.kind, e.source]).sort((a, b) => (a.join('\u0000') < b.join('\u0000') ? -1 : 1));
  return createHash('sha256').update(JSON.stringify({ nodes, edges })).digest('hex').slice(0, 16);
}

/** The token of a workspace with no tracker (nothing to show). */
export const SPRINT_EMPTY_CHANGE_TOKEN = sprintChangeTokenOf({ nodes: [], edges: [] });
