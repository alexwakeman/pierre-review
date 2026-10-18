import { describe, expect, it } from 'vitest';
import type { SprintColumn, SprintGraphEdge, SprintGraphNode, SprintGraphPr, SprintPace, SprintPaths, SprintPerson } from '@pierre-review/shared';
import {
  OUTSIDE_COLUMN_ID,
  UNKNOWN_COLUMN_ID,
  cardIdOf,
  collapsedColumns,
  countTable,
  layoutBoard,
  paceItems,
  pathsBoard,
  peopleBoard,
  sprintColumns,
  themesBoard,
  ticketCardBorder,
  ticketCardTags,
  waitingIdents,
} from '../src/lib/laneBoard.js';


// The lane board's pure folds (lib/laneBoard.ts): the columns, each view's lanes, the ghost column, the
// collapsed Complete columns, the arrows and their key, and a card's tag words.

// Two review buckets and a done bucket that also holds "Won't do" — the user's own setup, in the
// columns the server resolved (`statusLayout.columns`), with the derived merged column after review.
const COLUMNS: SprintColumn[] = [
  { id: 'todo', name: 'To do', meaning: 'not_started', derived: false },
  { id: 'doing', name: 'Doing', meaning: 'in_progress', derived: false },
  { id: 'cr', name: 'Code review', meaning: 'in_review', derived: false },
  { id: 'po', name: 'PO review', meaning: 'in_review', derived: false },
  { id: 'merged', name: 'Merged, not signed off', meaning: 'in_review', derived: true },
  { id: 'done', name: 'Done', meaning: 'done', derived: false },
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
  brief: { state: 'current', summary: null, criteriaCount: 0, criteriaDerived: false },
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
  it('the buckets in order, plus the derived merged column, verbatim', () => {
    expect(sprintColumns(COLUMNS, { outside: false, unknown: false }).map((c) => c.id)).toEqual(['todo', 'doing', 'cr', 'po', 'merged', 'done']);
  });
  it('"Outside the sprint" only at the left and "Status not known" only at the right, when needed', () => {
    const cols = sprintColumns(COLUMNS, { outside: true, unknown: true }).map((c) => c.id);
    expect(cols[0]).toBe(OUTSIDE_COLUMN_ID);
    expect(cols[cols.length - 1]).toBe(UNKNOWN_COLUMN_ID);
  });
  it('a Complete bucket collapses by default; the merged column and the pseudo-columns never do', () => {
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
    expect(b.lanes).toEqual([{ id: 'path:0', label: 'Writer first', data: { kind: 'path', risk: 'high', advice: 'Unblock the writer.' } }]);
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
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'Import' }, { name: 'Search' }] });
    expect(b.lanes.map((l) => l.label)).toEqual(['Import', 'Search', 'No theme']);
    expect(b.cards.filter((c) => c.lane === 'other').map((c) => c.data.node.key)).toEqual(['A-3', 'A-4']);
  });
  it('Theme: a theme Claude named "Other" never shares a label with the code\'s lane; count rows key on the lane', () => {
    const nodes = [node('A-1', { theme: 'Other' }), node('A-2')];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: [{ name: 'Other' }] });
    expect(b.lanes.map((l) => [l.id, l.label])).toEqual([['theme:Other', 'Other'], ['other', 'No theme']]);
    const t = countTable(nodes, [{ name: 'Other' }], COLUMNS);
    expect(new Set(t.rows.map((r) => r.id)).size).toBe(t.rows.length);
  });
  it('Theme: no themes → one "All tickets" lane; live and merged counted per lane', () => {
    const nodes = [
      node('A-1', { column: 'merged', prs: [pr({ state: 'merged' })] }),
      node('A-2', { column: 'done', stage: 'done' }),
      node('A-3'),
    ];
    const b = themesBoard({ nodes, edges: [], paths: null, columns: COLUMNS, themes: null });
    expect(b.lanes.map((l) => l.label)).toEqual(['All tickets']);
    expect(b.lanes[0]!.data).toMatchObject({ kind: 'theme', live: 2, merged: 1 });
    expect((b.lanes[0]!.data as { segments: Array<{ column: string; count: number }> }).segments.map((s) => [s.column, s.count])).toEqual([
      ['doing', 1],
      ['merged', 1],
      ['done', 1],
    ]);
  });
  it('People: ALPHABETICAL, Unassigned last — never by load; reviews waiting null stays null', () => {
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
    expect(b.lanes.map((l) => l.data)).toEqual([
      { kind: 'person', unassigned: false, tickets: 1, reviewsWaiting: null },
      { kind: 'person', unassigned: false, tickets: 1, reviewsWaiting: null },
      { kind: 'person', unassigned: false, tickets: 3, reviewsWaiting: 4 },
      { kind: 'person', unassigned: true, tickets: 1, reviewsWaiting: null },
    ]);
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
      themes: [{ name: 'T' }, { name: 'Empty' }, { name: 'U' }],
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

describe('under the Critical path board', () => {
  const pace: SprintPace = {
    daysElapsed: 4,
    daysTotal: 14,
    timeUsedPct: 29,
    tickets: 55,
    live: 38,
    done: 17,
    mergedNotSignedOff: 15,
    codeMerged: 21,
    openDependencies: 6,
    chains: 3,
  };
  it('the pace: every figure with its denominator', () => {
    expect(paceItems(pace, { mergedColumn: true }).map((i) => `${i.label}: ${i.value}`)).toEqual([
      'Time used: Day 4 of 14',
      'Code merged: 21 of 55',
      'Merged, not signed off: 15 of 55',
      'Complete: 17 of 55',
      'Open dependencies: 6 in 3 chains',
    ]);
    expect(paceItems(pace, { mergedColumn: true })[0]!.pct).toBe(29);
  });
  it('no sprint window: no time; merged column off: not listed', () => {
    const items = paceItems({ ...pace, daysElapsed: null, daysTotal: null, timeUsedPct: null, chains: 0 }, { mergedColumn: false });
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
    const t = countTable(nodes, [{ name: 'Import' }, { name: 'Search' }], COLUMNS);
    expect(t.rows.map((r) => [r.label, r.total])).toEqual([
      ['Import', 2],
      ['No theme', 1],
    ]);
    expect(t.total).toBe(3);
    expect(t.totals.reduce((a, b) => a + b, 0)).toBe(3);
    expect(t.columns.map((c) => c.id)).toEqual(COLUMNS.map((c) => c.id));
  });
});
