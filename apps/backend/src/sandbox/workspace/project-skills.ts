// THE PROJECT SKILLS OF A WORKSPACE SESSION (docs/SANDBOX.md § Memories → Project skills): the skills a
// repository keeps in its own tree, `<any folder>/.claude/skills/<name>/SKILL.md`. They come into the
// sandbox WITH THE REPOSITORY (the mirror checks out the whole tree), so nothing is copied for them;
// what this module adds is KNOWING they are there:
//
//   • the build tab's start panel counts them before Start (GET …/sandbox/project-skills, from the
//     newest default-branch commit Limn's clone cache holds — `listProjectSkills`);
//   • the seed names each one at its path inside the sandbox (`projectSkillsAt`, at the session's BASE
//     commit), so the agent reads a skill's SKILL.md when its task comes up. Claude Code loads only the
//     skills of the folder it starts in, and Codex none, so the list is what makes the rest usable.
//
// Read from LIMN'S OWN CLONE CACHE, file NAMES only (`git ls-tree`, `GIT_NO_LAZY_FETCH=1`: the blobless
// cache answers without a download), exactly like the compose files (sandbox/services/compose-files.ts).
// No network, nothing from the reader's checkout. A skill's text is repository content — UNTRUSTED, like
// every other file there — and is never read into the seed: only its folder name and path.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SandboxProjectSkillsRepo } from '@pierre-review/shared';
import { repoCloneDir } from '../../review/clone-manager.js';

const run = promisify(execFile);

/** Skills per repository at most (a repository with more names the first, shallowest first). */
export const PROJECT_SKILLS_MAX = 50;

/** Folders whose skills are someone else's: dependencies, vendored code. */
const SKIP_SEGMENTS = new Set(['node_modules', 'vendor', 'third_party', 'bower_components']);
/** A skill folder's name as the seed prints it: no path parts, no control or markdown-breaking characters. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export interface ProjectSkill {
  /** The skill folder's name. */
  name: string;
  /** `…/.claude/skills/<name>/SKILL.md`, relative to the repository root. */
  path: string;
}

/** A repository path that is a project skill's SKILL.md, or null. Pure. */
export function projectSkillOf(path: string): ProjectSkill | null {
  const parts = path.split('/');
  const n = parts.length;
  if (n < 4 || parts[n - 1] !== 'SKILL.md' || parts[n - 3] !== 'skills' || parts[n - 4] !== '.claude') return null;
  const name = parts[n - 2]!;
  if (!SAFE_SKILL_NAME.test(name)) return null;
  if (parts.slice(0, n - 4).some((p) => SKIP_SEGMENTS.has(p))) return null;
  return { name, path };
}

/** Every git call here: no hooks, no fsmonitor, no lazy fetch, no prompt. */
const GIT_ENV = { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
const git = async (dir: string, args: string[]): Promise<string> =>
  (await run('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { env: GIT_ENV, timeout: 20_000, maxBuffer: 64 * 1024 * 1024 })).stdout;

const SHA = /^[0-9a-f]{40,64}$/;

/** The newest default-branch commit the cache holds, or null (the compose files' rule). */
async function newestTip(dir: string): Promise<string | null> {
  const out = await git(dir, [
    'for-each-ref',
    '--sort=-committerdate',
    '--count=1',
    '--format=%(objectname)',
    'refs/pierre/ticket-default-branch',
    'refs/heads',
    'refs/remotes/origin',
  ]).catch(() => '');
  const sha = out.trim().split('\n')[0] ?? '';
  if (SHA.test(sha)) return sha;
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).catch(() => '')).trim();
  return SHA.test(head) ? head : null;
}

/** The project skills in one tree listing (`ls-tree -r --name-only -z`), shallowest first, capped. Pure. */
export function projectSkillsInListing(listing: string): ProjectSkill[] {
  const seen = new Set<string>();
  const out: ProjectSkill[] = [];
  for (const p of listing.split('\0')) {
    const s = p === '' ? null : projectSkillOf(p);
    if (s == null || seen.has(s.path)) continue;
    seen.add(s.path);
    out.push(s);
  }
  return out
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, PROJECT_SKILLS_MAX);
}

/** The project skills of a cached repository at `sha`. [] when the commit or the cache is not there. */
export async function projectSkillsAt(dir: string, sha: string): Promise<ProjectSkill[]> {
  if (!SHA.test(sha) || !existsSync(join(dir, '.git'))) return [];
  return projectSkillsInListing(await git(dir, ['ls-tree', '-r', '--name-only', '-z', sha]).catch(() => ''));
}

/** The project skills of one cached repository at its newest default-branch commit. null: no copy yet. */
export async function projectSkillsInClone(dir: string): Promise<ProjectSkill[] | null> {
  if (!existsSync(join(dir, '.git'))) return null;
  const tip = await newestTip(dir);
  return tip == null ? [] : projectSkillsAt(dir, tip);
}

export async function listProjectSkills(
  repos: ReadonlyArray<{ owner: string; name: string }>,
  cloneDirOf = repoCloneDir,
): Promise<SandboxProjectSkillsRepo[]> {
  return Promise.all(
    repos.map(async (r) => {
      const skills = await projectSkillsInClone(cloneDirOf(r.owner, r.name)).catch(() => null);
      return { repo: `${r.owner}/${r.name}`, skills: skills ?? [], copied: skills != null };
    }),
  );
}
