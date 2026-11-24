// THE RELEASE GRAPH (docs/RELEASES.md § The path to newer releases): the shared pure fold `releaseGraph`
// over a REAL release check (`foldReleaseCheck`), so the ladders, the plan and the tracker links are
// read off the same reasons the Releases tab shows.
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  releaseGraph,
  releasePointWords,
  type ReleaseCheckInput,
  type ReleaseCheckOpenPrInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckRepoInput,
  type ReleaseCheckResult,
  type ReleaseCheckTicketInput,
  type ReleasePointRef,
  type TicketLinkBlocker,
} from '@pierre-review/shared';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const sha = (c: string) => c.padEnd(40, '0');

/** A repo whose version tags are on main, each with its own increment of PR ids. */
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
const openPr = (number: number, repoId: number, repoName: string, tickets: string[]): ReleaseCheckOpenPrInput => ({
  repoId, repoName, number, url: `https://github.com/acme/${repoName}/pull/${number}`, prId: 900 + number, ticketIdents: tickets,
});
const done = (key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput => ({
  ident: key, key, title: `${key} title`, url: null, statusName: 'Done', done: true, readState: 'ok', ...extra,
});
const wip = (key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput => done(key, { statusName: 'In Progress', done: false, ...extra });
const link = (key: string, category: 'new' | 'indeterminate' | 'done' = 'indeterminate'): TicketLinkBlocker => ({
  key, title: `${key} title`, status: category === 'done' ? 'Done' : 'In Progress', category, relation: 'is blocked by', url: null,
});
const run = (parts: Partial<ReleaseCheckInput>): ReleaseCheckResult => foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], ...parts });
const words = (ps: ReleasePointRef[]) => ps.map(releasePointWords);

// api: v1 (T1 ✓) · v2 (T2 in progress) · v3 (T3 ✓) · v4 (T4 in progress) · v5 (T5 ✓, open PR).
const fiveTags = () => repo(1, 'api', [
  { name: 'v1', d: 1, prs: [1] },
  { name: 'v2', d: 2, prs: [2] },
  { name: 'v3', d: 3, prs: [3] },
  { name: 'v4', d: 4, prs: [4] },
  { name: 'v5', d: 5, prs: [5] },
]);
const fivePrs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3']), pr(4, 1, ['T4']), pr(5, 1, ['T5'])];
const fiveTickets = (over: Partial<Record<string, Partial<ReleaseCheckTicketInput>>> = {}) => [
  done('T1', over.T1), wip('T2', over.T2), done('T3', over.T3), wip('T4', over.T4), done('T5', over.T5),
];

describe('releaseGraph — one repository is a ladder', () => {
  const check = run({ repos: [fiveTags()], prs: fivePrs(), openPrs: [openPr(50, 1, 'api', ['T5'])], tickets: fiveTickets() });
  const g = releaseGraph(check);
  const api = g.ladders[0]!;

  it('folds tags with the same needs into one stop; the needs only grow', () => {
    expect(api.candidate).toBe('v1');
    expect(api.stops.map((s) => [s.tagName, s.tags, s.needs, s.adds])).toEqual([
      ['v3', 2, ['t:T2'], ['t:T2']],
      ['v4', 1, ['t:T2', 't:T4'], ['t:T4']],
      ['v5', 1, ['t:T2', 't:T4', 't:T5'], ['t:T5']],
    ]);
    expect(api.checkingFrom).toBeNull();
  });

  it('plans the cheapest next stop first, and says what each move unlocks', () => {
    expect(g.moves.map((m) => [m.work, words(m.unlocks)])).toEqual([
      [['t:T2'], ['api v3']],
      [['t:T4'], ['api v4']],
      [['t:T5'], ['api v5']],
    ]);
  });

  it('per work item: why, what it holds, and what finishing it alone unlocks', () => {
    const byId = new Map(g.work.map((w) => [w.id, w]));
    expect(g.work.map((w) => w.id)).toEqual(['t:T2', 't:T4', 't:T5']);
    expect(byId.get('t:T2')).toMatchObject({ state: 'not_done', key: 'T2', statusName: 'In Progress' });
    expect(words(byId.get('t:T2')!.unlocksAlone)).toEqual(['api v3']);
    expect(words(byId.get('t:T4')!.unlocksAlone)).toEqual([]); // T2 is still in the way
    expect(words(byId.get('t:T4')!.holds)).toEqual(['api v4']);
    expect(byId.get('t:T5')).toMatchObject({ state: 'open_pr' });
    expect(byId.get('t:T5')!.openPrs.map((p) => p.number)).toEqual([50]);
  });
});

describe('releaseGraph — the tracker\'s "is blocked by" links', () => {
  it('a link to a ticket outside the check is work the plan counts, kept apart from the rule', () => {
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets({ T2: { blockedBy: [link('X-9'), link('X-1', 'done')] } }) }));
    const first = g.ladders[0]!.stops[0]!;
    expect(first.needs).toEqual(['t:T2']);
    expect(first.via).toEqual(['k:X-9']); // the Complete X-1 is not in the way
    expect(g.moves[0]).toEqual({ work: ['k:X-9', 't:T2'], unlocks: [{ repoId: 1, repoName: 'api', tagName: 'v3' }] });
    const x9 = g.work.find((w) => w.id === 'k:X-9')!;
    expect(x9).toMatchObject({ state: 'tracker_link', key: 'X-9', statusName: 'In Progress' });
    expect(words(x9.holds)).toEqual(['api v3']);
    expect(g.work.find((w) => w.id === 't:T2')!.waitsOn).toEqual(['k:X-9']);
  });

  it('a loop of links is marked, and the plan still ends', () => {
    const g = releaseGraph(run({
      repos: [fiveTags()], prs: fivePrs(),
      tickets: fiveTickets({ T2: { blockedBy: [link('T4')] }, T4: { blockedBy: [link('T2')] } }),
    }));
    expect(g.work.filter((w) => w.inCycle).map((w) => w.id).sort()).toEqual(['t:T2', 't:T4']);
    expect(g.moves[0]!.work).toEqual(['t:T2', 't:T4']);
    expect(words(g.moves[0]!.unlocks)).toEqual(['api v5']); // no open PR here: v4 and v5 need the same
  });
});

describe('releaseGraph — picked together across repositories', () => {
  // api: v1.0.0 (T1) · v1.1.0 (T2 ✓, but its web half is in w1.1.0). web: w1.0.0 (W1) · w1.1.0 (T2 + W9 in progress).
  const check = run({
    repos: [
      repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1] }, { name: 'v1.1.0', d: 3, prs: [2] }]),
      repo(2, 'web', [{ name: 'w1.0.0', d: 1, prs: [21] }, { name: 'w1.1.0', d: 4, prs: [22] }]),
    ],
    prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(21, 2, ['W1']), pr(22, 2, ['T2', 'W9'])],
    tickets: [done('T1'), done('T2'), done('W1'), wip('W9')],
  });
  const g = releaseGraph(check);

  it("a split joins the other repository's needs, and the edge is drawn once", () => {
    const api = g.ladders.find((l) => l.repoName === 'api')!;
    expect(api.candidate).toBe('v1.0.0');
    expect(api.stops.map((s) => [s.tagName, s.needs])).toEqual([['v1.1.0', ['t:W9']]]);
    expect(words(api.stops[0]!.withPoints)).toEqual(['web w1.1.0']);
    expect(g.links.map((l) => `${releasePointWords(l.from)} → ${releasePointWords(l.to)}`)).toEqual(['api v1.1.0 → web w1.1.0']);
  });

  it('one move unlocks both repositories', () => {
    expect(g.moves.map((m) => [m.work, words(m.unlocks).sort()])).toEqual([[['t:W9'], ['api v1.1.0', 'web w1.1.0']]]);
    expect(words(g.work[0]!.unlocksAlone).sort()).toEqual(['api v1.1.0', 'web w1.1.0']);
  });
});

describe('releaseGraph — unknown is never zero', () => {
  it('a repository with nothing newer has an empty ladder and no plan', () => {
    const g = releaseGraph(run({ repos: [repo(1, 'api', [{ name: 'v1', d: 1, prs: [1] }])], prs: [pr(1, 1, ['T1'])], tickets: [done('T1')] }));
    expect(g.ladders[0]).toMatchObject({ candidate: 'v1', stops: [], checkingFrom: null });
    expect(g.moves).toEqual([]);
  });

  it('a tag with a ticket not read yet is partial: the plan promises nothing past it', () => {
    // The check lists no reason for the unread T4 (v4 is already ruled out by T2), so without this the
    // graph would say finishing T2 releases v5.
    const g = releaseGraph(run({ repos: [fiveTags()], prs: fivePrs(), tickets: fiveTickets({ T4: { readState: 'not_read', done: false, statusName: null } }) }));
    const api = g.ladders[0]!;
    expect(api.stops.map((s) => [s.tagName, s.tags, s.partial])).toEqual([['v3', 2, false], ['v5', 2, true]]);
    expect(g.moves.map((m) => [m.work, words(m.unlocks)])).toEqual([[['t:T2'], ['api v3']]]);
    expect(words(g.work.find((w) => w.id === 't:T2')!.unlocksAlone)).toEqual(['api v3']);
  });
});
