// The folder walk, the remote match and the layout, on a scratch folder that looks like the BNG one:
// sibling clones, a nested clone two levels down, a clone of another workspace (D6), a clone with no
// remote, a linked worktree (`.git` file), node_modules and dot-folders skipped, and a clone too deep.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectKey } from '../../ai/session-litter.js';
import { DEFAULT_ROOT, localFolderProblem, matchClones, planLayout, sandboxPathProblem, type WorkspaceRepo } from './layout.js';
import { scanFolder } from './scan.js';

let root = '';
const clone = (rel: string, url: string | null): void => {
  const d = join(root, rel);
  mkdirSync(join(d, '.git'), { recursive: true });
  writeFileSync(join(d, '.git', 'config'), url ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n` : '[core]\n');
};

const REPOS: WorkspaceRepo[] = [
  { repoId: 1, owner: 'DEFRA', name: 'bng-metric-backend' },
  { repoId: 2, owner: 'DEFRA', name: 'bng-metric-frontend' },
  { repoId: 3, owner: 'DEFRA', name: 'bng-metric-harness' },
  { repoId: 4, owner: 'DEFRA', name: 'bng-library' },
  { repoId: 5, owner: 'DEFRA', name: 'bng-perf-tests' },
];

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'limn-layout-test-')));
  clone('bng-metric-backend', 'git@github.com:DEFRA/bng-metric-backend.git');
  clone('bng-metric-harness', 'https://github.com/defra/BNG-metric-harness');
  clone('libs/vendored/bng-library', 'git@github.com:DEFRA/bng-library.git');
  clone('cdp-app-config', 'git@github.com:DEFRA/cdp-app-config.git');
  clone('old-copy', null);
  // A second clone of the backend, deeper: the shallower one wins.
  clone('archive/bng-metric-backend', 'git@github.com:DEFRA/bng-metric-backend.git');
  // A clone inside a clone is not part of the layout.
  clone('bng-metric-harness/vendor/bng-metric-frontend', 'git@github.com:DEFRA/bng-metric-frontend.git');
  // Too deep (depth 4).
  clone('a/b/c/bng-perf-tests', 'git@github.com:DEFRA/bng-perf-tests.git');
  // Skipped folders.
  clone('node_modules/bng-metric-frontend', 'git@github.com:DEFRA/bng-metric-frontend.git');
  clone('.hidden/bng-metric-frontend', 'git@github.com:DEFRA/bng-metric-frontend.git');
  // A linked worktree of the frontend: `.git` is a file pointing at the main repository's worktree folder.
  clone('.main/frontend', 'git@github.com:DEFRA/bng-metric-frontend.git');
  mkdirSync(join(root, '.main/frontend/.git/worktrees/wt'), { recursive: true });
  writeFileSync(join(root, '.main/frontend/.git/worktrees/wt/commondir'), '../..\n');
  mkdirSync(join(root, 'work/frontend-wt'), { recursive: true });
  writeFileSync(join(root, 'work/frontend-wt/.git'), `gitdir: ${join(root, '.main/frontend/.git/worktrees/wt')}\n`);
  // A symlink to a clone is never followed.
  symlinkSync(join(root, 'bng-metric-backend'), join(root, 'link-to-backend'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the folder walk and the match', () => {
  it('matches by remote, shallowest first, and names the clones outside the workspace', () => {
    const scan = scanFolder(root);
    const m = matchClones(REPOS, scan.clones);
    expect(m.matched).toEqual([
      { repoId: 1, fullName: 'DEFRA/bng-metric-backend', localPath: join(root, 'bng-metric-backend'), alsoAt: [join(root, 'archive/bng-metric-backend')] },
      { repoId: 2, fullName: 'DEFRA/bng-metric-frontend', localPath: join(root, 'work/frontend-wt'), alsoAt: [] },
      { repoId: 3, fullName: 'DEFRA/bng-metric-harness', localPath: join(root, 'bng-metric-harness'), alsoAt: [] },
      { repoId: 4, fullName: 'DEFRA/bng-library', localPath: join(root, 'libs/vendored/bng-library'), alsoAt: [] },
    ]);
    expect(m.missing.map((r) => r.name)).toEqual(['bng-perf-tests']);
    expect(m.outside).toEqual([{ fullName: 'DEFRA/cdp-app-config', localPath: join(root, 'cdp-app-config') }]);
    expect(scan.clones.some((c) => c.dir.includes('node_modules') || c.dir.includes('.hidden') || c.dir.includes('link-to'))).toBe(false);
    expect(scan.truncated).toBe(false);
  });

  it('stops at its limit and says so', () => {
    expect(scanFolder(root, { maxDirs: 3 }).truncated).toBe(true);
  });

  it('finds Claude projects by ENCODING the folders it visits, deeper inside clones only where a key leads', () => {
    mkdirSync(join(root, 'bng-metric-harness/packages/tools/deep'), { recursive: true });
    const keys = new Set([projectKey(join(root, 'bng-metric-harness')), projectKey(join(root, 'bng-metric-harness/packages/tools/deep')), '-Somewhere-else']);
    const scan = scanFolder(root, { projectKeys: keys });
    expect(scan.projectDirs.map((p) => p.dir)).toEqual([join(root, 'bng-metric-harness'), join(root, 'bng-metric-harness/packages/tools/deep')]);
  });
});

describe('the layout', () => {
  const scanAndMatch = () => matchClones(REPOS, scanFolder(root).clones);

  it('mirrors matched clones at their own paths and puts the rest beside them', () => {
    const l = planLayout({ repos: REPOS, folder: root, match: scanAndMatch(), memoryProjects: [] });
    expect(l.root).toBe(root);
    expect(l.repos.map((r) => [r.fullName, r.path, r.placed])).toEqual(
      [
        ['DEFRA/bng-metric-backend', join(root, 'bng-metric-backend'), 'local'],
        ['DEFRA/bng-metric-harness', join(root, 'bng-metric-harness'), 'local'],
        ['DEFRA/bng-perf-tests', join(root, 'bng-perf-tests'), 'folder'],
        ['DEFRA/bng-library', join(root, 'libs/vendored/bng-library'), 'local'],
        ['DEFRA/bng-metric-frontend', join(root, 'work/frontend-wt'), 'local'],
      ].sort((a, b) => (a[1]! < b[1]! ? -1 : 1)),
    );
    expect(l.startDir).toBe(root);
    expect(l.startDirReason).toBe('folder');
    expect(l.outside.map((o) => o.fullName)).toEqual(['DEFRA/cdp-app-config']);
  });

  it('starts in the ticked project with the most memories', () => {
    const memories = [
      { dir: join(root, 'bng-metric-backend'), key: 'k1', memoryCount: 3 },
      { dir: join(root, 'bng-metric-harness'), key: 'k2', memoryCount: 37 },
    ];
    const l = planLayout({ repos: REPOS, folder: root, match: scanAndMatch(), memoryProjects: memories });
    expect([l.startDir, l.startDirReason]).toEqual([join(root, 'bng-metric-harness'), 'memories']);
  });

  it('renames an unmatched repository whose name is taken, and never nests it in another', () => {
    const repos: WorkspaceRepo[] = [
      { repoId: 1, owner: 'acme', name: 'api' },
      { repoId: 2, owner: 'other', name: 'api' },
      { repoId: 3, owner: 'acme', name: 'cdp-app-config' },
    ];
    const match = matchClones(repos, [
      { dir: join(root, 'api'), remote: { host: 'github.com', owner: 'acme', name: 'api', slug: 'acme/api' }, depth: 1 },
      { dir: join(root, 'cdp-app-config'), remote: { host: 'github.com', owner: 'DEFRA', name: 'cdp-app-config', slug: 'defra/cdp-app-config' }, depth: 1 },
    ]);
    const l = planLayout({ repos, folder: root, match, memoryProjects: [] });
    expect(l.repos.find((r) => r.repoId === 2)!.path).toBe(join(root, 'other-api'));
    // An outside clone's path is not reused either.
    expect(l.repos.find((r) => r.repoId === 3)!.path).toBe(join(root, 'acme-cdp-app-config'));
  });

  it('uses the parent when the folder is itself a clone, so the seed files sit outside it', () => {
    const folder = join(root, 'bng-metric-backend');
    const match = matchClones(REPOS, scanFolder(folder).clones);
    const l = planLayout({ repos: REPOS, folder, match, memoryProjects: [] });
    expect(l.root).toBe(root);
    expect(l.repos.find((r) => r.repoId === 1)!.path).toBe(folder);
    expect(l.repos.find((r) => r.repoId === 2)!.path).toBe(join(root, 'bng-metric-frontend'));
  });

  it('with no folder, places every repository under /workspace/<owner>/<name>', () => {
    const l = planLayout({ repos: REPOS.slice(0, 2), folder: null, match: null, memoryProjects: [] });
    expect(l.root).toBe(DEFAULT_ROOT);
    expect(l.repos.map((r) => r.path)).toEqual(['/workspace/DEFRA/bng-metric-backend', '/workspace/DEFRA/bng-metric-frontend']);
    expect([l.startDir, l.startDirReason]).toEqual(['/workspace', 'default']);
  });

  it('falls back to /workspace when the folder cannot exist inside the sandbox', () => {
    const l = planLayout({ repos: REPOS.slice(0, 1), folder: '/usr/src/repos', match: null, memoryProjects: [] });
    expect(l.root).toBe(DEFAULT_ROOT);
    expect(l.notes[0]).toContain('/workspace instead');
  });
});

describe('folder rules', () => {
  const places = { home: '/Users/alex', dataDir: '/Users/alex/.limn' };
  it.each([
    ['relative/path', 'absolute'],
    ['/', 'whole disk'],
    ['/Users/alex', 'home folder'],
    ['/Users', 'home folder'],
    ['/Users/alex/.limn/clones', 'Limn’s own data folder'],
    ['/etc/repos', 'cannot place repositories'],
    ['/home/agent/x', 'cannot place repositories'],
    ['/tmp', 'cannot place repositories'],
    ['/Users/alex/a,b', 'without commas'],
  ])('refuses %s', (folder, words) => {
    expect(localFolderProblem(folder, places)).toContain(words);
  });

  it('accepts a folder under home', () => {
    expect(localFolderProblem('/Users/alex/Projects/DEFRA/bng-fe-be', places)).toBeNull();
    expect(sandboxPathProblem('/home/alex/src')).toBeNull();
  });
});
