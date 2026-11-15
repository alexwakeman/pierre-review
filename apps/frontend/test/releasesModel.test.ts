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
  releaseTagsLine,
  releaseWarningText,
  releaseWordsContext,
  repoRowText,
  showCreateRelease,
  ticketRepoMark,
  ticketsPanelRows,
} from '../src/components/Sprint/releasesModel.js';
import { releaseSuffixChangeWarning } from '../src/components/settings/releasesSectionModel.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const sha = (c: string) => c.padEnd(40, '0');

interface TagSpec {
  name: string;
  d: number;
  prs?: number[];
  commit?: string;
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
  const ranges = sorted.map(({ t, s }, i) => {
    const base = i > 0 ? sorted[i - 1]!.t : null;
    return {
      tagName: t.name,
      sha: t.sha,
      baseTagName: base?.name ?? null,
      baseSha: base?.sha ?? null,
      method: base == null ? ('history' as const) : ('compare' as const),
      prIds: s.prs ?? [],
      unresolvedPrNumbers: [],
      unmatchedCommits: 0,
      truncated: false,
    };
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
  return foldReleaseCheck({ settings: SETTINGS, repos: [], prs: [], tickets: [], acceptedRepos: [], ...parts });
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

describe('repo rows', () => {
  it('acceptance 4: all Done → "v1.2.0 → v1.2.0-rc · 3 tickets", and Create release is shown', () => {
    const res = run({ repos: [threeTags()], prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T2'), ticket('T3')] });
    const api = res.repos[0]!;
    expect(repoRowText(api, releaseWordsContext(res))).toBe('v1.2.0 → v1.2.0-rc · 3 tickets');
    expect(showCreateRelease(res)).toBe(true);
    expect(defaultTickedRepoIds(res)).toEqual([1]);
  });

  it('acceptance 5: an In review ticket in v1.1.0 → "v1.0.0 → v1.0.0-rc", and a fully held repo names the blocker', () => {
    const res = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['T1']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])],
      tickets: [ticket('T1'), ticket('T2', { done: false, statusName: 'In review' }), ticket('T3')],
    });
    expect(repoRowText(res.repos[0]!, releaseWordsContext(res))).toBe('v1.0.0 → v1.0.0-rc · 1 ticket');
    const held = run({
      repos: [threeTags()],
      prs: [pr(1, 1, ['PLAT-301']), pr(2, 1, ['T2']), pr(3, 1, ['T3'])],
      tickets: [ticket('PLAT-301', { done: false, statusName: 'In review' }), ticket('T2'), ticket('T3')],
    });
    expect(held.repos[0]!.status).toBe('blocked');
    expect(repoRowText(held.repos[0]!, releaseWordsContext(held))).toBe('No candidate: v1.0.0 held by PLAT-301 (In review)');
    expect(showCreateRelease(held)).toBe(false);
  });

  it('acceptance 7: an untracked human PR → still a candidate, a warning naming the PR', () => {
    const res = run({ repos: [threeTags()], prs: [pr(1, 1, ['T1']), pr(2, 1, []), pr(3, 1, ['T3'])], tickets: [ticket('T1'), ticket('T3')] });
    expect(repoRowText(res.repos[0]!, releaseWordsContext(res))).toBe('v1.2.0 → v1.2.0-rc · 2 tickets · 1 warning');
    expect(res.warnings.map((w) => releaseWarningText(w, res))).toEqual(['api #2 has no ticket: change 2.']);
  });

  it('acceptance 12 / 24: no version tag after the release → "Nothing new since v1.2.0-rc"', () => {
    const r = repo(1, 'api', [
      { name: 'v1.2.0', d: 5, prs: [3] },
      { name: 'v1.2.0-rc', d: 5, commit: 'v1.2.0' },
    ]);
    const res = run({ repos: [r], prs: [pr(3, 1, ['T3'])], tickets: [ticket('T3')] });
    expect(res.repos[0]!.status).toBe('nothing_new');
    expect(repoRowText(res.repos[0]!, releaseWordsContext(res))).toBe('Nothing new since v1.2.0-rc');
    expect(showCreateRelease(res)).toBe(false);
    expect(repoRowText(run({ repos: [repo(2, 'web', [])] }).repos[0]!, releaseWordsContext(res))).toBe('No version tags yet');
  });

  it('Create release… is HIDDEN when the only candidate is in a repo without push access', () => {
    const res = run({ repos: [threeTags(false)], prs: [pr(1, 1, ['T1'])], tickets: [ticket('T1')] });
    expect(res.repos[0]!.candidate).not.toBeNull();
    expect(showCreateRelease(res)).toBe(false);
    expect(showCreateRelease(null)).toBe(false);
  });
});

describe('across repos — the tickets panel and the dialog', () => {
  const api = () =>
    repo(1, 'api', [
      { name: 'v2.3.0', d: 1, prs: [10] },
      { name: 'v2.4.0', d: 5, prs: [11] },
    ]);
  const web = (withV19: boolean) =>
    repo(2, 'web', [{ name: 'v1.8.0', d: 2, prs: [20] }, ...(withV19 ? [{ name: 'v1.9.0', d: 8, prs: [21] }] : [])]);
  const prs = () => [
    pr(10, 1, ['PLAT-100']),
    pr(11, 1, ['PLAT-290'], { mergedAt: day(4) }),
    pr(20, 2, ['PLAT-200']),
    pr(21, 2, ['PLAT-290'], { mergedAt: day(6) }),
  ];
  const tickets = () => [ticket('PLAT-100'), ticket('PLAT-200'), ticket('PLAT-290')];

  it('acceptance 14: PLAT-290 is held first in the panel, marked "merged after candidate" in both repos', () => {
    const res = run({ repos: [api(), web(false)], prs: prs(), tickets: tickets() });
    const rows = ticketsPanelRows(res);
    expect(rows[0]!.key).toBe('PLAT-290');
    expect(rows[0]!.repos.map((r) => ticketRepoMark(r.state))).toEqual([
      { tone: 'bad', text: 'merged after candidate' },
      { tone: 'bad', text: 'merged after candidate' },
    ]);
    expect(rows.slice(1).map((t) => t.key)).toEqual(['PLAT-100', 'PLAT-200']);
  });

  it('acceptance 15: after the web tag, PLAT-290 reads "in candidate" in both', () => {
    const res = run({ repos: [api(), web(true)], prs: prs(), tickets: tickets() });
    const t = ticketsPanelRows(res).find((x) => x.key === 'PLAT-290')!;
    expect(t.repos.map((r) => ticketRepoMark(r.state).text)).toEqual(['in candidate', 'in candidate']);
    expect(releaseTagsLine(res, [1, 2])).toBe('api v2.4.0-rc · web v1.9.0-rc');
  });

  it('acceptance 17: a linked repo with no PR → a warning mark and sentence, never a stop', () => {
    const worker = repo(3, 'worker', [{ name: 'v0.1.0', d: 1, prs: [] }]);
    const res = run({ repos: [api(), web(true), worker], prs: prs(), tickets: tickets(), acceptedRepos: [{ ident: 'PLAT-290', repoId: 3 }] });
    expect(ticketRepoMark('linked_no_pr')).toEqual({ tone: 'warn', text: 'linked, no PR' });
    expect(res.warnings.map((w) => releaseWarningText(w, res))).toEqual(['PLAT-290 is linked to worker, which has no pull request for it.']);
    expect(confirmStops(res, [1, 2])).toEqual([]);
  });

  it('acceptance 18: unticking web when PLAT-290 needs it → Confirm stopped, PLAT-290 named', () => {
    const res = run({ repos: [api(), web(true)], prs: prs(), tickets: tickets() });
    expect(confirmStops(res, [1, 2])).toEqual([]);
    expect(confirmStops(res, [1])).toEqual(['PLAT-290 needs web too: it would ship in part.']);
    expect(confirmStops(res, [])).toEqual(['Tick at least one repository.']);
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
