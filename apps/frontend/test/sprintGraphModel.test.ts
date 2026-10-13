import { describe, expect, it } from 'vitest';
import {
  PERSON_GAP,
  PERSON_UNASSIGNED,
  canSplitByAssignee,
  DISC_SCALE_MAX,
  drawnRadius,
  personGroupCounts,
  personOf,
  personRoomAnchors,
  personRoomKey,
  personSplitLayout,
  readSplitAssignee,
  splitPersonRoomKey,
  writeSplitAssignee,
} from '../src/components/Activity/sprintGraphModel.js';
import type { SprintGraphEdge, SprintGraphNode, SprintGraphPr, SprintTicketReference } from '@pierre-review/shared';
import {
  BADGE_MIN_SCREEN_R,
  BADGE_R,
  badgeCentre,
  badgeScale,
  discFill,
  glyphSize,
  ringWidth,
  statusGlyph,
  DEFAULT_GROUP_MODE,
  DEFAULT_VISIBILITY,
  LABEL_ALWAYS,
  LABEL_SIDES,
  boxesOverlap,
  collidePadding,
  haloName,
  haloNameBox,
  haloNameRoom,
  fitLabelText,
  withNameRoom,
  HALO_NAME_GAP,
  HALO_NAME_MAX_PAD,
  badgeCircle,
  groupRadius,
  haloSeparation,
  labelBox,
  labelOffset,
  labelPriority,
  labelSize,
  pinchTransform,
  placeHaloNames,
  placeLabels,
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
  NO_THEME,
  STATUS_SLOTS,
  SUB_GAP,
  boundsOf,
  canSplitByStatus,
  enclosingHalo,
  fitBox,
  memberMatches,
  personNameKey,
  readSplitStatus,
  slotOfSubKey,
  sprintMembers,
  statusSlotOf,
  statusSplitLayout,
  subGroupAnchors,
  subGroupCounts,
  subGroupKey,
  subLabelColour,
  writeSplitStatus,
  driftScale,
  easeInOut,
  fitBoxIn,
  introGroupMode,
  introSeeds,
  lerpView,
  uncoveredSpan,
  withNeighbours,
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
    author: null,
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

const SPRINT_STAGES_LOCAL = ['not_started', 'in_progress', 'in_review', 'done'] as const;

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
    expect(o.members.map((m) => m.label)).toEqual(['Amy']);
    expect(o.anyUnassigned).toBe(true);
    expect(o.epics).toEqual([{ key: 'E-1', title: 'Reports' }]);
    expect(o.anyNoEpic).toBe(true);
  });
});

describe('the theme filter', () => {
  const nodes = [
    node({ ident: 'a', theme: 'Uploads' }),
    node({ ident: 'b', theme: 'Uploads' }),
    node({ ident: 'c', theme: 'Reports' }),
    node({ ident: 'd' }),
    node({ ident: 'g', ghost: true, depth: 1, theme: 'Ghostly' }),
  ];
  const deps = new Set<string>();
  it('lists the sprint tickets\' themes, largest first, and "no theme" only when some have one', () => {
    const o = filterOptions(nodes);
    expect(o.themes).toEqual(['Uploads', 'Reports']);
    expect(o.anyNoTheme).toBe(true);
    expect(filterOptions([node({ ident: 'x' })]).anyNoTheme).toBe(false);
  });
  it('keeps the theme, or the themeless', () => {
    const f = { ...NO_FILTERS, theme: 'Uploads' };
    expect(filtersActive(f)).toBe(true);
    expect(nodes.map((n) => passesFilters(n, f, deps))).toEqual([true, true, false, false, false]);
    expect(nodes.map((n) => passesFilters(n, { ...NO_FILTERS, theme: NO_THEME }, deps))).toEqual([false, false, false, true, false]);
  });
});

describe('members: one per person across the tracker and GitHub', () => {
  const author = (login: string, name: string | null, isBot = false) => ({ author: { login, name, isBot } });
  // The shapes measured on a real sprint: a tracker login-ish name, a lower-case name, a run-together
  // login, a profile name that differs from the tracker's, and a PR author with no profile name.
  const nodes = [
    node({ ident: 'a', assignee: { name: 'johny.farrar', avatarUrl: null }, prs: [pr({ prId: 1, ...author('jbfarrar', 'Johny Farrar') })] }),
    node({ ident: 'b', assignee: { name: 'david buckley', avatarUrl: null } }),
    node({ ident: 'c', prs: [pr({ prId: 2, ...author('TheLordDave', 'David Buckley') })] }),
    node({ ident: 'd', assignee: { name: 'Sinan Goktas', avatarUrl: null }, prs: [pr({ prId: 3, ...author('sinangoktas', 'SinanG') })] }),
    node({ ident: 'e', assignee: { name: 'Robin Dunn', avatarUrl: null }, prs: [pr({ prId: 4, ...author('robin-dunn', null) })] }),
    node({ ident: 'f', prs: [pr({ prId: 5, ...author('octo', null) })] }),
    node({ ident: 'g', ghost: true, depth: 1, assignee: { name: 'Ghost Person', avatarUrl: null } }),
  ];

  it('folds a tracker name and a GitHub account that read the same into one entry, labelled with the real name', () => {
    const ms = sprintMembers(nodes);
    expect(ms.map((m) => [m.label, m.names, m.logins])).toEqual([
      ['David Buckley', ['david buckley'], ['TheLordDave']],
      ['Johny Farrar', ['johny.farrar'], ['jbfarrar']],
      ['octo', [], ['octo']],
      ['Robin Dunn', ['Robin Dunn'], ['robin-dunn']],
      ['Sinan Goktas', ['Sinan Goktas'], ['sinangoktas']],
    ]);
    // Never two entries under one label.
    expect(new Set(ms.map((m) => m.label)).size).toBe(ms.length);
  });

  it('a member matches their tickets AND the tickets carrying their PRs', () => {
    const ms = new Map(sprintMembers(nodes).map((m) => [m.id, m]));
    const david = [...ms.values()].find((m) => m.label === 'David Buckley');
    expect(david).toBeDefined();
    expect(nodes.filter((n) => passesFilters(n, { ...NO_FILTERS, assignee: david!.id }, new Set(), ms)).map((n) => n.ident)).toEqual(['b', 'c']);
    expect(memberMatches(nodes[0]!, { names: [], logins: ['jbfarrar'] })).toBe(true);
  });

  it('a login that would join two different people joins neither', () => {
    const ms = sprintMembers([
      node({ ident: 'a', assignee: { name: 'Sam Lee', avatarUrl: null } }),
      node({ ident: 'b', assignee: { name: 'sam.lee', avatarUrl: null } }),
      node({ ident: 'c', assignee: { name: 'Samlee', avatarUrl: null } }),
      node({ ident: 'd', prs: [pr({ ...author('samlee', null) })] }),
    ]);
    // "Sam Lee" and "sam.lee" are one person; "Samlee" is a different key. The login matches both keys.
    expect(ms.find((m) => m.logins.includes('samlee'))?.names ?? []).toEqual([]);
  });

  it('two different people under one label are told apart by login', () => {
    const ms = sprintMembers([
      node({ ident: 'a', prs: [pr({ prId: 1, ...author('al1', 'Al') })] }),
      node({ ident: 'b', prs: [pr({ prId: 2, ...author('al2', 'Al') })] }),
    ]);
    expect(ms.map((m) => m.label)).toEqual(['Al (@al1)', 'Al (@al2)']);
  });

  it('a bot author is never a member, and its PR does not make a ticket a member\'s', () => {
    const ms = sprintMembers([
      node({ ident: 'a', assignee: { name: 'Ada Lovelace', avatarUrl: null }, prs: [pr({ prId: 1, ...author('dependabot[bot]', null, true) })] }),
      node({ ident: 'b', prs: [pr({ prId: 2, ...author('renovate', 'Renovate', true) })] }),
      node({ ident: 'c', prs: [pr({ prId: 3, ...author('ada', 'Ada Lovelace') })] }),
    ]);
    expect(ms.map((m) => [m.label, m.logins])).toEqual([['Ada Lovelace', ['ada']]]);
  });

  it('the name key sets aside case, accents and separators', () => {
    expect(personNameKey('  José_Núñez-Ruiz ')).toBe('jose nunez ruiz');
    expect(personNameKey('johny.farrar')).toBe(personNameKey('Johny Farrar'));
  });
});

describe('split by status', () => {
  it('any grouping but None splits (Section: status, then person)', () => {
    expect(canSplitByStatus('epic')).toBe(true);
    expect(canSplitByStatus('theme')).toBe(true);
    expect(canSplitByStatus('section')).toBe(false);
    expect(canSplitByStatus('none')).toBe(false);
  });

  it('counts the drawn members per group per status, ghosts included, unknown apart', () => {
    const nodes = [
      node({ ident: 'a', stage: 'done' }),
      node({ ident: 'b', stage: 'not_started' }),
      node({ ident: 'g', ghost: true, depth: 1, stage: 'done' }),
      node({ ident: 'u', stage: null }),
      node({ ident: 'x', stage: 'done' }),
    ];
    const groupOf = new Map<string, string | null>([
      ['a', 'E1'],
      ['b', 'E1'],
      ['g', 'E1'],
      ['u', 'E2'],
      ['x', null],
    ]);
    const c = subGroupCounts(nodes, groupOf);
    expect([...c.keys()]).toEqual(['E1', 'E2']);
    expect(Object.fromEntries(c.get('E1')!)).toEqual({ done: 2, not_started: 1 });
    expect(Object.fromEntries(c.get('E2')!)).toEqual({ unknown: 1 });
    expect(statusSlotOf(null)).toBe('unknown');
  });

  it('lays the sub-groups out left to right in section order, apart, inside the group\'s room', () => {
    const split = statusSplitLayout(new Map([['done', 3], ['not_started', 2], ['in_review', 9], ['unknown', 1]] as const));
    const order = [...split.subs.keys()];
    expect(order).toEqual(STATUS_SLOTS.filter((s) => s !== 'in_progress'));
    const subs = [...split.subs.values()];
    for (let i = 1; i < subs.length; i += 1) {
      const a = subs[i - 1]!;
      const b = subs[i]!;
      expect(b.x).toBeGreaterThan(a.x);
      // No two rooms overlap (rounding aside), with the gap between them.
      expect(b.x - b.r - (a.x + a.r)).toBeGreaterThanOrEqual(SUB_GAP - 1);
    }
    for (const s of subs) expect(Math.hypot(s.x, s.y) + s.r).toBeLessThanOrEqual(split.r);
    // Centred on the group's anchor.
    expect(Math.abs(subs[0]!.x - subs[0]!.r + (subs.at(-1)!.x + subs.at(-1)!.r))).toBeLessThanOrEqual(2);
  });

  it('places each sub-anchor at its group\'s anchor plus its offset, keyed by group and status', () => {
    const split = statusSplitLayout(new Map([['in_progress', 2], ['done', 2]] as const));
    const anchors = new Map([['E1', { x: 100, y: -50, r: split.r }]]);
    const subs = subGroupAnchors(anchors, new Map([['E1', split], ['E9', split]]));
    expect([...subs.keys()]).toEqual([subGroupKey('E1', 'in_progress'), subGroupKey('E1', 'done')]);
    const ip = subs.get(subGroupKey('E1', 'in_progress'))!;
    expect(ip.x).toBe(100 + split.subs.get('in_progress')!.x);
    expect(ip.y).toBe(-50);
    expect(slotOfSubKey(subGroupKey('E1', 'done'))).toBe('done');
    expect(slotOfSubKey('E1')).toBeNull();
  });

  it('split groups sized by their rows never overlap when placed', () => {
    const groups = [
      { key: 'A', count: 20, radius: statusSplitLayout(new Map([['not_started', 5], ['in_review', 8], ['done', 7]] as const)).r },
      { key: 'B', count: 6, radius: statusSplitLayout(new Map([['in_progress', 3], ['done', 3]] as const)).r },
      { key: 'C', count: 30, radius: statusSplitLayout(new Map([['done', 30]] as const)).r },
    ];
    const a = [...groupAnchors(groups, 1.8).values()];
    for (let i = 0; i < a.length; i += 1)
      for (let j = i + 1; j < a.length; j += 1) expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.y - a[j]!.y)).toBeGreaterThanOrEqual(a[i]!.r + a[j]!.r);
  });

  it('the group halo encloses its sub-halos', () => {
    const subs = [
      { x: -100, y: 0, r: 40 },
      { x: 20, y: 10, r: 60 },
    ];
    const h = enclosingHalo(subs, 14)!;
    for (const s of subs) expect(Math.hypot(s.x - h.x, s.y - h.y) + s.r).toBeLessThanOrEqual(h.r - 14 + 1e-9);
    expect(enclosingHalo([])).toBeNull();
  });

  it('remembers the choice per browser, off by default, and survives a storage that throws', () => {
    const st = new MemStorage();
    expect(readSplitStatus(st)).toBe(false);
    writeSplitStatus(st, true);
    expect(readSplitStatus(st)).toBe(true);
    writeSplitStatus(st, false);
    expect(readSplitStatus(st)).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readSplitStatus(broken)).toBe(false);
    expect(() => writeSplitStatus(broken, true)).not.toThrow();
    expect(readSplitStatus(null)).toBe(false);
  });

  it('the unknown slot is named in a lighter slate than its ring', () => {
    expect(subLabelColour('unknown')).not.toBe(STAGE_RING_UNKNOWN);
    expect(subLabelColour('done')).toBe(STAGE_RING.done);
  });
});

describe('framing a set of nodes', () => {
  it('boundsOf is the box round the rims; fitBox frames it', () => {
    expect(boundsOf([])).toBeNull();
    const b = boundsOf([
      { x: 0, y: 0, r: 10 },
      { x: 100, y: 50, r: 5 },
    ]);
    expect(b).toEqual({ minX: -10, minY: -10, maxX: 105, maxY: 55 });
    const t = fitBox(b, 800, 600);
    expect(t).toEqual(fitTransform([{ x: 0, y: 0, r: 10 }, { x: 100, y: 50, r: 5 }], 800, 600));
  });
});

describe('framing beside the drawer', () => {
  it('uncoveredSpan is the strip left of the drawer, or the whole canvas when that strip is too narrow', () => {
    expect(uncoveredSpan({ left: 100, width: 1200 }, null)).toEqual({ x0: 0, x1: 1200 });
    // A 1500px window, the drawer 672px wide from the right: the canvas (from x=100) is seen up to 728.
    expect(uncoveredSpan({ left: 100, width: 1200 }, 1500 - 672)).toEqual({ x0: 0, x1: 728 });
    // The drawer starts past the canvas: nothing is covered.
    expect(uncoveredSpan({ left: 0, width: 600 }, 900)).toEqual({ x0: 0, x1: 600 });
    // A phone: the drawer is full width, so frame in the whole canvas.
    expect(uncoveredSpan({ left: 16, width: 358 }, 0)).toEqual({ x0: 0, x1: 358 });
  });
  it('fitBoxIn centres the box in the span, not the canvas', () => {
    const b = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
    const pad = { x: 20, top: 20, bottom: 20 };
    const t = fitBoxIn(b, { x0: 0, x1: 400 }, 600, pad);
    const whole = fitBox(b, 1000, 600, pad);
    expect(t.k).toBe(whole.k);
    // The box's centre (0, 0) lands at the span's middle.
    expect(t.x).toBeCloseTo(200);
    expect(whole.x).toBeCloseTo(500);
  });
  it('withNeighbours adds every ticket one drawn edge away', () => {
    const es = [edge('a', 'b'), edge('c', 'a'), edge('d', 'e')];
    expect([...withNeighbours(es, ['a'])].sort()).toEqual(['a', 'b', 'c']);
    expect([...withNeighbours(es, ['a', 'd'])].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    // One hop only: b's other links are not followed.
    expect([...withNeighbours([edge('a', 'b'), edge('b', 'z')], ['a'])].sort()).toEqual(['a', 'b']);
  });
});

describe('motion', () => {
  it('eases from 0 to 1 and clamps', () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(2)).toBe(1);
    expect(lerpView({ k: 1, x: 0, y: 0 }, { k: 2, x: 10, y: -10 }, 0.5)).toEqual({ k: 1.5, x: 5, y: -5 });
  });
  it('the drift fades out before the canvas stills, and is zero after', () => {
    expect(driftScale(0, 5000, 2000)).toBe(1);
    expect(driftScale(4000, 5000, 2000)).toBeCloseTo(0.5);
    expect(driftScale(5000, 5000, 2000)).toBe(0);
    expect(driftScale(9000, 5000, 2000)).toBe(0);
  });
  it('the opening animation starts from Epic, or from Theme (else Section) when Epic is chosen', () => {
    expect(introGroupMode('theme', true)).toBe('epic');
    expect(introGroupMode('section', true)).toBe('epic');
    expect(introGroupMode('none', false)).toBe('epic');
    expect(introGroupMode('epic', true)).toBe('theme');
    expect(introGroupMode('epic', false)).toBe('section');
  });
  it('seeds each ticket inside its intro group, and a ticket in no group outside them all', () => {
    const anchors = new Map([
      ['e1', { x: -200, y: 0, r: 60 }],
      ['e2', { x: 200, y: 0, r: 40 }],
    ]);
    const groupOf = new Map<string, string | null>([
      ['a', 'e1'],
      ['b', 'e1'],
      ['c', 'e2'],
      ['g', null],
    ]);
    const s = introSeeds(['a', 'b', 'c', 'g'], groupOf, anchors);
    for (const [id, g] of [['a', 'e1'], ['b', 'e1'], ['c', 'e2']] as const) {
      const p = s.get(id) as { x: number; y: number };
      const a = anchors.get(g) as { x: number; y: number; r: number };
      expect(Math.hypot(p.x - a.x, p.y - a.y)).toBeLessThanOrEqual(a.r);
    }
    const g = s.get('g') as { x: number; y: number };
    expect(Math.hypot(g.x, g.y)).toBeGreaterThan(260);
    // Deterministic.
    expect(introSeeds(['a', 'b', 'c', 'g'], groupOf, anchors)).toEqual(s);
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
    expect(groupList(sections, assignGroups(sections, [], 'section'), 'section').map((g) => g.label)).toEqual(['Not started', 'Complete']);
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
    // A badge poking out widens the halo without moving its centre.
    const withBadge = groupHalo([{ x: 0, y: 0, r: 10 }, { x: 100, y: 0, r: 10 }], 5, [{ x: 100, y: -20, r: 8 }])!;
    expect(withBadge.x).toBe(50);
    expect(withBadge.r).toBeCloseTo(Math.hypot(50, 20) + 8 + 5);
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

  it('placeLabels: hover / focus / selection never MOVES a label — it only reveals a hidden one, on top', () => {
    const at = (id: string, x: number, y: number, priority: number, prev?: LabelItem['prev']): LabelItem => ({ id, x, y, R: 14, w: 70, h: 28, priority, prev });
    // A crowd at a somewhat-zoomed-in view: discs 40px apart, labels wider than the gaps.
    const crowd = [
      at('a', 100, 100, 50),
      at('b', 140, 100, 40),
      at('c', 100, 140, 30),
      at('d', 140, 140, 20),
      at('e', 120, 120, 10),
      at('f', 180, 120, 5),
    ];
    // Settle: run placement until every label holds its side (as the canvas does frame to frame).
    let items = crowd;
    let before = placeLabels(items);
    for (let i = 0; i < 4; i += 1) {
      items = items.map((it) => ({ ...it, prev: before.get(it.id) }));
      before = placeLabels(items);
    }
    expect([...before.values()].some((s) => s === 'none')).toBe(true);
    for (const it of items) {
      const during = placeLabels(items.map((o) => (o.id === it.id ? { ...o, reveal: true } : o)));
      // Every label that was shown keeps its side — the hovered one AND every other.
      for (const o of items) {
        if (o.id === it.id && before.get(o.id) === 'none') continue;
        expect(during.get(o.id)).toBe(before.get(o.id));
      }
      // The hovered label is shown either way.
      expect(during.get(it.id)).not.toBe('none');
    }
    // A revealed label keeps the side it was revealed at while it stays hovered.
    const hidden = items.find((it) => before.get(it.id) === 'none') as LabelItem;
    const first = placeLabels(items.map((o) => (o.id === hidden.id ? { ...o, reveal: true } : o))).get(hidden.id);
    const again = placeLabels(items.map((o) => (o.id === hidden.id ? { ...o, reveal: true, prev: first } : o))).get(hidden.id);
    expect(again).toBe(first);
  });

  it('nodes: big enough to read at Fit — status as ring, tinted fill and a centre mark', () => {
    expect(NODE_RADIUS_MIN).toBeGreaterThanOrEqual(13.5);
    expect(ringWidth(false, false)).toBeGreaterThanOrEqual(5);
    expect(ringWidth(false, true)).toBeGreaterThan(ringWidth(false, false));
    expect(ringWidth(true, false)).toBeLessThan(ringWidth(false, false));
    // One distinct mark per status, unknown included.
    const marks = [...SPRINT_STAGES_LOCAL, null].map((s) => statusGlyph(s));
    expect(new Set(marks).size).toBe(5);
    // A sprint ticket's fill is tinted by its status (distinct per status); a ghost keeps the plain ground.
    expect(new Set(SPRINT_STAGES_LOCAL.map((s) => discFill(s, false))).size).toBe(4);
    expect(discFill('in_progress', true)).toBe(discFill('done', true));
    expect(glyphSize(20)).toBeLessThan(40);
  });

  it('the assignee badge: never below its on-screen floor when zoomed out, outside the centre mark', () => {
    for (const k of [0.2, 0.35, 0.5, 0.75, 1, 1.5, 3]) {
      const s = badgeScale(k);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(BADGE_R * s * discScale(k) * k).toBeGreaterThanOrEqual(BADGE_MIN_SCREEN_R - 1e-9);
    }
    // Not enlarged once it is big enough on screen.
    expect(badgeScale(3)).toBe(1);
    // Its centre sits beyond the centre mark's corner, and moves outward as it grows.
    for (const r of [NODE_RADIUS_MIN, NODE_RADIUS_MAX]) {
      const c1 = badgeCentre(r, 1);
      const c2 = badgeCentre(r, 2);
      expect(Math.hypot(c1.x, c1.y)).toBeGreaterThan(glyphSize(r) / 2 + 2);
      expect(Math.hypot(c2.x, c2.y)).toBeGreaterThan(Math.hypot(c1.x, c1.y));
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

  it('haloNameRoom: the name fits inside the top of the roomy halo, above everything the halo held', () => {
    for (const r of [60, 90, 150, 400]) {
      for (const w of [50, 120, 220]) {
        const room = haloNameRoom(r, w, 17);
        if (room == null) continue;
        // The halo grows by pad/2 and its centre rises by pad/2: same bottom, top raised by pad.
        const halo = withNameRoom({ x: 0, y: 0, r }, room.pad);
        expect(halo.y + halo.r).toBeCloseTo(r);
        expect(halo.y - halo.r).toBeCloseTo(-r - room.pad);
        const box = haloNameBox(halo, { w: room.width, h: 17, room });
        // Inside the circle: every corner.
        for (const [x, y] of [[box.l, box.t], [box.r, box.t], [box.l, box.b], [box.r, box.b]] as const) {
          expect(Math.hypot(x - halo.x, y - halo.y)).toBeLessThanOrEqual(halo.r + 1e-6);
        }
        // Clear of the old halo (where the tickets and child halos are): it ends GAP above its top.
        expect(box.b).toBeCloseTo(-r - HALO_NAME_GAP);
        expect(room.width).toBeLessThanOrEqual(w);
        expect(room.pad).toBeLessThanOrEqual(HALO_NAME_MAX_PAD * r + 1e-6);
      }
    }
    // A big halo fits a long name whole; a small one cuts it to its chord; a tiny one has no room.
    expect(haloNameRoom(400, 220, 17)?.width).toBe(220);
    expect(haloNameRoom(60, 220, 17)!.width).toBeLessThan(220);
    expect(haloNameRoom(20, 120, 17)).toBeNull();
    expect(haloNameRoom(0, 120, 17)).toBeNull();
  });

  it('haloName: cut with an ellipsis to the chord; shows once the halo is big enough on screen', () => {
    const long = 'Project pages and housekeeping';
    const small = haloName(long, 'group', 70)!;
    expect(small.text.endsWith('…')).toBe(true);
    expect(small.w).toBeLessThanOrEqual(small.room.width);
    expect(haloName(long, 'group', 300)!.text).toBe(long);
    expect(haloName('In progress', 'sub', 12)).toBeNull();
    expect(haloName('In progress', 'sub', 120)!.text).toBe('In progress');
    // Bigger on screen never makes less room for the name.
    let last = 0;
    for (const r of [40, 60, 80, 120, 200, 400]) {
      const n = haloName(long, 'group', r);
      const w = n?.w ?? 0;
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
  });

  it('fitLabelText: the longest start that fits, with an ellipsis, trailing punctuation dropped', () => {
    const w = (t: string) => t.length * 10;
    expect(fitLabelText('Trading rules', 200, w)).toBe('Trading rules');
    expect(fitLabelText('Trading rules', 90, w)).toBe('Trading…');
    expect(fitLabelText('Ab, cd', 40, w)).toBe('Ab…');
  });

  it('withNameRoom: no room leaves the halo as it was', () => {
    const h = { x: 3, y: 4, r: 5, extra: 1 };
    expect(withNameRoom(h, 0)).toBe(h);
    expect(withNameRoom(h, 10)).toEqual({ x: 3, y: -1, r: 10, extra: 1 });
  });

  it('placeHaloNames: names never overlap each other or a ticket; the bigger group places first', () => {
    const it = (key: string, x: number, priority: number) => ({ key, box: { l: x, t: 0, r: x + 100, b: 17 }, priority });
    const out = placeHaloNames([it('small', 60, 2), it('big', 0, 10)]);
    expect(out.get('big')).toBe(true);
    expect(out.get('small')).toBe(false);
    expect(placeHaloNames([it('a', 0, 1)], [{ x: 50, y: 8, R: 6 }]).get('a')).toBe(false);
    expect(placeHaloNames([it('a', 0, 1)], [{ x: 50, y: 40, R: 6 }]).get('a')).toBe(true);
    // Names already shown (the outer level's) are obstacles; an always-shown name shows regardless.
    expect(placeHaloNames([it('a', 0, 1)], [], [{ l: 90, t: 0, r: 120, b: 10 }]).get('a')).toBe(false);
    expect(placeHaloNames([it('a', 0, 3), it('b', 40, LABEL_ALWAYS)]).get('b')).toBe(true);
  });

  it('badgeCircle: the badge sits up and to the right of the disc, scaled with it', () => {
    const b = badgeCircle(100, 100, 14, 1, 1);
    expect(b.x).toBeGreaterThan(100);
    expect(b.y).toBeLessThan(100);
    const b2 = badgeCircle(100, 100, 14, 2, 1);
    expect(b2.r).toBeCloseTo(2 * b.r);
  });

  it('the wheel zoom factor: lines and pages in pixels, one notch capped', () => {
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

describe('halos round the tickets as drawn', () => {
  it('sizes a ticket by its enlarged disc and ring, so a halo still contains it zoomed out', () => {
    expect(drawnRadius(14, 1)).toBe(17);
    expect(drawnRadius(14, 2)).toBe(34);
    // A one-ticket person halo at Fit (disc ×2) reaches past the drawn ring, not inside it.
    const h = groupHalo([{ x: 0, y: 0, r: drawnRadius(14, discScale(0.25)) }], 8);
    expect(h?.r).toBeGreaterThan(14 * discScale(0.25) + 3);
    expect(discScale(0.01)).toBe(DISC_SCALE_MAX);
  });
});

describe('split by assignee', () => {
  const members = new Map([['p:johny farrar', { label: 'Johny Farrar' }]]);

  it('only an Epic or Theme grouping splits', () => {
    expect(canSplitByAssignee('epic')).toBe(true);
    expect(canSplitByAssignee('theme')).toBe(true);
    expect(canSplitByAssignee('section')).toBe(true);
    expect(canSplitByAssignee('none')).toBe(false);
  });

  it('folds a spelling into the member identity and names it as the member list does', () => {
    expect(personOf({ name: 'johny.farrar' }, members)).toEqual({ key: 'p:johny farrar', label: 'Johny Farrar' });
    expect(personOf({ name: 'Johny Farrar' }, members).key).toBe('p:johny farrar');
    // Not a member (a ghost's assignee): its own name.
    expect(personOf({ name: 'Ada Lovelace' }, members)).toEqual({ key: 'p:ada lovelace', label: 'Ada Lovelace' });
    expect(personOf(null, members)).toEqual({ key: PERSON_UNASSIGNED, label: 'Unassigned' });
    expect(personOf({ name: '  ' }, members).key).toBe(PERSON_UNASSIGNED);
  });

  it('counts the drawn members per parent room, per person', () => {
    const nodes = [
      { ident: 'a', assignee: { name: 'johny.farrar' } },
      { ident: 'b', assignee: { name: 'Johny Farrar' } },
      { ident: 'c', assignee: null },
      { ident: 'd', assignee: { name: 'Ada' } },
      { ident: 'x', assignee: null },
    ] as Array<Pick<SprintGraphNode, 'ident' | 'assignee'>>;
    const parent = new Map<string, string | null>([['a', 'E1'], ['b', 'E1'], ['c', 'E1'], ['d', 'E2'], ['x', null]]);
    const c = personGroupCounts(nodes, (id) => parent.get(id) ?? null, members);
    expect([...c.keys()]).toEqual(['E1', 'E2']);
    expect(Object.fromEntries(c.get('E1')!)).toEqual({ 'p:johny farrar': 2, [PERSON_UNASSIGNED]: 1 });
    expect(Object.fromEntries(c.get('E2')!)).toEqual({ 'p:ada': 1 });
  });

  it('lays person rooms out busiest first, Unassigned last, apart, inside the parent room', () => {
    const counts = new Map([[PERSON_UNASSIGNED, 9], ['p:b', 2], ['p:a', 5], ['p:c', 2], ['p:d', 1]]);
    const split = personSplitLayout(counts, (k) => k);
    expect([...split.subs.keys()]).toEqual(['p:a', 'p:b', 'p:c', 'p:d', PERSON_UNASSIGNED]);
    const rooms = [...split.subs.values()];
    for (let i = 0; i < rooms.length; i += 1) {
      expect(Math.hypot(rooms[i]!.x, rooms[i]!.y) + rooms[i]!.r).toBeLessThanOrEqual(split.r);
      for (let j = i + 1; j < rooms.length; j += 1) {
        const a = rooms[i]!;
        const b = rooms[j]!;
        expect(Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r).toBeGreaterThanOrEqual(PERSON_GAP - 1);
      }
    }
    expect(personSplitLayout(new Map()).subs.size).toBe(0);
    // One person: centred on the parent.
    const one = personSplitLayout(new Map([['p:a', 3]]));
    expect(one.subs.get('p:a')).toMatchObject({ x: 0, y: 0 });
  });

  it('places each person anchor at its parent anchor plus its offset, keyed by parent and person', () => {
    const split = personSplitLayout(new Map([['p:a', 2], ['p:b', 2]]));
    const parents = new Map([['E1\u241fdone', { x: 40, y: 10, r: split.r }]]);
    const anchors = personRoomAnchors(parents, new Map([['E1\u241fdone', split], ['gone', split]]));
    const k = personRoomKey('E1\u241fdone', 'p:a');
    expect([...anchors.keys()]).toEqual([k, personRoomKey('E1\u241fdone', 'p:b')]);
    expect(anchors.get(k)).toEqual({ x: 40 + split.subs.get('p:a')!.x, y: 10 + split.subs.get('p:a')!.y, r: split.subs.get('p:a')!.r });
    expect(splitPersonRoomKey(k)).toEqual({ parent: 'E1\u241fdone', person: 'p:a' });
    expect(splitPersonRoomKey('E1')).toBeNull();
  });

  it('a status room split by person is sized round its people', () => {
    const people = personSplitLayout(new Map([['p:a', 6], ['p:b', 6], ['p:c', 6]]));
    const row = statusSplitLayout(new Map([['in_progress', 18], ['done', 1]] as const), (s) => (s === 'in_progress' ? people.r : undefined));
    expect(row.subs.get('in_progress')!.r).toBe(people.r);
  });

  it('remembers the choice per browser, and survives storage that throws', () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    expect(readSplitAssignee(s)).toBe(false);
    writeSplitAssignee(s, true);
    expect(readSplitAssignee(s)).toBe(true);
    writeSplitAssignee(s, false);
    expect(readSplitAssignee(s)).toBe(false);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(readSplitAssignee(bad)).toBe(false);
    expect(() => writeSplitAssignee(bad, true)).not.toThrow();
  });
});
