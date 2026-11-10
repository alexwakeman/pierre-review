// The reader's Claude files and the check: memory projects found by ENCODING (never decoding), Limn's
// own project folders never offered, ticks (default: every project with memories), caps, symlinks
// skipped, the user CLAUDE.md / skills, and the folder's own CLAUDE.md only outside every repository.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { projectKey } from '../../ai/session-litter.js';
import { resolveWorkspaceLayout, toFolderCheck, type LayoutPlaces } from './check.js';
import { collectFiles, memoryProjectKeys, MEMORY_FILE_MAX_BYTES, readMemories } from './memories.js';
import { readerFiles } from './mirror.js';

let base = '';
let folder = '';
let places: LayoutPlaces;

const write = (p: string, text: string | Buffer): void => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const memory = (dir: string, files: Record<string, string | Buffer>): void => {
  for (const [name, text] of Object.entries(files)) write(join(places.claude.projectsDir, projectKey(dir), 'memory', name), text);
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'limn-memories-test-')));
  const home = join(base, 'home');
  folder = join(home, 'Projects', 'bng-fe-be');
  const claudeDir = join(home, '.claude');
  const dataDir = join(home, '.limn');
  places = { home, dataDir, claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [`${projectKey(dataDir)}-`] } };
  for (const r of ['bng-metric-harness', 'bng-metric-backend']) {
    write(join(folder, r, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:DEFRA/${r}.git\n`);
  }
  write(join(folder, 'CLAUDE.md'), '# BNG notes\nThe harness drives the other repos.\n');
  memory(join(folder, 'bng-metric-harness'), { 'MEMORY.md': '- [a](a.md)\n', 'a.md': 'alpha', 'b.md': 'beta', 'sub/c.md': 'gamma' });
  memory(join(folder, 'bng-metric-backend'), { 'MEMORY.md': 'one' });
  // A project folder with an empty memory folder: not offered.
  mkdirSync(join(places.claude.projectsDir, projectKey(join(folder, 'empty')), 'memory'), { recursive: true });
  mkdirSync(join(folder, 'empty'), { recursive: true });
  // A project of another folder, and Limn's own litter: never offered.
  memory(join(home, 'elsewhere'), { 'MEMORY.md': 'x' });
  memory(join(dataDir, 'clones', 'x'), { 'MEMORY.md': 'litter' });
  // A transcript beside the memory folder is never read.
  write(join(places.claude.projectsDir, projectKey(join(folder, 'bng-metric-harness')), 'session.jsonl'), '{"secret":true}');
  write(join(claudeDir, 'CLAUDE.md'), '# Mine\nBritish English.\n');
  write(join(claudeDir, 'skills', 'bng-story', 'SKILL.md'), '---\nname: bng-story\n---\n');
  write(join(claudeDir, 'skills', 'bng-story', 'run.sh'), '#!/bin/sh\n');
  // A symlink in a memory folder is skipped.
  symlinkSync(join(claudeDir, 'CLAUDE.md'), join(places.claude.projectsDir, projectKey(join(folder, 'bng-metric-backend')), 'memory', 'link.md'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const REPOS = [
  { repoId: 1, owner: 'DEFRA', name: 'bng-metric-backend' },
  { repoId: 2, owner: 'DEFRA', name: 'bng-metric-harness' },
];

describe('memory projects', () => {
  it("leaves Limn's own project folders out, and keeps only those with a memory folder", () => {
    const keys = memoryProjectKeys(places.claude);
    expect(keys.has(projectKey(join(folder, 'bng-metric-harness')))).toBe(true);
    expect([...keys].some((k) => k.startsWith(places.claude.litter[0]!))).toBe(false);
  });

  it('the check FINDS the clones through their Claude projects (no folder setting), offers their memories ticked, and starts in the biggest', () => {
    const r = resolveWorkspaceLayout(REPOS, { memoryProjects: null }, places);
    const c = toFolderCheck(7, r, places);
    expect(c.folder).toBe(folder);
    expect(c.matched.map((m) => [m.fullName, m.localPath])).toEqual([
      ['DEFRA/bng-metric-backend', join(folder, 'bng-metric-backend')],
      ['DEFRA/bng-metric-harness', join(folder, 'bng-metric-harness')],
    ]);
    expect(c.memories).toEqual([
      { dir: join(folder, 'bng-metric-backend'), key: projectKey(join(folder, 'bng-metric-backend')), memoryCount: 1, ticked: true },
      { dir: join(folder, 'bng-metric-harness'), key: projectKey(join(folder, 'bng-metric-harness')), memoryCount: 4, ticked: true },
    ]);
    expect([c.startDir, r.layout.startDirReason]).toEqual([join(folder, 'bng-metric-harness'), 'memories']);
    // Mirrored paths: the key inside the sandbox is the reader's key, so Claude Code loads these memories.
    expect(r.layout.repos.map((x) => x.path)).toEqual([join(folder, 'bng-metric-backend'), join(folder, 'bng-metric-harness')]);
    expect(c.userClaudeMd).toBe(true);
    expect(c.folderClaudeMd).toBe(true);
    expect(c.userSkills).toEqual(['bng-story']);
  });

  it('honours the saved ticks', () => {
    const r = resolveWorkspaceLayout(REPOS, { memoryProjects: [join(folder, 'bng-metric-backend')] }, places);
    expect(r.projects.filter((p) => p.ticked).map((p) => p.dir)).toEqual([join(folder, 'bng-metric-backend')]);
    expect(r.layout.startDir).toBe(join(folder, 'bng-metric-backend'));
  });

  it('with no Claude project of a workspace clone, nothing is found and every repository goes under /workspace', () => {
    const r = resolveWorkspaceLayout([{ repoId: 9, owner: 'DEFRA', name: 'bng-unknown' }], { memoryProjects: null }, places);
    expect(r.folder).toBeNull();
    expect(r.projects).toEqual([]);
    expect(r.layout.repos[0]!.path).toBe('/workspace/DEFRA/bng-unknown');
  });

  it('copies memories under the same key, never a transcript; the user CLAUDE.md; skills only when asked', () => {
    const key = projectKey(join(folder, 'bng-metric-harness'));
    const got = readerFiles(places.claude, { memoryProjects: [{ dir: join(folder, 'bng-metric-harness'), key }], userClaudeMd: true, userSkills: false });
    expect(got.files.map((f) => f.path).sort()).toEqual(
      [
        `/home/agent/.claude/projects/${key}/memory/MEMORY.md`,
        `/home/agent/.claude/projects/${key}/memory/a.md`,
        `/home/agent/.claude/projects/${key}/memory/b.md`,
        `/home/agent/.claude/projects/${key}/memory/sub/c.md`,
        '/home/agent/.claude/CLAUDE.md',
      ].sort(),
    );
    expect(got.skills).toEqual([]);
    const withSkills = readerFiles(places.claude, { memoryProjects: [], userClaudeMd: false, userSkills: true });
    expect(withSkills.skills).toEqual(['bng-story']);
    expect(withSkills.files.find((f) => f.path.endsWith('run.sh'))!.mode).toBe(0o644);
    expect(withSkills.userClaudeMd).toBeNull();
  });

  it('skips symlinks and files past the cap, and counts them', () => {
    const key = projectKey(join(folder, 'bng-metric-backend'));
    write(join(places.claude.projectsDir, key, 'memory', 'huge.md'), Buffer.alloc(MEMORY_FILE_MAX_BYTES + 1, 97));
    const got = readMemories(places.claude, key);
    expect(got.files.map((f) => f.rel)).toEqual(['MEMORY.md']);
    expect(got.skipped).toBe(2);
    const capped = collectFiles(join(places.claude.projectsDir, projectKey(join(folder, 'bng-metric-harness')), 'memory'), { fileMax: 100, totalMax: 12 });
    expect(capped.files.map((f) => f.rel)).toEqual(['MEMORY.md']);
  });
});
