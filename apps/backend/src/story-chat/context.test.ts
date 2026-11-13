// THE STORY CHAT'S WORKSPACE CONTEXT on a scratch disk: the reader's Claude project memories are found
// through their Claude projects for the workspace's repositories (the SAME discovery builds use), the
// projects folder's CLAUDE.md and the skills come along under the workspace's settings, and the sprint
// lines are stored data only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SprintGraphNode } from '@pierre-review/shared';
import { projectKey } from '../ai/session-litter.js';
import type { LayoutPlaces } from '../sandbox/workspace/check.js';
import { projectSkillsIn, readerContextFor, sprintText } from './context.js';

let base = '';
let places: LayoutPlaces;
const write = (p: string, text: string): void => {
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, text);
};
const clone = (dir: string, slug: string): void => write(join(dir, '.git', 'config'), `[remote "origin"]\n\turl = git@github.com:${slug}.git\n`);
const REPOS = [
  { repoId: 1, owner: 'acme', name: 'api' },
  { repoId: 2, owner: 'acme', name: 'web' },
];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'story-chat-context-')));
  const home = join(base, 'home');
  const claudeDir = join(home, '.claude');
  places = { home, dataDir: join(home, '.limn'), claude: { claudeDir, projectsDir: join(claudeDir, 'projects'), litter: [`${projectKey(join(home, '.limn'))}-`] } };
  const team = join(home, 'code', 'team');
  clone(join(team, 'api'), 'acme/api');
  clone(join(team, 'web'), 'acme/web');
  write(join(places.claude.projectsDir, projectKey(join(team, 'api')), 'memory', 'MEMORY.md'), '- api: staging needs REFUNDS_V2\n');
  write(join(places.claude.projectsDir, projectKey(join(team, 'web')), 'memory', 'MEMORY.md'), '- web: e2e needs a seeded buyer\n');
  write(join(places.claude.projectsDir, projectKey(team), 'memory', 'MEMORY.md'), '- api and web deploy together\n');
  write(join(team, 'CLAUDE.md'), 'Team rule: never merge on Friday.');
  write(join(claudeDir, 'CLAUDE.md'), 'Write British English.');
  mkdirSync(join(claudeDir, 'skills', 'release'), { recursive: true });
  write(join(claudeDir, 'skills', 'release', 'SKILL.md'), '# Release');
  write(join(team, 'api', '.claude', 'skills', 'testing', 'SKILL.md'), '# Testing');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the story chat workspace context', () => {
  it('brings every Claude project memory of the workspace’s repositories (and their team folder)', () => {
    const r = readerContextFor(REPOS, { memoryProjects: null, userClaudeMd: true, userSkills: true }, places);
    const texts = r.memories.flatMap((m) => m.files.map((f) => f.text));
    expect(texts).toEqual(expect.arrayContaining(['- api: staging needs REFUNDS_V2\n', '- web: e2e needs a seeded buyer\n', '- api and web deploy together\n']));
    expect(r.userClaudeMd).toBe('Write British English.');
    expect(r.folderClaudeMd?.text).toBe('Team rule: never merge on Friday.');
    expect(r.userSkills).toEqual({ dir: join(places.claude.claudeDir, 'skills'), names: ['release'] });
  });

  it('follows the workspace’s settings: unticked projects, no CLAUDE.md, no skills', () => {
    const api = join(base, 'home', 'code', 'team', 'api');
    const r = readerContextFor(REPOS, { memoryProjects: [api], userClaudeMd: false, userSkills: false }, places);
    expect(r.memories.map((m) => m.dir)).toEqual([api]);
    expect(r.userClaudeMd).toBeNull();
    expect(r.folderClaudeMd).toBeNull();
    expect(r.userSkills).toBeNull();
  });

  it('finds the repositories’ own skills in the checkouts', () => {
    const api = join(base, 'home', 'code', 'team', 'api');
    expect(projectSkillsIn([{ repo: 'acme/api', path: api }, { repo: 'acme/web', path: null }])).toEqual([
      { repo: 'acme/api', name: 'testing', path: join(api, '.claude', 'skills', 'testing', 'SKILL.md') },
    ]);
  });

  it('lists the sprint’s other stories, never the one asked about or a ghost', () => {
    const node = (ident: string, key: string, extra: Partial<SprintGraphNode> = {}): SprintGraphNode =>
      ({
        ident,
        key,
        title: `${key} title`,
        ghost: false,
        status: { name: 'In Progress', category: null },
        prs: [],
        brief: { state: 'current', summary: null, oneLiner: null, criteriaCount: 0, criteriaDerived: false },
        ...extra,
      }) as unknown as SprintGraphNode;
    const text = sprintText(
      [
        node('a', 'ACME-9'),
        node('b', 'ACME-10', { prs: [{ repoFullName: 'acme/web', number: 3, state: 'open' }] as never, brief: { oneLiner: 'Refund emails.' } as never }),
        node('c', 'ACME-11', { ghost: true }),
      ],
      'a',
    );
    expect(text).toBe('- ACME-10 "ACME-10 title" — In Progress; acme/web#3 (open). Refund emails.');
  });
});
