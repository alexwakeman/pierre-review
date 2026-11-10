// FINDING THE READER'S CLONES WITHOUT A FOLDER SETTING (discover.ts). On a scratch disk:
//   • a Claude project key is decoded by walking the disk, so `bng-fe-be` (one folder with hyphens) and
//     `bng/fe/be` (three folders) are told apart;
//   • a multi-repository workspace: EACH repository's own memories are found (keyed by ITS clone), mirrored
//     at the same path, and copied under the SAME key — the key Claude Code computes inside the sandbox;
//   • a team folder (no clone, holds clones) counts; an unrelated project beside them, a clone of another
//     repository, a linked worktree, Limn's own folders and a dotfiles repository in the home folder do not.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectKey } from '../../ai/session-litter.js';
import { resolveWorkspaceLayout, type LayoutPlaces } from './check.js';
import { cloneRootOf, decodeProjectKey, discoverReaderClones, pickReaderFolder } from './discover.js';
import { readerFiles } from './mirror.js';

let base = '';
let home = '';
let places: LayoutPlaces;

const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const clone = (dir: string, slug: string): void => write(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:${slug}.git\n`);
const memory = (dir: string, files: Record<string, string>): void => {
  for (const [name, text] of Object.entries(files)) write(join(places.claude.projectsDir, projectKey(dir), 'memory', name), text);
};
/** A Claude project with no memories (Claude Code ran there; only a transcript). */
const project = (dir: string): void => write(join(places.claude.projectsDir, projectKey(dir), 'session.jsonl'), '{}');

const REPOS = [
  { repoId: 1, owner: 'acme', name: 'api' },
  { repoId: 2, owner: 'acme', name: 'web' },
  { repoId: 3, owner: 'acme', name: 'infra' },
];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'discover-test-')));
  home = join(base, 'home');
  const claudeDir = join(home, '.claude');
  const dataDir = join(home, '.limn');
  places = { home, dataDir, claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [`${projectKey(dataDir)}-`] } };
  // A dotfiles repository IN the home folder: never "the clone" of anything below it.
  clone(home, 'someone/dotfiles');
  // Two repositories side by side in a hyphenated folder, each with its OWN memories.
  clone(join(home, 'Projects', 'team-a', 'api'), 'acme/api');
  clone(join(home, 'Projects', 'team-a', 'web'), 'acme/web');
  memory(join(home, 'Projects', 'team-a', 'api'), { 'MEMORY.md': '- api note\n', 'db.md': 'migrations run on boot' });
  memory(join(home, 'Projects', 'team-a', 'web'), { 'MEMORY.md': '- web note\n' });
  // A folder that ENCODES the same as `team-a` but is a different path: `team/a` (no clones).
  mkdirSync(join(home, 'Projects', 'team', 'a'), { recursive: true });
  // A subfolder project inside a clone: it belongs to that clone.
  mkdirSync(join(home, 'Projects', 'team-a', 'api', 'packages', 'db'), { recursive: true });
  memory(join(home, 'Projects', 'team-a', 'api', 'packages', 'db'), { 'MEMORY.md': '- db\n' });
  // The team folder itself: Claude Code ran there too, with notes about both repositories.
  memory(join(home, 'Projects', 'team-a'), { 'MEMORY.md': '- how api and web fit\n' });
  // A third repository elsewhere, found only through a session (no memories).
  clone(join(home, 'Work', 'infra'), 'acme/infra');
  project(join(home, 'Work', 'infra'));
  // NOT related: another repository's clone with memories, a plain folder with memories, a linked worktree.
  clone(join(home, 'Projects', 'blog'), 'me/blog');
  memory(join(home, 'Projects', 'blog'), { 'MEMORY.md': 'private' });
  mkdirSync(join(home, 'Notes'), { recursive: true });
  memory(join(home, 'Notes'), { 'MEMORY.md': 'private' });
  write(join(home, 'wt', 'api-copy', '.git'), `gitdir: ${join(home, 'Projects', 'team-a', 'api', '.git', 'worktrees', 'x')}\n`);
  memory(join(home, 'wt', 'api-copy'), { 'MEMORY.md': 'worktree' });
  // Limn's own folder: never looked at.
  clone(join(dataDir, 'clones', 'acme__web'), 'acme/web');
  memory(join(dataDir, 'clones', 'acme__web'), { 'MEMORY.md': 'litter' });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('decoding a project key', () => {
  it('walks the disk, so a hyphenated folder and nested folders are told apart', () => {
    const key = projectKey(join(home, 'Projects', 'team-a'));
    expect(decodeProjectKey(key).sort()).toEqual([join(home, 'Projects', 'team', 'a'), join(home, 'Projects', 'team-a')].sort());
    expect(decodeProjectKey(projectKey(join(home, 'Projects', 'nope')))).toEqual([]);
    expect(decodeProjectKey('no-leading-dash')).toEqual([]);
  });

  it('finds the clone that holds a folder, never the home folder', () => {
    expect(cloneRootOf(join(home, 'Projects', 'team-a', 'api', 'packages', 'db'), home)).toBe(join(home, 'Projects', 'team-a', 'api'));
    expect(cloneRootOf(join(home, 'Notes'), home)).toBeNull();
  });
});

describe('the reader’s clones', () => {
  it('finds each workspace clone through its Claude project, and only the related projects', () => {
    const found = discoverReaderClones(REPOS, places.claude, home);
    expect(found.clones.map((c) => [c.fullName, c.dir])).toEqual([
      ['acme/api', join(home, 'Projects', 'team-a', 'api')],
      ['acme/web', join(home, 'Projects', 'team-a', 'web')],
      ['acme/infra', join(home, 'Work', 'infra')],
    ]);
    expect(found.teamFolders).toEqual([join(home, 'Projects', 'team-a')]);
    expect(found.projects.map((p) => p.dir)).toEqual([
      join(home, 'Projects', 'team-a'),
      join(home, 'Projects', 'team-a', 'api'),
      join(home, 'Projects', 'team-a', 'api', 'packages', 'db'),
      join(home, 'Projects', 'team-a', 'web'),
      join(home, 'Work', 'infra'),
    ]);
  });

  it('picks the closest common folder that is not the home folder', () => {
    const found = discoverReaderClones(REPOS, places.claude, home);
    // team-a holds two clones and infra one; their common parent is the home folder (refused).
    expect(pickReaderFolder(found, places)).toBe(join(home, 'Projects', 'team-a'));
    const two = discoverReaderClones(REPOS.slice(0, 2), places.claude, home);
    expect(pickReaderFolder(two, places)).toBe(join(home, 'Projects', 'team-a'));
    expect(pickReaderFolder({ clones: [], teamFolders: [], projects: [] }, places)).toBeNull();
  });
});

describe('each repository’s memories reach the sandbox under its own key', () => {
  it('mirrors the clones, offers their memories ticked, and copies them where Claude Code looks', () => {
    const r = resolveWorkspaceLayout(REPOS, { memoryProjects: null }, places);
    expect(r.folder).toBe(join(home, 'Projects', 'team-a'));
    const api = r.layout.repos.find((x) => x.fullName === 'acme/api')!;
    const web = r.layout.repos.find((x) => x.fullName === 'acme/web')!;
    expect([api.path, api.placed]).toEqual([join(home, 'Projects', 'team-a', 'api'), 'local']);
    expect([web.path, web.placed]).toEqual([join(home, 'Projects', 'team-a', 'web'), 'local']);
    // Every project with memories of a workspace clone or the team folder; blog, Notes, the worktree and
    // Limn's own folder are not offered.
    expect(r.projects.map((p) => [p.dir, p.memoryCount, p.ticked])).toEqual([
      [join(home, 'Projects', 'team-a'), 1, true],
      [join(home, 'Projects', 'team-a', 'api'), 2, true],
      [join(home, 'Projects', 'team-a', 'api', 'packages', 'db'), 1, true],
      [join(home, 'Projects', 'team-a', 'web'), 1, true],
    ]);
    // The agent starts in the repository with the most notes: Claude Code loads ITS memories there.
    expect(r.layout.startDir).toBe(api.path);

    const files = readerFiles(places.claude, { memoryProjects: r.layout.memoryProjects, userClaudeMd: false, userSkills: false });
    const paths = files.files.map((f) => f.path);
    // The key of each repository's path INSIDE the sandbox is the key its memories are copied under.
    for (const repo of [api, web]) {
      expect(paths).toContain(`/home/agent/.claude/projects/${projectKey(repo.path)}/memory/MEMORY.md`);
    }
    expect(paths).toContain(`/home/agent/.claude/projects/${projectKey(api.path)}/memory/db.md`);
    expect(files.files.find((f) => f.path.endsWith(`${projectKey(web.path)}/memory/MEMORY.md`))!.content.toString()).toBe('- web note\n');
    expect(paths.some((p) => p.includes(projectKey(join(home, 'Projects', 'blog'))))).toBe(false);
  });

  it('honours an untick', () => {
    const r = resolveWorkspaceLayout(REPOS, { memoryProjects: [join(home, 'Projects', 'team-a', 'web')] }, places);
    expect(r.layout.memoryProjects.map((m) => m.dir)).toEqual([join(home, 'Projects', 'team-a', 'web')]);
  });
});
