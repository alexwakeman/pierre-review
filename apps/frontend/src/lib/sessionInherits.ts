import type { SandboxFolderCheck, SandboxProjectSkills, SandboxWorkspaceSettings } from '@pierre-review/shared';

// WHAT A WORKSPACE SESSION BRINGS IN BESIDE THE CODE (the build tab's start panel, before Start): the
// reader's Claude memories of the TICKED projects (Settings → Sandbox; the folder check's `ticked` is the
// saved choice, else the default), their CLAUDE.md when the workspace brings it, their own skills when
// it opts in, and the skills the repositories keep in their own trees. The SAME rules the boot uses
// (sandbox/workspace/mirror.ts `readerFiles`, project-skills.ts), so the counts are what the agent gets.

export interface SessionInherits {
  /** Memory files of the ticked projects. */
  memories: number;
  /** Ticked projects with memories. */
  projects: number;
  /** `~/.claude/CLAUDE.md` (or the folder's own CLAUDE.md) comes in. */
  claudeMd: boolean;
  /** The reader's own skills (`~/.claude/skills/`) that come in: 0 unless the workspace opts in. */
  userSkills: number;
  /** Skills the workspace repositories keep in their own trees. */
  projectSkills: number;
}

/** Pure. A part not read yet counts as nothing. */
export function sessionInherits(
  check: SandboxFolderCheck | undefined,
  settings: SandboxWorkspaceSettings | undefined,
  skills: SandboxProjectSkills | undefined,
): SessionInherits {
  const ticked = (check?.memories ?? []).filter((m) => m.ticked && m.memoryCount > 0);
  return {
    memories: ticked.reduce((n, m) => n + m.memoryCount, 0),
    projects: ticked.length,
    claudeMd: settings?.userClaudeMd === true && (check?.userClaudeMd === true || check?.folderClaudeMd === true),
    userSkills: settings?.userSkills === true ? (check?.userSkills.length ?? 0) : 0,
    projectSkills: (skills?.repos ?? []).reduce((n, r) => n + r.skills.length, 0),
  };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "23 memories from 2 projects, your CLAUDE.md and 3 project skills", or null when nothing comes in. Pure. */
export function sessionInheritsText(i: SessionInherits): string | null {
  const parts: string[] = [];
  if (i.memories > 0) parts.push(`${plural(i.memories, 'memory', 'memories')} from ${plural(i.projects, 'project')}`);
  if (i.claudeMd) parts.push('your CLAUDE.md');
  if (i.userSkills > 0) parts.push(plural(i.userSkills, 'of your skills', 'of your skills'));
  if (i.projectSkills > 0) parts.push(plural(i.projectSkills, 'project skill'));
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
