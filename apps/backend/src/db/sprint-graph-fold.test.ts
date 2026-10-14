// The sprint graph fold (db/sprint-graph-fold.ts) — pure. Pinned: which tickets are nodes (the sprint,
// then ghosts reached along OUTWARD edges, ≤ depth, ≤ the ghost cap, deterministic), which references
// draw an edge (never out_of_scope / context), one edge per ordered pair (strongest kind, tracker beats
// text) and one per unordered pair for `concurrent`, degree, and `missing` (what the read fetches next).
import { describe, expect, it } from 'vitest';
import { trackerTicketIdent, type SprintBrief, type TicketLinkBlocker } from '@pierre-review/shared';
import { edgesOutOf, foldSprintGraph, identOfKey, type GraphTicketInput } from './sprint-graph-fold.js';

const ROOT = 'https://acme.atlassian.net';
const id = (k: string) => trackerTicketIdent('jira', ROOT, k);
const brief = (refs: Array<[string, string]>): SprintBrief => ({
  summary: 's',
  criteria: [],
  criteriaDerived: false,
  references: refs.map(([ticketKey, relation]) => ({ ticketKey, relation: relation as never, quote: null })),
  createdAt: '2026-10-12T00:00:00.000Z',
});
const link = (key: string, relation = 'is blocked by'): TicketLinkBlocker => ({ key, title: null, status: null, category: null, relation, url: null });
const t = (key: string, o: Partial<GraphTicketInput> = {}): GraphTicketInput => ({
  ident: id(key),
  key,
  title: key,
  url: null,
  status: null,
  issueType: null,
  assignee: null,
  epic: null,
  links: null,
  brief: null,
  briefState: 'pending',
  ...o,
});
const fold = (sprint: GraphTicketInput[], ghosts: GraphTicketInput[], o: { ghostMax?: number; depthMax?: number } = {}) =>
  foldSprintGraph({ provider: 'jira', apiRoot: ROOT, sprint, ghosts, stageOf: () => null, ...o });
const keyOf = (r: ReturnType<typeof fold>) => (ident: string) => r.nodes.find((n) => n.ident === ident)?.key;

describe('identOfKey / edgesOutOf', () => {
  it('canonicalises keys onto the site; blocking links and edge relations only; never itself', () => {
    expect(identOfKey('jira', ROOT, 'eng-1')).toEqual({ key: 'ENG-1', ident: id('ENG-1') });
    expect(identOfKey('jira', ROOT, 'not a key')).toBeNull();
    const out = edgesOutOf(
      t('A-1', {
        links: [link('B-1'), link('B-2', 'relates to'), link('A-1')],
        brief: brief([
          ['C-1', 'depends_on'],
          ['C-2', 'concurrent'],
          ['C-3', 'builds_on'],
          ['C-4', 'supersedes'],
          ['C-5', 'out_of_scope'],
          ['C-6', 'context'],
        ]),
      }),
      'jira',
      ROOT,
    );
    expect(out.map((e) => [e.toKey, e.kind, e.source])).toEqual([
      ['B-1', 'depends_on', 'tracker'],
      ['C-1', 'depends_on', 'text'],
      ['C-2', 'concurrent', 'text'],
      ['C-3', 'builds_on', 'text'],
      ['C-4', 'supersedes', 'text'],
    ]);
  });
});

describe('edge reasons (`why`)', () => {
  it('a text edge carries its reference’s why, a tracker edge its link reason; a tracker edge beating text keeps the text’s why', () => {
    const b: SprintBrief = {
      ...brief([]),
      references: [
        { ticketKey: 'C-1', relation: 'depends_on', quote: null, why: 'Needs the C-1 endpoint first.' },
        { ticketKey: 'B-2', relation: 'depends_on', quote: null, why: 'Uses the B-2 schema.' },
      ],
      linkReasons: [{ ticketKey: 'b-1', why: 'Checkout waits on B-1 payments.' }],
    };
    const out = edgesOutOf(t('A-1', { links: [link('B-1'), link('B-2')], brief: b }), 'jira', ROOT);
    expect(out.map((e) => [e.toKey, e.source, e.why])).toEqual([
      ['B-1', 'tracker', 'Checkout waits on B-1 payments.'],
      ['B-2', 'tracker', null],
      ['C-1', 'text', 'Needs the C-1 endpoint first.'],
      ['B-2', 'text', 'Uses the B-2 schema.'],
    ]);
    const r = fold([t('A-1', { links: [link('B-1'), link('B-2')], brief: b })], [t('B-1'), t('B-2'), t('C-1')]);
    const k = keyOf(r);
    expect(r.edges.map((e) => [k(e.to), e.source, e.why]).sort()).toEqual(
      [
        ['B-1', 'tracker', 'Checkout waits on B-1 payments.'],
        ['B-2', 'tracker', 'Uses the B-2 schema.'],
        ['C-1', 'text', 'Needs the C-1 endpoint first.'],
      ].sort(),
    );
  });
});

describe('foldSprintGraph', () => {
  it('nodes: the sprint, then ghosts breadth-first along outward edges; context-only ghosts are not nodes', () => {
    const r = fold(
      [t('A-1', { brief: brief([['G-1', 'depends_on'], ['G-9', 'context']]) }), t('A-2')],
      [t('G-1', { links: [link('G-2')] }), t('G-2', { brief: brief([['G-3', 'builds_on']]) }), t('G-3', { links: [link('G-4')] }), t('G-4'), t('G-9')],
    );
    expect(r.nodes.map((n) => [n.key, n.ghost, n.depth])).toEqual([
      ['A-1', false, 0],
      ['A-2', false, 0],
      ['G-1', true, 1],
      ['G-2', true, 2],
      ['G-3', true, 3],
    ]);
    // G-4 is a 4th hop: not a node and not missing (missing stops at the depth too).
    expect(r.missing).toEqual([]);
    expect(r.ghostsTruncated).toBe(false);
  });

  it('missing: unresolved targets with the depth they would sit at', () => {
    const r = fold([t('A-1', { links: [link('X-1')] })], [t('G-1')]);
    expect(r.missing).toEqual([{ key: 'X-1', depth: 1 }]);
    const deeper = fold([t('A-1', { links: [link('G-1')] })], [t('G-1', { brief: brief([['X-2', 'depends_on']]) })]);
    expect(deeper.missing).toEqual([{ key: 'X-2', depth: 2 }]);
  });

  it('the ghost cap: deterministic (depth, then key) and flagged', () => {
    const r = fold([t('A-1', { links: [link('G-3'), link('G-1'), link('G-2')] })], [t('G-1'), t('G-2'), t('G-3')], { ghostMax: 2 });
    expect(r.nodes.filter((n) => n.ghost).map((n) => n.key)).toEqual(['G-1', 'G-2']);
    expect(r.ghostsTruncated).toBe(true);
  });

  it('edges: one per ordered pair (strongest kind; tracker beats text), one per unordered pair for concurrent; degree', () => {
    const r = fold(
      [
        t('A-1', { links: [link('A-2')], brief: brief([['A-2', 'depends_on'], ['A-2', 'builds_on'], ['A-3', 'concurrent']]) }),
        t('A-2', { brief: brief([['A-1', 'supersedes']]) }),
        t('A-3', { brief: brief([['A-1', 'concurrent']]) }),
      ],
      [],
    );
    const k = keyOf(r);
    expect(r.edges.map((e) => [k(e.from), k(e.to), e.kind, e.source])).toEqual([
      ['A-1', 'A-2', 'depends_on', 'tracker'],
      ['A-1', 'A-3', 'concurrent', 'text'],
      ['A-2', 'A-1', 'supersedes', 'text'],
    ]);
    expect(r.nodes.map((n) => [n.key, n.degree])).toEqual([
      ['A-1', 3],
      ['A-2', 2],
      ['A-3', 1],
    ]);
  });

  it('a ghost that names a sprint ticket draws the edge back into the sprint; a ghost row that is also a sprint ticket is the sprint ticket', () => {
    const r = fold([t('A-1', { links: [link('G-1')] }), t('A-2')], [t('G-1', { brief: brief([['A-2', 'concurrent']]) }), t('A-2', { title: 'stale ghost copy' })]);
    const k = keyOf(r);
    expect(r.nodes.map((n) => [n.key, n.ghost, n.title])).toEqual([
      ['A-1', false, 'A-1'],
      ['A-2', false, 'A-2'],
      ['G-1', true, 'G-1'],
    ]);
    expect(r.edges.map((e) => [k(e.from), k(e.to), e.kind])).toEqual([
      ['A-1', 'G-1', 'depends_on'],
      ['G-1', 'A-2', 'concurrent'],
    ]);
  });

  it('a ghost has no epic; brief fields fold onto the node', () => {
    const r = fold([t('A-1', { epic: { key: 'E-1', title: 'Epic' }, brief: brief([['G-1', 'depends_on']]), briefState: 'current' })], [t('G-1', { epic: { key: 'E-2', title: null } })]);
    expect(r.nodes[0]!.epic).toEqual({ key: 'E-1', title: 'Epic' });
    expect(r.nodes[0]!.brief).toEqual({ state: 'current', summary: 's', criteriaCount: 0, criteriaDerived: false });
    expect(r.nodes[1]!.epic).toBeNull();
  });
});
