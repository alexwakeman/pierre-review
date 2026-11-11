// What a workspace session brings in beside the code, counted on the build tab's start panel.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend test/sessionInherits.test.ts
import { describe, expect, it } from 'vitest';
import type { SandboxFolderCheck, SandboxProjectSkills, SandboxWorkspaceSettings } from '@pierre-review/shared';
import { sessionInherits, sessionInheritsText } from '../src/lib/sessionInherits.js';

const check = (over: Partial<SandboxFolderCheck> = {}): SandboxFolderCheck => ({
  workspaceId: 1,
  folder: '/code',
  matched: [],
  notCloned: [],
  outside: [],
  memories: [
    { dir: '/code/api', key: 'a', memoryCount: 12, ticked: true },
    { dir: '/code/web', key: 'w', memoryCount: 5, ticked: true },
    { dir: '/code/old', key: 'o', memoryCount: 40, ticked: false },
  ],
  userClaudeMd: true,
  folderClaudeMd: false,
  userSkills: ['bng-story', 'pdf'],
  startDir: '/code/api',
  truncated: false,
  ...over,
});
const settings = (over: Partial<SandboxWorkspaceSettings> = {}): SandboxWorkspaceSettings =>
  ({ workspaceId: 1, memoryProjects: null, userClaudeMd: true, userSkills: false, ...over }) as SandboxWorkspaceSettings;
const skills: SandboxProjectSkills = {
  workspaceId: 1,
  repos: [
    { repo: 'acme/api', skills: [{ name: 'run-tests', path: '.claude/skills/run-tests/SKILL.md' }], copied: true },
    { repo: 'acme/web', skills: [], copied: false },
  ],
};

describe('sessionInherits', () => {
  it('counts only the ticked projects, CLAUDE.md when brought, own skills only when opted in, and project skills', () => {
    const i = sessionInherits(check(), settings(), skills);
    expect(i).toEqual({ memories: 17, projects: 2, claudeMd: true, userSkills: 0, projectSkills: 1 });
    expect(sessionInheritsText(i)).toBe('17 memories from 2 projects, your CLAUDE.md and 1 project skill');
    expect(sessionInherits(check(), settings({ userSkills: true }), skills).userSkills).toBe(2);
    expect(sessionInherits(check(), settings({ userClaudeMd: false }), skills).claudeMd).toBe(false);
  });

  it('nothing read yet, or nothing to bring ⇒ null text', () => {
    expect(sessionInheritsText(sessionInherits(undefined, undefined, undefined))).toBeNull();
    expect(sessionInheritsText({ memories: 1, projects: 1, claudeMd: false, userSkills: 0, projectSkills: 0 })).toBe('1 memory from 1 project');
  });
});
