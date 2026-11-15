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
  confirmStops,
  defaultTickedRepoIds,
  editedSections,
  latestReleaseLine,
  noBaselineLine,
  releaseTagsLine,
  releaseWarningText,
  repoReadingNote,
  repoRowCounts,
  repoRowText,
  showCreateRelease,
  startTagLine,
  tagContents,
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
}

function repo(repoId: number, name: string, specs: TagSpec[], writable = true): ReleaseCheckRepoInput {
  const tags = specs.map((s) => ({
    name: s.name,
    sha: sha(s.commit ?? s.name),
    committedAt: day(s.d),
    taggedAt: null,
    onDefaultBranch: true,
    moved: false,
  }));
  const sorted = tags.map((t, i) => ({ t, s: specs[i]! })).sort((a, b) => a.t.committedAt.getTime() - b.t.committedAt.getTime());
  const ranges = sorted.flatMap(({ t, s }, i) => {
    const base = i > 0 ? sorted[i - 1]!.t : null;
    if (s.noRange) return [];
    return [{
      tagName: t.name,
      sha: t.sha,
      baseTagName: base?.name ?? null,
      baseSha: base?.sha ?? null,
      method: base == null ? ('history' as const) : ('compare' as const),
      prIds: s.prs ?? [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
      truncated: false,
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

describe('repo rows — the pair: the latest version tag on main, and the candidate', () => {
  const all = () => ({ prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });

  it('acceptance 4: all Done → "Latest v1.2.0 is the candidate → v1.2.0-rc", and Create release is shown', () => {
    const res = run({ repos: [threeTags()], ...all() });
    const api = res.repos[0]!;
    expect(repoRowText(api)).toBe('Latest v1.2.0 is the candidate → v1.2.0-rc');
    expect(repoRowCounts(api)).toBe('3 tickets');
    expect(showCreateRelease(res)).toBe(true);
    expect(defaultTickedRepoIds(res)).toEqual([1]);
  });

  it('acceptance 5: an In PO Review ticket in v1.1.0 → "Latest v1.2.0 · candidate v1.0.0 → v1.0.0-rc"; a fully held repo names the blocker', () => {
    const res = run({
      repos: [threeTags()],
      prs: all().prs,
      tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In PO Review' }), ticket('T3')],
    });
    expect(repoRowText(res.repos[0]!)).toBe('Latest v1.2.0 · candidate v1.0.0 → v1.0.0-rc');
    expect(repoRowCounts(res.repos[0]!)).toBe('1 ticket');
    const held = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['BMD-1048']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])],
      tickets: [ticket('BMD-1048', { done: false, statusName: 'In PO Review' }), ticket('T2'), ticket('T3')],
    });
    expect(held.repos[0]!.status).toBe('blocked');
    expect(repoRowText(held.repos[0]!)).toBe('No candidate: v1.0.0 held by BMD-1048 (In PO Review)');
    expect(repoRowCounts(held.repos[0]!)).toBeNull();
    expect(showCreateRelease(held)).toBe(false);
  });

  it('changes not read yet read as "Reading changes…", never as a ticket blocker', () => {
    const first = repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1], noRange: true }, { name: 'v1.1.0', d: 3, prs: [2] }]);
    const res = run({ repos: [first], ...all() });
    expect(repoRowText(res.repos[0]!)).toBe('Latest v1.1.0 · Reading changes…');
    expect(repoReadingNote(res.repos[0]!)).toBeNull();
    const later = repo(1, 'api', [{ name: 'v1.0.0', d: 1, prs: [1] }, { name: 'v1.1.0', d: 3, prs: [2], noRange: true }]);
    const res2 = run({ repos: [later], ...all() });
    expect(repoRowText(res2.repos[0]!)).toBe('Latest v1.1.0 · candidate v1.0.0 → v1.0.0-rc');
    expect(repoReadingNote(res2.repos[0]!)).toBe('Reading changes…');
  });

  it('acceptance 7: an untracked human PR → still a candidate, a warning naming the PR', () => {
    const res = run({ repos: [threeTags()], prs: [pr(1, 1, ['T1']), pr(2, 1, []), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T3')] });
    expect(repoRowCounts(res.repos[0]!)).toBe('2 tickets · 1 warning');
    expect(res.warnings.map((w) => releaseWarningText(w, res))).toEqual(['api #2 has no ticket: change 2.']);
  });

  it('acceptance 12 / 24: no version tag after the release → "Nothing new since v1.2.0-rc"', () => {
    const r = repo(1, 'api', [
      { name: 'v1.2.0', d: 5, prs: [3] },
      { name: 'v1.2.0-rc', d: 5, commit: 'v1.2.0' },
    ]);
    const res = run({ repos: [r], prs: [pr(3, 1, ['T3'])], tickets: [ticket('T3')] });
    expect(res.repos[0]!.status).toBe('nothing_new');
    expect(repoRowText(res.repos[0]!)).toBe('Nothing new since v1.2.0-rc');
    expect(showCreateRelease(res)).toBe(false);
    expect(repoRowText(run({ repos: [repo(2, 'web', [])] }).repos[0]!)).toBe('No version tags on main yet');
  });

  it('Create release… is HIDDEN when the only candidate is in a repo without push access', () => {
    const res = run({ repos: [threeTags(false)], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1')] });
    expect(res.repos[0]!.candidate).not.toBeNull();
    expect(showCreateRelease(res)).toBe(false);
    expect(showCreateRelease(null)).toBe(false);
  });

  it('no release and no start tag: ONE line names the repos', () => {
    const res = run({ repos: [threeTags()], ...all() });
    expect(noBaselineLine(res.repos, 40)).toBe('No release or start tag yet in api: only the newest 40 tags are checked. Pick a start tag to check fewer.');
  });
});

describe('the expanded row: tags, tickets, the start tag', () => {
  it('each tag lists its tickets (Done or not) and its PRs with no ticket; nothing says "released"', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, []), pr(4, 1, [], { isBot: true })],
      tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In review' })],
    });
    const v11 = res.repos[0]!.tags.find((t) => t.name === 'v1.1.0')!;
    const c = tagContents(res, v11);
    expect(c.tickets.map((x) => [x.ticket.key, ticketMark(x.ticket), x.prs.map((p) => p.number)])).toEqual([
      ['T2', { tone: 'bad', text: 'In review' }, [2]],
    ]);
    const v10 = tagContents(res, res.repos[0]!.tags.find((t) => t.name === 'v1.0.0')!);
    expect(ticketMark(v10.tickets[0]!.ticket)).toEqual({ tone: 'ok', text: 'Done' });
    const v12 = tagContents(res, res.repos[0]!.tags.find((t) => t.name === 'v1.2.0')!);
    expect(v12.untracked.map((p) => p.number)).toEqual([3]);
    expect(ticketMark({ done: false, readState: 'no_access', statusName: null })).toEqual({ tone: 'warn', text: 'could not be read' });
  });

  it('the start tag line: used, superseded by a newer release, moved, gone', () => {
    const r = threeTags();
    r.startTag = { name: 'v1.1.0', sha: sha('v1.1.0'), setBy: 'ada', setAt: day(9) };
    const res = run({ repos: [r] });
    expect(startTagLine(res.repos[0]!)).toBe('Starts from v1.1.0');
    expect(res.repos[0]!.tags.map((t) => t.name)).toEqual(['v1.2.0']);
    r.startTag = { name: 'v1.1.0', sha: sha('old'), setBy: null, setAt: null };
    expect(startTagLine(run({ repos: [r] }).repos[0]!)).toBe('Start tag v1.1.0 moved to another commit, so it is not used.');
    r.startTag = { name: 'v0.9.0', sha: sha('v0.9.0'), setBy: null, setAt: null };
    expect(startTagLine(run({ repos: [r] }).repos[0]!)).toBe('Start tag v0.9.0 is no longer a version tag on main, so it is not used.');
    expect(startTagLine({ startTag: null, baseline: null })).toBeNull();
    expect(
      startTagLine({
        startTag: { name: 'v1.0.0', sha: 'x', setBy: null, setAt: null, problem: null },
        baseline: { name: 'v1.1.0-rc', sha: 'y', committedAt: null, kind: 'release' },
      }),
    ).toBe('Starts from v1.1.0-rc, the last release');
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
