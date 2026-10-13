import { describe, expect, it } from 'vitest';
import type { SprintGraphEdge, SprintGraphNode, SprintGraphPr, SprintTicketReference } from '@pierre-review/shared';
import {
  DEFAULT_GROUP_MODE,
  DEFAULT_VISIBILITY,
  LABEL_ALWAYS,
  LABEL_SIDES,
  boxesOverlap,
  collidePadding,
  groupLabelBox,
  groupRadius,
  haloSeparation,
  labelBox,
  labelOffset,
  labelPriority,
  labelSize,
  pinchTransform,
  placeGroupLabels,
  placeLabels,
  wheelIntent,
  wheelZoomFactor,
  type LabelItem,
  GROUP_MODE_STORAGE_KEY,
  NO_GROUP,
  assignGroups,
  effectiveGroupMode,
  groupAnchors,
  groupHalo,
  groupKeyOf,
  groupList,
  isShippedGhost,
  readGroupMode,
  visibleGraph,
  writeGroupMode,
  DIMMED_OPACITY,
  FILTERED_OPACITY,
  GHOST_RADIUS_MIN,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
  NO_EPIC,
  NO_FILTERS,
  STAGE_RING,
  STAGE_RING_UNKNOWN,
  UNASSIGNED,
  dependencyIdents,
  discScale,
  orbitRadius,
  edgeEndpoints,
  edgeStyle,
  filterOptions,
  filtersActive,
  fitTransform,
  groupReferences,
  labelOpacity,
  neighbourhood,
  nodeAriaLabel,
  nodeBaseOpacity,
  nodeOpacity,
  nodeRadius,
  passesFilters,
  pinnedStorageKey,
  readPinned,
  satellitesOf,
  stageRing,
  starField,
  toggleStage,
  truncateLabel,
  writePinned,
  zoomAbout,
} from '../src/components/Activity/sprintGraphModel.js';

function node(over: Partial<SprintGraphNode> & { ident: string }): SprintGraphNode {
  return {
    key: over.ident.toUpperCase(),
    title: 'A ticket',
    url: null,
    provider: 'jira',
    ghost: false,
    depth: 0,
    status: { name: 'In Progress', category: 'indeterminate' },
    stage: 'in_progress',
    issueType: 'Story',
    assignee: null,
    epic: null,
    brief: { state: 'current', summary: null, criteriaCount: 0, criteriaDerived: false },
    prs: [],
    degree: 0,
    theme: null,
    ...over,
  };
}

function pr(over: Partial<SprintGraphPr> = {}): SprintGraphPr {
  return {
    prId: 1,
    number: 1,
    repoFullName: 'acme/web',
    title: 'x',
    state: 'open',
    draft: false,
    ciState: null,
    url: 'https://github.com/acme/web/pull/1',
    ...over,
  };
}

const edge = (from: string, to: string, kind: SprintGraphEdge['kind'] = 'depends_on'): SprintGraphEdge => ({
  from,
  to,
  kind,
  source: 'text',
  quote: null,
});

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('nodeRadius', () => {
  it('is the minimum for a ticket with no links and grows with degree up to a cap', () => {
    expect(nodeRadius(0, false)).toBe(NODE_RADIUS_MIN);
    expect(nodeRadius(1, false)).toBeGreaterThan(NODE_RADIUS_MIN);
    expect(nodeRadius(4, false)).toBeGreaterThan(nodeRadius(1, false));
    expect(nodeRadius(500, false)).toBe(NODE_RADIUS_MAX);
  });
  it('draws a ghost smaller, never below its floor', () => {
    expect(nodeRadius(3, true)).toBeLessThan(nodeRadius(3, false));
    expect(nodeRadius(0, true)).toBeGreaterThanOrEqual(GHOST_RADIUS_MIN);
    expect(nodeRadius(0, true)).toBeLessThan(NODE_RADIUS_MIN);
  });
  it('treats a nonsense degree as zero', () => {
    expect(nodeRadius(-3, false)).toBe(NODE_RADIUS_MIN);
    expect(nodeRadius(Number.NaN, false)).toBe(NODE_RADIUS_MIN);
  });
});

describe('colours and fading', () => {
  it('gives each stage its own ring colour, unknown is slate', () => {
    const rings = new Set(Object.values(STAGE_RING));
    expect(rings.size).toBe(4);
    expect(stageRing(null)).toBe(STAGE_RING_UNKNOWN);
    expect(stageRing('done')).toBe(STAGE_RING.done);
  });
  it('fades done tickets and ghosts by depth', () => {
    expect(nodeBaseOpacity({ ghost: false, depth: 0, stage: 'in_progress' })).toBe(1);
    expect(nodeBaseOpacity({ ghost: false, depth: 0, stage: 'done' })).toBeLessThan(1);
    const d1 = nodeBaseOpacity({ ghost: true, depth: 1, stage: 'in_progress' });
    const d2 = nodeBaseOpacity({ ghost: true, depth: 2, stage: 'in_progress' });
    const d3 = nodeBaseOpacity({ ghost: true, depth: 3, stage: 'in_progress' });
    expect(d1).toBeGreaterThan(d2);
    expect(d2).toBeGreaterThan(d3);
  });
  it('keeps a shown label legible even when its circle fades', () => {
    expect(labelOpacity({ ghost: true, depth: 3, stage: 'done' })).toBeGreaterThanOrEqual(0.8);
    expect(labelOpacity({ ghost: false, depth: 0, stage: 'in_review' })).toBe(1);
  });
  it('a filter beats the selection, which beats the base', () => {
    expect(nodeOpacity(0.5, false, true)).toBe(FILTERED_OPACITY);
    expect(nodeOpacity(0.5, false, false)).toBe(FILTERED_OPACITY);
    expect(nodeOpacity(0.5, true, false)).toBe(DIMMED_OPACITY);
    expect(nodeOpacity(0.5, true, true)).toBe(0.5);
  });
});

describe('satellites', () => {
  it('classes PRs open / draft / merged / closed and rings only an OPEN PR with failing checks', () => {
    const s = satellitesOf([
      pr({ prId: 1, ciState: 'failure' }),
      pr({ prId: 2, draft: true, ciState: 'error' }),
      pr({ prId: 3, state: 'merged', ciState: 'failure' }),
      pr({ prId: 4, state: 'closed' }),
      pr({ prId: 5, ciState: 'success' }),
    ]);
    expect(s.map((x) => x.kind)).toEqual(['open', 'draft', 'merged', 'closed', 'open']);
    expect(s.map((x) => x.failing)).toEqual([true, true, false, false, false]);
  });
  it('caps the dots and spaces them evenly', () => {
    const many = Array.from({ length: 23 }, (_, i) => pr({ prId: i }));
    const s = satellitesOf(many);
    expect(s).toHaveLength(12);
    expect(s[1]!.angle - s[0]!.angle).toBeCloseTo((2 * Math.PI) / 12);
  });
});

describe('edges', () => {
  it('draws depends_on as a solid arrow, concurrent dashed, builds_on/supersedes faint and thin', () => {
    expect(edgeStyle('depends_on')).toMatchObject({ arrow: true, dash: null });
    expect(edgeStyle('concurrent').dash).not.toBeNull();
    expect(edgeStyle('concurrent').arrow).toBe(false);
    for (const k of ['builds_on', 'supersedes'] as const) {
      expect(edgeStyle(k).width).toBeLessThan(edgeStyle('depends_on').width);
      expect(edgeStyle(k).opacity).toBeLessThan(edgeStyle('concurrent').opacity);
    }
  });
  it('cuts a segment back to both rims (and the arrow gap)', () => {
    const p = edgeEndpoints({ x: 0, y: 0, r: 10 }, { x: 100, y: 0, r: 20 }, 2);
    expect(p).toEqual({ x1: 10, y1: 0, x2: 78, y2: 0 });
  });
  it('never crosses over when two circles overlap', () => {
    const p = edgeEndpoints({ x: 0, y: 0, r: 30 }, { x: 10, y: 0, r: 30 });
    expect(p.x1).toBeLessThanOrEqual(p.x2);
  });
});

describe('neighbourhood', () => {
  const edges = [edge('a', 'b'), edge('b', 'c', 'builds_on'), edge('d', 'c'), edge('x', 'y')];
  it('one hop follows links in both directions', () => {
    expect([...neighbourhood(edges, 'b', 1)].sort()).toEqual(['a', 'b', 'c']);
  });
  it('two hops reaches one further', () => {
    expect([...neighbourhood(edges, 'a', 2)].sort()).toEqual(['a', 'b', 'c']);
    expect([...neighbourhood(edges, 'b', 2)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
  it('a lone node is only itself', () => {
    expect([...neighbourhood(edges, 'z', 2)]).toEqual(['z']);
  });
});

describe('filters', () => {
  const nodes = [
    node({ ident: 'a', stage: 'not_started', assignee: { name: 'Amy', avatarUrl: null }, epic: { key: 'E-1', title: 'Reports' } }),
    node({ ident: 'b', stage: 'done', prs: [pr()] }),
    node({ ident: 'c', stage: null, ghost: true, depth: 1, assignee: { name: 'Zed', avatarUrl: null } }),
  ];
  const deps = dependencyIdents([edge('a', 'c'), edge('b', 'a', 'builds_on')]);

  it('passes everything with no filters set', () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(nodes.every((n) => passesFilters(n, NO_FILTERS, deps))).toBe(true);
  });
  it('section chips keep only their stages; an unknown stage drops out', () => {
    const f = { ...NO_FILTERS, stages: new Set(['not_started', 'done'] as const) };
    expect(filtersActive(f)).toBe(true);
    expect(nodes.map((n) => passesFilters(n, f, deps))).toEqual([true, true, false]);
  });
  it('assignee, unassigned, epic and no-epic', () => {
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, assignee: 'Amy' }, deps))).toEqual([true, false, false]);
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, assignee: UNASSIGNED }, deps))).toEqual([false, true, false]);
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, epic: 'E-1' }, deps))).toEqual([true, false, false]);
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, epic: NO_EPIC }, deps))).toEqual([false, true, true]);
  });
  it('has PRs; has dependencies counts depends_on edges only, either end', () => {
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, hasPrs: true }, deps))).toEqual([false, true, false]);
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, hasDeps: true }, deps))).toEqual([true, false, true]);
  });
  it('turning the last section chip off turns them all back on', () => {
    expect([...toggleStage(new Set(['done'] as const), 'done')].sort()).toEqual(['done', 'in_progress', 'in_review', 'not_started']);
    expect([...toggleStage(new Set(['done'] as const), 'in_review')].sort()).toEqual(['done', 'in_review']);
  });
  it('options come from sprint tickets only, sorted', () => {
    const o = filterOptions(nodes);
    expect(o.assignees).toEqual(['Amy']);
    expect(o.anyUnassigned).toBe(true);
    expect(o.epics).toEqual([{ key: 'E-1', title: 'Reports' }]);
    expect(o.anyNoEpic).toBe(true);
  });
});

describe('labels', () => {
  it('leaves a short title alone and cuts a long one at a word with an ellipsis', () => {
    expect(truncateLabel('Short title')).toBe('Short title');
    const t = truncateLabel('Finalise the project details required for the MVP release');
    expect(t.length).toBeLessThanOrEqual(26);
    expect(t.endsWith('…')).toBe(true);
    expect(t).toBe('Finalise the project…');
  });
  it('cuts mid-word when no space is near', () => {
    expect(truncateLabel('Supercalifragilisticexpialidocious', 10)).toBe('Supercali…');
  });
  it('names a node for a screen reader', () => {
    expect(nodeAriaLabel(node({ ident: 'bmd-1', title: 'Sign in', prs: [pr(), pr({ prId: 2 })] }))).toBe('BMD-1 Sign in, In Progress, 2 PRs');
    expect(nodeAriaLabel(node({ ident: 'g', ghost: true, status: null, stage: null }))).toBe('G A ticket, status unknown, 0 PRs, outside the sprint');
  });
});

describe('pinned positions', () => {
  it('round-trips through storage, keyed per workspace and sprint', () => {
    const s = new MemStorage();
    const key = pinnedStorageKey(3, 'Sprint 14');
    expect(key).toContain('3');
    expect(key).toContain('Sprint 14');
    writePinned(s, key, { a: { x: 1, y: 2 } });
    expect(readPinned(s, key)).toEqual({ a: { x: 1, y: 2 } });
    writePinned(s, key, {});
    expect(s.m.has(key)).toBe(false);
  });
  it('reads nothing from missing, blocked or malformed storage', () => {
    expect(readPinned(null, 'k')).toEqual({});
    const s = new MemStorage();
    s.setItem('k', 'not json');
    expect(readPinned(s, 'k')).toEqual({});
    s.setItem('k', JSON.stringify([1, 2]));
    expect(readPinned(s, 'k')).toEqual({});
    s.setItem('k', JSON.stringify({ a: { x: 'no', y: 1 }, b: { x: 1, y: 2 }, c: null }));
    expect(readPinned(s, 'k')).toEqual({ b: { x: 1, y: 2 } });
    const throwing = {
      getItem: (): string | null => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('quota');
      },
      removeItem: (): void => {
        throw new Error('blocked');
      },
    };
    expect(readPinned(throwing, 'k')).toEqual({});
    expect(() => writePinned(throwing, 'k', { a: { x: 1, y: 1 } })).not.toThrow();
  });
});

describe('view', () => {
  it('fits circles into the viewport, leaving screen room for the labels', () => {
    const pad = { x: 50, top: 20, bottom: 40 };
    const t = fitTransform([{ x: -100, y: -50, r: 10 }, { x: 100, y: 50, r: 10 }], 800, 600, pad);
    // The box's centre lands at the centre of the padded viewport, and the box fits inside it.
    expect(0 * t.k + t.x).toBeCloseTo(400);
    expect(0 * t.k + t.y).toBeCloseTo((600 + 20 - 40) / 2);
    expect(-110 * t.k + t.x).toBeGreaterThanOrEqual(50 - 1e-9);
    expect(60 * t.k + t.y).toBeLessThanOrEqual(600 - 40 + 1e-9);
  });
  it('enlarges discs only when zoomed out, up to double', () => {
    expect(discScale(1)).toBe(1);
    expect(discScale(0.5)).toBeCloseTo(1.5);
    expect(discScale(0.1)).toBe(2);
  });
  it('orbits unlinked tickets on two staggered rings outside the cluster', () => {
    expect(orbitRadius(1, 50, 60) - orbitRadius(0, 50, 60)).toBe(70);
    expect(orbitRadius(0, 50, 60)).toBeGreaterThanOrEqual(Math.sqrt(50) * 40 + 80);
    expect(orbitRadius(0, 50, 200)).toBeGreaterThan(orbitRadius(0, 50, 60));
  });
  it('zooms about a fixed screen point', () => {
    const t = zoomAbout({ k: 1, x: 0, y: 0 }, 2, 100, 100);
    // The graph point under (100,100) is still under it.
    expect((100 - t.x) / t.k).toBeCloseTo(100);
    expect(zoomAbout({ k: 3.9, x: 0, y: 0 }, 2, 0, 0).k).toBe(4);
  });
  it('the star field is fixed (seeded)', () => {
    expect(starField(5)).toEqual(starField(5));
  });
});

describe('references', () => {
  const ref = (key: string, relation: SprintTicketReference['relation'], done: boolean | null = false): SprintTicketReference => ({
    ident: `jira:x#${key}`,
    key,
    title: null,
    status: null,
    done,
    relation,
    quote: null,
    inGraph: true,
    url: null,
  });
  it('groups blockers first, loose mentions last, done last within a group', () => {
    const g = groupReferences([ref('A-2', 'context'), ref('A-9', 'depends_on', true), ref('A-3', 'blocked_by'), ref('A-10', 'depends_on')]);
    expect(g.map((x) => x.label)).toEqual(['Blocked by', 'Depends on', 'Related']);
    expect(g[1]!.refs.map((r) => r.key)).toEqual(['A-10', 'A-9']);
  });
});

// ── What is drawn, and how it groups ─────────────────────────────────────────────────────────────

const E = (from: string, to: string, kind: SprintGraphEdge['kind'] = 'depends_on'): SprintGraphEdge => ({ from, to, kind, source: 'text', quote: null });
const DONE = { name: 'Done', category: 'done' as const };

describe('visibleGraph', () => {
  // s1 → g1 (open) ; s1 → g2 (done) → g3 (open, only behind the done one) ; s2 ⇢ g4 (builds_on, open) ;
  // s1 — s2 concurrent ; g5 (done) hangs off s2 by a depends_on.
  const nodes = [
    node({ ident: 's1', degree: 4 }),
    node({ ident: 's2', degree: 3 }),
    node({ ident: 'g1', ghost: true, depth: 1, degree: 1 }),
    node({ ident: 'g2', ghost: true, depth: 1, status: DONE, degree: 2 }),
    node({ ident: 'g3', ghost: true, depth: 2, status: null, degree: 1 }),
    node({ ident: 'g4', ghost: true, depth: 1, degree: 1 }),
    node({ ident: 'g5', ghost: true, depth: 1, status: DONE, degree: 1 }),
  ];
  const edges = [E('s1', 'g1'), E('s1', 'g2'), E('g2', 'g3'), E('s2', 'g4', 'builds_on'), E('s1', 's2', 'concurrent'), E('s2', 'g5')];
  const ids = (v: ReturnType<typeof visibleGraph>) => v.nodes.map((n) => n.ident);

  it('shipped = a ghost whose category is done; unknown counts as open', () => {
    expect(isShippedGhost(nodes[3]!)).toBe(true);
    expect(isShippedGhost(nodes[4]!)).toBe(false);
    expect(isShippedGhost(node({ ident: 's', status: DONE }))).toBe(false);
  });

  it('default: open ghosts linked by drawn kinds only; chains behind a done ghost hidden', () => {
    const v = visibleGraph(nodes, edges, DEFAULT_VISIBILITY);
    expect(ids(v)).toEqual(['s1', 's2', 'g1']);
    expect(v.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['s1>g1', 's1>s2']);
  });

  it('history on: done ghosts and their chains return', () => {
    const v = visibleGraph(nodes, edges, { history: true, faint: false });
    expect(ids(v)).toEqual(['s1', 's2', 'g1', 'g2', 'g3', 'g5']);
    expect(v.edges).toHaveLength(5);
  });

  it('faint on: builds on / replaces lines and what only they reach', () => {
    const v = visibleGraph(nodes, edges, { history: false, faint: true });
    expect(ids(v)).toEqual(['s1', 's2', 'g1', 'g4']);
    expect(visibleGraph(nodes, edges, { history: true, faint: true }).edges).toHaveLength(6);
  });

  it('degree counts only the drawn edges; an unchanged node keeps its identity', () => {
    const v = visibleGraph(nodes, edges, DEFAULT_VISIBILITY);
    expect(Object.fromEntries(v.nodes.map((n) => [n.ident, n.degree]))).toEqual({ s1: 2, s2: 1, g1: 1 });
    expect(v.nodes.find((n) => n.ident === 'g1')).toBe(nodes[2]);
    // Sprint tickets are always drawn, linked or not.
    expect(ids(visibleGraph([node({ ident: 'lonely' })], [], DEFAULT_VISIBILITY))).toEqual(['lonely']);
  });
});

describe('grouping', () => {
  const epic = (key: string, title: string | null = null) => ({ key, title });
  it('groupKeyOf by mode', () => {
    const n = node({ ident: 'a', epic: epic('E-1'), theme: 'Checkout', stage: 'in_review' });
    expect(groupKeyOf(n, 'epic')).toBe('E-1');
    expect(groupKeyOf(n, 'theme')).toBe('Checkout');
    expect(groupKeyOf(n, 'section')).toBe('in_review');
    expect(groupKeyOf(n, 'none')).toBeNull();
    const bare = node({ ident: 'b', stage: null });
    expect([groupKeyOf(bare, 'epic'), groupKeyOf(bare, 'theme'), groupKeyOf(bare, 'section')]).toEqual([NO_GROUP, NO_GROUP, NO_GROUP]);
  });

  it('a ghost inherits the NEAREST sprint ticket’s group; an unreached ghost and "none" → null', () => {
    const nodes = [
      node({ ident: 'a', epic: epic('E-1') }),
      node({ ident: 'b', epic: epic('E-2') }),
      node({ ident: 'g1', ghost: true }),
      node({ ident: 'g2', ghost: true }),
      node({ ident: 'g3', ghost: true }),
      node({ ident: 'lost', ghost: true }),
    ];
    // a → g1 → g2 ; b → g2 (b is nearer to g2: one hop) ; b → g3
    const edges = [E('a', 'g1'), E('g1', 'g2'), E('b', 'g2'), E('b', 'g3')];
    const g = assignGroups(nodes, edges, 'epic');
    expect(Object.fromEntries(g)).toEqual({ a: 'E-1', b: 'E-2', g1: 'E-1', g2: 'E-2', g3: 'E-2', lost: null });
    // Tie at the same distance: the sprint ticket listed first wins.
    expect(assignGroups(nodes, [E('a', 'g1'), E('b', 'g1')], 'epic').get('g1')).toBe('E-1');
    expect([...assignGroups(nodes, edges, 'none').values()].every((v) => v == null)).toBe(true);
  });

  it('groupList: largest first (sprint tickets only), no-group last; sections in stage order; labels', () => {
    const nodes = [
      node({ ident: 'a', epic: epic('E-1', 'Checkout') }),
      node({ ident: 'b', epic: epic('E-2') }),
      node({ ident: 'c', epic: epic('E-2') }),
      node({ ident: 'd' }),
      node({ ident: 'g', ghost: true }),
    ];
    const by = assignGroups(nodes, [E('a', 'g')], 'epic');
    // Counted over SPRINT tickets only: the ghost g (in E-1) does not move E-1 up.
    expect(groupList(nodes, by, 'epic')).toEqual([
      { key: 'E-2', label: 'E-2', count: 2, drawn: 2 },
      // The ghost g joins E-1: it is DRAWN there (room), but not counted (order).
      { key: 'E-1', label: 'Checkout', count: 1, drawn: 2 },
      { key: NO_GROUP, label: 'No epic', count: 1, drawn: 1 },
    ]);
    const sections = [node({ ident: 'x', stage: 'done' }), node({ ident: 'y', stage: 'not_started' }), node({ ident: 'z', stage: 'done' })];
    expect(groupList(sections, assignGroups(sections, [], 'section'), 'section').map((g) => g.label)).toEqual(['Not started', 'Done']);
    expect(groupList(nodes, by, 'none')).toEqual([]);
    expect(groupList([node({ ident: 'q' })], assignGroups([node({ ident: 'q' })], [], 'theme'), 'theme')).toEqual([{ key: NO_GROUP, label: 'No theme', count: 1, drawn: 1 }]);
  });

  it('groupAnchors: no overlaps, bigger groups get more room, the no-group group sits outward', () => {
    const groups = [
      { key: 'big', count: 13 },
      { key: 'mid', count: 6 },
      ...Array.from({ length: 10 }, (_, i) => ({ key: `s${i}`, count: 1 + (i % 3) })),
      { key: NO_GROUP, count: 17 },
    ];
    const a = groupAnchors(groups);
    expect(a.size).toBe(groups.length);
    const list = [...a.entries()];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const [, p] = list[i]!;
        const [, q] = list[j]!;
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r - 1);
      }
    }
    expect(a.get('big')!.r).toBeGreaterThan(a.get('mid')!.r);
    // Outward: the no-group anchor is further from the centre of the named groups than any of them.
    const named = list.filter(([k]) => k !== NO_GROUP).map(([, p]) => p);
    const cx = named.reduce((s, p) => s + p.x, 0) / named.length;
    const cy = named.reduce((s, p) => s + p.y, 0) / named.length;
    const far = Math.max(...named.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    const ng = a.get(NO_GROUP)!;
    expect(Math.hypot(ng.x - cx, ng.y - cy)).toBeGreaterThan(far);
    // Deterministic.
    expect([...groupAnchors(groups)]).toEqual(list);
    expect(groupAnchors([]).size).toBe(0);
  });

  it('groupHalo surrounds its members', () => {
    expect(groupHalo([])).toBeNull();
    const h = groupHalo([
      { x: 0, y: 0, r: 10 },
      { x: 100, y: 0, r: 10 },
    ], 5)!;
    expect(h).toEqual({ x: 50, y: 0, r: 65 });
  });

  it('Theme without themes falls back; the choice is stored and read back safely', () => {
    // The default is Theme; without themes it DRAWS as Epic, and the choice itself is untouched.
    expect(DEFAULT_GROUP_MODE).toBe('theme');
    expect(effectiveGroupMode(DEFAULT_GROUP_MODE, false)).toBe('epic');
    expect(effectiveGroupMode('theme', true)).toBe('theme');
    expect(effectiveGroupMode('epic', true)).toBe('epic');
    expect(effectiveGroupMode('section', false)).toBe('section');
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    expect(readGroupMode(storage)).toBe('theme');
    writeGroupMode(storage, 'section');
    expect(mem.get(GROUP_MODE_STORAGE_KEY)).toBe('section');
    expect(readGroupMode(storage)).toBe('section');
    mem.set(GROUP_MODE_STORAGE_KEY, 'bogus');
    expect(readGroupMode(storage)).toBe('theme');
    // A stored choice wins over the default.
    writeGroupMode(storage, 'epic');
    expect(readGroupMode(storage)).toBe('epic');
    const throwing = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
    expect(readGroupMode(throwing)).toBe('theme');
    expect(() => writeGroupMode(throwing, 'none')).not.toThrow();
    expect(readGroupMode(null)).toBe('theme');
  });

  it('group room: area grows with the DRAWN members; a large group is a spread disc', () => {
    // Area ∝ count: four times the members, about twice the radius (plus the larger group's padding).
    expect(groupRadius(40) / groupRadius(10)).toBeGreaterThan(1.9);
    expect(groupRadius(40) / groupRadius(10)).toBeLessThan(2.6);
    expect(groupRadius(0)).toBe(groupRadius(1));
    expect(collidePadding(false, 40)).toBe(20);
    expect(collidePadding(true, 4)).toBeLessThan(collidePadding(true, 42));
    expect(collidePadding(true, 1000)).toBe(collidePadding(true, 32));
    // History on: a group's ghosts widen ITS room, so the next group moves out instead of overlapping.
    const without = groupAnchors([{ key: 'a', count: 6 }, { key: 'b', count: 6 }]);
    const withGhosts = groupAnchors([{ key: 'a', count: 6, drawn: 14 }, { key: 'b', count: 6 }]);
    const gap = (m: Map<string, { x: number; y: number; r: number }>): number => {
      const a = m.get('a')!;
      const b = m.get('b')!;
      return Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
    };
    expect(withGhosts.get('a')!.r).toBeGreaterThan(without.get('a')!.r);
    expect(gap(withGhosts)).toBeGreaterThanOrEqual(gap(without) - 1);
  });

  it('groupAnchors in a wide canvas spread wider than tall, still without overlaps', () => {
    const groups = [17, 14, 12, 11, 11, 8, 7].map((count, i) => ({ key: `g${i}`, count }));
    const extent = (m: Map<string, { x: number; y: number; r: number }>): { w: number; h: number } => {
      const ps = [...m.values()];
      return {
        w: Math.max(...ps.map((p) => p.x + p.r)) - Math.min(...ps.map((p) => p.x - p.r)),
        h: Math.max(...ps.map((p) => p.y + p.r)) - Math.min(...ps.map((p) => p.y - p.r)),
      };
    };
    const square = extent(groupAnchors(groups, 1));
    const wideMap = groupAnchors(groups, 1.75);
    const wide = extent(wideMap);
    expect(wide.w / wide.h).toBeGreaterThan(square.w / square.h);
    const list = [...wideMap.values()];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const p = list[i]!;
        const q = list[j]!;
        expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThanOrEqual(p.r + q.r - 1);
      }
    }
    // A nonsense aspect behaves like a square one.
    expect([...groupAnchors(groups, Number.NaN)]).toEqual([...groupAnchors(groups, 1)]);
  });

  it('haloSeparation pushes overlapping halos apart, the smaller one further', () => {
    const halos = new Map([
      ['big', { x: 0, y: 0, r: 100 }],
      ['small', { x: 120, y: 0, r: 40 }],
      ['far', { x: 1000, y: 0, r: 40 }],
    ]);
    const push = haloSeparation(halos, 20);
    expect(push.has('far')).toBe(false);
    const big = push.get('big')!;
    const small = push.get('small')!;
    expect(big.dx).toBeLessThan(0);
    expect(small.dx).toBeGreaterThan(0);
    expect(Math.abs(small.dx)).toBeGreaterThan(Math.abs(big.dx));
    // Together they close exactly the overlap (100 + 40 + 20 − 120 = 40).
    expect(small.dx - big.dx).toBeCloseTo(40);
    // Coincident halos still separate.
    const same = haloSeparation(new Map([['a', { x: 5, y: 5, r: 10 }], ['b', { x: 5, y: 5, r: 10 }]]));
    expect(same.get('a')!.dx).toBeLessThan(0);
    expect(same.get('b')!.dx).toBeGreaterThan(0);
    expect(haloSeparation(new Map()).size).toBe(0);
  });

  it('labelOffset and labelBox agree: below, above, beside and the corners sit clear of the disc', () => {
    const it0 = { x: 100, y: 100, R: 10, w: 60, h: 15 };
    const below = labelBox(it0, 'below');
    expect(below.t).toBeGreaterThan(110);
    expect(below.l + below.r).toBeCloseTo(200);
    expect(labelBox(it0, 'above').b).toBeLessThan(90);
    expect(labelBox(it0, 'right').l).toBeGreaterThan(110);
    expect(labelBox(it0, 'left').r).toBeLessThan(90);
    for (const side of LABEL_SIDES) {
      const b = labelBox(it0, side);
      // No side's box covers the ticket's own centre.
      expect(b.l <= 100 && b.r >= 100 && b.t <= 100 && b.b >= 100).toBe(false);
      const o = labelOffset(side, 60, 15);
      expect(Number.isFinite(o.sx + o.sy + o.lx + o.ly)).toBe(true);
    }
    // A title adds a second line; capitals read wider than lower case.
    expect(labelSize('BMD-1', 'Sign in', true).h).toBeGreaterThan(labelSize('BMD-1', 'Sign in', false).h);
    expect(labelSize('BMD-1', '', true).h).toBe(labelSize('BMD-1', '', false).h);
    expect(labelSize('K', 'ABCDEFGHIJ', true).w).toBeGreaterThan(labelSize('K', 'abcdefghij', true).w);
  });

  it('placeLabels: no two shown labels overlap; the lower priority gives way, the promoted one never does', () => {
    const at = (id: string, x: number, y: number, priority: number, prev?: LabelItem['prev']): LabelItem => ({ id, x, y, R: 8, w: 56, h: 15, priority, prev });
    // A dense row: every label wants "below", and they are 20px apart.
    const row = Array.from({ length: 8 }, (_, i) => at(`n${i}`, 100 + i * 20, 100, 10 - i));
    const sides = placeLabels(row);
    const shown = row.filter((it) => sides.get(it.id) !== 'none');
    for (let i = 0; i < shown.length; i += 1) {
      for (let j = i + 1; j < shown.length; j += 1) {
        expect(boxesOverlap(labelBox(shown[i]!, sides.get(shown[i]!.id) as never), labelBox(shown[j]!, sides.get(shown[j]!.id) as never))).toBe(false);
      }
    }
    // The highest priority keeps its preferred side; at least one lower one is hidden or moved.
    expect(sides.get('n0')).toBe('below');
    expect(row.some((it) => sides.get(it.id) !== 'below')).toBe(true);
    // Promote the LAST one (hover / focus / selection): it is shown, and a neighbour gives way instead.
    const promoted = row.map((it) => (it.id === 'n7' ? { ...it, priority: LABEL_ALWAYS } : it));
    expect(placeLabels(promoted).get('n7')).not.toBe('none');
    // Two far-apart tickets both show, below.
    const apart = placeLabels([at('a', 0, 0, 1), at('b', 500, 500, 1)]);
    expect([apart.get('a'), apart.get('b')]).toEqual(['below', 'below']);
    // A label keeps its previous side while that is free (no flicker as the canvas drifts).
    expect(placeLabels([at('a', 0, 0, 1, 'left')]).get('a')).toBe('left');
    // An obstacle (a group name) is never covered.
    const blocked = placeLabels([at('a', 0, 0, 1)], [labelBox(at('x', 0, 0, 0), 'below')]);
    expect(blocked.get('a')).not.toBe('below');
    // A label never sits over the MIDDLE of another ticket's disc.
    const discs = placeLabels([at('a', 0, 0, 2), { id: 'b', x: 0, y: 24, R: 14, w: 56, h: 15, priority: 1 }]);
    const aSide = discs.get('a');
    if (aSide != null && aSide !== 'none') {
      const b = labelBox(at('a', 0, 0, 2), aSide);
      const px = Math.max(b.l, Math.min(0, b.r));
      const py = Math.max(b.t, Math.min(24, b.b));
      expect(Math.hypot(px, py - 24)).toBeGreaterThanOrEqual(14 * 0.55 - 1e-6);
    }
  });

  it('labelPriority: promoted, then readable, sprint, better connected, larger', () => {
    const base = { degree: 1, ghost: false, faded: false, pinned: false, r: 10 };
    expect(labelPriority({ ...base, pinned: true })).toBe(LABEL_ALWAYS);
    expect(labelPriority({ ...base, faded: true, degree: 50 })).toBeLessThan(labelPriority(base));
    expect(labelPriority({ ...base, ghost: true, degree: 50 })).toBeLessThan(labelPriority(base));
    expect(labelPriority({ ...base, degree: 3 })).toBeGreaterThan(labelPriority(base));
    expect(labelPriority({ ...base, r: 20 })).toBeGreaterThan(labelPriority(base));
    expect(labelPriority({ ...base, pinned: true })).toBeGreaterThan(labelPriority({ ...base, degree: 1e9 }));
  });

  it('placeGroupLabels: names never overlap; the bigger group keeps the top, a crowded name hides', () => {
    const g = (key: string, x: number, priority: number) => ({ key, x, y: 100, r: 30, w: 120, h: 17, priority });
    const out = placeGroupLabels([g('small', 60, 2), g('big', 0, 10)]);
    expect(out.get('big')).toBe('top');
    expect(out.get('small')).toBe('bottom');
    const three = placeGroupLabels([g('a', 0, 3), g('b', 40, 2), g('c', 80, 1)]);
    expect(three.get('a')).toBe('top');
    expect(three.get('b')).toBe('bottom');
    expect(three.get('c')).toBe('none');
    // A hovered member's group always shows its name.
    expect(placeGroupLabels([g('a', 0, 3), g('b', 40, 2), g('c', 80, LABEL_ALWAYS)]).get('c')).toBe('top');
    // Another group's ticket under the top spot pushes the name below; its own tickets do not.
    const top = groupLabelBox(g('a', 0, 1), 'top');
    const disc = { x: 0, y: (top.t + top.b) / 2, R: 6 };
    expect(placeGroupLabels([g('a', 0, 1)], [{ ...disc, group: 'other' }]).get('a')).toBe('bottom');
    expect(placeGroupLabels([g('a', 0, 1)], [{ ...disc, group: 'a' }]).get('a')).toBe('top');
  });

  it('the wheel: plain scrolls the page, Ctrl / ⌘ (and a pinch, sent as Ctrl) zooms', () => {
    expect(wheelIntent({ ctrlKey: false, metaKey: false })).toBe('scroll');
    expect(wheelIntent({ ctrlKey: true, metaKey: false })).toBe('zoom');
    expect(wheelIntent({ ctrlKey: false, metaKey: true })).toBe('zoom');
    // Up zooms in, down zooms out; one mouse notch is a capped step; lines and pages convert.
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.25));
    expect(wheelZoomFactor(-1000)).toBeCloseTo(wheelZoomFactor(-100));
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(wheelZoomFactor(-48));
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04));
    expect(wheelZoomFactor(Number.NaN)).toBe(1);
  });

  it('pinchTransform zooms by the fingers spread and keeps the midpoint content under the fingers', () => {
    const start = { k: 1, x: 0, y: 0 };
    const t = pinchTransform(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(t.k).toBeCloseTo(2);
    // The graph point at the first midpoint (150, 100) is still at the screen midpoint (150, 100).
    expect(150 * t.k + t.x).toBeCloseTo(150);
    expect(100 * t.k + t.y).toBeCloseTo(100);
    // Moving both fingers pans.
    const pan = pinchTransform(start, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 10, y: 20 }, { x: 110, y: 20 });
    expect(pan).toEqual({ k: 1, x: 10, y: 20 });
  });
});
