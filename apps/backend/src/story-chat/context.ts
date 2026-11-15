// STORY CHAT — THE WORKSPACE CONTEXT, the same inputs a build gets (sandbox/workspace/*), READ-ONLY:
//
//   memories        the reader's Claude project memories for the workspace's repositories — the projects
//                   ticked in Settings → Sandbox (default: every project found with memories), found
//                   through their Claude projects exactly as builds find them (`resolveWorkspaceLayout`)
//   CLAUDE.md       ~/.claude/CLAUDE.md and the projects folder's own CLAUDE.md (outside every repo),
//                   when the workspace says so (`userClaudeMd`, default on)
//   skills          ~/.claude/skills (when the workspace opts in, `userSkills`), given as a READ-ONLY
//                   folder; the repositories' own `.claude/skills/*/SKILL.md` in the checkouts
//   docs            the workspace's reference library, a READ-ONLY folder + the navigation rules
//   sprint          the other stories of the sprint, from Limn's STORED copy (the sprint graph, DB only)
//
// Nothing here writes, and nothing reads the tracker.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SprintGraphNode } from '@pierre-review/shared';
import { folderClaudeMdPath, resolveWorkspaceLayout, type LayoutPlaces } from '../sandbox/workspace/check.js';
import { listUserSkills, readMemories, readSmallFile, readUserClaudeMd, USER_CLAUDE_MD_MAX_BYTES } from '../sandbox/workspace/memories.js';
import type { WorkspaceRepo } from '../sandbox/workspace/layout.js';
import type { SeedMemory } from './seed.js';

export interface ReaderContext {
  memories: SeedMemory[];
  userClaudeMd: string | null;
  /** The projects folder's own CLAUDE.md, with the folder it belongs to. */
  folderClaudeMd: { folder: string; text: string } | null;
  /** ~/.claude/skills, readable, when the workspace brings the reader's skills. */
  userSkills: { dir: string; names: string[] } | null;
}

export interface ReaderSettings {
  memoryProjects: string[] | null;
  userClaudeMd: boolean;
  userSkills: boolean;
}

/** The reader's files for a chat in this workspace. Never throws: they help, they never fail a chat. */
export function readerContextFor(repos: readonly WorkspaceRepo[], settings: ReaderSettings, places: LayoutPlaces): ReaderContext {
  const out: ReaderContext = { memories: [], userClaudeMd: null, folderClaudeMd: null, userSkills: null };
  try {
    if (repos.length > 0) {
      const resolved = resolveWorkspaceLayout(repos, { memoryProjects: settings.memoryProjects }, places);
      for (const p of resolved.projects.filter((x) => x.ticked)) {
        const got = readMemories(places.claude, p.key);
        if (got.files.length > 0) out.memories.push({ dir: p.dir, files: got.files.map((f) => ({ rel: f.rel, text: f.content.toString('utf8') })) });
      }
      if (settings.userClaudeMd) {
        const path = folderClaudeMdPath(resolved);
        const b = path ? readSmallFile(path, USER_CLAUDE_MD_MAX_BYTES) : null;
        if (path && b) out.folderClaudeMd = { folder: resolved.folder!, text: b.toString('utf8') };
      }
    }
  } catch {
    /* memories are a help */
  }
  if (settings.userClaudeMd) {
    const b = readUserClaudeMd(places.claude);
    if (b) out.userClaudeMd = b.toString('utf8');
  }
  if (settings.userSkills) {
    const names = listUserSkills(places.claude);
    if (names.length > 0) out.userSkills = { dir: join(places.claude.claudeDir, 'skills'), names };
  }
  return out;
}

/** The repositories' own skills in the checkouts: `<checkout>/.claude/skills/<name>/SKILL.md`. */
export function projectSkillsIn(checkouts: ReadonlyArray<{ repo: string; path: string | null }>): Array<{ repo: string; name: string; path: string }> {
  const out: Array<{ repo: string; name: string; path: string }> = [];
  for (const c of checkouts) {
    if (!c.path) continue;
    const dir = join(c.path, '.claude', 'skills');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort().slice(0, 50)) {
      const path = join(dir, name, 'SKILL.md');
      try {
        if (statSync(path).isFile()) out.push({ repo: c.repo, name, path });
      } catch {
        /* not a skill */
      }
    }
  }
  return out;
}

export const SPRINT_STORIES_MAX = 80;
export const SPRINT_TEXT_MAX_CHARS = 16_000;

/** The other stories of the sprint, one line each (stored data only). Pure. */
export function sprintText(nodes: readonly SprintGraphNode[], currentIdent: string): string {
  const lines: string[] = [];
  let used = 0;
  const stories = nodes.filter((n) => !n.ghost && n.ident !== currentIdent).slice(0, SPRINT_STORIES_MAX);
  for (const n of stories) {
    const status = n.status?.name ?? 'status unknown';
    const prs = n.prs.length === 0 ? 'no pull requests' : n.prs.map((p) => `${p.repoFullName}#${p.number} (${p.state})`).join(', ');
    const about = n.brief.oneLiner ?? null;
    const line = `- ${n.key} "${n.title}" — ${status}; ${prs}${about ? `. ${about}` : ''}`;
    if (used + line.length > SPRINT_TEXT_MAX_CHARS) {
      lines.push(`- … and ${stories.length - lines.length} more stories.`);
      break;
    }
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}
