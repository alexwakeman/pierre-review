// CREATING A RELEASE — the shared PURE half (packages/shared/src/release-write.ts): the snapshot and
// its change list (acceptance 18, 21), the notes (acceptance 32, 33, 47), the comment's exact lines, the
// summary's digit gate. docs/RELEASES.md § Releases tab, § Release notes.
import { describe, expect, it } from 'vitest';
import {
  cleanStorySummary,
  foldReleaseCheck,
  jiraWikiPlain,
  notesText,
  releaseCommentLines,
  releaseCommentWiki,
  releaseDateWords,
  releaseFinalState as finalState,
  releaseNotesDocument,
  releaseNotesInputOf,
  releaseNotesSection,
  releaseSnapshotChanges,
  releaseSnapshotOf,
  releaseStepLines,
  releaseTagMessage,
  type ReleaseCheckInput,
} from '@pierre-review/shared';

const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));
const sha = (c: string) => c.padEnd(40, '0');
const API = 1;
const WEB = 2;
const ident = (key: string) => `jira:https://acme.atlassian.net#${key}`;

function input(over: { done?: Record<string, boolean>; webTagged?: boolean; released?: boolean; openPrs?: ReleaseCheckInput['openPrs'] } = {}): ReleaseCheckInput {
  const done = { 'PLAT-1': true, 'PLAT-2': true, 'PLAT-3': true, ...(over.done ?? {}) };
  // `released`: an earlier release (v0.9.0-rc on v0.9.0) is the baseline, so the scope is everything since.
  const repo = (repoId: number, name: string, prIds: number[]) => ({
    repoId,
    name,
    fullName: `acme/${name}`,
    writable: true,
    tags: [
      ...(over.released === true
        ? [
            { name: 'v0.9.0', sha: sha(`${name}0`), committedAt: day(1), taggedAt: null, onDefaultBranch: true, moved: false },
            { name: 'v0.9.0-rc', sha: sha(`${name}0`), committedAt: day(1), taggedAt: day(2), onDefaultBranch: true, moved: false },
          ]
        : []),
      { name: 'v1.0.0', sha: sha(`${name}1`), committedAt: day(5), taggedAt: null, onDefaultBranch: true, moved: false },
    ],
    ranges: [
      ...(over.released === true
        ? [
            { tagName: 'v0.9.0', sha: sha(`${name}0`), baseTagName: null, baseSha: null, prIds: [], unresolvedPrNumbers: [], unmatchedCommits: 0 },
            { tagName: 'v0.9.0-rc', sha: sha(`${name}0`), baseTagName: 'v0.9.0', baseSha: sha(`${name}0`), prIds: [], unresolvedPrNumbers: [], unmatchedCommits: 0 },
          ]
        : []),
      {
        tagName: 'v1.0.0',
        sha: sha(`${name}1`),
        baseTagName: over.released === true ? 'v0.9.0-rc' : null,
        baseSha: over.released === true ? sha(`${name}0`) : null,
        prIds,
        unresolvedPrNumbers: [],
        unmatchedCommits: 0,
      },
    ],
  });
  const pr = (id: number, repoId: number, number: number, title: string, tickets: string[], isBot = false) => ({
    id,
    repoId,
    number,
    title,
    url: `https://github.com/acme/${repoId === API ? 'api' : 'web'}/pull/${number}`,
    isBot,
    mergedAt: day(4),
    ticketIdents: tickets.map(ident),
  });
  return {
    settings: { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' },
    repos: [repo(API, 'api', [10, 11, 12, 13]), repo(WEB, 'web', over.webTagged === false ? [21] : [20, 21])],
    prs: [
      pr(10, API, 10, 'Login via SSO', ['PLAT-1']),
      pr(11, API, 11, 'Rate limit the export', ['PLAT-2']),
      pr(12, API, 12, 'Fix typo @someone noticed', []),
      pr(13, API, 13, 'Bump lodash', [], true),
      pr(20, WEB, 20, 'SSO button', ['PLAT-1']),
      pr(21, WEB, 21, 'Dark mode', ['PLAT-3']),
    ],
    openPrs: over.openPrs ?? [],
    tickets: Object.entries(done).map(([key, d]) => ({
      ident: ident(key),
      key,
      title: `Story ${key.slice(5) === '1' ? 'one' : key.slice(5) === '2' ? 'two' : 'three'}`,
      url: `https://acme.atlassian.net/browse/${key}`,
      statusName: d ? 'Done' : 'In review',
      done: d,
      readState: 'ok' as const,
    })),
  };
}

describe('the snapshot and its changes', () => {
  it('snapshot: each ticked repo with a candidate, and the tickets it ships', () => {
    const res = foldReleaseCheck(input());
    expect(releaseSnapshotOf(res, [API, WEB])).toEqual({
      repos: [
        { repoId: API, tagName: 'v1.0.0', sha: sha('api1') },
        { repoId: WEB, tagName: 'v1.0.0', sha: sha('web1') },
      ],
      tickets: ['PLAT-1', 'PLAT-2', 'PLAT-3'].map((key) => ({ ident: ident(key), key })),
    });
  });

  it('no change → nothing to say', () => {
    const res = foldReleaseCheck(input());
    expect(releaseSnapshotChanges(releaseSnapshotOf(res, [API, WEB]), res)).toEqual([]);
  });

  it('acceptance 21: a ticket that left Done since the dialog opened is named, with its status', () => {
    const before = releaseSnapshotOf(foldReleaseCheck(input()), [API, WEB]);
    const after = foldReleaseCheck(input({ done: { 'PLAT-2': false } }));
    const changes = releaseSnapshotChanges(before, after);
    expect(changes).toContain('PLAT-2 “Story two” is In review.');
    expect(changes).toContain('api has no tag that can be released now.');
  });

  it('acceptance 21: a pull request opened for a shipped ticket since the dialog opened is named', () => {
    const before = releaseSnapshotOf(foldReleaseCheck(input()), [API, WEB]);
    const after = foldReleaseCheck(input({ openPrs: [{ repoId: WEB, repoName: 'web', number: 77, url: 'https://github.com/acme/web/pull/77', prId: 7, ticketIdents: [ident('PLAT-3')] }] }));
    const changes = releaseSnapshotChanges(before, after);
    expect(changes).toContain('PLAT-3 “Story three” has an open pull request in web (#77).');
    expect(changes).toContain('web has no tag that can be released now.');
  });

  it('a moved version tag and an unread ticket are changes', () => {
    const res = foldReleaseCheck(input());
    const changes = releaseSnapshotChanges(releaseSnapshotOf(res, [API]), res, {
      liveShaChanged: [{ repoId: API, tagName: 'v1.0.0' }],
      unread: [{ ident: ident('PLAT-2'), key: 'PLAT-2' }],
    });
    expect(changes).toEqual(['PLAT-2 could not be read again from the tracker.', 'v1.0.0 in api now points at another commit.']);
  });
});

describe('release notes — code-built, one section per repo', () => {
  it('acceptance 32 (AI off): the complete document minus summaries — stories, PRs per repo, untracked, bot changes', () => {
    const res = foldReleaseCheck(input());
    const facts = releaseNotesInputOf(res, [API, WEB]);
    const api = releaseNotesSection(facts[0]!);
    expect(api).toContain('## api v1.0.0-rc');
    expect(api).toContain('Built from v1.0.0.');
    // No release yet: everything up to the candidate tag ships, and the notes say so.
    expect(api).toContain('First release: everything up to this tag.');
    expect(api).toContain('### Stories\n');
    expect(api).toContain('#### [PLAT-1](https://acme.atlassian.net/browse/PLAT-1) Story one');
    // The story's PRs in every repo of the release.
    expect(api).toContain('- [api #10](https://github.com/acme/api/pull/10) Login via SSO');
    expect(api).toContain('- [web #20](https://github.com/acme/web/pull/20) SSO button');
    expect(api).toContain('### Untracked changes');
    // An @mention in a title cannot notify anyone.
    expect(api).toContain('Fix typo `@someone` noticed');
    expect(api).toContain('### Dependency and bot changes');
    expect(api).toContain('Bump lodash');
    const doc = releaseNotesDocument(facts.map(releaseNotesSection));
    expect(doc.indexOf('## api')).toBeLessThan(doc.indexOf('## web'));
  });

  it('acceptance 47: with a release, the notes list everything since it (no "First release" line)', () => {
    const res = foldReleaseCheck(input({ released: true }));
    expect(res.repos[0]!.baseline?.name).toBe('v0.9.0-rc');
    const api = releaseNotesSection(releaseNotesInputOf(res, [API])[0]!);
    expect(api).toContain('### Stories\n');
    expect(api).not.toContain('First release');
    expect(api).toContain('Login via SSO');
  });

  it('a ticket the tracker could not give is in the notes (by key), but not commented on', () => {
    const base = input();
    base.tickets = base.tickets.map((t) => (t.key === 'PLAT-3' ? { ...t, readState: 'not_found' as const, done: false, title: null, statusName: null } : t));
    const res = foldReleaseCheck(base);
    const web = releaseNotesSection(releaseNotesInputOf(res, [WEB]).find((r) => r.repoName === 'web')!);
    expect(web).toContain('#### [PLAT-3](https://acme.atlassian.net/browse/PLAT-3)');
    expect(releaseSnapshotOf(res, [WEB]).tickets.map((t) => t.key)).toEqual(['PLAT-1']);
  });

  it('acceptance 32 (AI on): a summary per story, inside its story', () => {
    const res = foldReleaseCheck(input());
    const facts = releaseNotesInputOf(res, [API], new Map([[ident('PLAT-2'), 'Exports no longer overload the service.']]));
    const api = releaseNotesSection(facts[0]!);
    expect(api).toMatch(/Story two\n\nExports no longer overload the service\.\n\n- \[api #11\]/);
  });

  it('acceptance 33: no output contains the product name', () => {
    const res = foldReleaseCheck(input());
    const facts = releaseNotesInputOf(res, [API, WEB]);
    const out = [
      ...facts.map(releaseNotesSection),
      releaseTagMessage('api', 'v1.0.0-rc', 'v1.0.0'),
      releaseCommentWiki({ approverName: 'Ada', at: day(14), tags: [{ repoName: 'api', releaseTagName: 'v1.0.0-rc' }], notesUrl: 'https://github.com/x' }),
    ].join('\n');
    expect(out).not.toMatch(/limn|ensemble/i);
  });

  it('notesText escapes markdown that could link, style or embed HTML', () => {
    expect(notesText('a [b](c) <img> *x*')).toBe('a \\[b\\](c) \\<img\\> \\*x\\*');
  });
});

describe('the story summary — the D4 digit gate', () => {
  it('acceptance 32: a summary with a model-written number is refused', () => {
    expect(cleanStorySummary('Adds 3 new export formats.')).toBeNull();
    expect(cleanStorySummary('Ships in v２.')).toBeNull();
    expect(cleanStorySummary('Ships with Ⅻ fixes.')).toBeNull();
  });
  it('acceptance 33: a summary naming the product is refused', () => {
    expect(cleanStorySummary('Ensemble found this.')).toBeNull();
    expect(cleanStorySummary('Limn found this.')).toBeNull();
  });
  it('one paragraph, trimmed', () => {
    expect(cleanStorySummary('  "Exports are faster.\n\nThey also stream."  ')).toBe('Exports are faster. They also stream.');
    expect(cleanStorySummary('')).toBeNull();
  });
});

describe('the tracker comment — exactly the spec', () => {
  it('three lines: approver and date, the release tags, the notes link', () => {
    const f = {
      approverName: 'Ada Lovelace',
      at: new Date(2026, 10, 14, 12),
      tags: [
        { repoName: 'api', releaseTagName: 'v2.4.0-rc' },
        { repoName: 'web', releaseTagName: 'v1.8.2-rc' },
      ],
      notesUrl: 'https://github.com/acme/api/releases/tag/v2.4.0-rc',
    };
    expect(releaseCommentLines(f)).toEqual([
      'Approved for release by Ada Lovelace on 14 Nov 2026.',
      'api v2.4.0-rc · web v1.8.2-rc',
      'Release notes: https://github.com/acme/api/releases/tag/v2.4.0-rc',
    ]);
    // Jira wiki: the hyphens are escaped (never strikethrough), the link stays bare.
    expect(releaseCommentWiki(f).split('\n')).toEqual([
      'Approved for release by Ada Lovelace on 14 Nov 2026.',
      'api v2.4.0\\-rc · web v1.8.2\\-rc',
      'Release notes: https://github.com/acme/api/releases/tag/v2.4.0-rc',
    ]);
  });
  it('a name cannot mention anyone or open a macro', () => {
    expect(jiraWikiPlain('[~admin] {html}')).toBe('\\[\\~admin\\] \\{html\\}');
  });
  it('dates read "14 Nov 2026"', () => {
    expect(releaseDateWords(new Date(2026, 8, 3, 12))).toBe('3 Sep 2026');
  });
});

describe('the per-step result list and the final state', () => {
  const item = (repoName: string, tagState: 'done' | 'failed' | 'refused', prereleaseState: 'done' | 'skipped' | 'failed') => ({
    repoId: 1,
    repoName,
    versionTag: 'v1.0.0',
    sha: sha('a'),
    releaseTagName: 'v1.0.0-rc',
    tagState,
    prereleaseState,
    releaseUrl: null,
    error: tagState === 'failed' ? 'GitHub did not answer' : null,
  });
  it('acceptance 22: a failed repo is said, and its tickets say why they got no comment', () => {
    const d = {
      items: [item('api', 'done', 'done'), item('web', 'failed', 'skipped')],
      comments: [
        { ticketKey: 'PLAT-1', state: 'skipped' as const, error: 'web was not tagged' },
        { ticketKey: 'PLAT-2', state: 'posted' as const, error: null },
      ],
    };
    expect(releaseStepLines(d)).toEqual([
      { ok: true, text: 'Tagged api v1.0.0-rc.' },
      { ok: false, text: 'Tagging web v1.0.0-rc failed: GitHub did not answer' },
      { ok: true, text: 'Published the pre-release api v1.0.0-rc.' },
      { ok: false, text: 'No pre-release for web v1.0.0-rc, because it was not tagged.' },
      { ok: false, text: 'No comment on PLAT-1: web was not tagged.' },
      { ok: true, text: 'Commented on PLAT-2.' },
    ]);
    expect(finalState(d)).toBe('partial');
  });
  it('every step worked → done; no tag landed → failed; another tracker is not a failure', () => {
    expect(finalState({ items: [item('api', 'done', 'done')], comments: [{ ticketKey: 'X-1', state: 'skipped', error: 'comments on Linear are not supported yet' }] })).toBe('done');
    expect(finalState({ items: [item('api', 'refused', 'skipped')], comments: [] })).toBe('failed');
  });
});
