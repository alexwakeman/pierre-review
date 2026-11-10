// FINDING THE READER'S CLONES WITHOUT A FOLDER SETTING (docs/SANDBOX.md § The workspace mirror → Where
// the reader's clones are). Disk only, read-only, bounded; no `git` process.
//
// Claude Code records every folder it ran in as a project key under `~/.claude/projects/` (the folder with
// every non-alphanumeric character as `-`, `projectKey`). The key is LOSSY, so it is never decoded by
// string rules: `decodeProjectKey` walks the disk from `/`, entering only a folder whose encoded name is
// the next part of the key, and returns every real folder that encodes to it (normally one).
//
// A decoded folder is RELATED to the workspace when it is inside a clone of a workspace repository (its
// remote, read as text, names the repository), or when it holds such a clone (a team folder with its own
// CLAUDE.md and memories). The folder the layout mirrors is then picked from those clones
// (`pickReaderFolder`): the closest common parent of all of them when that is a usable folder, else the
// parent that holds the most of them, else the single clone itself.
//
// ⚠ Limn's own project folders (its runs' worktrees and temp folders) are skipped (`places.litter`).
// ⚠ Symlinks are never followed (a Dirent of a link is not a directory).
import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { projectKey } from '../../ai/session-litter.js';
import { fullNameOf, inside, localFolderProblem, type WorkspaceRepo } from './layout.js';
import type { ClaudePlaces } from './memories.js';
import { cloneRemote, scanFolder } from './scan.js';

/** Folders read while decoding ONE key (each is one `readdir`). */
export const DECODE_MAX_DIRS = 400;
/** Keys looked at in all (the newest Claude projects are not favoured: the list is sorted). */
export const DISCOVER_MAX_KEYS = 400;
/** A team folder is searched for clones this deep (the folder walk's own depth). */
const TEAM_FOLDER_SCAN_DIRS = 2_000;
const TEAM_FOLDER_SCAN_MS = 1_000;

/** Every real folder whose project key is `key`, at most `max`. */
export function decodeProjectKey(key: string, opts: { maxDirs?: number; max?: number } = {}): string[] {
  if (!key.startsWith('-')) return [];
  const out: string[] = [];
  let budget = opts.maxDirs ?? DECODE_MAX_DIRS;
  const max = opts.max ?? 4;
  const walk = (dir: string, rest: string): void => {
    if (rest === '') {
      out.push(dir);
      return;
    }
    if (budget <= 0 || out.length >= max) return;
    budget -= 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory()) continue;
      const enc = projectKey(e.name);
      if (rest === enc) walk(join(dir, e.name), '');
      else if (rest.startsWith(`${enc}-`)) walk(join(dir, e.name), rest.slice(enc.length + 1));
      if (out.length >= max) return;
    }
  };
  walk('/', key.slice(1));
  return out;
}

/**
 * The clone that holds `dir` (a folder with a `.git` FOLDER; a linked worktree is skipped for its main
 * clone). The home folder and its parents are never a clone here (a dotfiles repository in the home
 * folder would otherwise hold everything).
 */
export function cloneRootOf(dir: string, home: string | null = null): string | null {
  let d = normalize(dir);
  for (;;) {
    if (home != null && inside(d, home)) return null;
    try {
      if (lstatSync(join(d, '.git')).isDirectory()) return d;
    } catch {
      /* not here */
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export interface ReaderClone {
  repoId: number;
  fullName: string;
  /** The clone's folder on this computer. */
  dir: string;
}

export interface ReaderDiscovery {
  /** Workspace clones found through the Claude projects, one per repository (the first found). */
  clones: ReaderClone[];
  /** Team folders: a related project folder that is not inside a clone but holds workspace clones. */
  teamFolders: string[];
  /** Every Claude project folder of a clone above or of a team folder (memories or not), sorted. */
  projects: Array<{ dir: string; key: string }>;
}

/** The reader's clones of the workspace's repositories, found through their Claude projects. */
export function discoverReaderClones(repos: readonly WorkspaceRepo[], places: ClaudePlaces, home: string | null = null): ReaderDiscovery {
  const bySlug = new Map(repos.map((r) => [fullNameOf(r).toLowerCase(), r]));
  const clones = new Map<number, ReaderClone>();
  const teamFolders = new Set<string>();
  let keys: string[];
  try {
    keys = readdirSync(places.projectsDir).filter((k) => k.startsWith('-') && !places.litter.some((p) => k.startsWith(p)));
  } catch {
    return { clones: [], teamFolders: [], projects: [] };
  }
  // A clone's folder → whether it is a clone of a workspace repository (read once).
  const known = new Map<string, boolean>();
  const take = (root: string): boolean => {
    const was = known.get(root);
    if (was != null) return was;
    const remote = cloneRemote(root);
    const repo = remote ? bySlug.get(remote.slug) : undefined;
    known.set(root, repo != null);
    if (repo == null) return false;
    if (!clones.has(repo.repoId)) clones.set(repo.repoId, { repoId: repo.repoId, fullName: fullNameOf(repo), dir: root });
    return true;
  };
  const projects: Array<{ dir: string; key: string }> = [];
  for (const key of keys.sort().slice(0, DISCOVER_MAX_KEYS)) {
    for (const dir of decodeProjectKey(key)) {
      const root = cloneRootOf(dir, home);
      if (root != null) {
        if (take(root)) projects.push({ dir, key });
        continue;
      }
      // Not inside a clone: a team folder when it holds a workspace clone.
      // The home folder (or a parent of it) is never one: too wide, and never a layout.
      if (home != null && inside(dir, home)) continue;
      const scan = scanFolder(dir, { maxDirs: TEAM_FOLDER_SCAN_DIRS, maxMs: TEAM_FOLDER_SCAN_MS });
      let any = false;
      for (const c of scan.clones) {
        // The folder itself (a linked worktree's root) is not a team folder of itself.
        if (c.depth === 0 || c.remote == null || !bySlug.has(c.remote.slug)) continue;
        take(c.dir);
        any = true;
      }
      if (any) {
        teamFolders.add(dir);
        projects.push({ dir, key });
      }
    }
  }
  return {
    clones: [...clones.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1)),
    teamFolders: [...teamFolders].sort(),
    projects: projects.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)),
  };
}

function commonParent(paths: readonly string[]): string {
  let parts = paths[0]!.split('/');
  for (const p of paths.slice(1)) {
    const q = p.split('/');
    let n = 0;
    while (n < parts.length && n < q.length && parts[n] === q[n]) n += 1;
    parts = parts.slice(0, n);
  }
  return parts.join('/') || '/';
}

/**
 * The folder the layout mirrors, or null when no clone was found. Candidates, the first usable one wins:
 * the closest common parent of every clone and team folder; each parent (or team folder) by how many
 * clones it holds; each clone itself (its parent then holds the layout).
 */
export function pickReaderFolder(found: ReaderDiscovery, places: { home: string; dataDir: string }): string | null {
  if (found.clones.length === 0) return null;
  const anchors = new Map<string, number>();
  for (const c of found.clones) {
    const team = found.teamFolders.find((t) => inside(t, c.dir) && t !== c.dir);
    const a = team ?? dirname(c.dir);
    anchors.set(a, (anchors.get(a) ?? 0) + 1);
  }
  const candidates = [
    commonParent([...anchors.keys()]),
    ...[...anchors].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([a]) => a),
    ...found.clones.map((c) => c.dir),
  ];
  return candidates.find((c) => localFolderProblem(c, places) == null) ?? null;
}
