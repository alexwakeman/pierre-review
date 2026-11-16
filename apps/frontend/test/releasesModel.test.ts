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
  expandedTags,
  latestReleaseLine,
  noTicketLine,
  releaseTagsLine,
  releasesPollInterval,
  repoLatestNote,
  repoProgress,
  repoRowCounts,
  repoRowText,
  showCreateRelease,
  tagContents,
  tagExplainer,
  ticketMark,
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
    expect(tagExplainer(res.repos[0]!.tags[0]!)).toEqual([{ tone: 'bad', text: 'T3 has an open pull request in bng-metric-frontend (#812).' }]);
    expect(ticketMark(res.tickets.find((t) => t.ident === 'T3')!)).toEqual({ tone: 'bad', text: 'Done, 1 open pull request' });
  });

  it('acceptance 11: a Cancelled ticket does not qualify — the reason names its status', () => {
    const res = run({ repos: [threeTags()], prs: all().prs, tickets: [ticket('T1'), ticket('T2'), ticket('T3', { done: false, statusName: "Won't Do" })] });
    expect(tagExplainer(res.repos[0]!.tags[0]!)).toEqual([{ tone: 'bad', text: "T3 is Won't Do." }]);
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
    expect(tagExplainer(t.repos[0]!.tags[0]!)).toEqual([{ tone: 'warn', text: 'T3 is not read yet.' }]);
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
    expect(tagExplainer(api.tags[0]!)).toEqual([{ tone: 'warn', text: 'T3 not found. Check it by hand.' }]);
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
    const tags = expandedTags(res.repos[0]!);
    expect(tags.map((t) => t.name)).toEqual(['v1.2.0', 'v1.1.0']);
    expect(tagExplainer(tags[0]!)).toEqual([{ tone: 'bad', text: 'T3 is In review.' }]);
    expect(tagExplainer(tags[1]!)).toEqual([]);
  });

  it('acceptance 7: each tag lists its tickets and its PRs with no ticket (human or bot), never a warning; nothing says "released"', () => {
    const r = threeTags();
    r.ranges[2]!.prIds = [3, 4, 5];
    const res = run({
      repos: [r],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3']), pr(4, 1, []), pr(5, 1, [], { isBot: true })],
      tickets: [ticket('T1'), ticket('T2'), ticket('T3')],
    });
    const v12 = tagContents(res, res.repos[0]!.tags[0]!);
    expect(v12.tickets.map((t) => [t.ticket.key, ticketMark(t.ticket).text, t.prs.map((p) => p.number)])).toEqual([['T3', 'Done', [3]]]);
    expect(v12.noTicket.map((p) => p.number)).toEqual([4, 5]);
    expect(noTicketLine(v12.noTicket.length)).toBe('Also includes 2 pull requests with no ticket');
    expect(noTicketLine(1)).toBe('Also includes a pull request with no ticket');
    expect(noTicketLine(0)).toBeNull();
    expect(JSON.stringify(v12)).not.toMatch(/released/i);
    expect(ticketMark({ done: false, readState: 'no_access', statusName: null, openPrs: [] })).toEqual({ tone: 'warn', text: 'could not be read' });
    expect(ticketMark({ done: false, readState: 'not_read', statusName: null, openPrs: [] })).toEqual({ tone: 'warn', text: 'not read yet' });
    expect(ticketMark({ done: false, readState: 'not_found', statusName: null, openPrs: [] })).toEqual({ tone: 'warn', text: 'not found' });
  });

  it('after a release the candidate lists every ticket in its scope (everything since the release)', () => {
    const released = repo(1, 'api', [
      { name: 'v1.0.0', d: 1, prs: [1] },
      { name: 'v1.0.0-rc', d: 1, commit: 'v1.0.0', taggedAt: 2 },
      { name: 'v1.1.0', d: 3, prs: [2] },
      { name: 'v1.2.0', d: 5, prs: [3] },
    ]);
    const res = run({ repos: [released], prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T2'), ticket('T3')] });
    const c = tagContents(res, res.repos[0]!.tags[0]!);
    expect(c.tickets.map((t) => t.ticket.key)).toEqual(['T2', 'T3']);
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
