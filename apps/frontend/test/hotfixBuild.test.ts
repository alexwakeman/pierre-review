// HOTFIX BUILDS in the build tab: the pure words (lib/hotfix.ts) over REAL results of the shared fold
// (`hotfixBasesOf`). docs/RELEASES.md § Acceptance checks — numbers in the test names.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/hotfixBuild.test.ts
import { describe, expect, it } from 'vitest';
import { hotfixPortClaimOf, hotfixPortOf, hotfixBasesOf, type StoryBuildRepo, type StoryBuildRepoHotfix } from '@pierre-review/shared';
import { HOTFIX_DIFF_LABEL, hotfixBaseLine, hotfixDiffTargets, hotfixMovedLine, hotfixPortView, hotfixPushWords } from '../src/lib/hotfix.js';
import { canPushRepo } from '../src/lib/storyBuild.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const at = (s: string): Date => new Date(`${s}T12:00:00Z`);

const hf = (over: Partial<StoryBuildRepoHotfix> = {}): StoryBuildRepoHotfix => ({
  tagName: 'v2.4.0-rc',
  readOnly: false,
  hotfixBranch: 'hotfix/v2.4.0-rc',
  mainBaseRef: 'main',
  mainBaseSha: 'c'.repeat(40),
  mainStatus: 'ready',
  mainHasPatch: true,
  mainFilesChanged: ['a.ts'],
  mainInsertions: 1,
  mainDeletions: 0,
  mainError: null,
  mainPushedBranch: null,
  mainPushedPrNumber: null,
  mainPushedPrUrl: null,
  mainPushError: null,
  mainPushErrorCode: null,
  branch: null,
  port: { claim: null, flag: null, files: null },
  ...over,
});

type RepoBits = Pick<StoryBuildRepo, 'include' | 'status' | 'hasPatch' | 'pushedPrNumber' | 'hotfix'>;
const repo = (over: Partial<RepoBits> = {}): RepoBits => ({ include: true, status: 'ready', hasPatch: true, pushedPrNumber: null, hotfix: hf(), ...over });

describe('the Start panel base list (acceptance 25)', () => {
  it('25: each repository reads its latest release and both PR bases; one without a release reads read only', () => {
    const r = hotfixBasesOf(
      [
        { repoId: 1, fullName: 'acme/api', defaultBranch: 'main', releasable: true, tags: [{ name: 'v2.4.0-rc', sha: 'b'.repeat(40), committedAt: at('2026-11-12'), taggedAt: null }] },
        { repoId: 3, fullName: 'acme/worker', defaultBranch: 'main', releasable: true, tags: [] },
        { repoId: 4, fullName: 'acme/tests', defaultBranch: 'main', releasable: false, tags: [{ name: 'v9.0.0-rc', sha: 'c'.repeat(40), committedAt: at('2026-11-12'), taggedAt: null }] },
      ],
      SETTINGS,
    );
    expect(r.offered).toBe(true);
    expect(r.repos.map((b) => `${b.fullName} ${hotfixBaseLine(b)}`)).toEqual([
      'acme/api from v2.4.0-rc (12 Nov) → PRs into hotfix/v2.4.0-rc and main',
      'acme/tests not released from this workspace — read only',
      'acme/worker no release yet — read only',
    ]);
  });

  it('1: not offered without both suffixes', () => {
    expect(hotfixBasesOf([], { releaseSuffix: '-rc', hotfixSuffix: null }).offered).toBe(false);
  });
});

describe('the repository card (acceptance 27, 28, 29)', () => {
  it('27: two diffs, "Release fix" and "Main fix", only those with a change', () => {
    expect(hotfixDiffTargets(repo()).map((t) => HOTFIX_DIFF_LABEL[t])).toEqual(['Release fix', 'Main fix']);
    expect(hotfixDiffTargets(repo({ hasPatch: false }))).toEqual(['main']);
    expect(hotfixDiffTargets(repo({ hotfix: hf({ mainHasPatch: false }) }))).toEqual(['release']);
    expect(hotfixDiffTargets(repo({ hotfix: null }))).toEqual(['release']);
  });

  it('28: Push opens both pull requests (drafts by default), or the one left', () => {
    expect(hotfixPushWords(repo(), true)).toBe('Push both as drafts');
    expect(hotfixPushWords(repo(), false)).toBe('Push both');
    expect(hotfixPushWords(repo({ pushedPrNumber: 40 }), true)).toBe('Push as draft');
    // Only a main fix still pushes (the release needed no change).
    expect(canPushRepo(repo({ hasPatch: false }))).toBe(true);
    expect(canPushRepo(repo({ hasPatch: false, hotfix: hf({ mainHasPatch: false }) }))).toBe(false);
  });

  it('29: a moved hotfix branch names the PRs already on it', () => {
    const branch = {
      name: 'hotfix/v2.4.0-rc',
      releaseSha: 'b'.repeat(40),
      created: false,
      movedToSha: 'f'.repeat(40),
      prs: [{ number: 12, title: 'PLAT-201: Fix the totals', url: null }],
      at: '2026-11-15T09:00:00.000Z',
    };
    expect(hotfixMovedLine(branch)).toBe(
      'hotfix/v2.4.0-rc has moved past the release, so your pull request targets the branch as it is now. Already on it: #12 PLAT-201: Fix the totals.',
    );
    expect(hotfixMovedLine({ ...branch, prs: [] })).toContain('No other pull request is open on it.');
    expect(hotfixMovedLine({ ...branch, movedToSha: null, prs: [] })).toBeNull();
    expect(hotfixMovedLine({ ...branch, created: true, movedToSha: null, prs: [] })).toBeNull();
    expect(hotfixMovedLine(null)).toBeNull();
  });

  it('29: a second hotfix off the same release, with the first still open, names the PR on the branch', () => {
    const branch = {
      name: 'hotfix/v2.4.0-rc',
      releaseSha: 'b'.repeat(40),
      created: false,
      movedToSha: null,
      prs: [{ number: 50, title: 'PLAT-201: Fix the totals', url: null }],
      at: '2026-11-15T09:00:00.000Z',
    };
    expect(hotfixMovedLine(branch)).toBe('hotfix/v2.4.0-rc already exists. Already on it: #50 PLAT-201: Fix the totals.');
  });
});

describe('the port report line (acceptance 34–37)', () => {
  const port = (claim: Parameters<typeof hotfixPortClaimOf>[0] | null, mainFiles: string[]) =>
    hotfixPortOf({ claim: claim ? hotfixPortClaimOf(claim) : null, releaseFiles: ['a.ts'], mainFiles, mainChanged: mainFiles.length > 0 });

  it('34: same → "Applied to both", the files compared', () => {
    const v = hotfixPortView(repo({ hotfix: hf({ port: port({ outcome: 'same', reason: 'ignored for same' }, ['a.ts']) }) }));
    expect(v).toEqual({ line: 'Applied to both', outcome: 'same', flag: null, files: 'Both fixes change the same files.' });
  });

  it('35: adapted → the reason after the outcome', () => {
    const v = hotfixPortView(repo({ hotfix: hf({ port: port({ outcome: 'adapted', reason: 'main moved the totals to src/money.ts.' }, ['src/money.ts']) }) }));
    expect(v?.line).toBe('Applied to both, adapted for main — main moved the totals to src/money.ts.');
    expect(v?.files).toBe('The two fixes have no file in common.');
    expect(v?.flag).toBeNull();
  });

  it('36: not_needed with main unchanged → the reason, no flag', () => {
    const v = hotfixPortView(repo({ hotfix: hf({ mainHasPatch: false, port: port({ outcome: 'not_needed', reason: 'The export code was removed in src/export/.' }, []) }) }));
    expect(v).toEqual({ line: 'Not applied to main — The export code was removed in src/export/.', outcome: 'not_needed', flag: null, files: null });
  });

  it('37: a claim the patches contradict is flagged; no claim reads "No report from the agent"', () => {
    expect(hotfixPortView(repo({ hotfix: hf({ port: port({ outcome: 'not_needed', reason: 'gone' }, ['a.ts']) }) }))?.flag).toBe('Says main does not need it, but changed main.');
    expect(hotfixPortView(repo({ hotfix: hf({ mainHasPatch: false, port: port({ outcome: 'same' }, []) }) }))?.flag).toBe('Says it was ported, but main is unchanged.');
    expect(hotfixPortView(repo({ hotfix: hf({ port: port(null, ['a.ts']) }) }))).toEqual({ line: 'No report from the agent', outcome: null, flag: null, files: 'Both fixes change the same files.' });
  });

  it('a read-only repository, or one with no change and no claim, has no line', () => {
    expect(hotfixPortView(repo({ hotfix: hf({ readOnly: true, port: null }) }))).toBeNull();
    expect(hotfixPortView(repo({ hasPatch: false, hotfix: hf({ mainHasPatch: false }) }))).toBeNull();
    expect(hotfixPortView(repo({ hotfix: null }))).toBeNull();
  });
});
