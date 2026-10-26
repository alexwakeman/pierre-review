import { describe, expect, it } from 'vitest';
import type { SprintColumn, SprintGraphEdge, SprintGraphNode, SprintGraphPr, SprintPace, SprintPaths, SprintPerson } from '@pierre-review/shared';
import {
  OUTSIDE_COLUMN_ID,
  UNKNOWN_COLUMN_ID,
  cardIdOf,
  cellKey,
  collapsedColumns,
  countTable,
  layoutBoard,
  paceItems,
  pathsBoard,
  peopleBoard,
  assigneeLabel,
  personIndex,
  sprintColumns,
  themesBoard,
  hasLivePr,
  lanePrCount,
  sprintCardFilter,
  ticketCodeNote,
  ticketCardBorder,
  ticketCardCriteria,
  ticketCardTags,
  waitingIdents,
} from '../src/lib/laneBoard.js';


// The lane board's pure folds (lib/laneBoard.ts): the columns, each view's lanes, the ghost column, the
// collapsed Complete columns, the arrows and their key, and a card's tag words.

// Two review buckets and a done bucket that also holds "Won't do" — the user's own setup, in the
// columns the server resolved (`statusLayout.columns`), with a Product review bucket after review.
const COLUMNS: SprintColumn[] = [
  { id: 'todo', name: 'To do', meaning: 'not_started' },
  { id: 'doing', name: 'Doing', meaning: 'in_progress' },
  { id: 'cr', name: 'Code review', meaning: 'in_review' },
  { id: 'po', name: 'PO review', meaning: 'in_review' },
  { id: 'qa', name: 'Product review', meaning: 'product_review' },
  { id: 'done', name: 'Done', meaning: 'done' },
];

const pr = (o: Partial<SprintGraphPr> = {}): SprintGraphPr => ({
  prId: 1,
  number: 1,
  repoFullName: 'acme/app',
  title: 'x',
  state: 'open',
  draft: false,
  ciState: 'success',
  url: 'https://github.com/acme/app/pull/1',
  author: null,
  ...o,
});

const node = (key: string, o: Partial<SprintGraphNode> = {}): SprintGraphNode => ({
  ident: `jira:R#${key}`,
  key,
  title: `Title ${key}`,
  url: null,
  provider: 'jira',
  ghost: false,
  depth: 0,
  status: { name: 'Doing', category: 'indeterminate' },
  stage: 'in_progress',
  bucketId: 'doing',
  column: 'doing',
  issueType: 'Story',
  assignee: { name: 'Sinan Goktas', avatarUrl: null },
  epic: null,
  brief: { state: 'current', summary: null, oneLiner: null, criteriaCount: 0, criteriaDerived: false },
  check: null,
  checkRunning: false,
  prs: [],
  degree: 0,
  theme: null,
  ...o,
});

const id = (key: string): string => `jira:R#${key}`;
const dep = (from: string, to: string, why: string | null = null): SprintGraphEdge => ({
  from: id(from),
  to: id(to),
  kind: 'depends_on',
  source: 'tracker',
  quote: null,
  why,
});

describe('columns', () => {
  it('the buckets in order, verbatim', () => {
    expect(sprintColumns(COLUMNS, { outside: false, unknown: false }).map((c) => c.id)).toEqual(['todo', 'doing', 'cr', 'po', 'qa', 'done']);
  });
  it('"Outside the sprint" only at the left and "Status not known" only at the right, when needed', () => {
    const cols = sprintColumns(COLUMNS, { outside: true, unknown: true }).map((c) => c.id);
    expect(cols[0]).toBe(OUTSIDE_COLUMN_ID);
    expect(cols[cols.length - 1]).toBe(UNKNOWN_COLUMN_ID);
  });
  it('a Complete bucket collapses by default; Product review and the pseudo-columns never do', () => {
    const cols = sprintColumns(COLUMNS, { outside: true, unknown: true });
    expect([...collapsedColumns(cols, new Set())]).toEqual(['done']);
    expect([...collapsedColumns(cols, new Set(['done']))]).toEqual([]);
  });
});

describe('the ghost column is the Critical path view only', () => {
  const ghost = node('OUT-1', { ghost: true, depth: 1, column: 'doing', assignee: null });
  const nodes = [node('A-1'), node('A-2'), ghost];
  const paths: SprintPaths = {
    paths: [{ title: 'Writer first', tickets: ['A-2', 'OUT-1'], idents: [id('A-2'), id('OUT-1')], advice: 'Unblock the writer.', risk: 'high' }],
    callouts: [],
    createdAt: '2026-10-18T00:00:00.000Z',
  };
  it('paths: the ticket outside the sprint sits in "Outside the sprint", at the left', () => {
    const b = pathsBoard({ nodes, edges: [dep('A-2', 'OUT-1')], paths, columns: COLUMNS });
    expect(b.columns[0]!.id).toBe(OUTSIDE_COLUMN_ID);
    expect(b.cards.find((c) => c.data.node.key === 'OUT-1')!.column).toBe(OUTSIDE_COLUMN_ID);
    expect(b.lanes).toEqual([{ id: 'path:0', label: 'Writer first', data: { kind: 'path', risk: 'high', advice: 'Unblock the writer.', prs: 0 } }]);
  });
  it('themes and people draw sprint tickets only, and never the column', () => {
    const t = themesBoard({ nodes, edges: [], paths, columns: COLUMNS, themes: null });
    const p = peopleBoard({ nodes, edges: [], paths, columns: COLUMNS, people: [] });
    for (const b of [t, p]) {
      expect(b.columns.map((c) => c.id)).not.toContain(OUTSIDE_COLUMN_ID);
      expect(b.cards.map((c) => c.data.node.key).sort()).toEqual(['A-1', 'A-2']);
    }
  });
  it('a path with no paths stored draws no lane', () => {
    expect(pathsBoard({ nodes, edges: [], paths: null, columns: COLUMNS }).lanes).toEqual([]);
  });
  it('a stored path none of whose tickets is on today\'s map draws no lane (never a header-only board)', () => {
    const gone: SprintPaths = { ...paths, paths: [{ ...paths.paths[0]!, idents: [] }, ...paths.paths] };
    const b = pathsBoard({ nodes, edges: [], paths: gone, columns: COLUMNS });
    expect(b.lanes.map((l) => l.label)).toEqual(['Writer first']);
    expect(pathsBoard({ nodes, edges: [], paths: { ...paths, paths: [{ ...paths.paths[0]!, idents: [id('GONE-1')] }] }, columns: COLUMNS }).lanes).toEqual([]);
  });
  it('a ticket on two paths is two cards but one ticket in its column\'s count', () => {
    const two: SprintPaths = { ...paths, paths: [paths.paths[0]!, { ...paths.paths[0]!, title: 'Again', idents: [id('A-2')] }] };
    const b = pathsBoard({ nodes, edges: [], paths: two, columns: COLUMNS });
    expect(b.cards.filter((c) => c.data.node.key === 'A-2')).toHaveLength(2);
    const l = layoutBoard({ ...b, collapsed: new Set() });
    expect(l.columns.find((c) => c.id === 'doing')!.count).toBe(1);
  });
});

describe('lanes per view', () => {
  it('Theme: the stored theme order, then "No theme" for tickets no theme holds', () => {
    const nodes = [node('A-1', { theme: 'Search' }), node('A-2', { theme: 'Import' }), node('A-3', { theme: 'Gone' }), node('A-4')];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'Import', summary: null }, { name: 'Search', summary: null }] });
    expect(b.lanes.map((l) => l.label)).toEqual(['Import', 'Search', 'No theme']);
    expect(b.cards.filter((c) => c.lane === 'other').map((c) => c.data.node.key)).toEqual(['A-3', 'A-4']);
  });
  it('Theme: a theme Claude named "Other" never shares a label with the code\'s lane; count rows key on the lane', () => {
    const nodes = [node('A-1', { theme: 'Other' }), node('A-2')];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'Other', summary: null }] });
    expect(b.lanes.map((l) => [l.id, l.label])).toEqual([['theme:Other', 'Other'], ['other', 'No theme']]);
    const t = countTable(nodes, [{ name: 'Other', summary: null }], COLUMNS);
    expect(new Set(t.rows.map((r) => r.id)).size).toBe(t.rows.length);
  });
  it('Theme: no themes → one "All tickets" lane; live and merged counted per lane', () => {
    const nodes = [
      node('A-1', { column: 'qa', prs: [pr({ state: 'merged' })] }),
      node('A-2', { column: 'done', stage: 'done' }),
      node('A-3'),
    ];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: null });
    expect(b.lanes.map((l) => l.label)).toEqual(['All tickets']);
    expect(b.lanes[0]!.data).toMatchObject({ kind: 'theme', live: 2, merged: 1 });
    expect((b.lanes[0]!.data as { segments: Array<{ column: string; count: number }> }).segments.map((s) => [s.column, s.count])).toEqual([
      ['doing', 1],
      ['qa', 1],
      ['done', 1],
    ]);
    // CODE's row line, over the same cards; no theme sentence on "All tickets".
    expect(b.lanes[0]!.data).toMatchObject({
      summary: null,
      progress: '1 Doing, 1 Product review, 1 Done',
      code: '1 with a pull request, 2 without',
    });
  });
  it("Theme: each theme lane carries the themes pass's sentence; \"No theme\" carries none", () => {
    const nodes = [node('A-1', { theme: 'Import', prs: [pr()] }), node('A-2')];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'Import', summary: 'Code changes to the importer.' }] });
    expect(b.lanes.map((l) => [l.label, (l.data as { summary: string | null }).summary])).toEqual([
      ['Import', 'Code changes to the importer.'],
      ['No theme', null],
    ]);
    expect(b.lanes[0]!.data).toMatchObject({ progress: '1 Doing', code: 'Has a pull request' });
  });
  it('People: with no pull requests, alphabetical, Unassigned last; reviews waiting null stays null', () => {
    const people: SprintPerson[] = [
      { name: 'Sinan Goktas', names: ['Sinan Goktas'], reviewsWaiting: 4 },
      { name: 'Colin Ames', names: ['colin.ames'], reviewsWaiting: null },
    ];
    const nodes = [
      node('A-1'),
      node('A-2'),
      node('A-3'),
      node('A-4', { assignee: { name: 'colin.ames', avatarUrl: null } }),
      node('A-5', { assignee: null }),
      node('A-6', { assignee: { name: 'Bea', avatarUrl: null } }),
    ];
    const b = peopleBoard({ nodes, edges: [], paths: null, columns: COLUMNS, people });
    expect(b.lanes.map((l) => l.label)).toEqual(['Bea', 'Colin Ames', 'Sinan Goktas', 'Unassigned']);
    expect(b.lanes.map((l) => l.data)).toMatchObject([
      { kind: 'person', unassigned: false, tickets: 1, reviewsWaiting: null },
      { kind: 'person', unassigned: false, tickets: 1, reviewsWaiting: null },
      { kind: 'person', unassigned: false, tickets: 3, reviewsWaiting: 4 },
      { kind: 'person', unassigned: true, tickets: 1, reviewsWaiting: null },
    ]);
    // CODE's row line and bar: what the data shows, nothing about the person.
    expect(b.lanes[2]!.data).toMatchObject({ progress: '3 Doing', code: 'None has a pull request', segments: [{ column: 'doing', count: 3 }] });
  });
});

describe('rows are sorted by their pull request count (every view)', () => {
  const two = [pr({ prId: 1 }), pr({ prId: 2, state: 'closed' })];
  it('Theme: most PRs first, ties in the stored order, "No theme" last whatever it holds', () => {
    const nodes = [
      node('A-1', { theme: 'Import' }),
      node('A-2', { theme: 'Search', prs: [pr({ prId: 9 })] }),
      node('A-3', { theme: 'Export', prs: two }),
      node('A-4', { prs: [pr({ prId: 3 }), pr({ prId: 4 }), pr({ prId: 5 })] }),
    ];
    const themes = ['Import', 'Search', 'Export'].map((name) => ({ name, summary: null }));
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes });
    expect(b.lanes.map((l) => [l.label, (l.data as { prs: number }).prs])).toEqual([
      ['Export', 2],
      ['Search', 1],
      ['Import', 0],
      ['No theme', 3],
    ]);
    // The cards follow their lanes.
    expect(b.cards.map((c) => c.data.node.key)).toEqual(['A-3', 'A-2', 'A-1', 'A-4']);
  });
  it('a PR on two tickets of one row counts once', () => {
    const shared = pr({ prId: 7 });
    const b = themesBoard({ nodes: [node('A-1', { prs: [shared] }), node('A-2', { prs: [shared] })], edges: [], paths: null, columns: COLUMNS, themes: null });
    expect(lanePrCount(b.cards)).toBe(1);
  });
  it('People: most PRs first, ties alphabetical, Unassigned last', () => {
    const nodes = [
      node('A-1', { assignee: { name: 'Bea', avatarUrl: null } }),
      node('A-2', { assignee: { name: 'Zed', avatarUrl: null }, prs: two }),
      node('A-3', { assignee: { name: 'Amy', avatarUrl: null } }),
      node('A-4', { assignee: null, prs: [pr({ prId: 3 }), pr({ prId: 4 }), pr({ prId: 5 })] }),
    ];
    const b = peopleBoard({ nodes, edges: [], paths: null, columns: COLUMNS, people: [] });
    expect(b.lanes.map((l) => l.label)).toEqual(['Zed', 'Amy', 'Bea', 'Unassigned']);
  });
  it('Critical path: most PRs first, ties riskiest first as stored', () => {
    const nodes = [node('A-1'), node('A-2', { prs: [pr({ prId: 1 })] }), node('A-3')];
    const paths: SprintPaths = {
      paths: [
        { title: 'First', risk: 'high', advice: 'a', idents: [id('A-1')] },
        { title: 'Second', risk: 'medium', advice: 'b', idents: [id('A-3')] },
        { title: 'Third', risk: 'low', advice: 'c', idents: [id('A-2')] },
      ],
    } as unknown as SprintPaths;
    const b = pathsBoard({ nodes, edges: [], paths, columns: COLUMNS });
    expect(b.lanes.map((l) => l.label)).toEqual(['Third', 'First', 'Second']);
  });
});

describe('the board filters', () => {
  const judged = (state: 'code' | 'no_code' | 'pending' | 'off') => ({ codeJudgement: { state, reason: null } });
  const nodes = [
    node('A-1', { prs: [pr({ state: 'closed' })] }),
    node('A-2', { stage: 'not_started', column: 'todo', ...judged('code') }),
    node('A-3', { stage: 'not_started', column: 'todo', ...judged('no_code') }),
    node('A-4', { stage: 'not_started', column: 'todo', ...judged('pending') }),
    node('A-5'),
  ];
  const keys = (f: { hasPrs: boolean; needsCode: boolean }) => nodes.filter(sprintCardFilter(f)).map((n) => n.key);
  it('Has PRs keeps any pull request, closed included; Needs code adds the judged and the not-yet-judged', () => {
    expect(keys({ hasPrs: false, needsCode: false })).toEqual(['A-1', 'A-2', 'A-3', 'A-4', 'A-5']);
    expect(keys({ hasPrs: true, needsCode: false })).toEqual(['A-1']);
    expect(keys({ hasPrs: false, needsCode: true })).toEqual(['A-1', 'A-2', 'A-4']);
    expect(keys({ hasPrs: true, needsCode: true })).toEqual(['A-1']);
  });
  it('AI off: Needs code keeps only tickets with a pull request', () => {
    const off = [node('A-1', { prs: [pr()] }), node('A-2', { stage: 'not_started', ...judged('off') })];
    expect(off.filter(sprintCardFilter({ hasPrs: false, needsCode: true })).map((n) => n.key)).toEqual(['A-1']);
  });
  it('the boards drop what the filter rejects; a row left empty is not drawn', () => {
    const keep = sprintCardFilter({ hasPrs: true, needsCode: false });
    const b = themesBoard({ nodes: [node('A-1', { theme: 'X', prs: [pr()] }), node('A-2', { theme: 'Y' })], edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'X', summary: null }, { name: 'Y', summary: null }], keep });
    expect(b.cards.map((c) => c.data.node.key)).toEqual(['A-1']);
    expect(b.lanes.filter((l) => b.cards.some((c) => c.lane === l.id)).map((l) => l.label)).toEqual(['X']);
  });
  it('the card note: the reason as a tooltip; "Not judged yet" only while pending; nothing when not asked or off', () => {
    expect(ticketCodeNote({ codeJudgement: { state: 'code', reason: 'Adds a field.' } })).toEqual({ marker: null, tooltip: 'Likely needs code: Adds a field.' });
    expect(ticketCodeNote({ codeJudgement: { state: 'no_code', reason: null } })).toEqual({ marker: null, tooltip: 'Likely no code' });
    expect(ticketCodeNote({ codeJudgement: { state: 'pending', reason: null } })?.marker).toBe('Not judged yet');
    expect(ticketCodeNote({ codeJudgement: { state: 'off', reason: null } })).toBeNull();
    expect(ticketCodeNote({ codeJudgement: null })).toBeNull();
    expect(ticketCodeNote({})).toBeNull();
  });
});

describe("a card's person pill spells the person as the People lane does", () => {
  const people: SprintPerson[] = [
    { name: 'Colin Ames', names: ['colin.ames', 'Colin A'], reviewsWaiting: null },
    { name: '  ', names: ['ghost.name'], reviewsWaiting: null },
  ];
  const index = personIndex(people);
  it('a matched tracker spelling prints the person, an unmatched one the tracker spelling, nobody null', () => {
    expect(assigneeLabel(node('A-1', { assignee: { name: 'colin.ames', avatarUrl: null } }), index)).toBe('Colin Ames');
    expect(assigneeLabel(node('A-2', { assignee: { name: 'Colin A', avatarUrl: null } }), index)).toBe('Colin Ames');
    expect(assigneeLabel(node('A-3', { assignee: { name: ' david buckley ', avatarUrl: null } }), index)).toBe('david buckley');
    expect(assigneeLabel(node('A-4', { assignee: null }), index)).toBeNull();
    expect(assigneeLabel(node('A-5', { assignee: { name: '   ', avatarUrl: null } }), index)).toBeNull();
    // A person with a blank label falls back to the tracker spelling, never an empty pill.
    expect(assigneeLabel(node('A-6', { assignee: { name: 'ghost.name', avatarUrl: null } }), index)).toBe('ghost.name');
  });

  it('the pill and the People lane agree on every card', () => {
    const nodes = [node('A-1', { assignee: { name: 'colin.ames', avatarUrl: null } }), node('A-2', { assignee: { name: 'Bea', avatarUrl: null } })];
    const b = peopleBoard({ nodes, edges: [], paths: null, columns: COLUMNS, people });
    for (const c of b.cards) {
      const lane = b.lanes.find((l) => l.id === c.lane)!;
      expect(assigneeLabel(c.data.node, index)).toBe(lane.label);
    }
  });
});

describe('arrows and their key', () => {
  const nodes = [
    node('A-1', { assignee: { name: 'Colin', avatarUrl: null } }),
    node('A-2'),
    node('A-3'),
    node('A-4', { column: 'done', stage: 'done' }),
  ];
  const edges = [dep('A-2', 'A-1', 'Needs the writer.'), dep('A-3', 'A-2', null), dep('A-3', 'A-4', 'Uses the schema.')];
  it('an arrow runs FROM the ticket waited on TO the one that waits; its words read that way', () => {
    const b = themesBoard({ nodes, edges, paths: null, columns: COLUMNS, themes: null });
    const a = b.arrows.find((x) => x.text.startsWith('A-2'))!;
    expect(a).toMatchObject({ from: cardIdOf('all', id('A-1')), to: cardIdOf('all', id('A-2')), label: 'Needs the writer.', critical: false });
    expect(a.text).toBe('A-2 waits on A-1: Needs the writer.');
  });
  it('People: an arrow between two people is a hand-off, keyed "<person> waits on <person>"', () => {
    const b = peopleBoard({ nodes, edges, paths: null, columns: COLUMNS, people: [] });
    expect(b.arrows.find((x) => x.text.startsWith('A-2'))!.label).toBe('Sinan Goktas waits on Colin');
    // Inside one person's lane: the brief's why (none here).
    expect(b.arrows.find((x) => x.text.startsWith('A-3 waits on A-2'))!.label).toBeNull();
  });
  it('layout: only arrows between drawn cards; a collapsed column draws none; numbers shared by equal words', () => {
    const b = themesBoard({ nodes, edges, paths: null, columns: COLUMNS, themes: null });
    const collapsed = layoutBoard({ ...b, collapsed: collapsedColumns(b.columns, new Set()) });
    expect(collapsed.arrows.map((a) => a.text)).toEqual(['A-2 waits on A-1: Needs the writer.', 'A-3 waits on A-2']);
    expect(collapsed.key).toEqual([{ n: 1, label: 'Needs the writer.' }]);
    expect(collapsed.arrows.map((a) => a.n)).toEqual([1, null]);
    expect(collapsed.lanes[0]!.hidden.get('done')).toBe(1);
    const open = layoutBoard({ ...b, collapsed: collapsedColumns(b.columns, new Set(['done'])) });
    expect(open.arrows).toHaveLength(3);
    expect(open.key.map((k) => k.n)).toEqual([1, 2]);
    const twice = layoutBoard({
      ...b,
      arrows: [...b.arrows, { from: b.cards[2]!.id, to: b.cards[0]!.id, label: 'Needs the writer.', critical: false, text: 'x' }],
      collapsed: new Set(),
    });
    expect(twice.key).toHaveLength(2);
    expect(twice.arrows[twice.arrows.length - 1]!.n).toBe(1);
  });
  it("a lane's \"n tickets\" opens THAT lane's cell only: its cards drawn below a toggle row, arrows to them, the column widened", () => {
    const b = peopleBoard({ nodes, edges, paths: null, columns: COLUMNS, people: [] });
    const collapsed = collapsedColumns(b.columns, new Set());
    const shut = layoutBoard({ ...b, collapsed });
    const laneOfA4 = b.cards.find((c) => c.data.node.key === 'A-4')!.lane;
    const open = layoutBoard({ ...b, collapsed, expanded: new Set([cellKey(laneOfA4, 'done')]) });
    const lane = open.lanes.find((l) => l.id === laneOfA4)!;
    expect(lane.hidden.has('done')).toBe(false);
    expect(lane.opened.get('done')).toBe(1);
    const a4 = open.cards.find((c) => c.data.node.key === 'A-4')!;
    // Row 0 of the cell holds the "Hide" toggle; the card sits under it.
    expect(a4.row).toBe(lane.row + 1);
    expect(lane.span).toBeGreaterThanOrEqual(2);
    expect(open.columns.find((c) => c.id === 'done')).toMatchObject({ collapsed: true, widened: true });
    expect(shut.columns.find((c) => c.id === 'done')).toMatchObject({ collapsed: true, widened: false });
    expect(open.arrows.some((a) => a.text.startsWith('A-3 waits on A-4'))).toBe(true);
    expect(shut.arrows.some((a) => a.text.startsWith('A-3 waits on A-4'))).toBe(false);
    // Another lane's cell in the same column stays a count.
    const other = layoutBoard({ ...b, collapsed, expanded: new Set([cellKey('nobody', 'done')]) });
    expect(other.lanes.find((l) => l.id === laneOfA4)!.hidden.get('done')).toBe(1);
  });
  it('critical: on a path, every arrow; elsewhere, two tickets next to each other on a stored path', () => {
    const paths: SprintPaths = {
      paths: [{ title: 'Chain', tickets: ['A-1', 'A-2'], idents: [id('A-1'), id('A-2')], advice: 'Go.', risk: 'medium' }],
      callouts: [],
      createdAt: '2026-10-18T00:00:00.000Z',
    };
    expect(pathsBoard({ nodes, edges, paths, columns: COLUMNS }).arrows.map((a) => a.critical)).toEqual([true]);
    const t = themesBoard({ nodes, edges, paths, columns: COLUMNS, themes: null });
    expect(t.arrows.map((a) => [a.text.slice(0, 13), a.critical])).toEqual([
      ['A-2 waits on ', true],
      ['A-3 waits on ', false],
      ['A-3 waits on ', false],
    ]);
    expect(t.cards.filter((c) => c.data.critical).map((c) => c.data.node.key)).toEqual(['A-1', 'A-2']);
  });
});

describe('layout', () => {
  it('a lane is as tall as its fullest cell; cards stack within a cell; an empty lane is not drawn', () => {
    const b = themesBoard({
      nodes: [node('A-1', { theme: 'T' }), node('A-2', { theme: 'T' }), node('A-3', { theme: 'T', column: 'cr' }), node('A-4', { theme: 'U' })],
      edges: [],
      paths: null,
      columns: COLUMNS,
      themes: [{ name: 'T', summary: null }, { name: 'Empty', summary: null }, { name: 'U', summary: null }],
    });
    const l = layoutBoard({ ...b, collapsed: new Set() });
    expect(l.lanes.map((x) => [x.label, x.row, x.span])).toEqual([
      ['T', 0, 2],
      ['U', 2, 1],
    ]);
    expect(l.cards.map((c) => [c.data.node.key, c.row, c.col])).toEqual([
      ['A-1', 0, 1],
      ['A-2', 1, 1],
      ['A-3', 0, 2],
      ['A-4', 2, 1],
    ]);
    expect(l.rows).toBe(3);
    expect(l.columns.find((c) => c.id === 'doing')!.count).toBe(3);
  });
});

describe('waiting', () => {
  it('an unfinished ticket on an unfinished one waits; on a Complete one, or itself Complete, does not', () => {
    const nodes = [node('A-1'), node('A-2'), node('A-3', { stage: 'done' }), node('A-4', { stage: 'done' })];
    expect([...waitingIdents(nodes, [dep('A-2', 'A-1'), dep('A-1', 'A-3'), dep('A-4', 'A-1')])]).toEqual([id('A-2')]);
  });
});

describe('TicketCard tags are words', () => {
  it('No PR, No owner', () => {
    expect(ticketCardTags(node('A-1', { assignee: null }))).toEqual(['No PR', 'No owner']);
  });
  it('n PRs · m open, closed unmerged ones ignored; CI failing first, on an open PR only', () => {
    expect(ticketCardTags(node('A-1', { prs: [pr(), pr({ state: 'merged' }), pr({ state: 'closed' })] }))).toEqual(['2 PRs · 1 open']);
    expect(ticketCardTags(node('A-1', { prs: [pr({ state: 'merged' })] }))).toEqual(['1 PR · 0 open']);
    expect(ticketCardTags(node('A-1', { prs: [pr({ ciState: 'failure' })] }))).toEqual(['CI failing', '1 PR · 1 open']);
    expect(ticketCardTags(node('A-1', { prs: [pr({ state: 'merged', ciState: 'failure' })] }))).toEqual(['1 PR · 0 open']);
  });
  it('a ticket outside the sprint is never "No owner" (its assignee is not read)', () => {
    expect(ticketCardTags(node('X-1', { ghost: true, assignee: null }))).toEqual(['No PR']);
  });
  it('the border marks state by STYLE, not colour alone: critical = 2px solid, waiting = dashed', () => {
    expect(ticketCardBorder({ critical: true, waiting: false, ghost: false })).toMatch(/border-2 border-solid border-ai-signal-fill/);
    expect(ticketCardBorder({ critical: true, waiting: true, ghost: false })).toMatch(/border-2 border-dashed border-ai-signal-fill/);
    expect(ticketCardBorder({ critical: false, waiting: true, ghost: false })).toMatch(/border-dashed/);
    expect(ticketCardBorder({ critical: false, waiting: false, ghost: true })).toMatch(/border-dashed/);
    // Outside the sprint stays FAINT even on a path: 1px, dashed, tinted.
    expect(ticketCardBorder({ critical: true, waiting: false, ghost: true })).toMatch(/^border border-dashed border-ai-signal-fill\/60 bg-gray-50/);
    expect(ticketCardBorder({ critical: false, waiting: false, ghost: false })).toMatch(/border-solid/);
  });
});

describe('cards with a pull request', () => {
  it('an open or merged PR counts; a closed, unmerged one does not', () => {
    expect(hasLivePr(node('A-1'))).toBe(false);
    expect(hasLivePr(node('A-1', { prs: [pr({ state: 'closed' })] }))).toBe(false);
    expect(hasLivePr(node('A-1', { prs: [pr({ state: 'merged' })] }))).toBe(true);
    expect(hasLivePr(node('A-1', { prs: [pr()] }))).toBe(true);
  });
  it('a pull request is not a border: no violet, no glow', () => {
    expect(ticketCardBorder({ critical: false, waiting: false, ghost: false })).toBe(
      'border border-solid border-gray-300 bg-white dark:border-gray-700 dark:bg-gray-950',
    );
    expect(ticketCardBorder({ critical: true, waiting: false, ghost: false })).toMatch(/border-2 border-solid border-ai-signal-fill/);
    expect(ticketCardBorder({ critical: true, waiting: false, ghost: false })).not.toMatch(/violet|ticket-card-pr/);
  });
  it('PR cards sit FIRST in every cell, input order kept within each group', () => {
    const nodes = [node('A-1'), node('A-2', { prs: [pr()] }), node('A-3'), node('A-4', { prs: [pr({ state: 'merged' })] }), node('A-5', { prs: [pr({ state: 'closed' })] })];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [] });
    const l = layoutBoard({ ...b, collapsed: new Set() });
    const order = [...l.cards].sort((x, y) => x.row - y.row).map((c) => c.data.node.key);
    expect(order).toEqual(['A-2', 'A-4', 'A-1', 'A-3', 'A-5']);
  });
  it('the link ordering never lifts a card without a PR above one with a PR', () => {
    // A-3 (no PR) links to a card in another column at row 0; it would sort to the top on links alone.
    const nodes = [
      node('A-1', { prs: [pr()] }),
      node('A-2', { prs: [pr()] }),
      node('A-3'),
      node('B-1', { column: 'cr', stage: 'in_review' }),
    ];
    const b = themesBoard({ nodes, edges: [dep('A-3', 'B-1')], paths: null, columns: COLUMNS, themes: [] });
    const l = layoutBoard({ ...b, collapsed: new Set() });
    const doing = l.cards.filter((c) => c.column === 'doing').sort((x, y) => x.row - y.row).map((c) => c.data.node.key);
    expect(doing).toEqual(['A-1', 'A-2', 'A-3']);
  });
  it('Critical path: PR cards first within a cell, then path order', () => {
    const nodes = [node('A-1'), node('A-2', { prs: [pr()] }), node('A-3')];
    const paths: SprintPaths = {
      paths: [{ title: 'P', tickets: ['A-1', 'A-2', 'A-3'], idents: [id('A-1'), id('A-2'), id('A-3')], advice: '', risk: 'low' }],
      callouts: [],
      createdAt: '2026-10-18T00:00:00.000Z',
    };
    const b = pathsBoard({ nodes, edges: [], paths, columns: COLUMNS });
    const l = layoutBoard({ ...b, collapsed: new Set() });
    expect([...l.cards].sort((x, y) => x.row - y.row).map((c) => c.data.node.key)).toEqual(['A-2', 'A-1', 'A-3']);
  });
});

describe('the criteria line', () => {
  const check = (o: Partial<NonNullable<SprintGraphNode['check']>> = {}): NonNullable<SprintGraphNode['check']> => ({
    met: 3,
    partlyMet: 0,
    notMet: 1,
    unsettled: 0,
    total: 4,
    checkedAt: '2026-10-19T10:00:00.000Z',
    stale: false,
    ...o,
  });
  const brief = (criteriaCount: number): SprintGraphNode['brief'] => ({ state: 'current', summary: null, oneLiner: null, criteriaCount, criteriaDerived: false });
  it('a ticket check wins: "n of m criteria met", stale carried', () => {
    expect(ticketCardCriteria(node('A-1', { check: check(), brief: brief(5) }))).toEqual({ text: '3 of 4 criteria met', stale: false, running: false });
    expect(ticketCardCriteria(node('A-1', { check: check({ met: 1, total: 1, stale: true }) }))).toEqual({ text: '1 of 1 criterion met', stale: true, running: false });
  });
  it('else the brief count; else nothing', () => {
    expect(ticketCardCriteria(node('A-1', { brief: brief(4) }))?.text).toBe('4 criteria');
    expect(ticketCardCriteria(node('A-1', { brief: brief(1) }))?.text).toBe('1 criterion');
    expect(ticketCardCriteria(node('A-1'))).toBeNull();
    // A check with no criteria of its own falls back to the brief.
    expect(ticketCardCriteria(node('A-1', { check: check({ total: 0, met: 0 }), brief: brief(2) }))?.text).toBe('2 criteria');
  });
  it('a running check shows even with nothing else to say', () => {
    expect(ticketCardCriteria(node('A-1', { checkRunning: true }))).toEqual({ text: '', stale: false, running: true });
    expect(ticketCardCriteria(node('A-1', { checkRunning: true, brief: brief(3) }))).toEqual({ text: '3 criteria', stale: false, running: true });
  });
});

describe('under the Critical path board', () => {
  const pace: SprintPace = {
    daysElapsed: 4,
    daysTotal: 14,
    timeUsedPct: 29,
    tickets: 55,
    live: 38,
    done: 17,
    productReview: 15,
    codeMerged: 21,
    openDependencies: 6,
    chains: 3,
  };
  it('the pace: every figure with its denominator', () => {
    expect(paceItems(pace, { productReview: true }).map((i) => `${i.label}: ${i.value}`)).toEqual([
      'Time used: Day 4 of 14',
      'Code merged: 21 of 55',
      'Product review: 15 of 55',
      'Complete: 17 of 55',
      'Open dependencies: 6 in 3 chains',
    ]);
    expect(paceItems(pace, { productReview: true })[0]!.pct).toBe(29);
  });
  it('no sprint window: no time; no Product review bucket: not listed', () => {
    const items = paceItems({ ...pace, daysElapsed: null, daysTotal: null, timeUsedPct: null, chains: 0 }, { productReview: false });
    expect(items.map((i) => i.label)).toEqual(['Code merged', 'Complete', 'Open dependencies']);
    expect(items[2]!.value).toBe('6');
  });
  it('the count table: every sprint ticket once, by theme and column, totals that add up', () => {
    const nodes = [
      node('A-1', { theme: 'Import' }),
      node('A-2', { theme: 'Import', column: 'done', stage: 'done' }),
      node('A-3'),
      node('X-1', { ghost: true }),
    ];
    const t = countTable(nodes, [{ name: 'Import', summary: null }, { name: 'Search', summary: null }], COLUMNS);
    expect(t.rows.map((r) => [r.label, r.total])).toEqual([
      ['Import', 2],
      ['No theme', 1],
    ]);
    expect(t.total).toBe(3);
    expect(t.totals.reduce((a, b) => a + b, 0)).toBe(3);
    expect(t.columns.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
  });
});

describe('layoutBoard — linked cards sit near each other', () => {
  const cols = [
    { id: 'a', name: 'A', meaning: 'not_started' as const },
    { id: 'b', name: 'B', meaning: 'in_progress' as const },
  ];
  const card = (id: string, column: string) => ({ id, lane: 'L', column, data: null });
  it('a card follows the row of the card it is linked to; no arrows keeps the input order', () => {
    const cards = [card('x1', 'a'), card('x2', 'a'), card('x3', 'a'), card('y1', 'b'), card('y2', 'b'), card('y3', 'b')];
    const base = { columns: cols, lanes: [{ id: 'L', data: null }], cards, collapsed: new Set<string>() };
    const rowOf = (l: ReturnType<typeof layoutBoard>, id: string) => l.cards.find((c) => c.id === id)!.row;
    const plain = layoutBoard({ ...base, arrows: [] });
    expect(['x1', 'x2', 'x3'].map((id) => rowOf(plain, id))).toEqual([0, 1, 2]);
    // y1 (row 0) waits on x3; y3 (row 2) waits on x1 — the linked cards should swap to face them.
    const l = layoutBoard({ ...base, arrows: [{ from: 'x3', to: 'y1', label: null, text: '' }, { from: 'x1', to: 'y3', label: null, text: '' }] });
    expect(rowOf(l, 'x3')).toBeLessThan(rowOf(l, 'x1'));
  });
});
