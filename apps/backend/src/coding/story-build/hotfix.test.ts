// HOTFIX BUILDS — the pure folds (docs/STORY-BUILD.md § Hotfix builds; docs/RELEASES.md § Hotfix, acceptance
// 25–31). Base selection (the latest release, read-only repositories), the read-only refusal at extraction,
// the push targets and branch names, the moved-branch state, the pair line, the main checkout paths, and the
// seed: a hotfix section only on a hotfix build (every other seed byte-identical).
import { describe, expect, it } from 'vitest';
import {
  hotfixBasesOf,
  hotfixBranchName,
  hotfixBranchState,
  hotfixMainBranchName,
  hotfixPairLine,
  hotfixPatchVerdict,
  hotfixPushTargets,
  hotfixReadOnlyLine,
  latestReleaseTag,
  type HotfixBaseRepoInput,
} from '@pierre-review/shared';
import { mainCheckoutPaths } from '../../sandbox/workspace/hotfix.js';
import { hotfixSeedOf } from '../../sandbox/workspace/index.js';
import { buildSeed, type SeedInput } from '../../sandbox/workspace/seed.js';
import { planBuildInstruction } from '../../sandbox/session/plan.js';
import { parseStoryBuildBaseRef, storyBuildMainRef, storyBuildRefKey } from './base-refs.js';

const SETTINGS = { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' };
const d = (s: string): Date => new Date(`${s}T12:00:00Z`);
const tag = (name: string, sha: string, day: string, taggedAt: string | null = null) => ({ name, sha: sha.repeat(40).slice(0, 40), committedAt: d(day), taggedAt: taggedAt ? d(taggedAt) : null });

const REPOS: HotfixBaseRepoInput[] = [
  { repoId: 2, fullName: 'acme/web', defaultBranch: 'main', tags: [tag('v1.8.1', 'c', '2026-11-01'), tag('v1.8.2', 'd', '2026-11-10'), tag('v1.8.2-rc', 'd', '2026-11-12')] },
  { repoId: 1, fullName: 'acme/api', defaultBranch: 'main', tags: [tag('v2.3.0-rc', 'a', '2026-10-01'), tag('v2.4.0', 'b', '2026-11-11'), tag('v2.4.0-rc', 'b', '2026-11-12')] },
  { repoId: 3, fullName: 'acme/worker', defaultBranch: 'trunk', tags: [tag('v0.1.0', 'e', '2026-11-01')] },
];

describe('hotfix bases (acceptance 25)', () => {
  it('25: each repository starts at its latest release; a repository without one is read only', () => {
    const r = hotfixBasesOf(REPOS, SETTINGS);
    expect(r.configured).toBe(true);
    expect(r.offered).toBe(true);
    expect(r.repos.map((x) => x.fullName)).toEqual(['acme/api', 'acme/web', 'acme/worker']);
    expect(r.repos[0]).toMatchObject({ release: { tagName: 'v2.4.0-rc', sha: 'b'.repeat(40), kind: 'release' }, hotfixBranch: 'hotfix/v2.4.0-rc' });
    expect(r.repos[1]).toMatchObject({ release: { tagName: 'v1.8.2-rc', kind: 'release' }, hotfixBranch: 'hotfix/v1.8.2-rc' });
    expect(r.repos[2]).toMatchObject({ release: null, hotfixBranch: null, defaultBranch: 'trunk' });
  });

  it('1: without both suffixes "Treat as a hotfix" is not offered and no repository has a base', () => {
    const r = hotfixBasesOf(REPOS, { releaseSuffix: '-rc', hotfixSuffix: null });
    expect(r.configured).toBe(false);
    expect(r.offered).toBe(false);
    expect(r.repos.every((x) => x.release == null)).toBe(true);
  });

  it('not offered when no repository has a release yet', () => {
    expect(hotfixBasesOf([REPOS[2]!], SETTINGS).offered).toBe(false);
  });

  it('30: a hand-pushed hotfix tag on the hotfix branch becomes the latest release; the next hotfix bases on it', () => {
    const api = { ...REPOS[1]!, tags: [...REPOS[1]!.tags, tag('v2.4.1-hotfix', 'f', '2026-11-14')] };
    const r = hotfixBasesOf([api], SETTINGS);
    expect(r.repos[0]!.release).toMatchObject({ tagName: 'v2.4.1-hotfix', kind: 'hotfix', sha: 'f'.repeat(40) });
    expect(r.repos[0]!.hotfixBranch).toBe('hotfix/v2.4.1-hotfix');
  });

  it('latest release: ties on the commit date go to the later tag creation', () => {
    const tags = [tag('v1.0.0-rc', 'a', '2026-11-01', '2026-11-02'), tag('v1.0.0-hotfix', 'a', '2026-11-01', '2026-11-03')];
    expect(latestReleaseTag(tags, SETTINGS)?.tag.name).toBe('v1.0.0-hotfix');
    expect(latestReleaseTag([tag('v1.0.0', 'a', '2026-11-01')], SETTINGS)).toBeNull();
  });
});

describe('read-only refusal at extraction (acceptance 25)', () => {
  it('a change in a read-only repository is refused, never stored', () => {
    expect(hotfixPatchVerdict({ readOnly: true, patch: 'diff --git a/x b/x\n' })).toBe('refused');
    expect(hotfixPatchVerdict({ readOnly: true, patch: '' })).toBe('empty');
    expect(hotfixPatchVerdict({ readOnly: false, patch: 'diff --git a/x b/x\n' })).toBe('store');
    expect(hotfixReadOnlyLine('acme/worker')).toBe('acme/worker has no release yet, so it is read only in this hotfix build. Its changes were not kept.');
  });
});

describe('push targets and branch names (acceptance 28, 29)', () => {
  it('28: PR 1 <KEY> → hotfix/<tag>; PR 2 <KEY>-main → the default branch', () => {
    expect(hotfixBranchName('v2.4.0-rc')).toBe('hotfix/v2.4.0-rc');
    expect(hotfixMainBranchName('PLAT-290')).toBe('PLAT-290-main');
    expect(hotfixPushTargets({ branch: 'PLAT-290', tagName: 'v2.4.0-rc', defaultBranch: 'main' })).toEqual({
      release: { head: 'PLAT-290', base: 'hotfix/v2.4.0-rc' },
      main: { head: 'PLAT-290-main', base: 'main' },
    });
  });

  it('29: the hotfix branch is missing, at the release commit, or moved past it', () => {
    const rel = 'a'.repeat(40);
    expect(hotfixBranchState(null, rel)).toBe('missing');
    expect(hotfixBranchState(rel, rel)).toBe('at_release');
    expect(hotfixBranchState('b'.repeat(40), rel)).toBe('moved');
  });

  it('28: each body links the other', () => {
    expect(hotfixPairLine('main', { tagName: 'v2.4.0-rc', defaultBranch: 'main', other: { number: 41, url: 'https://github.com/acme/api/pull/41' } })).toBe(
      '**Hotfix:** the same fix for the release v2.4.0-rc is [#41](https://github.com/acme/api/pull/41).',
    );
    expect(hotfixPairLine('release', { tagName: 'v2.4.0-rc', defaultBranch: 'main', other: { number: 42, url: 'javascript:alert(1)' } })).toBe('**Hotfix:** the same fix for main is #42.');
    expect(hotfixPairLine('release', { tagName: 'v2.4.0-rc', defaultBranch: 'main', other: null })).toContain('follows in its own pull request');
  });
});

describe('the main checkout (acceptance 26)', () => {
  it('26: the main checkout sits beside the release checkout, never on another repository', () => {
    const layout = {
      repos: [
        { repoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api', path: '/work/code/api', placed: 'local' as const },
        { repoId: 2, owner: 'acme', name: 'api.main', fullName: 'acme/api.main', path: '/work/code/api.main', placed: 'local' as const },
        { repoId: 3, owner: 'acme', name: 'web', fullName: 'acme/web', path: '/work/code/web', placed: 'local' as const },
      ],
    };
    const paths = mainCheckoutPaths(layout, new Set([1, 3]));
    expect(paths.get(1)).toBe('/work/code/api.main-2');
    expect(paths.get(3)).toBe('/work/code/web.main');
    expect(paths.has(2)).toBe(false);
  });

  it('the main pin shares the repository\'s sweep key', () => {
    const ref = storyBuildMainRef(12, 3);
    expect(ref).toBe('refs/pierre/story-build/12/main/3');
    expect(storyBuildRefKey(parseStoryBuildBaseRef(ref)!)).toBe('12/3');
  });
});

describe('the seed (one fold, sandbox/workspace/seed.ts)', () => {
  const base: SeedInput = {
    layout: {
      root: '/workspace',
      folder: null,
      repos: [
        { repoId: 1, owner: 'acme', name: 'api', fullName: 'acme/api', path: '/workspace/acme/api', placed: 'default' },
        { repoId: 3, owner: 'acme', name: 'worker', fullName: 'acme/worker', path: '/workspace/acme/worker', placed: 'default' },
      ],
      startDir: '/workspace',
      startDirReason: 'default',
      memoryProjects: [],
      outside: [],
      notes: [],
    },
    bases: new Map([
      [1, { sha: 'b'.repeat(40), label: 'the release v2.4.0-rc', note: null }],
      [3, { sha: 'e'.repeat(40), label: 'main', note: 'Read only in this hotfix build: no release yet.' }],
    ]),
    branch: 'PLAT-290',
    ticket: {
      ident: 'jira:https://acme.atlassian.net#PLAT-290',
      key: 'PLAT-290',
      title: 'Refund rounding',
      url: null,
      description: 'Fix the rounding.',
      acceptanceCriteriaText: 'Refunds round half up.',
      criteria: [{ n: 1, text: 'Refunds round half up.' }],
      criteriaSource: 'ticket_review',
      openPoints: [],
      comments: null,
      prs: [],
      gaps: null,
      fresh: true,
      readAt: '2026-11-14T09:00:00.000Z',
      acLocation: { kind: 'none' },
    },
    mode: 'implement',
    memories: [],
    userClaudeMd: null,
    folderClaudeMd: null,
    skills: [],
    services: null,
    planFirst: true,
  };

  it('an ordinary build: no hotfix words (the seed is byte-identical with or without the key)', () => {
    const plain = buildSeed(base);
    const withNull = buildSeed({ ...base, hotfix: null });
    expect(withNull.claudeMd).toBe(plain.claudeMd);
    expect(withNull.agentsMd).toBe(plain.agentsMd);
    expect(withNull.systemPrompts).toEqual(plain.systemPrompts);
    expect(plain.claudeMd).not.toContain('## Hotfix');
  });

  it('25 + 26: a hotfix build names the release and main checkouts and the read-only repositories', () => {
    const hotfix = hotfixSeedOf(
      { repos: [{ repoId: 1, fullName: 'acme/api', path: '/workspace/acme/api', sha: 'b'.repeat(40) }, { repoId: 3, fullName: 'acme/worker', path: '/workspace/acme/worker', sha: 'e'.repeat(40) }] },
      { repos: [{ repoId: 1, fullName: 'acme/api', path: '/workspace/acme/api.main', sha: 'c'.repeat(40) }] },
      { mainBases: new Map(), releases: new Map([[1, { tagName: 'v2.4.0-rc', hotfixBranch: 'hotfix/v2.4.0-rc' }]]), mainLabels: new Map([[1, 'main']]) },
    );
    expect(hotfix.repos[1]).toMatchObject({ fullName: 'acme/worker', release: null, main: null });
    const seed = buildSeed({ ...base, hotfix });
    for (const md of [seed.claudeMd, seed.agentsMd]) {
      expect(md).toContain('## Hotfix');
      expect(md).toContain('acme/api: `/workspace/acme/api` at the release v2.4.0-rc.');
      expect(md).toContain('acme/api: `/workspace/acme/api.main` at main (ccccccc).');
      expect(md).toContain('acme/worker: `/workspace/acme/worker`');
      expect(md).toContain('Limn refuses their changes');
    }
    expect(seed.systemPrompts.claude).toContain('This is a hotfix build');
  });

  it('the build turn: unchanged for an ordinary build, the release fix then the port for a hotfix', () => {
    const o = { revision: 2, root: '/workspace', ticketChanged: false, extra: null, stack: [{ key: 'P1', fullName: 'acme/api', branch: 'PLAT-290', stackIndex: 1 }] };
    const plain = planBuildInstruction(o);
    expect(planBuildInstruction({ ...o, hotfix: null })).toBe(plain);
    expect(plain).toContain('- P1: `PLAT-290` in acme/api');
    const hf = planBuildInstruction({ ...o, hotfix: { branch: 'PLAT-290' } });
    expect(hf).toContain('in BOTH checkouts');
    expect(hf).toContain('Port the fix to the main checkout');
    expect(hf).not.toContain('- P1: `PLAT-290` in acme/api');
  });
});
