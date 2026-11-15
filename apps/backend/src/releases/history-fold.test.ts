// THE HISTORY PASS'S PURE HALF (releases/history-fold.ts; docs/RELEASES.md § One history pass):
// one history page → its first-parent commits and their PRs, and the walked commits + tags → each tag's
// place on the default branch and its increment.
import { describe, expect, it } from 'vitest';
import type { GqlHistoryCommit } from '../github/tag-queries.js';
import { historyPrsOf, historyView, walkHistoryPage, type StoredHistoryCommit } from './history-fold.js';

const sha = (c: string) => c.padEnd(40, '0');
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const FULL = 'acme/api';

const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `change ${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  headRefName: `PLAT-${number}-x`,
  baseRefName: 'main',
  merged: true,
  mergedAt: day(1).toISOString(),
  mergeCommit: { oid: null },
  author: { __typename: 'User', login: 'ada' },
  repository: { nameWithOwner: FULL },
  ...extra,
});
const node = (c: string, parent: string | null, prs: unknown[] = [], d = 1): GqlHistoryCommit => ({
  oid: sha(c),
  committedDate: day(d).toISOString(),
  parents: { nodes: parent == null ? [] : [{ oid: sha(parent) }] },
  associatedPullRequests: { nodes: prs as never },
});

describe('historyPrsOf — the PRs that count for a range', () => {
  it('merged, into the default branch, of THIS repo; the merge commit first; each once', () => {
    const out = historyPrsOf(
      [
        pr(1),
        pr(2, { merged: false }),
        pr(3, { baseRefName: 'hotfix/v1.0.0-rc' }),
        pr(4, { repository: { nameWithOwner: 'fork/api' } }),
        pr(5, { mergeCommit: { oid: sha('c') }, author: { __typename: 'Bot', login: 'renovate' } }),
        pr(1),
      ] as never,
      sha('c'),
      FULL,
      'main',
    );
    expect(out.map((p) => p.number)).toEqual([5, 1]);
    expect(out[0]).toMatchObject({ authorIsBotType: true, authorLogin: 'renovate', headRefName: 'PLAT-5-x' });
  });
});

describe('walkHistoryPage — the first-parent chain', () => {
  it('a merge commit with two parents is walked FIRST-PARENT: the merged branch\'s own commits are passed over', () => {
    // git log order: M (merge of main~ and side), S2, S1 (the side branch), A, ROOT.
    const nodes = [
      { ...node('M', 'A', [pr(7)]), parents: { nodes: [{ oid: sha('A') }, { oid: sha('S2') }] } },
      node('S2', 'S1', [pr(7)]),
      node('S1', 'A', [pr(7)]),
      node('A', 'ROOT', [pr(6)]),
      node('ROOT', null),
    ];
    const r = walkHistoryPage(nodes, { expected: sha('M'), fullName: FULL, defaultBranch: 'main' });
    expect(r.taken.map((c) => c.sha)).toEqual([sha('M'), sha('A'), sha('ROOT')]);
    expect(r.taken.map((c) => c.prs.map((p) => p.number))).toEqual([[7], [6], []]);
    expect(r).toMatchObject({ expected: null, reachedStop: false, paused: false });
  });

  it('a tip segment stops at the walked head (not taken); the deep one pauses after the baseline', () => {
    const nodes = [node('D', 'C'), node('C', 'B'), node('B', 'A'), node('A', null)];
    const tip = walkHistoryPage(nodes, { expected: sha('D'), stopSha: sha('B'), fullName: FULL, defaultBranch: 'main' });
    expect(tip.taken.map((c) => c.sha)).toEqual([sha('D'), sha('C')]);
    expect(tip).toMatchObject({ reachedStop: true, expected: sha('B') });
    const deep = walkHistoryPage(nodes, { expected: sha('D'), fullName: FULL, defaultBranch: 'main', pauseAfter: (s) => s === sha('C') });
    expect(deep.taken.map((c) => c.sha)).toEqual([sha('D'), sha('C')]);
    expect(deep).toMatchObject({ paused: true, expected: sha('B') });
    // Read again from the same cursor, the walk goes on from where it paused.
    const again = walkHistoryPage(nodes, { expected: deep.expected, fullName: FULL, defaultBranch: 'main' });
    expect(again.taken.map((c) => c.sha)).toEqual([sha('B'), sha('A')]);
  });
});

describe('historyView — commit → tag assignment and the tags on main', () => {
  // Walked newest first: c7 (v1.2.0), c6, c5 (v1.1.0 and its release tag), c4, c3, c2 (v1.0.0), c1.
  const chain = (prs: Record<string, number[]> = {}): StoredHistoryCommit[] =>
    ['c7', 'c6', 'c5', 'c4', 'c3', 'c2', 'c1'].map((c, i) => ({ sha: sha(c), seq: -i, prNumbers: prs[c] ?? [], committedAt: day(7 - i) }));
  const tag = (name: string, c: string, d: number, taggedAt: number | null = null) => ({ name, sha: sha(c), committedAt: day(d), taggedAt: taggedAt == null ? null : day(taggedAt) });
  const tags = [tag('v1.0.0', 'c2', 2), tag('v1.1.0', 'c5', 5), tag('v1.1.0-rc', 'c5', 5, 6), tag('v1.2.0', 'c7', 7), tag('v0.9.0-hotfix', 'h1', 4)];

  it('linear: each commit belongs to the nearest tag at or above it; the oldest tag takes everything to the root', () => {
    const v = historyView(chain({ c7: [9], c6: [8], c5: [7], c4: [6], c3: [], c2: [4], c1: [3] }), tags, { coversAll: true, tipPending: false, topCommittedAt: day(7) });
    expect(v.increments.map((x) => [x.tagName, x.prNumbers, x.commitCount, x.unmatchedCommits])).toEqual([
      ['v1.0.0', [3, 4], 2, 0],
      ['v1.1.0', [6, 7], 3, 1],
      // Tags on ONE commit: the second adds nothing.
      ['v1.1.0-rc', [], 0, 0],
      ['v1.2.0', [8, 9], 2, 0],
    ]);
    expect(v.increments.find((x) => x.tagName === 'v1.2.0')).toMatchObject({ baseTagName: 'v1.1.0-rc' });
    // A tag off main (a hotfix tag) is not on it once the walk covers its date.
    expect(v.onDefaultBranch.get('v0.9.0-hotfix')).toBe(false);
    expect(v.onDefaultBranch.get('v1.0.0')).toBe(true);
  });

  it('commits above the newest tag are in no tag yet', () => {
    const c = [{ sha: sha('c8'), seq: 1, prNumbers: [99], committedAt: day(8) }, ...chain()];
    const v = historyView(c, tags, { coversAll: true, tipPending: false, topCommittedAt: day(8) });
    expect(v.increments.flatMap((x) => x.prNumbers)).not.toContain(99);
  });

  it('part way: the oldest tag reached has no complete increment yet; tags older than the walk are not known', () => {
    // Walked c7 … c4 only (the deep segment is still going back).
    const v = historyView(chain({ c7: [9], c6: [8], c5: [7] }).slice(0, 4), tags, { coversAll: false, tipPending: false, topCommittedAt: day(7) });
    expect(v.increments.map((x) => x.tagName)).toEqual(['v1.1.0-rc', 'v1.2.0']);
    expect(v.onDefaultBranch.get('v1.0.0')).toBeNull();
    expect(v.onDefaultBranch.get('v1.1.0')).toBe(true);
  });

  it('a newer head still being read: tags dated after the walked head are not known yet', () => {
    const v = historyView(chain(), [...tags, tag('v1.3.0', 'c9', 9)], { coversAll: true, tipPending: true, topCommittedAt: day(7) });
    expect(v.onDefaultBranch.get('v1.3.0')).toBeNull();
    expect(v.onDefaultBranch.get('v0.9.0-hotfix')).toBe(false);
  });
});
