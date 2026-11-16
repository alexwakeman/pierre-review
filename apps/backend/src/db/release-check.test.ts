// THE RELEASE CHECK (docs/RELEASES.md § The release check; § Acceptance checks 4–18, 38–43, 47–48): the
// pure shared fold `foldReleaseCheck` — THE SIMPLE RULE (2026-11-16): the newest version tag whose
// tickets are Complete with no pull request still open — (+ the words, `releaseShippedTickets`), then the
// DB half (db/release-check.ts `getReleases`) on a THROWAWAY sqlite DB with the tracker site stubbed.
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
  releaseScopeTickets,
  releaseShippedTickets,
  releaseUnverifiedText,
  releasesChecking,
  type ReleaseCheckInput,
  type ReleaseCheckOpenPrInput,
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
  onDefaultBranch?: boolean | null;
  /** Leave the stored increment out (not read yet). */
  noRange?: boolean;
}

/** A repo whose stored increments are fresh: each tag's base is the default-branch tag before it. */
function repo(repoId: number, name: string, specs: TagSpec[], writable = true): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({
    name: s.name,
    sha: sha(s.commit ?? s.name),
    committedAt: day(s.d),
    taggedAt: s.taggedAt != null ? day(s.taggedAt, 18) : null,
    onDefaultBranch: s.onDefaultBranch === undefined ? true : s.onDefaultBranch,
    moved: false,
  }));
  const onMain = tags
    .map((t, i) => ({ t, s: specs[i]! }))
    .filter((x) => x.t.onDefaultBranch === true)
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
        prIds: s.prs ?? [],
        unresolvedPrNumbers: [],
        unmatchedCommits: 0,
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
    mergedAt: day(1),
    ticketIdents: tickets,
    ...extra,
  };
}

function openPr(number: number, repoId: number, repoName: string, tickets: string[]): ReleaseCheckOpenPrInput {
  return { repoId, repoName, number, url: `https://github.com/acme/${repoName}/pull/${number}`, prId: 900 + number, ticketIdents: tickets };
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
const reasons = (res: ReleaseCheckResult, repoId: number, name: string) => tagOf(res, repoId, name).blockers.map(releaseBlockerText);

// v1.0.0 (PR 1, T1) · v1.1.0 (PR 2, T2) · v1.2.0 (PR 3, T3), no release.
const threeTags = () =>
  repo(1, 'api', [
    { name: 'v1.0.0', d: 1, prs: [1] },
    { name: 'v1.1.0', d: 3, prs: [2] },
    { name: 'v1.2.0', d: 5, prs: [3] },
  ]);
const threePrs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])];
const allDone = () => [ticket('T1'), ticket('T2'), ticket('T3')];

// The same three tags after a release of v1.0.0 (v1.0.0-rc on its commit): the baseline.
const released = () =>
  repo(1, 'api', [
    { name: 'v1.0.0', d: 1, prs: [1] },
    { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
    { name: 'v1.1.0', d: 3, prs: [2] },
    { name: 'v1.2.0', d: 5, prs: [3] },
  ]);

// ── The rule ────────────────────────────────────────────────────────────────────────────────────

describe('foldReleaseCheck — the simple rule, newest first, per repo', () => {
  it('acceptance 4: v1.0.0, v1.1.0, v1.2.0, no release, all Complete → candidate v1.2.0; nothing older is read', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: allDone() });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'candidate', checking: false, progress: null, baseline: null, scope: 'own_tag', newestReason: null });
    expect(api.candidate).toMatchObject({ name: 'v1.2.0', releaseTagName: 'v1.2.0-rc', releaseTagExists: false });
    // The walk stopped at the first tag that qualifies: older tags are not listed.
    expect(api.tags.map((t) => t.name)).toEqual(['v1.2.0']);
    expect(api.tags[0]).toMatchObject({ isCandidate: true, state: 'qualifies', blockers: [], unverified: [] });
    // No release: the scope is the tag's own increment only.
    expect(api.ticketIdents).toEqual(['T3']);
    expect(api.candidatePrIds).toEqual([3]);
  });

  it('acceptance 5/42: NEWEST-FIRST STOP — v1.2.0 adds an In review ticket → candidate v1.1.0; v1.2.0 says why; v1.0.0 is not read', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'In review' })] });
    const api = repoOf(res, 1);
    expect(api.candidate?.name).toBe('v1.1.0');
    expect(api.tags.map((t) => [t.name, t.state])).toEqual([
      ['v1.2.0', 'does_not_qualify'],
      ['v1.1.0', 'qualifies'],
    ]);
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['T3 is In review.']);
    expect(api.newestReason).toEqual({ tagName: 'v1.2.0', blocker: { kind: 'not_done', ident: 'T3', key: 'T3', statusName: 'In review', fromTag: null } });
    // The ticket's own state, for Refresh and Confirm.
    expect(ticketOf(res, 'T3')).toMatchObject({ ready: false, inRelease: false, blocker: { kind: 'not_done' } });
    expect(ticketOf(res, 'T2')).toMatchObject({ ready: true, inRelease: true, repos: [{ repoId: 1, state: 'in_candidate', prIds: [2] }] });
    expect(ticketOf(res, 'T3').repos).toEqual([{ repoId: 1, state: 'after_candidate', prIds: [3] }]);
  });

  it('acceptance 6: that ticket moves to Complete (the scan\'s read or Refresh) → candidate v1.2.0', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: allDone() });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
  });

  it('acceptance 7: PRs with no ticket (human or bot) never block and are no warning: listed under the tag, and in the notes', () => {
    const r = threeTags();
    r.ranges[2]!.prIds = [3, 4, 5];
    const res = run({ repos: [r], prs: [...threePrs(), pr(4, 1, []), pr(5, 1, [], { isBot: true })], tickets: allDone() });
    const api = repoOf(res, 1);
    expect(api.candidate?.name).toBe('v1.2.0');
    expect(tagOf(res, 1, 'v1.2.0')).toMatchObject({ state: 'qualifies', prIds: [3, 4, 5], blockers: [], unverified: [] });
    expect(api.untrackedPrIds).toEqual([4]);
    expect(api.botPrIds).toEqual([5]);
    expect('warnings' in res).toBe(false);
  });

  it('acceptance 8/9: a bot PR naming a not-Complete ticket → the tag does not qualify (authorship changes nothing)', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'], { isBot: true })],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'To do' })],
    });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.1.0');
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['T3 is To do.']);
  });

  it('acceptance 10: NOT FOUND LISTED, NOT BLOCKING — a ticket the tracker could not give is listed under the tag for the reader', () => {
    for (const [readState, words] of [
      ['not_found', 'T3 not found'],
      ['no_access', 'T3 could not be read: there is no access to it'],
      ['failed', 'T3 could not be read: the tracker did not answer'],
    ] as const) {
      const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3', { readState, done: false, statusName: null })] });
      const api = repoOf(res, 1);
      expect(api).toMatchObject({ status: 'candidate', checking: false, unverifiedCount: 1 });
      expect(api.candidate?.name).toBe('v1.2.0');
      const t = tagOf(res, 1, 'v1.2.0');
      expect(t.unverified).toEqual([{ ident: 'T3', key: 'T3', reason: readState, fromTag: null }]);
      expect(releaseUnverifiedText(t.unverified[0]!)).toBe(words);
      // In the release (the notes list it) but not commented on (not READY).
      expect(ticketOf(res, 'T3')).toMatchObject({ inRelease: true, ready: false, unverified: readState, blocker: null });
      expect(releaseScopeTickets(res, [1]).map((x) => x.key)).toEqual(['T3']);
      expect(releaseShippedTickets(res, [1])).toEqual([]);
    }
    // A tracker that cannot read at all: never "checking" forever — listed as could not be read.
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2')], ticketsReadable: false });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
    expect(releaseUnverifiedText(tagOf(res, 1, 'v1.2.0').unverified[0]!)).toBe('T3 could not be read: the tracker cannot read it');
  });

  it("acceptance 11: CANCELLED DOES NOT QUALIFY — \"Won't do\" (not Complete in the fold) rules its tag out", () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: "Won't do" })] });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.1.0');
    expect(reasons(res, 1, 'v1.2.0')).toEqual(["T3 is Won't do."]);
  });

  it('acceptance 12: no version tag after the baseline → "Nothing new"; no version tag at all → no_tags', () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
    ]);
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1', { done: false })] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'nothing_new', nothingNewReason: 'no_new_tags', candidate: null, checking: false });
    expect(repoOf(res, 1).baseline?.name).toBe('v1.0.0-rc');
    expect(res.tickets).toEqual([]);
    expect(repoOf(run({ repos: [repo(2, 'web', [])] }), 2)).toMatchObject({ status: 'nothing_new', nothingNewReason: 'no_tags', latestVersion: null });
  });

  it('acceptance 13: a merged PR into hotfix/… is in no main tag (its increment never holds it)', () => {
    // The history pass keeps only PRs merged into the default branch: the hotfix PR is in no range.
    const res = run({ repos: [threeTags()], prs: [...threePrs(), pr(9, 1, ['T9'])], tickets: [...allDone(), ticket('T9', { done: false })] });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
    expect(res.tickets.map((t) => t.ident)).not.toContain('T9');
  });

  it('acceptance 14: NO BASELINE, OWN INCREMENT — v1.1.0 adds a not-Complete ticket, v1.2.0 only Complete ones → candidate v1.2.0', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In Progress' }), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api.candidate?.name).toBe('v1.2.0');
    // T2 is not in v1.2.0's scope (no release: only the tag's own increment) and is not read at all.
    expect(api.ticketIdents).toEqual(['T3']);
    expect(res.tickets.map((t) => t.ident)).toEqual(['T3']);
  });

  it('acceptance 15: BASELINE, WHOLE SCOPE — after a release, a reason from an earlier tag in the scope rules out every later tag, and says which', () => {
    const res = run({ repos: [released()], prs: threePrs(), tickets: [ticket('T1', { done: false }), ticket('T2', { done: false, statusName: 'In review' }), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'none', scope: 'since_release', candidate: null, checking: false });
    expect(api.baseline?.name).toBe('v1.0.0-rc');
    expect(api.tags.map((t) => t.name)).toEqual(['v1.2.0', 'v1.1.0']);
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['T2 (from v1.1.0) is In review.']);
    expect(reasons(res, 1, 'v1.1.0')).toEqual(['T2 is In review.']);
    // T1 is in the release (v1.0.0-rc): never read again.
    expect(res.tickets.map((t) => t.ident)).not.toContain('T1');
    // T2 moves to Complete → v1.2.0, whose scope is everything since the release.
    const ok = run({ repos: [released()], prs: threePrs(), tickets: [ticket('T2'), ticket('T3')] });
    expect(repoOf(ok, 1).candidate?.name).toBe('v1.2.0');
    expect(repoOf(ok, 1).ticketIdents.sort()).toEqual(['T2', 'T3']);
    expect(repoOf(ok, 1).candidatePrIds.sort()).toEqual([2, 3]);
    expect(tagOf(ok, 1, 'v1.2.0').scopePrIds.sort()).toEqual([2, 3]);
  });

  it('acceptance 16: NONE — every tag ruled out: the newest tag\'s reason', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), tickets: [ticket('T1', { done: false, statusName: 'To do' }), ticket('T2', { done: false, statusName: 'To do' }), ticket('T3', { done: false, statusName: 'In PO Review' })] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'none', candidate: null, checking: false });
    expect(api.tags.map((t) => t.name)).toEqual(['v1.2.0', 'v1.1.0', 'v1.0.0']);
    expect(api.newestReason?.tagName).toBe('v1.2.0');
    expect(releaseBlockerShort(api.newestReason!.blocker)).toBe('T3 is In PO Review');
  });

  it('acceptance 17: A TICKET NOT READ YET makes its tag CHECKING — the walk stops there (it may yet qualify)', () => {
    const r = threeTags();
    r.defaultBranch = 'main';
    const res = run({ repos: [r], prs: threePrs(), tickets: [ticket('T1'), ticket('T2')], trackerName: 'Jira' });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'checking', candidate: null, checking: true });
    expect(api.tags.map((t) => [t.name, t.state])).toEqual([['v1.2.0', 'checking']]);
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['T3 is not read yet.']);
    expect(api.progress).toEqual({ step: 'tickets', done: 0, total: 1, line: 'Reading tickets from Jira: 0 of 1' });
    expect(ticketOf(res, 'T3')).toMatchObject({ pending: true, blocker: { kind: 'checking' } });
    // A reason that rules a tag out is certain even while another ticket is not read yet.
    const both = run({ repos: [r], prs: [...threePrs(), pr(4, 1, ['T4'])], tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'To do' })] });
    expect(repoOf(both, 1).candidate?.name).toBe('v1.1.0');
  });

  it('acceptance 18: OPEN PR IN ANOTHER RELEASABLE REPO — a Complete ticket with an open PR into the default branch does not qualify', () => {
    const res = run({ repos: [threeTags()], prs: threePrs(), openPrs: [openPr(812, 2, 'web', ['T3'])], tickets: allDone() });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.1.0');
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['T3 has an open pull request in web (#812).']);
    expect(ticketOf(res, 'T3').openPrs).toEqual([{ repoId: 2, repoName: 'web', number: 812, url: 'https://github.com/acme/web/pull/812', prId: 1712 }]);
    // Two open PRs in two repos.
    const two = run({ repos: [threeTags()], prs: threePrs(), openPrs: [openPr(812, 2, 'web', ['T3']), openPr(7, 1, 'api', ['T3']), openPr(813, 2, 'web', ['T3'])], tickets: allDone() });
    expect(reasons(two, 1, 'v1.2.0')).toEqual(['T3 has open pull requests in api (#7) and web (#812, #813).']);
    // Merged PRs elsewhere are fine: only an OPEN one counts.
    expect(repoOf(run({ repos: [threeTags()], prs: [...threePrs(), pr(20, 2, ['T3'])], tickets: allDone() }), 1).candidate?.name).toBe('v1.2.0');
  });

  it('each repository is judged on its own: a web tag ruled out holds nothing in api', () => {
    const web = repo(2, 'web', [{ name: 'w1', d: 2, prs: [20] }]);
    const res = run({ repos: [threeTags(), web], prs: [...threePrs(), pr(20, 2, ['W1'])], tickets: [...allDone(), ticket('W1', { done: false })] });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
    expect(repoOf(res, 2).status).toBe('none');
  });

  it('acceptance 38: a release tag on main is the baseline; only later version tags are read', () => {
    const res = run({ repos: [released()], prs: threePrs(), tickets: [ticket('T2'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api.baseline?.name).toBe('v1.0.0-rc');
    expect(res.tickets.map((t) => t.ident).sort()).toEqual(['T2', 'T3']);
  });

  it('acceptance 39: a range PR with no record yet is checking (the history is still being read)', () => {
    const r = threeTags();
    r.ranges[2]!.unresolvedPrNumbers = [88];
    const res = run({ repos: [r], prs: threePrs(), tickets: allDone() });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', checking: true });
    expect(reasons(res, 1, 'v1.2.0')).toEqual(['The history is still being read.']);
  });

  it('a moved tag (its stored increment no longer matches) is checking, then read again', () => {
    const moved = threeTags();
    moved.tags[2]!.sha = sha('moved');
    moved.tags[2]!.moved = true;
    const res = run({ repos: [moved], prs: threePrs(), tickets: allDone() });
    expect(tagOf(res, 1, 'v1.2.0')).toMatchObject({ moved: true, state: 'checking', historyRead: false });
  });

  it('acceptance 6: Refresh reads again the tickets not Complete, not read yet, or not given — never only for an open PR', async () => {
    const { ticketsToRefresh } = await import('../releases/refresh.js');
    const r = released();
    const res = run({
      repos: [r],
      prs: [...threePrs(), pr(4, 1, ['T4']), pr(5, 1, ['T5'])],
      openPrs: [openPr(812, 2, 'web', ['T5'])],
      tickets: [ticket('T2', { done: false, statusName: 'In review' }), ticket('T3', { readState: 'failed', done: false }), ticket('T5')],
    });
    // v1.2.0 and v1.1.0 are ruled out by T2; T4 / T5 are in no tag here.
    expect(ticketsToRefresh(res).map((t) => t.key)).toEqual(['T2', 'T3']);
    expect(ticketsToRefresh(res, 1).map((t) => t.key)).toEqual(['T2']);
  });

  it('flags a candidate whose release tag name already exists', () => {
    const r = threeTags();
    r.tags.push({ name: 'v1.2.0-rc', sha: sha('elsewhere'), committedAt: day(6), taggedAt: null, onDefaultBranch: false, moved: false });
    const res = run({ repos: [r], prs: threePrs(), tickets: allDone() });
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

  it('commits with no pull request are a note only', () => {
    const r = threeTags();
    r.ranges[2]!.unmatchedCommits = 3;
    const res = run({ repos: [r], prs: threePrs(), tickets: allDone() });
    expect(tagOf(res, 1, 'v1.2.0')).toMatchObject({ unmatchedCommits: 3, state: 'qualifies' });
    expect(repoOf(res, 1).directCommits).toBe(3);
  });
});

describe('releaseScanLine and releasesChecking — the progress words and the polling switch', () => {
  it('one short line per step', () => {
    expect(releaseScanLine({ step: 'history', done: 1200, total: 5400, branch: 'main' })).toBe("Reading main's history: 1,200 of 5,400 commits");
    expect(releaseScanLine({ step: 'tickets', done: 300, total: 420, tracker: 'Jira' })).toBe('Reading tickets from Jira: 300 of 420');
    expect(releaseScanLine({ step: 'history', done: 0, total: 0, branch: 'main' })).toBe("Reading main's history");
    expect(releaseScanLine({ step: 'history', done: 10, total: 80, branch: 'main', paused: true })).toBe(
      "Reading main's history: 10 of 80 commits (waiting for GitHub's rate limit)",
    );
  });
  it('acceptance 41: on while any repo is checking, off when none is', () => {
    const checking = threeTags();
    checking.ranges = checking.ranges.slice(0, 2);
    const on = run({ repos: [checking], prs: threePrs(), tickets: allDone() });
    expect(releasesChecking({ check: on })).toBe(true);
    const off = run({ repos: [threeTags()], prs: threePrs(), tickets: allDone() });
    expect(releasesChecking({ check: off })).toBe(false);
    expect(releasesChecking(null)).toBe(false);
  });
});

describe('foldReleaseCheck — NEWEST FIRST while the history pass reads (acceptance 43, 48)', () => {
  // v1.0.0 (not reached yet) · v1.1.0 (T1) · v1.2.0 (T2) · v1.3.0 (T3): the pass has read from the head
  // back past v1.1.0's commit but not to v1.0.0's, so v1.1.0's own increment is not complete yet.
  const partial = () => {
    const r = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [], onDefaultBranch: null },
      { name: 'v1.1.0', d: 3, prs: [1], noRange: true },
      { name: 'v1.2.0', d: 5, prs: [2] },
      { name: 'v1.3.0', d: 7, prs: [3] },
    ]);
    r.ranges = r.ranges.map((x) => (x.tagName === 'v1.2.0' ? { ...x, baseTagName: 'v1.1.0', baseSha: sha('v1.1.0') } : x));
    r.defaultBranch = 'main';
    r.history = { done: 2160, total: 5400, complete: false };
    return r;
  };
  const prs = () => [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])];

  it('acceptance 43: EARLY ANSWER, no release — the newest tag\'s own increment is read and its tickets answered → the candidate, before the pass is done', () => {
    const res = run({ repos: [partial()], prs: prs(), tickets: [ticket('T2'), ticket('T3')] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'candidate', checking: false, progress: null });
    expect(api.candidate?.name).toBe('v1.3.0');
  });

  it('the newest tags ruled out, an older one decided early', () => {
    const res = run({ repos: [partial()], prs: prs(), tickets: [ticket('T2'), ticket('T3', { done: false, statusName: 'In review' })] });
    expect(repoOf(res, 1).candidate?.name).toBe('v1.2.0');
  });

  it('every tag read is ruled out and older history is still unread: CHECKING (an older tag may qualify), with the history line', () => {
    const res = run({ repos: [partial()], prs: prs(), tickets: [ticket('T2', { done: false, statusName: 'To do' }), ticket('T3', { done: false, statusName: 'To do' })] });
    const api = repoOf(res, 1);
    expect(api).toMatchObject({ status: 'checking', candidate: null, checking: true });
    expect(api.tags.map((t) => [t.name, t.state])).toEqual([
      ['v1.3.0', 'does_not_qualify'],
      ['v1.2.0', 'does_not_qualify'],
      ['v1.1.0', 'checking'],
    ]);
    expect(api.progress).toEqual({ step: 'history', done: 2160, total: 5400, line: "Reading main's history: 2,160 of 5,400 commits" });
  });

  it('with a baseline the candidate waits for the whole scope: a release tag not reached yet is a baseline not known yet', () => {
    const r = partial();
    r.tags.push({ name: 'v1.0.0-rc', sha: sha('v1.0.0'), committedAt: day(1), taggedAt: day(2, 18), onDefaultBranch: null, moved: false });
    const res = run({ repos: [r], prs: prs(), tickets: [ticket('T2'), ticket('T3')] });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', candidate: null });
    expect(reasons(res, 1, 'v1.3.0')).toEqual(['The history is still being read.']);
    // Its own reason is still certain while the baseline is not known.
    const own = run({ repos: [r], prs: prs(), tickets: [ticket('T2'), ticket('T3', { done: false, statusName: 'To do' })] });
    expect(reasons(own, 1, 'v1.3.0')).toEqual(['T3 is To do.']);
  });

  it('a newer tag whose place on main is not known yet (the tip is still read) stops the walk at the top', () => {
    const r = threeTags();
    r.tags.push({ name: 'v1.3.0', sha: sha('v1.3.0'), committedAt: day(7), taggedAt: null, onDefaultBranch: null, moved: false });
    r.history = { done: 3, total: 10, complete: false };
    r.defaultBranch = 'main';
    const res = run({ repos: [r], prs: threePrs(), tickets: allDone() });
    expect(repoOf(res, 1)).toMatchObject({ status: 'checking', candidate: null });
    expect(repoOf(res, 1).progress?.step).toBe('history');
    // Nothing known yet: checking, never "No version tags".
    const none = threeTags();
    none.tags.forEach((t) => (t.onDefaultBranch = null));
    expect(repoOf(run({ repos: [none] }), 1)).toMatchObject({ status: 'checking', nothingNewReason: null });
  });

  it('the WHOLE history can be read — 250 version tags, no release: the newest qualifying one, the rest unread', () => {
    const specs: TagSpec[] = Array.from({ length: 250 }, (_, i) => ({ name: `v0.${i}.0`, d: 1, prs: [] }));
    const r = repo(1, 'api', specs);
    r.tags.forEach((t, i) => (t.committedAt = new Date(Date.UTC(2026, 0, 1, 0, i))));
    const ordered = [...r.tags].sort((a, b) => a.committedAt!.getTime() - b.committedAt!.getTime());
    r.ranges = ordered.map((t, i) => ({
      tagName: t.name,
      sha: t.sha,
      baseTagName: i > 0 ? ordered[i - 1]!.name : null,
      baseSha: i > 0 ? ordered[i - 1]!.sha : null,
      prIds: i === 249 ? [1] : [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
    }));
    const res = run({ repos: [r], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1', { done: false, statusName: 'In Progress' })] });
    expect(repoOf(res, 1).candidate?.name).toBe('v0.248.0');
    expect(repoOf(res, 1).tags).toHaveLength(2);
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
    expect(repo.newestReason?.tagName).toBe('v1.1.0');
    expect(repo.tags.map((t) => t.name)).toEqual(['v1.1.0', 'v1.0.0']);
    const v11 = repo.tags.find((t) => t.name === 'v1.1.0')!;
    expect(v11.prIds.sort()).toEqual([l2, l3].sort());
    expect(v11.blockers).toEqual([
      { kind: 'not_done', ident: `jira:${SITE.apiRoot}#PLAT-2`, key: 'PLAT-2', statusName: 'In review', fromTag: null },
    ]);
    // A light record also stored as a full PR lends its id (the PR tab) and its author (bot-ness).
    expect(res.check!.prs.find((p) => p.id === l3)).toMatchObject({ prId: p3, isBot: true, ticketIdents: [] });
    expect(res.check!.prs.find((p) => p.id === l1)).toMatchObject({ prId: p1, number: 1 });

    // The ticket is closed as "Won't Do" → Cancelled, not Complete: v1.1.0 still does not qualify.
    const { eq } = await import('drizzle-orm');
    await db.update(trackerTickets).set({ statusName: "Won't Do", statusCategory: 'done' }).where(eq(trackerTickets.issueKey, 'PLAT-2')).execute();
    const cancelled = await m.getReleases(1, scope.workspaceId);
    const repoC = cancelled.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repoC.candidate?.name).toBe('v1.0.0');
    expect(repoC.tags.find((t) => t.name === 'v1.1.0')!.blockers).toEqual([
      { kind: 'not_done', ident: `jira:${SITE.apiRoot}#PLAT-2`, key: 'PLAT-2', statusName: "Won't Do", fromTag: null },
    ]);

    // The ticket moves to Done → the candidate moves to v1.1.0; the bot PR without a ticket is listed,
    // not warned.
    await db.update(trackerTickets).set({ statusName: 'Done', statusCategory: 'done' }).execute();
    const after = await m.getReleases(1, scope.workspaceId);
    const repo2 = after.check!.repos.find((r) => r.repoId === api.id)!;
    expect(repo2.candidate).toMatchObject({ name: 'v1.1.0', releaseTagName: 'v1.1.0-rc' });
    expect(repo2.botPrIds).toEqual([l3]);
    expect(repo2.tags.map((t) => t.name)).toEqual(['v1.1.0']);

    // A ticket the tracker refuses is listed for the reader, never a block.
    await db.update(trackerTickets).set({ state: 'no_access', fetchedAt: null }).execute();
    const unread = await m.getReleases(1, scope.workspaceId);
    const repoU = unread.check!.repos[0]!;
    expect(repoU.candidate?.name).toBe('v1.1.0');
    expect(repoU.tags[0]!.unverified).toEqual([{ ident: `jira:${SITE.apiRoot}#PLAT-2`, key: 'PLAT-2', reason: 'no_access', fromTag: null }]);
    await db.update(trackerTickets).set({ state: 'ok', fetchedAt: day(10) }).execute();

    // An unknown workspace id falls back to the Default workspace, never a 404.
    expect((await m.getReleases(1, 'nope')).workspaceId).toBe(scope.workspaceId);
  });

  it('acceptance 17/39: a LIGHT-only range PR (older than the synced history) gets its ticket from THE detection rule; not read yet is CHECKING; a tracker that cannot read lists it (never a block)', async () => {
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
    // No credential: the tracker cannot read, so the ticket would never be read — listed, not blocking.
    expect(repo.candidate?.name).toBe('v1.2.0');
    expect(repo.untrackedPrIds).not.toContain(l4);
    expect(repo.tags.find((t) => t.name === 'v1.2.0')!.unverified).toEqual([
      { ident: `jira:${SITE.apiRoot}#PLAT-310`, key: 'PLAT-310', reason: 'not_read', fromTag: null },
    ]);
    expect(res.check!.prs.find((p) => p.id === l4)).toMatchObject({ prId: null, ticketIdents: [`jira:${SITE.apiRoot}#PLAT-310`] });
    expect(await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + 1000)).toEqual({ keys: [], waiting: 0 });

    // With a credential the scan's next batch reads it: CHECKING, with the tickets step.
    await db.update(workspaceTrackers).set({ authEmail: 'ada@acme.test', authToken: 'plain:tok' }).execute();
    const res2 = await m.getReleases(1, scope.workspaceId);
    const repo2 = res2.check!.repos.find((r) => r.repoId === api.id)!;
    // The newest tag waits for it: the walk stops there (it may yet qualify).
    expect(repo2).toMatchObject({ status: 'checking', checking: true, candidate: null });
    expect(repo2.tags.map((t) => [t.name, t.state])).toEqual([['v1.2.0', 'checking']]);
    expect(repo2.tags[0]!.blockers).toEqual([{ kind: 'checking', ident: `jira:${SITE.apiRoot}#PLAT-310`, key: 'PLAT-310', fromTag: null }]);
    expect(repo2.progress).toEqual({ step: 'tickets', done: 0, total: 1, line: 'Reading tickets from Jira: 0 of 1' });
    // Owed: the unread one; the others were read a second ago (inside the TTL).
    expect(await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + 1000)).toEqual({ keys: ['PLAT-310'], waiting: 1 });
    // Past the TTL every ticket in the tags after the baseline is read again (in one batch).
    expect((await m.releaseTicketKeysOwed(1, scope.workspaceId, api.id, SETTINGS, day(10).getTime() + m.RELEASE_TICKET_TTL_MS + 1)).keys).toEqual([
      'PLAT-1',
      'PLAT-2',
      'PLAT-310',
    ]);
  });

  it('the batched status row answers a ticket; a transient failure is checking until it failed three times, then listed (it stops blocking)', async () => {
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
    expect(t2).toMatchObject({ readState: 'failed', blocker: null, unverified: 'failed', pending: false });
    const repo = (await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.name === 'api')!;
    expect(repo.candidate?.name).toBe('v1.2.0');
    expect(repo.tags[0]!.unverified).toEqual([{ ident, key: 'PLAT-310', reason: 'failed', fromTag: null }]);
    await db.delete(schema.trackerTicketStatus).execute();
  });

  it("the scan's live history step is laid over the derived one (its rate-limit wait)", async () => {
    const { db, schema } = client;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const { eq } = await import('drizzle-orm');
    const scope = await resolveWorkspaceScope(1, undefined);
    const api = (await db.select().from(schema.repos).execute()).find((r: any) => r.name === 'api');
    await db.update(schema.releaseHistoryScans).set({ deepExpectedSha: sha('older'), deepEstimate: 80 }).where(eq(schema.releaseHistoryScans.repoId, api.id)).execute();
    // v1.2.0 and v1.1.0 are ruled out; v1.0.0's own increment waits for older history.
    await db
      .insert(schema.trackerTicketStatus)
      .values({ accountId: 1, workspaceId: scope.workspaceId, provider: 'jira', apiRoot: SITE.apiRoot, issueKey: 'PLAT-310', ident: `jira:${SITE.apiRoot}#PLAT-310`, state: 'ok', statusName: 'To do', statusCategory: 'new', fetchedAt: day(12), checkedAt: day(12) })
      .execute();
    await db.update(schema.trackerTickets).set({ statusName: 'In review', statusCategory: 'indeterminate' }).where(eq(schema.trackerTickets.issueKey, 'PLAT-2')).execute();
    const derived = (await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.repoId === api.id)!;
    expect(derived).toMatchObject({ status: 'checking', candidate: null });
    expect(derived.progress).toEqual({ step: 'history', done: 4, total: 80, line: "Reading main's history: 4 of 80 commits" });
    const scan = await import('../releases/scan-state.js');
    scan.noteScanStep(api.id, { step: 'history', done: 35, total: 80, paused: true });
    const live = (await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.repoId === api.id)!;
    expect(live.progress).toEqual({ step: 'history', done: 35, total: 80, line: "Reading main's history: 35 of 80 commits (waiting for GitHub's rate limit)" });
    expect(live.tags.map((t) => [t.name, t.state])).toEqual([
      ['v1.2.0', 'does_not_qualify'],
      ['v1.1.0', 'does_not_qualify'],
      ['v1.0.0', 'checking'],
    ]);
    scan.__resetScanState();
    await db.update(schema.releaseHistoryScans).set({ deepExpectedSha: null }).where(eq(schema.releaseHistoryScans.repoId, api.id)).execute();
    await db.delete(schema.trackerTicketStatus).execute();
    await db.update(schema.trackerTickets).set({ statusName: 'Done', statusCategory: 'done' }).execute();
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

  it('acceptance 18: an OPEN PR into the default branch of a releasable repo, naming a Complete ticket, rules the tag out; one into hotfix/… does not', async () => {
    const { db, schema } = client;
    const { resolveWorkspaceScope } = await import('./queries.js');
    const { eq } = await import('drizzle-orm');
    const scope = await resolveWorkspaceScope(1, undefined);
    const api = (await db.select().from(schema.repos).execute()).find((r: any) => r.name === 'api');
    const open = async (number: number, base: string) =>
      (
        await db
          .insert(schema.pullRequests)
          .values({ githubNodeId: `PR_rc_open_${number}`, accountId: 1, repoId: api.id, number, title: `PLAT-310: follow up ${number}`, state: 'open', isDraft: false, openedAt: day(11), updatedAt: day(11), baseRefName: base })
          .returning()
          .execute()
      )[0].id as number;
    const hot = await open(50, 'hotfix/v1.0.0-rc');
    expect((await m.getReleases(1, scope.workspaceId)).check!.repos.find((r) => r.name === 'api')!.candidate?.name).toBe('v1.2.0');
    expect(await m.releaseCandidateProven(1, api.id, [{ workspaceId: scope.workspaceId, settings: SETTINGS }])).toBe(true);
    const main = await open(51, 'main');
    const res = await m.getReleases(1, scope.workspaceId);
    const repo = res.check!.repos.find((r) => r.name === 'api')!;
    expect(repo.candidate?.name).toBe('v1.1.0');
    expect(repo.tags[0]!.blockers).toEqual([
      {
        kind: 'open_pr',
        ident: `jira:${SITE.apiRoot}#PLAT-310`,
        key: 'PLAT-310',
        prs: [{ repoId: api.id, repoName: 'api', number: 51, url: 'https://github.com/acme/api/pull/51', prId: main }],
        fromTag: null,
      },
    ]);
    // HISTORY STOPS EARLY only once every releasing workspace has its candidate.
    expect(await m.releaseCandidateProven(1, api.id, [{ workspaceId: scope.workspaceId, settings: SETTINGS }])).toBe(true);
    expect(await m.releaseCandidateProven(1, api.id, [{ settings: SETTINGS }])).toBe(false);
    await db.delete(schema.pullRequests).where(eq(schema.pullRequests.id, main)).execute();
    await db.delete(schema.pullRequests).where(eq(schema.pullRequests.id, hot)).execute();
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
