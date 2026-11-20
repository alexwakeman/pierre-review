// RELEASING WITHOUT VERSION TAGS (docs/RELEASES.md § Releasing without version tags, 2026-11-19): the pure
// parts — the basis rule, the date-named release tag, the release points from the walked history, and the
// fold over them (via the same `historyView` the DB half uses).
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  releaseBasisOf,
  releaseDateTagName,
  releasePointNumber,
  releaseSplitWhere,
  type ReleaseCheckInput,
  type ReleaseCheckRepoInput,
} from '@pierre-review/shared';
import { historyView, releasePointsOf, type StoredHistoryCommit } from './history-fold.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const sha = (c: string) => c.padEnd(40, '0');

describe('releaseBasisOf — THE ONE basis rule', () => {
  it('auto: no version tag (release and hotfix tags do not count) → merged pull requests; one → version tags', () => {
    expect(releaseBasisOf('auto', [], SETTINGS)).toBe('prs');
    expect(releaseBasisOf(null, ['2026.11.19-rc', 'x-hotfix'], SETTINGS)).toBe('prs');
    expect(releaseBasisOf(undefined, ['v1.0.0', 'v1.0.0-rc'], SETTINGS)).toBe('tags');
  });
  it('a stored choice wins', () => {
    expect(releaseBasisOf('prs', ['v1.0.0'], SETTINGS)).toBe('prs');
    expect(releaseBasisOf('tags', [], SETTINGS)).toBe('tags');
  });
});

describe('releaseDateTagName — the tag Ensemble creates when there is no version', () => {
  it('the local day + suffix; .2, .3 when taken', () => {
    const at = new Date(2026, 10, 9, 15);
    expect(releaseDateTagName(at, '-rc', [])).toBe('2026.11.09-rc');
    expect(releaseDateTagName(at, '-rc', ['2026.11.09-rc'])).toBe('2026.11.09.2-rc');
    expect(releaseDateTagName(at, '-rc', new Set(['2026.11.09-rc', '2026.11.09.2-rc']))).toBe('2026.11.09.3-rc');
  });
  it('point names round-trip', () => {
    expect(releasePointNumber('#539')).toBe(539);
    expect(releasePointNumber('v1.0.0')).toBeNull();
  });
});

const commit = (c: string, seq: number, prs: number[], d: number): StoredHistoryCommit => ({ sha: sha(c), seq, prNumbers: prs, committedAt: day(d) });

describe('releasePointsOf — one point per merged PR, at its newest first-parent commit', () => {
  it('squash and merge commits are one point each; a rebase merge is one point at its top commit; direct pushes make none', () => {
    const points = releasePointsOf([
      commit('c1', -5, [1], 1),
      commit('c2', -4, [], 2),
      commit('c3', -3, [2], 3),
      commit('c4', -2, [2], 3),
      commit('c5', -1, [3, 4], 4),
    ]);
    expect(points.map((p) => [p.name, p.sha])).toEqual([
      ['#3', sha('c5')],
      ['#2', sha('c4')],
      ['#1', sha('c1')],
    ]);
  });
  it('dates that tie or run backwards are nudged so the points sort in walk order', () => {
    const points = releasePointsOf([commit('a', -3, [1], 5), commit('b', -2, [2], 5), commit('c', -1, [3], 4)]);
    const ms = points.map((p) => p.committedAt!.getTime()).reverse();
    expect(ms[0]).toBe(day(5).getTime());
    expect(ms[1]).toBe(day(5).getTime() + 1);
    expect(ms[2]).toBe(day(5).getTime() + 2);
  });
});

/** What the DB half builds for a repository released from merged PRs: the points as tags, increments by
 *  `historyView`. Each PR id = its number; ticket T<n> on PR n. */
function pointsRepo(commits: StoredHistoryCommit[], extraTags: Array<{ name: string; c: string; d: number; taggedAt?: number }> = []): ReleaseCheckRepoInput {
  const points = releasePointsOf(commits);
  const pointAt = new Map(points.map((p) => [p.sha, p.committedAt]));
  const tags = [
    ...points.map((p) => ({ name: p.name, sha: p.sha, committedAt: p.committedAt, taggedAt: null })),
    ...extraTags.map((t) => ({ name: t.name, sha: sha(t.c), committedAt: pointAt.get(sha(t.c)) ?? day(t.d), taggedAt: t.taggedAt != null ? day(t.taggedAt) : null })),
  ];
  const view = historyView(commits, tags, { coversAll: true, tipPending: false, topCommittedAt: null });
  return {
    repoId: 1,
    fullName: 'acme/svc',
    name: 'svc',
    writable: true,
    basis: 'prs',
    pointReleaseTagName: '2026.11.19-rc',
    tags: tags.map((t) => ({ ...t, onDefaultBranch: view.onDefaultBranch.get(t.name) ?? null, moved: false })),
    ranges: view.increments.map((x) => ({ ...x, prIds: x.prNumbers, unresolvedPrNumbers: [] })),
  };
}

function input(repo: ReleaseCheckRepoInput, notDone: number[] = [], n = 0): ReleaseCheckInput {
  const numbers = repo.ranges.flatMap((r) => r.prIds);
  const all = n > 0 ? Array.from({ length: n }, (_, i) => i + 1) : numbers;
  return {
    settings: SETTINGS,
    repos: [repo],
    prs: all.map((id) => ({ id, repoId: 1, number: id, title: `change ${id}`, url: `https://github.com/acme/svc/pull/${id}`, isBot: false, mergedAt: day(1), ticketIdents: [`T${id}`] })),
    tickets: all.map((id) => ({ ident: `T${id}`, key: `T-${id}`, title: null, url: null, statusName: notDone.includes(id) ? 'In review' : 'Done', done: !notDone.includes(id), readState: 'ok' as const })),
  };
}

describe('the cumulative rule over release points', () => {
  const chain = () => [commit('c1', -4, [1], 1), commit('c2', -3, [2], 2), commit('c3', -2, [3], 3), commit('c4', -1, [4], 4)];

  it('all Complete → the newest merged PR; its release tag is the date-named one', () => {
    const res = foldReleaseCheck(input(pointsRepo(chain())));
    expect(res.repos[0]).toMatchObject({ basis: 'prs', status: 'candidate', scope: 'since_start' });
    expect(res.repos[0]!.candidate).toMatchObject({ name: '#4', sha: sha('c4'), releaseTagName: '2026.11.19-rc', point: { number: 4, title: 'change 4' } });
  });

  it('a ticket not Complete holds its PR and every later one: the candidate is the PR just below it', () => {
    const res = foldReleaseCheck(input(pointsRepo(chain()), [2]));
    const repo = res.repos[0]!;
    expect(repo.candidate?.name).toBe('#1');
    expect(repo.tags.map((t) => [t.name, t.state])).toEqual([
      ['#4', 'does_not_qualify'],
      ['#3', 'does_not_qualify'],
      ['#2', 'does_not_qualify'],
      ['#1', 'qualifies'],
    ]);
    expect(repo.tags[0]!.blockers[0]).toMatchObject({ kind: 'not_done', key: 'T-2', fromTag: '#2' });
  });

  it('a release tag on a point is the baseline: only later PRs are new', () => {
    const repo = pointsRepo(chain(), [{ name: '2026.11.10-rc', c: 'c2', d: 2, taggedAt: 9 }]);
    const res = foldReleaseCheck(input(repo, [1]));
    expect(res.repos[0]).toMatchObject({ status: 'candidate', baseline: { name: '2026.11.10-rc' }, scope: 'since_release' });
    expect(res.repos[0]!.candidate?.name).toBe('#4');
    // PR 1's ticket is behind the release: it holds nothing.
    expect(res.repos[0]!.candidatePrIds.sort()).toEqual([3, 4]);
  });

  it('nothing merged since the release → nothing new', () => {
    const repo = pointsRepo(chain(), [{ name: '2026.11.10-rc', c: 'c4', d: 4, taggedAt: 9 }]);
    expect(foldReleaseCheck(input(repo))).toMatchObject({ repos: [{ status: 'nothing_new', nothingNewReason: 'no_new_tags' }] });
  });

  it('a split names the PR alone when it is its own point', () => {
    expect(releaseSplitWhere({ repoName: 'web', number: 21, tagName: '#21' })).toBe('web #21');
    expect(releaseSplitWhere({ repoName: 'web', number: 21, tagName: '#20' })).toBe('web #21 (in #20)');
    expect(releaseSplitWhere({ repoName: 'web', number: 21, tagName: 'v1.1.0' })).toBe('web #21 (in v1.1.0)');
  });

  it('stays fast on a long history: 1,500 merged PRs with the oldest one held', () => {
    const N = 1500;
    const commits = Array.from({ length: N }, (_, i) => commit(`p${i + 1}`, -(N - i), [i + 1], 1 + i / 100));
    const repo = pointsRepo(commits);
    const t0 = performance.now();
    const res = foldReleaseCheck(input(repo, [1], N));
    const ms = performance.now() - t0;
    expect(res.repos[0]!.status).toBe('none');
    expect(res.repos[0]!.tags).toHaveLength(N);
    expect(ms).toBeLessThan(1_000);
  });
});
