// This Sprint → Releases and Settings → Releases: the pure UI half (components/Sprint/releasesModel.ts,
// components/settings/releasesSectionModel.ts) over REAL results of the shared fold
// (`foldReleaseCheck`). docs/RELEASES.md § Acceptance checks — numbers in the test names.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/releasesModel.test.ts
import { describe, expect, it } from 'vitest';
import {
  foldReleaseCheck,
  type ReleaseCheckInput,
  type ReleaseCheckPrInput,
  type ReleaseCheckRepoInput,
  type ReleaseCheckResult,
  type ReleaseCheckTicketInput,
} from '@pierre-review/shared';
import {
  RELEASES_POLL_MS,
  confirmStops,
  defaultTickedRepoIds,
  editedSections,
  BAND_WORDS,
  candidateScopeLabel,
  latestReleaseLine,
  noTicketLine,
  noTicketPrLine,
  olderBandView,
  olderShowMore,
  olderTagSummary,
  readAgoWords,
  rowBands,
  tagHeader,
  ticketDetail,
  ticketLine,
  ticketStatusWords,
  releaseTagsLine,
  releasesPollInterval,
  repoLatestNote,
  repoProgress,
  repoRowCounts,
  repoRowText,
  showCreateRelease,
  tagExplainer,
  tagTickets,
} from '../src/components/Sprint/releasesModel.js';
import { releaseReposDirty, releaseSuffixChangeWarning } from '../src/components/settings/releasesSectionModel.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const sha = (c: string) => c.padEnd(40, '0');

interface TagSpec {
  name: string;
  d: number;
  prs?: number[];
  commit?: string;
  noRange?: boolean;
  taggedAt?: number;
}

function repo(repoId: number, name: string, specs: TagSpec[], writable = true): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({
    name: s.name,
    sha: sha(s.commit ?? s.name),
    committedAt: day(s.d),
    taggedAt: s.taggedAt != null ? day(s.taggedAt, 18) : null,
    onDefaultBranch: true,
    moved: false,
  }));
  const sorted = tags
    .map((t, i) => ({ t, s: specs[i]! }))
    .sort((a, b) => a.t.committedAt.getTime() - b.t.committedAt.getTime() || (a.t.taggedAt?.getTime() ?? 0) - (b.t.taggedAt?.getTime() ?? 0));
  const ranges = sorted.flatMap(({ t, s }, i) => {
    const base = i > 0 ? sorted[i - 1]!.t : null;
    if (s.noRange) return [];
    return [{
      tagName: t.name,
      sha: t.sha,
      baseTagName: base?.name ?? null,
      baseSha: base?.sha ?? null,
      prIds: s.prs ?? [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
    }];
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

function ticket(key: string, extra: Partial<ReleaseCheckTicketInput> = {}): ReleaseCheckTicketInput {
  return { ident: key, key, title: `${key} title`, url: null, statusName: 'Done', done: true, readState: 'ok', ...extra };
}

function run(parts: Partial<ReleaseCheckInput>): ReleaseCheckResult {
  return foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], ...parts });
}

const threeTags = (writable = true) =>
  repo(
    1,
    'api',
    [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ],
    writable,
  );

describe('the header line', () => {
  it('says "none" with no release, else the day and month', () => {
    expect(latestReleaseLine({ latestReleaseTagAt: null, latestRelease: null })).toBe('Latest release: none');
    expect(latestReleaseLine({ latestReleaseTagAt: day(12).toISOString(), latestRelease: null })).toBe('Latest release: 12 Nov');
    // A release made here whose tag is not synced yet still counts.
    expect(
      latestReleaseLine({ latestReleaseTagAt: null, latestRelease: { id: 1, createdAt: day(14).toISOString(), state: 'done' } }),
    ).toBe('Latest release: 14 Nov');
  });
});

describe('repo rows — the simple rule, newest first', () => {
  const all = () => ({ prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });

  it('acceptance 4: all Complete, no release → "Release v1.2.0 → v1.2.0-rc", no "Latest" beside it, Create release shown', () => {
    const res = run({ repos: [threeTags()], ...all() });
    const api = res.repos[0]!;
    expect(repoRowText(api)).toBe('Release v1.2.0 → v1.2.0-rc');
    expect(repoLatestNote(api)).toBeNull();
    expect(repoRowCounts(api)).toBe('1 ticket');
    expect(repoProgress(api)).toBeNull();
    expect(showCreateRelease(res)).toBe(true);
    expect(defaultTickedRepoIds(res)).toEqual([1]);
  });

  it('acceptance 5: an In PO Review ticket in v1.2.0 → "Release v1.1.0 → v1.1.0-rc" with "Latest v1.2.0" beside it', () => {
    const res = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'In PO Review' })] });
    const api = res.repos[0]!;
    expect(repoRowText(api)).toBe('Release v1.1.0 → v1.1.0-rc');
    expect(repoLatestNote(api)).toBe('Latest v1.2.0');
  });

  it('acceptance 16: every tag ruled out → "No tag can be released — <newest>: <reason>"; after a release, "No tag since … can be released"', () => {
    const none = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1', { done: false }), ticket('T2', { done: false }), ticket('T3', { done: false, statusName: 'In PO Review' })] });
    expect(repoRowText(none.repos[0]!)).toBe('No tag can be released — v1.2.0: T3 is In PO Review');
    expect(showCreateRelease(none)).toBe(false);
    const released = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [released], prs: all().prs, tickets: [ticket('T2', { done: false, statusName: 'In Progress' }), ticket('T3')] });
    expect(repoRowText(res.repos[0]!)).toBe('No tag since v1.0.0-rc can be released — v1.2.0: T2 (from v1.1.0) is In Progress');
  });

  it('acceptance 18: an open pull request elsewhere names the repo and number', () => {
    const res = run({
      repos: [threeTags()],
      ...all(),
      openPrs: [{ repoId: 2, repoName: 'bng-metric-frontend', number: 812, url: 'https://github.com/acme/bng-metric-frontend/pull/812', prId: 5, ticketIdents: ['T3'] }],
    });
    expect(repoRowText(res.repos[0]!)).toBe('Release v1.1.0 → v1.1.0-rc');
    // Its own ticket line carries the reason; the explainer is for reasons from elsewhere.
    expect(tagExplainer(res.repos[0]!.tags[0]!)).toEqual([]);
    expect(ticketLine(res.tickets.find((t) => t.ident === 'T3')!, 'Jira')).toEqual({ tone: 'bad', text: 'Done, but has an open PR: bng-metric-frontend #812' });
  });

  it('acceptance 11: a Cancelled ticket does not qualify — the reason names its status', () => {
    const res = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: "Won't Do", stage: 'cancelled' })] });
    expect(repoRowText(res.repos[0]!)).toBe('Release v1.1.0 → v1.1.0-rc');
    // The status name, with the bucket in brackets because it differs.
    expect(ticketLine(res.tickets.find((t) => t.ident === 'T3')!, 'Jira')).toEqual({ tone: 'bad', text: "Won't Do (Cancelled)" });
  });

  it('acceptance 17: not decided yet → "Checking…" with a bar and ONE line', () => {
    const r = threeTags();
    r.defaultBranch = 'main';
    r.ranges = r.ranges.filter((x) => x.tagName !== 'v1.2.0');
    r.history = { done: 1200, total: 5400, complete: false };
    const res = run({ repos: [r], ...all() });
    const api = res.repos[0]!;
    expect(repoRowText(api)).toBe('Checking…');
    expect(repoProgress(api)).toEqual({ share: 1200 / 5400, line: "Reading main's history: 1,200 of 5,400 commits" });
    expect(tagExplainer(api.tags[0]!)).toEqual([{ tone: 'warn', text: 'The history is still being read.' }]);
    // A ticket not read yet: the tickets line.
    const t = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2')], trackerName: 'Jira' });
    expect(repoProgress(t.repos[0]!)).toEqual({ share: 0, line: 'Reading tickets from Jira: 0 of 1' });
    expect(ticketLine(t.tickets.find((x) => x.ident === 'T3')!, 'Jira')).toEqual({ tone: 'warn', text: 'not read yet' });
  });

  it('acceptance 41: the tab polls every ~3 s while a repo is checking, and stops when none is', () => {
    const r = threeTags();
    r.ranges = r.ranges.filter((x) => x.tagName !== 'v1.2.0');
    expect(releasesPollInterval({ check: run({ repos: [r], ...all() }) })).toBe(RELEASES_POLL_MS);
    expect(releasesPollInterval({ check: run({ repos: [threeTags()], ...all() }) })).toBe(false);
    expect(releasesPollInterval(null)).toBe(false);
  });

  it('acceptance 10: a ticket the tracker could not find → still the candidate; counted "to check" and listed under the tag', () => {
    const res = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2'), ticket('T3', { readState: 'not_found', done: false, statusName: null })] });
    const api = res.repos[0]!;
    expect(repoRowText(api)).toBe('Release v1.2.0 → v1.2.0-rc');
    expect(repoRowCounts(api)).toBe('1 ticket · 1 to check');
    expect(ticketLine(res.tickets.find((x) => x.ident === 'T3')!, 'Jira')).toEqual({ tone: 'unknown', text: 'not found in Jira — check by hand' });
  });

  it('acceptance 12 / 24: no version tag after the release → "Nothing new since v1.2.0-rc"; none at all → "No version tags on main yet"', () => {
    const r = repo(1, 'api', [
      { name: 'v1.2.0', d: 5, prs: [3] },
      { name: 'v1.2.0-rc', d: 5, commit: 'v1.2.0', taggedAt: 6 },
    ]);
    const res = run({ repos: [r], ...all() });
    expect(repoRowText(res.repos[0]!)).toBe('Nothing new since v1.2.0-rc');
    expect(showCreateRelease(res)).toBe(false);
    expect(repoRowText(run({ repos: [repo(2, 'web', [])] }).repos[0]!)).toBe('No version tags on main yet');
  });

  it('Create release… is HIDDEN when the only candidate is in a repo without push access', () => {
    const res = run({ repos: [threeTags(false)], ...all() });
    expect(res.repos[0]!.candidate).not.toBeNull();
    expect(showCreateRelease(res)).toBe(false);
  });
});

describe('the expanded row: the tags read, newest first', () => {
  it('acceptance 42: each tag newer than the candidate says why it does not qualify; older tags are not read', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: 'In review' })],
    });
    const b = rowBands(res.repos[0]!);
    expect(b.newerHeading).toBe('Newer than the candidate — can’t be released');
    expect(b.newer.map((t) => t.name)).toEqual(['v1.2.0']);
    expect(b.candidate?.name).toBe('v1.1.0');
    // The tag's own ticket speaks on its own line ("✗ T3 … In review"); the explainer adds nothing.
    expect(tagExplainer(b.newer[0]!)).toEqual([]);
    const t3 = tagTickets(res, b.newer[0]!).tickets[0]!.ticket;
    expect(ticketLine(t3, 'Jira')).toEqual({ tone: 'bad', text: 'In review' });
    // The older band lists v1.0.0 for checking.
    expect(b.older.map((t) => t.name)).toEqual(['v1.0.0']);
  });

  it('acceptance 7: each tag lists its tickets and its PRs with no ticket (human or bot), never a warning; nothing says "released"', () => {
    const r = threeTags();
    r.ranges[2]!.prIds = [3, 4, 5];
    const res = run({
      repos: [r],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3']), pr(4, 1, []), pr(5, 1, [], { isBot: true })],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3')],
    });
    const v12 = tagTickets(res, res.repos[0]!.tags[0]!);
    expect(v12.tickets.map((t) => [t.ticket.key, ticketLine(t.ticket, 'Jira').text, t.prs.map((p) => p.number)])).toEqual([['T3', 'Done', [3]]]);
    expect(v12.noTicket.map((p) => p.number)).toEqual([4, 5]);
    expect(noTicketLine(v12.noTicket.length)).toBe('2 pull requests with no ticket');
    expect(noTicketLine(1)).toBe('1 pull request with no ticket');
    expect(noTicketLine(0)).toBeNull();
    expect(JSON.stringify(v12)).not.toMatch(/released/i);
  });

  it('after a release the candidate lists every ticket in its scope (everything since the release)', () => {
    const released = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [released], prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T2'), ticket('T3')] });
    const c = tagTickets(res, res.repos[0]!.tags[0]!);
    expect(c.tickets.map((t) => t.ticket.key)).toEqual(['T2', 'T3']);
    expect(candidateScopeLabel(res.repos[0]!)).toBe('checked: everything since v1.0.0-rc');
  });
});

describe('the three bands, the tag headers and the ticket lines (the approved layout)', () => {
  /** `n` tags v1.<i>.0, each adding PR i naming T<i>. */
  const many = (n: number) => repo(1, 'api', Array.from({ length: n }, (_, k) => ({ name: `v1.${k + 1}.0`, d: k + 1, prs: [k + 1] })));
  const manyPrs = (n: number) => Array.from({ length: n }, (_, k) => pr(k + 1, 1, [`T${k + 1}`], { authorLogin: 'alex' }));
  const manyTickets = (n: number) => Array.from({ length: n }, (_, k) => ticket(`T${k + 1}`, { statusName: 'Complete', stage: 'done' }));

  it('49: every tag newer than the candidate, each with ALL its tickets in order — stops first, then to check, then Complete; ties by key', () => {
    const r = many(3);
    r.ranges[2]!.prIds = [3, 4, 5, 6];
    const res = run({
      repos: [r],
      prs: [...manyPrs(3), pr(4, 1, ['T4']), pr(5, 1, ['T0']), pr(6, 1, ['T9'])],
      openPrs: [{ repoId: 2, repoName: 'frontend', number: 812, url: 'https://github.com/acme/frontend/pull/812', prId: null, ticketIdents: ['T4'] }],
      tickets: [
        ...manyTickets(3),
        ticket('T4', { statusName: 'Complete', stage: 'done' }),
        ticket('T0', { readState: 'not_found', done: false, statusName: null }),
        ticket('T9', { done: false, statusName: 'In PO Review', stage: 'product_review' }),
      ],
      trackerName: 'Jira',
    });
    const b = rowBands(res.repos[0]!);
    expect(b.newer.map((t) => t.name)).toEqual(['v1.3.0']);
    expect(b.candidate?.name).toBe('v1.2.0');
    const lines = tagTickets(res, b.newer[0]!).tickets.map(({ ticket: t }) => [t.key, ticketLine(t, res.trackerName).tone, ticketLine(t, res.trackerName).text]);
    expect(lines).toEqual([
      ['T4', 'bad', 'Complete, but has an open PR: frontend #812'],
      ['T9', 'bad', 'In PO Review (Product review)'],
      ['T0', 'unknown', 'not found in Jira — check by hand'],
      ['T3', 'ok', 'Complete'],
    ]);
    expect(tagHeader(res, b.newer[0]!).text).toBe(`v1.3.0 · 3 Nov · ${sha('v1.3.0').slice(0, 7)} · 4 PRs · 4 tickets`);
    expect(tagHeader(res, b.candidate!).url).toBe(`https://github.com/acme/api/commit/${sha('v1.2.0')}`);
    expect(candidateScopeLabel(res.repos[0]!)).toBe('checked: this tag’s own changes');
  });

  it('no candidate: every tag read is in the first band, under "Can’t be released"; no older band', () => {
    const res = run({ repos: [many(2)], prs: manyPrs(2), tickets: [ticket('T1', { done: false, statusName: 'To do' }), ticket('T2', { done: false, statusName: 'To do' })] });
    const b = rowBands(res.repos[0]!);
    expect(b).toMatchObject({ newerHeading: BAND_WORDS.newerNoCandidate, candidate: null, older: [] });
    expect(b.newer.map((t) => t.name)).toEqual(['v1.2.0', 'v1.1.0']);
    expect(repoRowText(res.repos[0]!)).toBe('No tag can be released — v1.2.0: T2 is To do');
  });

  it('50: the older band — 10 shown, one summary line each, "… 10 tags shown" and "Show 50 more"; a press asks the server for 60', () => {
    const tickets = manyTickets(15);
    tickets[8] = ticket('T9', { done: false, statusName: 'In Progress', stage: 'in_progress' });
    const res = run({ repos: [many(15)], prs: manyPrs(15), tickets });
    const api = res.repos[0]!;
    const v = olderBandView(api, 10);
    expect(v.tags).toHaveLength(10);
    expect(v).toMatchObject({ shownLine: '… 10 tags shown', showMore: true, lastReleaseLine: null, progress: null });
    expect(olderTagSummary(res, v.tags[0]!)).toEqual({ tone: 'ok', text: '1 ticket Complete' });
    expect(olderTagSummary(res, v.tags.find((t) => t.name === 'v1.9.0')!)).toEqual({ tone: 'bad', text: 'T9 In Progress' });
    expect(olderShowMore(10, api.older.wanted)).toEqual({ shown: 60, ask: 60 });
    // The server already holds more than shown: no request, the tags are shown at once.
    expect(olderShowMore(10, 110)).toEqual({ shown: 60, ask: null });
    // All of them shown and none more: no button.
    const r60 = many(15);
    r60.olderWanted = 60;
    const all = run({ repos: [r60], prs: manyPrs(15), tickets: manyTickets(15) }).repos[0]!;
    expect(olderBandView(all, 60)).toMatchObject({ showMore: false, shownLine: null });
    // A summary for two Complete tickets.
    const two = many(3);
    two.ranges[1]!.prIds = [2, 9];
    const r2 = run({ repos: [two], prs: [...manyPrs(3), pr(9, 1, ['T99'])], tickets: [...manyTickets(3), ticket('T99', { statusName: 'Complete' })] });
    expect(olderTagSummary(r2, r2.repos[0]!.olderTags[0]!)).toEqual({ tone: 'ok', text: 'all 2 tickets Complete' });
  });

  it('51: after a release the older band ends with the release tag: "v1.0.0-rc — last release"', () => {
    const released = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [released], prs: manyPrs(3), tickets: manyTickets(3) });
    const v = olderBandView(res.repos[0]!, 10);
    expect(v.tags.map((t) => t.name)).toEqual(['v1.1.0']);
    expect(v).toMatchObject({ lastReleaseLine: 'v1.0.0-rc — last release', showMore: false });
  });

  it('53: while the band reads older history it shows the bar and its line, and hides "Show 50 more"; the tab polls', () => {
    const r = many(3);
    r.tags.push({ name: 'v0.9.0', sha: sha('v0.9.0'), committedAt: day(0), taggedAt: null, onDefaultBranch: null, moved: false });
    r.history = { done: 300, total: 900, complete: false };
    r.defaultBranch = 'main';
    const res = run({ repos: [r], prs: manyPrs(3), tickets: manyTickets(3) });
    const v = olderBandView(res.repos[0]!, 10);
    expect(v.progress).toEqual({ share: 300 / 900, line: "Reading main's history: 300 of 900 commits" });
    expect(v.showMore).toBe(false);
    expect(releasesPollInterval({ check: res })).toBe(RELEASES_POLL_MS);
  });

  it('54: a ticket line opens to its detail — type, assignee, last read; PRs in this tag and elsewhere (OPEN, in a tag, not in a tag yet)', () => {
    const api = many(3);
    api.ranges[1]!.prIds = [2, 4];
    const web = repo(2, 'frontend', [{ name: 'w1.0.0', d: 2, prs: [20] }]);
    const res = run({
      repos: [api, web],
      prs: [...manyPrs(3), pr(4, 1, ['T3'], { title: 'T3: schema', mergedAt: day(2), authorLogin: 'sam' }), pr(20, 2, ['T3'], { title: 'T3: page', mergedAt: day(2) })],
      openPrs: [{ repoId: 2, repoName: 'frontend', number: 812, url: 'https://github.com/acme/frontend/pull/812', prId: 9, ticketIdents: ['T3'], title: 'T3: export button' }],
      mergedPrs: [{ repoId: 1, repoName: 'api', number: 30, title: 'T3: later', url: 'https://github.com/acme/api/pull/30', prId: 300, authorLogin: 'alex', mergedAt: day(9), ticketIdents: ['T3'] }],
      tickets: [...manyTickets(2), ticket('T3', { statusName: 'Complete', stage: 'done', typeName: 'Story', assigneeName: 'Robin Lee', readAt: day(10, 11) })],
      trackerName: 'Jira',
    });
    const v13 = res.repos[0]!.tags.find((t) => t.name === 'v1.3.0')!;
    const t3 = res.tickets.find((t) => t.ident === 'T3')!;
    const d = ticketDetail(res, v13, t3, day(10, 11).getTime() + 4 * 60_000);
    expect(d.facts).toEqual(['Type: Story', 'Assignee: Robin Lee', 'Jira status read 4 min ago']);
    expect(d.inThisTag.map((l) => [l.label, l.title, l.tail])).toEqual([['api #3', '“change 3”', 'merged 1 Nov · alex']]);
    expect(d.elsewhere.map((l) => [l.label, l.title, l.tail])).toEqual([
      ['frontend #812', '“T3: export button”', 'OPEN'],
      ['api #4', '“T3: schema”', 'merged 2 Nov · in v1.2.0'],
      ['api #30', '“T3: later”', 'merged 9 Nov · not in a tag yet'],
      ['frontend #20', '“T3: page”', 'merged 2 Nov · in w1.0.0'],
    ]);
    // A PR with no ticket, listed under its tag.
    expect(noTicketPrLine(res, res.prs.find((p) => p.id === 3)!)).toMatchObject({ label: 'api #3', title: '“change 3”', tail: 'merged 1 Nov · alex' });
  });

  it('the status words: the bucket in brackets only when it differs; the read age', () => {
    expect(ticketStatusWords({ statusName: "Won't Do", stage: 'cancelled', done: false })).toBe("Won't Do (Cancelled)");
    expect(ticketStatusWords({ statusName: 'Complete', stage: 'done', done: true })).toBe('Complete');
    expect(ticketStatusWords({ statusName: 'In progress', stage: 'in_progress', done: false })).toBe('In progress');
    expect(ticketStatusWords({ statusName: 'Done', stage: null, done: true })).toBe('Done');
    const t0 = day(10).getTime();
    expect(readAgoWords(day(10).toISOString(), t0 + 10_000)).toBe('just now');
    expect(readAgoWords(day(10).toISOString(), t0 + 3 * 3_600_000)).toBe('3 hours ago');
    expect(readAgoWords(day(10).toISOString(), t0 + 86_400_000)).toBe('1 day ago');
  });
});

describe('the dialog: each repo on its own', () => {
  it('unticking a repo stops nothing; none ticked hides Confirm', () => {
    const api = repo(1, 'api', [{ name: 'v2.4.0', d: 5, prs: [11] }]);
    const web = repo(2, 'web', [{ name: 'v1.9.0', d: 8, prs: [21] }]);
    const res = run({ repos: [api, web], prs: [pr(11, 1, ['PLAT-290']), pr(21, 2, ['PLAT-290'])], tickets: [ticket('PLAT-290')] });
    expect(confirmStops([1])).toEqual([]);
    expect(confirmStops([])).toEqual(['Tick at least one repository.']);
    expect(releaseTagsLine(res, [1, 2])).toBe('api v2.4.0-rc · web v1.9.0-rc');
  });
});

describe('the dialog sends only edited, ticked sections', () => {
  const preview = {
    sections: [
      { repoId: 1, repoName: 'api', releaseTagName: 'v1-rc', markdown: '## api' },
      { repoId: 2, repoName: 'web', releaseTagName: 'v2-rc', markdown: '## web' },
    ],
  };
  it('an unchanged edit and an unticked repo are left out', () => {
    const edits = new Map([
      [1, '## api\n\nEdited.'],
      [2, '## web edited'],
    ]);
    expect(editedSections(preview, [1], edits)).toEqual([{ repoId: 1, markdown: '## api\n\nEdited.' }]);
    expect(editedSections(preview, [1, 2], new Map([[1, '## api']]))).toEqual([]);
  });
});

describe('Settings → Releases: the ticked repositories', () => {
  it('dirty only when the set changes (order does not count)', () => {
    expect(releaseReposDirty([1, 2], [2, 1])).toBe(false);
    expect(releaseReposDirty([1], [1, 2])).toBe(true);
    expect(releaseReposDirty([1, 2], [1])).toBe(true);
    expect(releaseReposDirty([], [])).toBe(false);
  });
});

describe('Settings → Releases: the suffix-change warning', () => {
  const saved = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix', hasReleases: true };
  it('acceptance 3: changing the release suffix after a release exists warns', () => {
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-release', hotfixSuffix: '-hotfix' })).toBe(
      'Tags ending in -rc will stop counting as releases.',
    );
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-rc', hotfixSuffix: '-fix' })).toBe(
      'Tags ending in -hotfix will stop counting as hotfixes.',
    );
  });
  it('no warning before any release, for an unchanged suffix, or for a first set', () => {
    expect(releaseSuffixChangeWarning({ ...saved, hasReleases: false }, { releaseSuffix: '-x', hotfixSuffix: '-y' })).toBeNull();
    expect(releaseSuffixChangeWarning(saved, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' })).toBeNull();
    expect(
      releaseSuffixChangeWarning({ releaseSuffix: null, hotfixSuffix: null, hasReleases: true }, { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' }),
    ).toBeNull();
  });
});
