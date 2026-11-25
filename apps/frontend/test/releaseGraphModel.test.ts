// This Sprint → Releases, the path to newer releases: the pure display half (components/Sprint/releaseGraphModel.ts)
// over REAL results of the shared folds (`foldReleaseCheck` → `releaseGraph`). docs/RELEASES.md § Releases tab.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/releaseGraphModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  releaseGraph,
  type ReleaseCheckInput,
  type ReleaseCheckOpenPrInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckRepoInput,
  type ReleaseCheckResult,
  type ReleaseCheckTicketInput,
  type TicketLinkBlocker,
} from '@pierre-review/shared';
import {
  PLAN_CARDS_SHOWN,
  ladderRows,
  newTagWords,
  planCards,
  planWindow,
  ticketGraphBadges,
  unlocksWords,
  workChip,
} from '../src/components/Sprint/releaseGraphModel.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const sha = (c: string) => c.padEnd(40, '0');

function repo(repoId: number, name: string, specs: Array<{ name: string; d: number; prs: number[] }>): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({ name: s.name, sha: sha(s.name), committedAt: day(s.d), taggedAt: null, onDefaultBranch: true, moved: false }));
  const ranges = specs.map((s, i) => ({
    tagName: s.name,
    sha: sha(s.name),
    baseTagName: i > 0 ? specs[i - 1]!.name : null,
    baseSha: i > 0 ? sha(specs[i - 1]!.name) : null,
    prIds: s.prs,
    unresolvedPrNumbers: [],
    unmatchedCommits: 0,
  }));
  return { repoId, fullName: `acme/${name}`, name, writable: true, tags, ranges };
}
const pr = (id: number, repoId: number, tickets: string[]): ReleaseCheckPrInput => ({
  id, repoId, number: id, title: `change ${id}`, url: `https://github.com/acme/r/pull/${id}`, isBot: false, mergedAt: day(1), ticketIdents: tickets,
});
const openPr = (number: number, repoId: number, repoName: string, tickets: string[], prId: number | null = 900 + number): ReleaseCheckOpenPrInput => ({
  repoId, repoName, number, url: `https://github.com/acme/${repoName}/pull/${number}`, prId, ticketIdents: tickets,
});
const done = (key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput => ({
  ident: key, key, title: `${key} title`, url: null, statusName: 'Done', done: true, readState: 'ok', ...extra,
});
const wip = (key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput => done(key, { statusName: 'In Progress', done: false, ...extra });
const link = (key: string): TicketLinkBlocker => ({
  key, title: `${key} title`, status: 'In Progress', category: 'indeterminate', relation: 'is blocked by', url: `https://acme.atlassian.net/browse/${key}`,
});
const run = (parts: Partial<ReleaseCheckInput>): ReleaseCheckResult => foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], ...parts });
const names = new Map([[1, 'acme/api'], [2, 'acme/web']]);

// api: v1 (T1 ✓) · v2 (T2 in progress) · v3 (T3 ✓) · v4 (T4 in progress) · v5 (T5 ✓, open PR #50).
const fiveTags = () => repo(1, 'api', [
  { name: 'v1', d: 1, prs: [1] },
  { name: 'v2', d: 2, prs: [2] },
  { name: 'v3', d: 3, prs: [3] },
  { name: 'v4', d: 4, prs: [4] },
  { name: 'v5', d: 5, prs: [5] },
]);
const fivePrs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3']), pr(4, 1, ['T4']), pr(5, 1, ['T5'])];
const fiveTickets = (over: Partial<Record<string, Partial<ReleaseCheckTicketInput>>> = {}) => [
  done('T1', over.T1), wip('T2', { assigneeName: 'Robin Lee', ...over.T2 }), done('T3', over.T3), wip('T4', over.T4), done('T5', over.T5),
];

describe('Do these first — the plan as cards', () => {
  const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), openPrs: [openPr(50, 1, 'api', ['T5'])], tickets: fiveTickets() }));
  const cards = planCards(g, names);

  it('one card per move, the first THE best next move, each saying what it unlocks', () => {
    expect(cards.map((c) => [c.step, c.best, c.work.map((w) => w.label), c.unlocks])).toEqual([
      [1, true, ['T2'], 'Unlocks api v3'],
      [2, false, ['T4'], 'Unlocks api v4'],
      [3, false, ['T5'], 'Unlocks api v5'],
    ]);
  });

  it('a ticket chip opens the story; its title names status and assignee; a Complete ticket carries its open PR', () => {
    const t2 = cards[0]!.work[0]!;
    expect(t2).toMatchObject({ kind: 'story', ident: 'T2', key: 'T2', ticketTitle: 'T2 title', prs: [] });
    expect(t2.title).toBe('T2 “T2 title” · In Progress · Robin Lee');
    const t5 = cards[2]!.work[0]!;
    expect(t5.title).toBe('T5 “T5 title” · Done, pull request still open');
    expect(t5.prs).toEqual([{ key: '1#50', label: 'api #50', prId: 950, repoId: 1, repoFullName: 'acme/api', number: 50, url: 'https://github.com/acme/api/pull/50' }]);
  });

  it(`shows ${PLAN_CARDS_SHOWN}, then all`, () => {
    const many = [...cards, { ...cards[0]!, step: 4, best: false }, { ...cards[0]!, step: 5, best: false }];
    expect(planWindow(many, false)).toMatchObject({ hidden: 2 });
    expect(planWindow(many, false).shown.map((c) => c.step)).toEqual([1, 2, 3]);
    expect(planWindow(many, true)).toMatchObject({ hidden: 0 });
    expect(planWindow(cards, false)).toMatchObject({ hidden: 0 });
  });

  it('no moves, no cards', () => {
    const none = releaseGraph(run({ repos: [repo(1, 'api', [{ name: 'v1', d: 1, prs: [1] }])], prs: [pr(1, 1, ['T1'])], tickets: [done('T1')] }));
    expect(planCards(none)).toEqual([]);
  });
});

describe('Path to newer releases — one ladder per repository', () => {
  it('stops left to right with what each adds, how many tags it covers, and the plan step that releases it', () => {
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), openPrs: [openPr(50, 1, 'api', ['T5'])], tickets: fiveTickets() }));
    const [api] = ladderRows(g);
    expect(api).toMatchObject({ repoName: 'api', candidate: 'v1', checkingFrom: null });
    expect(api!.stops.map((s) => [s.tagName, s.tagsWords, s.adds.map((w) => w.label), s.step, s.partial])).toEqual([
      ['v3', '2 tags', ['T2'], 1, false],
      ['v4', null, ['T4'], 2, false],
      ['v5', null, ['T5'], 3, false],
    ]);
  });

  it("the tracker's links are kept apart (via), a tracker-only ticket links out, a loop is marked", () => {
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets({ T2: { blockedBy: [link('X-9')] } }) }));
    const stop = ladderRows(g)[0]!.stops[0]!;
    expect(stop.adds.map((w) => w.id)).toEqual(['t:T2']);
    expect(stop.via).toHaveLength(1);
    expect(stop.via[0]).toMatchObject({ id: 'k:X-9', kind: 'tracker', label: 'X-9', viaLink: true, url: 'https://acme.atlassian.net/browse/X-9' });
    expect(stop.via[0]!.title).toBe('X-9 “X-9 title” · In Progress · in the way through a tracker link');

    const loop = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets({ T2: { blockedBy: [link('T4')] }, T4: { blockedBy: [link('T2')] } }) }));
    expect(planCards(loop)[0]!.work.map((w) => [w.label, w.inCycle])).toEqual([['T2', true], ['T4', true]]);
  });

  it('a picked-together point is named once, on the first stop that needs it; one move releases both rows', () => {
    const check = run({
      repos: [
        repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1] }, { name: 'v1.1.0', d: 3, prs: [2] }]),
        repo(2, 'web', [{ name: 'w1.0.0', d: 1, prs: [21] }, { name: 'w1.1.0', d: 4, prs: [22] }]),
      ],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(21, 2, ['W1']), pr(22, 2, ['T2', 'W9'])],
      tickets: [done('T1'), done('T2'), done('W1'), wip('W9')],
    });
    const g = releaseGraph(check);
    const rows = ladderRows(g, check);
    const api = rows.find((r) => r.repoName === 'api')!;
    expect(api.stops[0]!.withPoints).toEqual([{ key: '2:w1.1.0', words: 'web w1.1.0', target: '2:w1.1.0' }]);
    expect(rows.find((r) => r.repoName === 'web')!.stops[0]!.key).toBe('2:w1.1.0');
    expect(rows.flatMap((r) => r.stops.map((s) => s.step))).toEqual([1, 1]);
  });

  it('"with web w1.1.0" points at the stop that HOLDS that tag when a stop covers several', () => {
    const check = run({
      repos: [
        repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1] }, { name: 'v1.1.0', d: 3, prs: [2] }]),
        repo(2, 'web', [{ name: 'w1.0.0', d: 1, prs: [21] }, { name: 'w1.1.0', d: 4, prs: [22] }, { name: 'w1.2.0', d: 5, prs: [23] }]),
      ],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(21, 2, ['W1']), pr(22, 2, ['T2', 'W9']), pr(23, 2, ['W2'])],
      tickets: [done('T1'), done('T2'), done('W1'), wip('W9'), done('W2')],
    });
    const rows = ladderRows(releaseGraph(check), check);
    expect(rows.find((r) => r.repoName === 'web')!.stops.map((s) => [s.key, s.tagsWords])).toEqual([['2:w1.2.0', '2 tags']]);
    expect(rows.find((r) => r.repoName === 'api')!.stops[0]!.withPoints).toEqual([{ key: '2:w1.1.0', words: 'web w1.1.0', target: '2:w1.2.0' }]);
  });

  it('unknown is never zero: nothing above the candidate is NO row; a partial stop says so and has no step', () => {
    const flat = releaseGraph(run({ repos: [repo(1, 'api', [{ name: 'v1', d: 1, prs: [1] }])], prs: [pr(1, 1, ['T1'])], tickets: [done('T1')] }));
    expect(ladderRows(flat)).toEqual([]);
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets({ T4: { readState: 'not_read', done: false, statusName: null } }) }));
    expect(ladderRows(g)[0]!.stops.map((s) => [s.tagName, s.partial, s.step])).toEqual([['v3', false, 1], ['v5', true, null]]);
  });
});

describe('the ticket list badge', () => {
  it('"Unlocks …" when finishing it alone releases something, else "Holds back …"; only work items', () => {
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets() }));
    const b = ticketGraphBadges(g);
    expect(b.get('T2')).toEqual({ tone: 'unlocks', text: 'Unlocks api v3' });
    expect(b.get('T4')).toEqual({ tone: 'holds', text: 'Holds back api v5' }); // no open PR here: v4 and v5 are one stop
    expect(b.has('T1')).toBe(false);
    expect(b.has('T3')).toBe(false);
  });
});

describe('words', () => {
  it('joins points; nothing is no words', () => {
    expect(unlocksWords([{ repoId: 1, repoName: 'api', tagName: '0.330.0' }, { repoId: 2, repoName: 'web', tagName: 'w1.1.0' }])).toBe('Unlocks api 0.330.0 · web w1.1.0');
    expect(unlocksWords([])).toBeNull();
  });

  it('a new tag reads as the work it is', () => {
    expect(newTagWords({ repoName: 'web', number: 40 })).toBe('New version tag in web for #40');
    const chip = workChip({
      id: 'n:web#40', kind: 'new_tag', state: 'new_tag', key: null, ident: null, title: null, statusName: null, assigneeName: null, url: null,
      openPrs: [], repoName: 'web', number: 40, waitsOn: [], inCycle: false, holds: [], unlocksAlone: [],
    });
    expect(chip).toMatchObject({ kind: 'tag', label: 'New version tag in web for #40' });
  });
});
