// THE PROJECT SKILLS (project-skills.ts): which repository paths are a skill's SKILL.md, the listing
// fold (shallowest first, capped, de-duplicated), and the clone-cache read on a real git repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROJECT_SKILLS_MAX, projectSkillOf, projectSkillsAt, projectSkillsInClone, projectSkillsInListing } from './project-skills.js';

describe('projectSkillOf', () => {
  it('a SKILL.md under .claude/skills/<name>/, at the root or in a sub-project', () => {
    expect(projectSkillOf('.claude/skills/run-tests/SKILL.md')).toEqual({ name: 'run-tests', path: '.claude/skills/run-tests/SKILL.md' });
    expect(projectSkillOf('apps/web/.claude/skills/deploy/SKILL.md')?.name).toBe('deploy');
  });

  it('nothing else: other files, other folders, vendored code, unsafe names', () => {
    expect(projectSkillOf('.claude/skills/run-tests/README.md')).toBeNull();
    expect(projectSkillOf('.claude/skills/SKILL.md')).toBeNull();
    expect(projectSkillOf('skills/run-tests/SKILL.md')).toBeNull();
    expect(projectSkillOf('node_modules/x/.claude/skills/a/SKILL.md')).toBeNull();
    expect(projectSkillOf('.claude/skills/bad`name/SKILL.md')).toBeNull();
  });
});

describe('projectSkillsInListing', () => {
  it('shallowest first, then by path; capped', () => {
    const listing = ['b/.claude/skills/z/SKILL.md', '.claude/skills/b/SKILL.md', '.claude/skills/a/SKILL.md', 'src/x.ts'].join('\0');
    expect(projectSkillsInListing(listing).map((s) => s.path)).toEqual([
      '.claude/skills/a/SKILL.md',
      '.claude/skills/b/SKILL.md',
      'b/.claude/skills/z/SKILL.md',
    ]);
    const many = Array.from({ length: PROJECT_SKILLS_MAX + 5 }, (_, i) => `.claude/skills/s${i}/SKILL.md`).join('\0');
    expect(projectSkillsInListing(many)).toHaveLength(PROJECT_SKILLS_MAX);
  });
});

describe('the clone-cache read', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

  it('lists the skills at a commit and at the newest default-branch commit; no copy ⇒ null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'limn-skills-'));
    git(dir, 'init', '-q', '-b', 'main');
    mkdirSync(join(dir, '.claude/skills/run-tests'), { recursive: true });
    writeFileSync(join(dir, '.claude/skills/run-tests/SKILL.md'), '---\nname: run-tests\n---\n');
    writeFileSync(join(dir, 'README.md'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'one');
    const sha = git(dir, 'rev-parse', 'HEAD');
    expect(await projectSkillsAt(dir, sha)).toEqual([{ name: 'run-tests', path: '.claude/skills/run-tests/SKILL.md' }]);
    expect((await projectSkillsInClone(dir))?.map((s) => s.name)).toEqual(['run-tests']);
    expect(await projectSkillsAt(dir, 'not-a-sha')).toEqual([]);
    expect(await projectSkillsInClone(join(dir, 'missing'))).toBeNull();
  });
});
