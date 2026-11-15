// THE RELEASE CHECK (docs/RELEASES.md § The release check; § Acceptance checks 4–18, 38–42): the pure shared
// fold `foldReleaseCheck` (+ `releaseBlockerText`, `releaseShippedTickets`), then the DB half
// (db/release-check.ts `getReleases`) on a THROWAWAY sqlite DB with the tracker site stubbed.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load), and
// every DB value import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  foldReleaseCheck,
  releaseBlockerShort,
  releaseBlockerText,
  releaseScanLine,
  releaseShippedTickets,
  releasesChecking,
  type ReleaseCheckInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckRepoInput,
  type ReleaseCheckResult,
  type ReleaseCheckTicketInput,
} from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-check-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const SITE = { provider: 'jira' as const, apiRoot: 'https://acme.atlassian.net' };
vi.mock('./stories.js', () => ({ workspaceSite: async () => SITE }));

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const sha = (c: string) => c.padEnd(40, '0');

// ── Builders for the pure fold ──────────────────────────────────────────────────────────────────

interface TagSpec {
  name: string;
  d: number;
  /** PR ids in this tag's increment. */
  prs?: number[];
  /** Defaults to the tag name (a release tag passes its version tag's to share the commit). */
  commit?: string;
  taggedAt?: number;
  onDefaultBranch?: boolean;
  /** Leave the stored increment out (not computed yet). */
  noRange?: boolean;
}

/** A repo whose stored increments are fresh: each tag's base is the default-branch tag before it. */
function repo(repoId: number, name: string, specs: TagSpec[], writable = true): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({
    name: s.name,
    sha: sha(s.commit ?? s.name),
    committedAt: day(s.d),
    taggedAt: s.taggedAt != null ? day(s.taggedAt, 18) : null,
    onDefaultBranch: s.onDefaultBranch ?? true,
    moved: false,
  }));
  const onMain = tags
    .map((t, i) => ({ t, s: specs[i]! }))
    .filter((x) => x.t.onDefaultBranch)
    .sort((a, b) => a.t.committedAt.getTime() - b.t.committedAt.getTime() || (a.t.taggedAt?.getTime() ?? 0) - (b.t.taggedAt?.getTime() ?? 0));
  const ranges = onMain.flatMap(({ t, s }, i) => {
    if (s.noRange) return [];
    const base = i > 0 ? onMain[i - 1]!.t : null;
    return [
      {
        tagName: t.name,
        sha: t.sha,
        baseTagName: base?.name ?? null,
        baseSha: base?.sha ?? null,
        method: base == null ? ('history' as const) : ('compare' as const),
        prIds: s.prs ?? [],
        unresolvedPrNumbers: [],
        unmatchedCommits: 0,
        truncated: false,
      },
    ];
  });
  return { repoId, fullName: `acme/${name}`, name, writable, tags, ranges };
}

function pr(id: number, repoId: number, tickets: string[], extra: Partial<ReleaseCheckPrInput> = {}): ReleaseCheckPrInput {
  return {
    id,
    repoId,
    number: id,
    title: `change ${id}`,
    url: `https://github.com/acme/r/pull/${id}`,
    isBot: false,
    intoDefaultBranch: true,
    state: 'merged',
    mergedAt: day(1),
    ticketIdents: tickets,
    ...extra,
  };
}

function ticket(key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput {
  return { ident: key, key, title: `${key} title`, url: null, statusName: 'Done', done: true, readState: 'ok', ...extra };
}

function run(parts: Partial<ReleaseCheckInput>): ReleaseCheckResult {
  return foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], ...parts });
}

const repoOf = (res: ReleaseCheckResult, repoId: number) => res.repos.find((r) => r.repoId === repoId)!;
const tagOf = (res: ReleaseCheckResult, repoId: number, name: string) => repoOf(res, repoId).tags.find((t) => t.name === name)!;
const ticketOf = (res: ReleaseCheckResult, ident: string) => res.tickets.find((t) => t.ident === ident)!;
const words = (res: ReleaseCheckResult) => ({
  repoName: (id: number) => res.repos.find((r) => r.repoId === id)?.name ?? '?',
  prNumber: (id: number) => res.prs.find((p) => p.id === id)?.number ?? null,
});

// v1.0.0 (PR 1, T1) · v1.1.0 (PR 2, T2) · v1.2.0 (PR 3, T3), no release.
const threeTags = () =>
  repo(1, 'api', [
    { name: 'v1.0.0', d: 1, prs: [1] },
    { name: 'v1.1.0', d: 3, prs: [2] },
    { name: 'v1.2.0', d: 5, prs: [3] },
  ]);
const threePrs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])];

// ── Candidate ───────────────────────────────────────────────────────────────────────────────────

describe('foldReleaseCheck — the automatic walk, per repo', () => {
  it('acceptance 4/14: v1.0.0, v1.1.0, v1.2.0, no release, all Done → the walk starts at the OLDEST tag; candidate v1.2.0', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api.status).toBe('candidate');
    expect(api.candidate).toMatchObject({ name: 'v1.2.0', releaseTagName: 'v1.2.0-rc', releaseTagExists: false });
    expect(api.baseline).toBeNull();
    expect(api.firstVersion?.name).toBe('v1.0.0');
    expect(api.tags.map((t) => t.name)).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0']);
    expect(api.tags.filter((t) => t.isCandidate).map((t) => t.name)).toEqual(['v1.2.0']);
    expect(api.ticketIdents.sort()).toEqual(['T1', 'T2', 'T3']);
    expect(api).toMatchObject({ checking: false, progress: null });
    expect(res.warnings).toEqual([]);
  });

  it('acceptance 5/42: v1.1.0 adds an In review ticket → candidate v1.0.0; v1.1.0 names it; v1.2.0 says it also contains it', () => {
    const res = run({
      repos: [threeTags()],
      prs: threePrs(),
      tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In review' }), ticket('T3', { done: false, statusName: 'To do' })],
    });
    const api = repoOf(res, 1);
    expect(api.status).toBe('candidate');
    expect(api.candidate?.name).toBe('v1.0.0');
    expect(api.firstBlocked).toBe('v1.1.0');
    expect(api.firstBlocker).toEqual({ kind: 'not_done', ident: 'T2', key: 'T2', statusName: 'In review' });
    const v11 = tagOf(res, 1, 'v1.1.0');
    expect(v11).toMatchObject({ blocked: true, state: 'held', alsoHeldBy: [] });
    expect(releaseBlockerText(v11.blockers[0]!, words(res))).toBe('T2 is not done (In review).');
    // v1.2.0 shows its OWN reason, and what it carries from the earlier held tag (tags are cumulative).
    const v12 = tagOf(res, 1, 'v1.2.0');
    expect(v12).toMatchObject({ blocked: true, state: 'held' });
    expect(v12.blockers).toEqual([{ kind: 'not_done', ident: 'T3', key: 'T3', statusName: 'To do' }]);
    expect(v12.alsoHeldBy).toEqual([{ blocker: v11.blockers[0], fromTag: 'v1.1.0' }]);
    expect(ticketOf(res, 'T2')).toMatchObject({ ready: false, inRelease: false });
    expect(api.latestVersion?.name).toBe('v1.2.0');
  });

  it('acceptance 16: the OLDEST tag holds → no tag can be released (blocked, the oldest tag named)', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1', { done: false, statusName: 'In Progress' }), ticket('T2'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'blocked', candidate: null, firstBlocked: 'v1.0.0', baseline: null });
    expect(api.firstBlocker).toMatchObject({ kind: 'not_done', key: 'T1', statusName: 'In Progress' });
    expect(releaseBlockerShort(api.firstBlocker!)).toBe('T1 (In Progress)');
    // The later tags are each read and say they also contain T1.
    expect(tagOf(res, 1, 'v1.2.0').alsoHeldBy.map((h) => [h.blocker.kind, h.fromTag])).toEqual([['not_done', 'v1.0.0']]);
  });

  it('acceptance 8: that ticket moves to Done → candidate v1.2.0', () => {
    const before = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In review' }), ticket('T3')] });
    const after = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(before, 1).candidate?.name).toBe('v1.0.0');
    expect(repoOf(after, 1).candidate?.name).toBe('v1.2.0');
  });

  it('acceptance 7: a human PR with no ticket → still a candidate, with a warning naming the PR', () => {
    const res = run({ repos: [threeTags()], prs: [pr(1, 1, ['T1']), pr(2, 1, []), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api.candidate?.name).toBe('v1.2.0');
    expect(api.untrackedPrIds).toEqual([2]);
    expect(api.botPrIds).toEqual([]);
    expect(api.warningCount).toBe(1);
    expect(res.warnings).toEqual([{ kind: 'untracked_pr', repoId: 1, prId: 2 }]);
  });

  it('acceptance 8: a bot PR with no ticket → no warning; listed under bot changes', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, [], { isBot: true }), pr(3, 1, ['T3'])],
      tickets: [ticket('T1'), ticket('T3')],
    });
    const api = repoOf(res, 1);
    expect(api.candidate?.name).toBe('v1.2.0');
    expect(api.botPrIds).toEqual([2]);
    expect(api.untrackedPrIds).toEqual([]);
    expect(api.warningCount).toBe(0);
    expect(res.warnings).toEqual([]);
  });

  it('acceptance 9: a bot PR naming a not-done ticket → blocks', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2'], { isBot: true }), pr(3, 1, ['T3'])],
      tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'To do' }), ticket('T3')],
    });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
    expect(tagOf(res, 1, 'v1.1.0').blockers[0]).toMatchObject({ kind: 'not_done', key: 'T2' });
  });

  it.each([
    ['not_found', 'T2 could not be read: it was not found.'],
    ['no_access', 'T2 could not be read: there is no access to it.'],
    ['failed', 'T2 could not be read: the tracker did not answer.'],
  ] as const)('acceptance 10: a tracker failure (%s) → blocks, with the reason', (state, sentence) => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2', { readState: state, done: false }), ticket('T3')] });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
    const b = tagOf(res, 1, 'v1.1.0').blockers[0]!;
    expect(b).toEqual({ kind: 'unreadable', ident: 'T2', key: 'T2', reason: state });
    expect(releaseBlockerText(b, words(res))).toBe(sentence);
  });

  it('acceptance 17: a ticket NOT READ YET is checking, never a blocker: the candidate proven so far stands, with later tags still read', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T3')], trackerName: 'Jira' });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'candidate', checking: true, firstBlocked: null });
    expect(api.candidate?.name).toBe('v1.0.0');
    expect(tagOf(res, 1, 'v1.1.0')).toMatchObject({ state: 'checking', pending: true, blockers: [], blocked: true });
    expect(ticketOf(res, 'T2')).toMatchObject({ pending: true, blocker: null, ready: false });
    expect(api.progress).toEqual({ step: 'tickets', done: 2, total: 3, line: 'Reading tickets from Jira: 2 of 3' });
    // The FIRST tag's ticket not read: the repo is checking, no candidate yet.
    const first = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T2'), ticket('T3')] });
    expect(repoOf(first, 1)).toMatchObject({ status: 'checking', candidate: null, firstBlocked: null });
    // A tracker that cannot read at all: a ticket not read yet will never be read — it HOLDS.
    const none = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T3')], ticketsReadable: false });
    expect(tagOf(none, 1, 'v1.1.0').blockers[0]).toMatchObject({ kind: 'unreadable', reason: 'not_read' });
    expect(repoOf(none, 1)).toMatchObject({ status: 'candidate', checking: false, firstBlocked: 'v1.1.0' });
  });

  it('acceptance 11: a Cancelled ticket ("Won\'t do", not Done in the fold) holds its tag like any not-Done one', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2', { statusName: "Won't do", done: false }), ticket('T3')] });
    const blocker = tagOf(res, 1, 'v1.1.0').blockers[0]!;
    expect(blocker).toMatchObject({ kind: 'not_done', key: 'T2', statusName: "Won't do" });
    expect(releaseBlockerText(blocker, words(res))).toBe("T2 is not done (Won't do).");
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
  });

  it('acceptance 12: no version tag after the baseline → "Nothing new", not in the release; no tags at all → no_tags', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
    ]);
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'nothing_new', nothingNewReason: 'no_new_tags', candidate: null, tags: [], checking: false });
    expect(api.baseline?.name).toBe('v1.0.0-rc');
    expect(api.latestRelease).toMatchObject({ name: 'v1.0.0-rc', kind: 'release' });
    expect(res.tickets).toEqual([]);
    expect(repoOf(run({ repos: [repo(2, 'web', [])] }), 2)).toMatchObject({ status: 'nothing_new', nothingNewReason: 'no_tags' });
  });

  it('acceptance 15/24: the newest release tag on main is the baseline; only later version tags count', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.1.0-rc', d: 3, commit: 'v1.1.0', taggedAt: 4 },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1', { done: false }), ticket('T2', { done: false }), ticket('T3')] });
    const api = repoOf(res, 1);
    // T1 and T2 are not done, but they shipped before the baseline: not checked.
    expect(api.baseline?.name).toBe('v1.1.0-rc');
    expect(api.candidate?.name).toBe('v1.2.0');
    expect(api.tags.map((t) => t.name)).toEqual(['v1.2.0']);
    // With a baseline, the held tag is "the next tag" after it.
    const held = run({ repos: [r], prs: threePrs(), tickets: [ticket('T3', { done: false, statusName: 'In Progress' })] });
    expect(repoOf(held, 1)).toMatchObject({ status: 'blocked', firstBlocked: 'v1.2.0', baseline: { name: 'v1.1.0-rc' } });
  });

  it('acceptance 13: a merged PR into hotfix/… for a not-done ticket blocks no main candidate', () => {
    const res = run({
      repos: [threeTags()],
      prs: [...threePrs(), pr(9, 1, ['T9'], { intoDefaultBranch: false, mergedAt: day(4) }), pr(10, 1, ['T3'], { intoDefaultBranch: false, state: 'open', mergedAt: null })],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3'), ticket('T9', { done: false, statusName: 'In progress' })],
    });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
    expect(ticketOf(res, 'T3').ready).toBe(true);
    expect(res.tickets.map((t) => t.ident)).not.toContain('T9');
  });

  it('acceptance 16 (notes): commits with no pull request are a note only', () => {
    const r = threeTags();
    r.ranges[1]!.unmatchedCommits = 3;
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'candidate', directCommits: 3, warningCount: 0 });
    expect(tagOf(res, 1, 'v1.1.0')).toMatchObject({ unmatchedCommits: 3, state: 'clear', blockers: [] });
  });

  it('acceptance 17: an increment not computed yet (or stale) is checking, never a ticket blocker', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.1.0', d: 3, prs: [2], noRange: true },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'candidate', checking: true, firstBlocked: null });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
    // The history pass says it is complete here, so no step is left: the tag is still checking.
    expect(repoOf(res, 1).progress).toBeNull();
    expect(tagOf(res, 1, 'v1.1.0')).toMatchObject({ pending: true, blocked: true, blockers: [], state: 'checking' });
    // The first tag not read: CHECKING, not blocked.
    const first = repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1], noRange: true }]);
    expect(repoOf(run({ repos: [first], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1')] }), 1)).toMatchObject({ status: 'checking', candidate: null });
    // A moved tag: the stored increment's sha no longer matches → checking.
    const moved = threeTags();
    moved.tags[2]!.sha = sha('moved');
    moved.tags[2]!.moved = true;
    const res2 = run({ repos: [moved], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res2, 1).candidate?.name).toBe('v1.1.0');
    expect(tagOf(res2, 1, 'v1.2.0')).toMatchObject({ moved: true, pending: true });
  });

  it("acceptance 17/38: a tag whose place on main is not known yet stops the walk there; the repo says it is reading main's history", () => {
    const r = threeTags();
    r.defaultBranch = 'main';
    r.tags[1]!.onDefaultBranch = null;
    r.history = { done: 2000, total: 5400, complete: false };
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'candidate', checking: true });
    expect(api.candidate?.name).toBe('v1.0.0');
    expect(api.progress).toEqual({ step: 'history', done: 2000, total: 5400, line: "Reading main's history: 2,000 of 5,400 commits" });
    // Nothing known yet: checking, never "No version tags".
    const none = threeTags();
    none.tags.forEach((t) => (t.onDefaultBranch = null));
    expect(repoOf(run({ repos: [none] }), 1)).toMatchObject({ status: 'checking', nothingNewReason: null });
  });

  it('acceptance 38: the WHOLE history is walked — 250 version tags, no release, no window', () => {
    const specs: TagSpec[] = Array.from({ length: 250 }, (_, i) => ({ name: `v0.${i}.0`, d: 1, prs: [] }));
    const r = repo(1, 'api', specs);
    r.tags.forEach((t, i) => (t.committedAt = new Date(Date.UTC(2026, 0, 1, 0, i))));
    // Rebuild the ranges in the new order (the builder sorted by the old dates).
    const ordered = [...r.tags].sort((a, b) => a.committedAt!.getTime() - b.committedAt!.getTime());
    r.ranges = ordered.map((t, i) => ({
      tagName: t.name,
      sha: t.sha,
      baseTagName: i > 0 ? ordered[i - 1]!.name : null,
      baseSha: i > 0 ? ordered[i - 1]!.sha : null,
      method: i > 0 ? ('compare' as const) : ('history' as const),
      prIds: i === 0 ? [1] : [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
      truncated: false,
    }));
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1', { done: false, statusName: 'In Progress' })] });
    const api = repoOf(res, 1);
    expect(api.tags).toHaveLength(250);
    expect(api).toMatchObject({ status: 'blocked', firstBlocked: 'v0.0.0' });
    const clear = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1')] });
    expect(repoOf(clear, 1).candidate?.name).toBe('v0.249.0');
  });

  it('acceptance 39: a range PR with no record yet is checking, never a blocker', () => {
    const r = threeTags();
    r.ranges[1]!.unresolvedPrNumbers = [88];
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'candidate', checking: true });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
    expect(tagOf(res, 1, 'v1.1.0')).toMatchObject({ state: 'checking', unresolvedPrCount: 1, blockers: [] });
  });

  it('acceptance 17: a truncated compare (more commits than are read) holds its tag, with a sentence', () => {
    const r = threeTags();
    r.ranges[1]!.truncated = true;
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'candidate' });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.0.0');
    const b = tagOf(res, 1, 'v1.1.0').blockers[0]!;
    expect(b).toEqual({ kind: 'too_large', tagName: 'v1.1.0' });
    expect(releaseBlockerText(b, words(res))).toBe('v1.1.0 has more commits than can be read, so its changes cannot be checked.');
  });

  it('acceptance 6: Refresh reads again the tickets held by their own state or not read yet, capped', async () => {
    const { ticketsToRefresh } = await import('../releases/refresh.js');
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3']), pr(4, 1, ['T2'], { state: 'open' })],
      tickets: [ticket('T2', { done: false, statusName: 'In review' }), ticket('T3', { readState: 'failed', done: false })],
    });
    expect(ticketsToRefresh(res).map((t) => t.key)).toEqual(['T1', 'T2', 'T3']);
    expect(ticketsToRefresh(res, 1).map((t) => t.key)).toEqual(['T1']);
  });

  it('flags a candidate whose release tag name already exists', () => {
    const r = threeTags();
    r.tags.push({ name: 'v1.2.0-rc', sha: sha('elsewhere'), committedAt: day(6), taggedAt: null, onDefaultBranch: false, moved: false });
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1).candidate).toMatchObject({ name: 'v1.2.0', releaseTagExists: true });
  });

  it('the latest release is the newest release OR hotfix tag on any branch', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.0.1-hotfix', d: 4, onDefaultBranch: false },
      { name: 'v1.1.0', d: 3, prs: [2] },
    ]);
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2'])], tickets: [ticket('T1'), ticket('T2')] });
    const api = repoOf(res, 1);
    expect(api.latestRelease).toMatchObject({ name: 'v1.0.1-hotfix', kind: 'hotfix' });
    // The hotfix tag is not on main: the baseline stays the release tag.
    expect(api.baseline?.name).toBe('v1.0.0-rc');
    expect(api.candidate?.name).toBe('v1.1.0');
  });
});

describe('releaseScanLine and releasesChecking — the progress words and the polling switch', () => {
  it('one short line per step', () => {
    expect(releaseScanLine({ step: 'history', done: 1200, total: 5400, branch: 'main' })).toBe("Reading main's history: 1,200 of 5,400 commits");
    expect(releaseScanLine({ step: 'history', done: 0, total: 0, branch: 'main' })).toBe("Reading main's history");
    expect(releaseScanLine({ step: 'tickets', done: 300, total: 420, tracker: 'Jira' })).toBe('Reading tickets from Jira: 300 of 420');
    expect(releaseScanLine({ step: 'history', done: 100, total: 5400, branch: 'main', paused: true })).toBe(
      "Reading main's history: 100 of 5,400 commits (waiting for GitHub's rate limit)",
    );
  });
  it('acceptance 41: on while any repo is checking, off when none is', () => {
    const checking = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1')] });
    const done = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(releasesChecking({ check: checking })).toBe(true);
    expect(releasesChecking({ check: done })).toBe(false);
    expect(releasesChecking({ check: null })).toBe(false);
    expect(releasesChecking(undefined)).toBe(false);
  });
});

// ── Each repo on its own ────────────────────────────────────────────────────────────────────────

describe('foldReleaseCheck — NEWEST FIRST: the early upper limit while the history pass reads', () => {
  // v1.0.0 (not reached yet) · v1.1.0 (T1) · v1.2.0 (T2) · v1.3.0 (T3): the pass has read from the head
  // back past v1.1.0's commit but not to v1.0.0's, so v1.1.0's own increment is not complete yet.
  const partial = () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [] },
      { name: 'v1.1.0', d: 3, prs: [1] },
      { name: 'v1.2.0', d: 5, prs: [2] },
      { name: 'v1.3.0', d: 7, prs: [3] },
    ]);
    r.tags[0]!.onDefaultBranch = null;
    r.ranges = r.ranges.filter((x) => x.tagName !== 'v1.0.0' && x.tagName !== 'v1.1.0');
    r.defaultBranch = 'main';
    r.history = { done: 2160, total: 5400, complete: false };
    return r;
  };
  const prs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])];

  it('a held tag found early caps the candidate at the tag before it; nothing is confirmed yet', () => {
    const res = run({ repos: [partial()], prs: prs(), tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In Progress' }), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'checking', candidate: null, heldFrom: 'v1.2.0', checking: true });
    expect(api.upperLimit?.name).toBe('v1.1.0');
    expect(api.progress).toEqual({ step: 'history', done: 2160, total: 5400, line: "Reading main's history: 2,160 of 5,400 commits" });
  });

  it('nothing held yet: the upper limit is the latest tag', () => {
    const res = run({ repos: [partial()], prs: prs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', heldFrom: null });
    expect(repoOf(res, 1).upperLimit?.name).toBe('v1.3.0');
  });

  it('the oldest tag read so far is held: no upper limit yet (the tag before it is not read), never "blocked"', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [], onDefaultBranch: false },
      { name: 'v1.1.0', d: 3, prs: [1] },
      { name: 'v1.2.0', d: 5, prs: [2] },
    ]);
    r.tags[0]!.onDefaultBranch = null;
    r.history = { done: 300, total: 5400, complete: false };
    const res = run({ repos: [r], prs: prs(), tickets: [ticket('T1', { done: false, statusName: 'In review' }), ticket('T2')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', heldFrom: 'v1.1.0', upperLimit: null, candidate: null });
  });

  it('the pass completes: the candidate is the tag just before the OLDEST held tag', () => {
    const done = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [] },
      { name: 'v1.1.0', d: 3, prs: [1] },
      { name: 'v1.2.0', d: 5, prs: [2] },
      { name: 'v1.3.0', d: 7, prs: [3] },
    ]);
    done.history = { done: 5400, total: 5400, complete: true };
    const res = run({ repos: [done], prs: prs(), tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In Progress' }), ticket('T3', { done: false })] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'candidate', checking: false, upperLimit: null, firstBlocked: 'v1.2.0', heldFrom: 'v1.2.0' });
    expect(api.candidate?.name).toBe('v1.1.0');
  });

  it('the first tag after the baseline held while the pass is still reading: checking, not blocked', () => {
    const r = repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1] }]);
    r.history = { done: 100, total: 900, complete: false };
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1', { done: false })] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', heldFrom: 'v1.0.0' });
    r.history = { done: 900, total: 900, complete: true };
    expect(repoOf(run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1', { done: false })] }), 1).status).toBe('blocked');
  });
});

describe('foldReleaseCheck — each repo on its own (no "ships whole", no "open work")', () => {
  // api: v2.3.0 (PR 10, PLAT-100) · v2.4.0 (PR 11, PLAT-290). web: v1.8.0 (PR 20, PLAT-200).
  const api = () =>
    repo(1, 'api', [
      { name: 'v2.3.0', d: 1, prs: [10] },
      { name: 'v2.4.0', d: 5, prs: [11] },
    ]);
  const web = () => repo(2, 'web', [{ name: 'v1.8.0', d: 2, prs: [20] }]);
  const prs = () => [pr(10, 1, ['PLAT-100']), pr(11, 1, ['PLAT-290'], { mergedAt: day(4) }), pr(20, 2, ['PLAT-200'])];
  const tickets = () => [ticket('PLAT-100'), ticket('PLAT-200'), ticket('PLAT-290')];

  it('acceptance 18: a Done ticket ships in api even though its web PR is in no web tag yet (each repo on its own)', () => {
    const res = run({ repos: [api(), web()], prs: prs(), tickets: tickets() });
    expect(repoOf(res, 1).candidate?.name).toBe('v2.4.0');
    expect(repoOf(res, 2).candidate?.name).toBe('v1.8.0');
    expect(ticketOf(res, 'PLAT-290')).toMatchObject({ ready: true, inRelease: true, repos: [{ repoId: 1, state: 'in_candidate', prIds: [11] }] });
  });

  it('acceptance 18: a web tag held by another ticket never holds api', () => {
    const w = repo(2, 'web', [
      { name: 'v1.8.0', d: 2, prs: [20] },
      { name: 'v1.9.0', d: 8, prs: [21, 22] },
    ]);
    const res = run({
      repos: [api(), w],
      prs: [...prs(), pr(21, 2, ['PLAT-290']), pr(22, 2, ['PLAT-301'])],
      tickets: [...tickets(), ticket('PLAT-301', { done: false, statusName: 'In review' })],
    });
    expect(repoOf(res, 2).candidate?.name).toBe('v1.8.0');
    expect(repoOf(res, 1).candidate?.name).toBe('v2.4.0');
    expect(ticketOf(res, 'PLAT-290').repos).toEqual([
      { repoId: 1, state: 'in_candidate', prIds: [11] },
      { repoId: 2, state: 'after_candidate', prIds: [21] },
    ]);
    // Releasing api alone ships PLAT-290 (nothing to untick around).
    expect(releaseShippedTickets(res, [1]).map((t) => t.key)).toContain('PLAT-290');
  });

  it('acceptance 18: an open PR on a Done ticket blocks nothing', () => {
    const res = run({
      repos: [api()],
      prs: [...prs(), pr(30, 1, ['PLAT-290'], { state: 'open', mergedAt: null })],
      tickets: tickets(),
    });
    expect(repoOf(res, 1).candidate?.name).toBe('v2.4.0');
    expect(res.warnings).toEqual([]);
  });
});

// ── The DB half ─────────────────────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
let client: any;
let m: typeof import('./release-check.js');

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  client = await import('./client.js');
  await runMigrations();
  m = await import('./release-check.js');
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ticketIsDone — the This Sprint stage resolver', () => {
  it("acceptance 11: \"Won't do\" (done category) is Cancelled, not Complete, so it is NOT Done", () => {
    expect(m.ticketIsDone(null, "Won't Do", 'done')).toBe(false);
    expect(m.ticketIsDone(null, 'Duplicate', 'done')).toBe(false);
    expect(m.ticketIsDone(null, 'Closed as not planned', 'done')).toBe(false);
    expect(m.ticketIsDone(null, 'Done', 'done')).toBe(true);
    expect(m.ticketIsDone(null, 'Closed', 'done')).toBe(true);
  });
  it('a status placed in a Cancelled bucket is not Done, whatever its name or category', () => {
    const layout = {
      order: [{ name: 'Shelved', category: 'done' as const, count: 0, auto: false, stage: 'cancelled' as const, bucketId: 'cancelled' }],
      buckets: [],
    };
    expect(m.ticketIsDone(layout, 'Shelved', 'done')).toBe(false);
  });
  it('In review / In progress / no status are not Done', () => {
    expect(m.ticketIsDone(null, 'In review', 'indeterminate')).toBe(false);
    expect(m.ticketIsDone(null, 'To do', 'new')).toBe(false);
    expect(m.ticketIsDone(null, null, null)).toBe(false);
  });
  it('a placed status follows its bucket, not its category', () => {
    const layout = {
      order: [{ name: 'Shipped', category: 'indeterminate' as const, count: 0, auto: false, stage: 'done' as const, bucketId: 'done' }],
      buckets: [],
    };
    expect(m.ticketIsDone(layout, 'Shipped', 'indeterminate')).toBe(true);
  });
});

describe('bestTicketRow', () => {
  it('prefers the newest successful read, else the newest attempt', () => {
    const rows = [
      { state: 'ok', fetchedAt: day(1), checkedAt: day(1), id: 'a' },
      { state: 'ok', fetchedAt: day(3), checkedAt: day(3), id: 'b' },
      { state: 'failed', fetchedAt: null, checkedAt: day(5), id: 'c' },
    ];
    expect(m.bestTicketRow(rows)?.id).toBe('b');
    expect(m.bestTicketRow(rows.slice(2))?.id).toBe('c');
  });
});

/** The history pass's stored result for one repo: its first-parent chain NEWEST FIRST, each commit
 *  with its PR numbers, the walk complete to the root (or not), replacing what was there. */
async function walked(repoId: number, chain: Array<{ c: string; prs?: number[]; d: number }>, opts: { complete?: boolean } = {}) {
  const { db, schema } = client;
  const { eq } = await import('drizzle-orm');
  await db.delete(schema.releaseHistoryCommits).where(eq(schema.releaseHistoryCommits.repoId, repoId)).execute();
  await db.delete(schema.releaseHistoryScans).where(eq(schema.releaseHistoryScans.repoId, repoId)).execute();
  await db
    .insert(schema.releaseHistoryScans)
    .values({
      accountId: 1,
      repoId,
      topSha: sha(chain[0]!.c),
      deepStartSha: sha(chain[0]!.c),
      deepExpectedSha: opts.complete === false ? sha('older') : null,
      deepNextIdx: chain.length,
      deepEstimate: chain.length,
      updatedAt: day(10),
    })
    .execute();
  await db
    .insert(schema.releaseHistoryCommits)
    .values(chain.map((x, i) => ({ accountId: 1, repoId, sha: sha(x.c), seq: -i, prNumbers: x.prs ?? [], committedAt: day(x.d) })))
    .execute();
}

/** A light record (what the history pass stores for a range PR). */
async function light(repoId: number, number: number, title: string, extra: Record<string, unknown> = {}) {
  const { db, schema } = client;
  return (
    await db
      .insert(schema.releaseRangePrs)
      .values({ accountId: 1, repoId, number, title, url: `https://github.com/acme/api/pull/${number}`, mergedAt: day(1), seenAt: day(10), ...extra })
      .returning()
      .execute()
  )[0].id as number;
}

describe('getReleases (GET /api/releases) — stored rows only', () => {
  it('not configured → check null; configured → the fold over the walked history, the light PR records and tickets', async () => {
    const { db, schema } = client;
    const { repos, pullRequests, repoTags, trackerTickets, users } = schema;
    const { setReleaseSettings } = await import('./release-settings.js');
    const { resolveWorkspaceScope } = await import('./queries.js');

    const [api] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_rc_api', defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    const scope = await resolveWorkspaceScope(1, undefined);
    expect(scope.repoIds).toContain(api.id);

    const off = await m.getReleases(1, scope.workspaceId);
    expect(off).toMatchObject({ workspaceId: scope.workspaceId, configured: false, check: null, latestRelease: null });

    await setReleaseSettings(1, scope.workspaceId, SETTINGS);
    // Configured, but no repo ticked "Released from this workspace": no check (the setup line).
    expect(await m.getReleases(1, scope.workspaceId)).toMatchObject({ configured: true, hasReleasableRepos: false, check: null });
    const { setReleaseRepos } = await import('./release-repos.js');
    await setReleaseRepos(1, scope.workspaceId, [api.id]);
    const [bot] = await db.insert(users).values({ githubLogin: 'renovate[bot]', githubNodeId: 'U_rc_bot', isBot: true }).returning().execute();
    const mkPr = async (number: number, base: string, extra: Record<string, unknown> = {}) =>
      (
        await db
          .insert(pullRequests)
          .values({
            githubNodeId: `PR_rc_${number}`,
            accountId: 1,
            repoId: api.id,
            number,
            title: `change ${number}`,
            state: 'merged',
            isDraft: false,
            openedAt: day(1, 0),
            updatedAt: day(1),
            mergedAt: day(1),
            baseRefName: base,
            ...extra,
          })
          .returning()
          .execute()
      )[0].id as number;
    const p1 = await mkPr(1, 'main');
    const p2 = await mkPr(2, 'main', { mergedAt: day(3), updatedAt: day(3) });
    const p3 = await mkPr(3, 'main', { mergedAt: day(3), updatedAt: day(3), authorId: bot.id });
    const l1 = await light(api.id, 1, 'change 1');
    const l2 = await light(api.id, 2, 'change 2');
    const l3 = await light(api.id, 3, 'change 3', { authorLogin: 'renovate[bot]' });
    const tag = (name: string, d: number) => ({
      accountId: 1,
      repoId: api.id,
      name,
      sha: sha(name),
      committedAt: day(d),
      firstSeenAt: day(d),
      lastSeenAt: day(d),
    });
    await db.insert(repoTags).values([tag('v1.0.0', 1), tag('v1.1.0', 4)]).execute();
    // The pass walked main newest first, down to the root: v1.1.0's commit (PR 3), a commit (PR 2),
    // v1.0.0's commit (PR 1).
    await walked(api.id, [
      { c: 'v1.1.0', prs: [3], d: 4 },
      { c: 'mid', prs: [2], d: 3 },
      { c: 'v1.0.0', prs: [1], d: 1 },
    ]);
    const now = day(10);
    const tt = (prId: number, key: string, statusName: string, statusCategory: string, state = 'ok') => ({
      accountId: 1,
      workspaceId: scope.workspaceId,
      prId,
      provider: 'jira',
      issueKey: key,
      detectedFrom: 'title',
      detectOrder: 0,
      apiRoot: SITE.apiRoot,
      url: `${SITE.apiRoot}/browse/${key}`,
      state,
      statusName,
      statusCategory,
      fetchedAt: state === 'ok' ? now : null,
      checkedAt: now,
      nextCheckAt: now,
    });
    await db
      .insert(trackerTickets)
      .values([tt(p1, 'PLAT-1', 'Done', 'done'), tt(p2, 'PLAT-2', 'In review', 'indeterminate')])
      .execute();

    const res = await m.getReleases(1, String(scope.workspaceId));
    expect(res.configured).toBe(true);
    const repo = res.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repo).toMatchObject({ status: 'candidate', writable: true, fullName: 'acme/api', checking: false });
    expect(repo.candidate?.name).toBe('v1.0.0');
    expect(repo.firstBlocked).toBe('v1.1.0');
    const v11 = repo.tags.find((t) => t.name === 'v1.1.0')!;
    expect(v11.prIds.sort()).toEqual([l2, l3].sort());
    expect(v11.blockers).toEqual([
      { kind: 'not_done', ident: `jira:${SITE.apiRoot}#PLAT-2`, key: 'PLAT-2', statusName: 'In review' },
    ]);
    // A light record also stored as a full PR lends its id (the PR tab) and its author (bot-ness).
    expect(res.check!.prs.find((p) => p.id === l3)).toMatchObject({ prId: p3, isBot: true, ticketIdents: [] });
    expect(res.check!.prs.find((p) => p.id === l1)).toMatchObject({ prId: p1, number: 1 });

    // The ticket is closed as "Won't Do" → Cancelled, not Complete: it still holds v1.1.0.
    const { eq } = await import('drizzle-orm');
    await db.update(trackerTickets).set({ statusName: "Won't Do", statusCategory: 'done' }).where(eq(trackerTickets.issueKey, 'PLAT-2')).execute();
    const cancelled = await m.getReleases(1, scope.workspaceId);
    const repoC = cancelled.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repoC.candidate?.name).toBe('v1.0.0');
    expect(repoC.tags.find((t) => t.name === 'v1.1.0')!.blockers).toEqual([
      { kind: 'not_done', ident: `jira:${SITE.apiRoot}#PLAT-2`, key: 'PLAT-2', statusName: "Won't Do" },
    ]);

    // The ticket moves to Done → the candidate moves to v1.1.0; the bot PR without a ticket is listed,
    // not warned.
    await db.update(trackerTickets).set({ statusName: 'Done', statusCategory: 'done' }).execute();
    const after = await m.getReleases(1, scope.workspaceId);
    const repo2 = after.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repo2.candidate).toMatchObject({ name: 'v1.1.0', releaseTagName: 'v1.1.0-rc' });
    expect(repo2.botPrIds).toEqual([l3]);
    expect(after.check!.warnings).toEqual([]);

    // An unreadable ticket blocks with its reason.
    await db.update(trackerTickets).set({ state: 'no_access', fetchedAt: null }).execute();
    const unread = await m.getReleases(1, scope.workspaceId);
    expect(unread.check!.repos[0]!.tags.find((t) => t.name === 'v1.0.0')!.blockers[0]).toMatchObject({ kind: 'unreadable', reason: 'no_access' });
    await db.update(trackerTickets).set({ state: 'ok', fetchedAt: day(10) }).execute();

    // An unknown workspace id falls back to the Default workspace, never a 404.
    expect((await m.getReleases(1, 'nope')).workspaceId).toBe(scope.workspaceId);
  });

  it('acceptance 17/39: a LIGHT-only range PR (older than the synced history) gets its ticket from THE detection rule; not read yet is CHECKING; a tracker that cannot read holds it', async () => {
    const { db, schema } = client;
    const { repos, repoTags, workspaceTrackers } = schema;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const scope = await resolveWorkspaceScope(1, undefined);
    const api = (await db.select().from(repos).execute()).find((r: any) => r.name === 'api');
    await db.insert(workspaceTrackers).values({ accountId: 1, workspaceId: scope.workspaceId, provider: 'jira', baseUrl: SITE.apiRoot }).execute();
    // No pull_requests row for #4: only the light record the history pass stored.
    const l4 = await light(api.id, 4, 'PLAT-310: change X', { headRefName: 'PLAT-310-change-x' });
    await db
      .insert(repoTags)
      .values({ accountId: 1, repoId: api.id, name: 'v1.2.0', sha: sha('v1.2.0'), committedAt: day(6), firstSeenAt: day(6), lastSeenAt: day(6) })
      .execute();
    await walked(api.id, [
      { c: 'v1.2.0', prs: [4], d: 6 },
      { c: 'v1.1.0', prs: [3], d: 4 },
      { c: 'mid', prs: [2], d: 3 },
      { c: 'v1.0.0', prs: [1], d: 1 },
    ]);
    const res = await m.getReleases(1, scope.workspaceId);
    const repo = res.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repo.candidate?.name).toBe('v1.1.0');
    expect(repo.untrackedPrIds).not.toContain(l4);
    // No credential: the tracker cannot read, so the ticket would never be read — it holds.
    expect(repo.tags.find((t) => t.name === 'v1.2.0')!.blockers).toEqual([
      { kind: 'unreadable', ident: `jira:${SITE.apiRoot}#PLAT-310`, key: 'PLAT-310', reason: 'not_read' },
    ]);
    expect(res.check!.prs.find((p) => p.id === l4)).toMatchObject({ prId: null, ticketIdents: [`jira:${SITE.apiRoot}#PLAT-310`] });
    expect(await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + 1000)).toEqual({ keys: [], waiting: 0 });

    // With a credential the scan's next batch reads it: CHECKING, with the tickets step.
    await db.update(workspaceTrackers).set({ authEmail: 'ada@acme.test', authToken: 'plain:tok' }).execute();
    const res2 = await m.getReleases(1, scope.workspaceId);
    const repo2 = res2.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repo2).toMatchObject({ status: 'candidate', checking: true, firstBlocked: null });
    expect(repo2.candidate?.name).toBe('v1.1.0');
    expect(repo2.tags.find((t) => t.name === 'v1.2.0')).toMatchObject({ state: 'checking', blockers: [] });
    expect(repo2.progress).toEqual({ step: 'tickets', done: 2, total: 3, line: 'Reading tickets from Jira: 2 of 3' });
    // Owed: the unread one; the others were read a second ago (inside the TTL).
    expect(await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + 1000)).toEqual({ keys: ['PLAT-310'], waiting: 1 });
    // Past the TTL every ticket in the tags after the baseline is read again (in one batch).
    expect((await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + m.RELEASE_TICKET_TTL_MS + 1)).keys).toEqual([
      'PLAT-1',
      'PLAT-2',
      'PLAT-310',
    ]);
  });

  it('the batched status row answers a ticket; a transient failure is checking until it failed three times', async () => {
    const { db, schema } = client;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const { eq } = await import('drizzle-orm');
    const scope = await resolveWorkspaceScope(1, undefined);
    const ident = `jira:${SITE.apiRoot}#PLAT-310`;
    const row = (state: string, attempts: number) => ({
      accountId: 1,
      workspaceId: scope.workspaceId,
      provider: 'jira',
      apiRoot: SITE.apiRoot,
      issueKey: 'PLAT-310',
      ident,
      state,
      attempts,
      checkedAt: day(11),
    });
    await db.insert(schema.trackerTicketStatus).values(row('failed', 1)).execute();
    const t1 = (await m.getReleases(1, scope.workspaceId)).check!.tickets.find((t) => t.ident === ident)!;
    expect(t1).toMatchObject({ readState: 'not_read', pending: true });
    await db.update(schema.trackerTicketStatus).set({ attempts: 3 }).where(eq(schema.trackerTicketStatus.ident, ident)).execute();
    const t2 = (await m.getReleases(1, scope.workspaceId)).check!.tickets.find((t) => t.ident === ident)!;
    expect(t2).toMatchObject({ readState: 'failed', blocker: { kind: 'unreadable', reason: 'failed' } });
    await db.delete(schema.trackerTicketStatus).execute();
  });

  it("the scan's live history step is laid over the derived one (its rate-limit wait)", async () => {
    const { db, schema } = client;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const { eq } = await import('drizzle-orm');
    const scope = await resolveWorkspaceScope(1, undefined);
    const api = (await db.select().from(schema.repos).execute()).find((r: any) => r.name === 'api');
    await db.update(schema.releaseHistoryScans).set({ deepExpectedSha: sha('older'), deepEstimate: 80 }).where(eq(schema.releaseHistoryScans.repoId, api.id)).execute();
    const derived = (await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.repoId === api.id)!;
    expect(derived).toMatchObject({ status: 'checking', candidate: null });
    expect(derived.progress).toEqual({ step: 'history', done: 4, total: 80, line: "Reading main's history: 4 of 80 commits" });
    const scan = await import('../releases/scan-state.js');
    scan.noteScanStep(api.id, { step: 'history', done: 35, total: 80, paused: true });
    const live = (await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.repoId === api.id)!;
    expect(live.progress).toEqual({ step: 'history', done: 35, total: 80, line: "Reading main's history: 35 of 80 commits (waiting for GitHub's rate limit)" });
    scan.__resetScanState();
    await db.update(schema.releaseHistoryScans).set({ deepExpectedSha: null }).where(eq(schema.releaseHistoryScans.repoId, api.id)).execute();
  });

  it('acceptance 6: Refresh (POST /api/releases/refresh) reads the held tickets again in ONE batch; Done → the candidate moves up', async () => {
    const { db, schema } = client;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const { refreshReleases } = await import('../releases/refresh.js');
    const scope = await resolveWorkspaceScope(1, undefined);
    const batches: string[][] = [];
    const res = await refreshReleases(1, scope.workspaceId, {
      async rereadTickets(_a, ws, tickets) {
        batches.push(tickets.map((t) => t.key));
        for (const t of tickets) {
          await db
            .insert(schema.trackerTicketStatus)
            .values({ accountId: 1, workspaceId: ws, provider: 'jira', apiRoot: SITE.apiRoot, issueKey: t.key, ident: t.ident, state: 'ok', statusName: 'Done', statusCategory: 'done', fetchedAt: day(12), checkedAt: day(12) })
            .execute();
        }
        return new Set(tickets.map((t) => t.ident));
      },
    });
    expect(batches).toEqual([['PLAT-310']]);
    expect(res).toMatchObject({ reread: 1, unread: [] });
    const api = res.check!.repos.find((r) => r.name === 'api')!;
    expect(api.candidate?.name).toBe('v1.2.0');
  });

  it('acceptance 18: a workspace repo that is not ticked is ignored entirely (no row, no block, no ticket)', async () => {
    const { db, schema } = client;
    const { repos, repoTags } = schema;
    const { resolveWorkspaceScope, ensureRepoMemberships } = await import('./queries.js');
    const scope = await resolveWorkspaceScope(1, undefined);
    const [tests] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'journey-tests', githubNodeId: 'R_rc_tests', defaultBranch: 'main', viewerPermission: 'WRITE' })
      .returning()
      .execute();
    await ensureRepoMemberships(1);
    await db
      .insert(repoTags)
      .values({ accountId: 1, repoId: tests.id, name: 'v9.0.0', sha: sha('t9'), committedAt: day(6), firstSeenAt: day(6), lastSeenAt: day(6) })
      .execute();
    await walked(tests.id, [{ c: 't9', d: 6 }]);
    const res = await m.getReleases(1, scope.workspaceId);
    expect((await resolveWorkspaceScope(1, scope.workspaceId)).repoIds).toContain(tests.id);
    expect(res.check!.repos.map((r) => r.name)).toEqual(['api']);
    // Asking the loader for it directly still reads nothing of it.
    const input = await m.loadReleaseCheckInput(1, scope.workspaceId, [tests.id], SETTINGS);
    expect(input.repos).toEqual([]);
  });
});

describe('releasePrDetectInput — a light record and a stored PR name the same tickets (ONE rule)', () => {
  it('detects on title + head branch either way', async () => {
    const { detectKeysWithAccess, withParsedLinks } = await import('../tracker/enricher.js');
    const access = {
      issue: { provider: 'jira', baseUrl: SITE.apiRoot, projectKeys: ['PLAT'], matchScope: 'title_branch' },
      token: { state: 'none' },
      email: null,
      notion: null,
    } as never;
    const lightRec = { title: 'PLAT-12: fix the export', headRefName: 'feature/PLAT-13-more' };
    const stored = { title: 'PLAT-12: fix the export', headRefName: 'feature/PLAT-13-more', closingIssues: null, linearLinks: null, linearLinksRoot: null };
    type Raw = { title: string; headRefName: string | null; closingIssues?: unknown; linearLinks?: unknown; linearLinksRoot?: unknown };
    const a = detectKeysWithAccess(access, withParsedLinks(m.releasePrDetectInput(lightRec, null) as Raw));
    const b = detectKeysWithAccess(access, withParsedLinks(m.releasePrDetectInput(lightRec, stored) as Raw));
    expect(a).toEqual(b);
    expect(a?.sort()).toEqual(['PLAT-12', 'PLAT-13']);
  });
});

describe('ticketKeysOwed / bestTicketRead', () => {
  const at = (ms: number) => new Date(ms);
  it('not read → owed now; read → owed past the TTL; not read but tried → after the retry wait', () => {
    const reads = [
      { ident: 'a', key: 'A-1', readState: 'not_read' as const, lastAt: null },
      { ident: 'b', key: 'B-1', readState: 'ok' as const, lastAt: at(1_000) },
      { ident: 'c', key: 'C-1', readState: 'not_read' as const, lastAt: at(1_000) },
    ];
    expect(m.ticketKeysOwed(reads, 2_000)).toEqual(['A-1']);
    expect(m.ticketKeysOwed(reads, 1_000 + m.RELEASE_TICKET_RETRY_MS)).toEqual(['A-1', 'C-1']);
    expect(m.ticketKeysOwed(reads, 1_000 + m.RELEASE_TICKET_TTL_MS)).toEqual(['A-1', 'B-1', 'C-1']);
    expect(m.ticketKeysOwed(reads, 2_000, { force: true })).toEqual(['A-1', 'B-1', 'C-1']);
  });
  it('the freshest successful read wins across stores; a failed batch read is checking below the hold count', () => {
    const c = (source: 'pr' | 'status' | 'sprint', state: string, ms: number, extra: Record<string, unknown> = {}) => ({
      source,
      state,
      key: 'K-1',
      title: null,
      url: null,
      statusName: state === 'ok' ? `S${ms}` : null,
      statusCategory: null,
      fetchedAt: state === 'ok' ? at(ms) : null,
      checkedAt: at(ms),
      ...extra,
    });
    expect(m.bestTicketRead([c('pr', 'ok', 1), c('status', 'ok', 3), c('sprint', 'ok', 2)], 3).read?.statusName).toBe('S3');
    expect(m.bestTicketRead([c('pr', 'ok', 1), c('status', 'not_found', 5)], 3).readState).toBe('ok');
    expect(m.bestTicketRead([c('status', 'not_found', 5)], 3).readState).toBe('not_found');
    expect(m.bestTicketRead([c('status', 'failed', 5, { attempts: 2 })], 3).readState).toBe('not_read');
    expect(m.bestTicketRead([c('status', 'failed', 5, { attempts: 3 })], 3).readState).toBe('failed');
    expect(m.bestTicketRead([], 3)).toEqual({ read: null, readState: 'not_read' });
  });
});
