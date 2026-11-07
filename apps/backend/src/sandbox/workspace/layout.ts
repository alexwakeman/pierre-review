// THE WORKSPACE LAYOUT INSIDE A SANDBOX (docs/SANDBOX.md § The workspace mirror). Pure.
//
// The local folder decides only WHERE each repository sits and which memories come with it:
//   • a repository with a local clone in the folder (matched BY GIT REMOTE) sits at that clone's path;
//   • one with no local clone sits at `<folder>/<name>` (`<folder>/<owner>-<name>` on a clash);
//   • with no folder, every repository sits at `/workspace/<owner>/<name>`.
// Paths are MIRRORED (the same absolute path as on the reader's machine), so Claude Code's project key
// and every path a memory cites still resolve. A clone in the folder whose repository is not in the
// workspace is NAMED and LEFT OUT (owner decision D6).
//
// ONE writable root (`root`, a session volume) holds every repository and the seed files, which sit
// at the root, OUTSIDE every repository, so they are never committed. When the folder is itself a
// clone, the root is its parent.
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { SandboxMatchedRepo, SandboxOutsideClone, SandboxUnmatchedRepo } from '@pierre-review/shared';
import type { FoundClone } from './scan.js';

/** The root used when there is no usable local folder. */
export const DEFAULT_ROOT = '/workspace';

export interface WorkspaceRepo {
  repoId: number;
  owner: string;
  name: string;
}

export const fullNameOf = (r: WorkspaceRepo): string => `${r.owner}/${r.name}`;

// Trees the sandbox image (or the kernel) owns: a repository may never be placed at or under one.
const SYSTEM_TREES = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/lib', '/var/cache', '/var/log', '/var/run', '/home/agent', '/work', '/limn', '/limn-store'];
// Folders a volume may sit UNDER but not AT (mounting there would hide what the image keeps in it).
const SYSTEM_EXACT = ['/home', '/var', '/tmp', '/opt', '/srv', '/mnt', '/media'];

export function inside(parent: string, child: string): boolean {
  const r = relative(parent, child);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** A plain line when this path cannot be a root inside the sandbox, else null. */
export function sandboxPathProblem(path: string): string | null {
  if (!isAbsolute(path) || /[\0\n,"]/.test(path)) {
    return 'Use an absolute folder path without commas or quotes.';
  }
  const p = normalize(path);
  if (p === '/') return 'Choose a folder, not the whole disk.';
  if (SYSTEM_TREES.some((s) => inside(s, p)) || SYSTEM_EXACT.includes(p)) return `Limn cannot place repositories at ${p} inside the sandbox. Choose a folder in your home folder.`;
  return null;
}

/** A plain line when the reader may not use this folder at all (before it is read), else null. */
export function localFolderProblem(folder: string, places: { home: string; dataDir: string }): string | null {
  if (!isAbsolute(folder)) return 'Use an absolute folder path.';
  const p = normalize(folder);
  if (p === '/') return 'Choose a folder, not the whole disk.';
  if (inside(p, places.home)) return 'Choose the folder that holds your clones, not your home folder.';
  if (inside(places.dataDir, p) || inside(p, places.dataDir)) return 'That is Limn’s own data folder.';
  return sandboxPathProblem(p);
}

export interface CloneMatch {
  matched: SandboxMatchedRepo[];
  missing: WorkspaceRepo[];
  outside: SandboxOutsideClone[];
}

/** Match the folder's clones to the workspace's repositories by remote. Shallowest clone first. */
export function matchClones(repos: readonly WorkspaceRepo[], clones: readonly FoundClone[]): CloneMatch {
  const bySlug = new Map<string, FoundClone[]>();
  for (const c of [...clones].sort((a, b) => a.depth - b.depth || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))) {
    if (!c.remote) continue;
    const list = bySlug.get(c.remote.slug) ?? [];
    list.push(c);
    bySlug.set(c.remote.slug, list);
  }
  const wanted = new Set(repos.map((r) => fullNameOf(r).toLowerCase()));
  const matched: SandboxMatchedRepo[] = [];
  const missing: WorkspaceRepo[] = [];
  for (const r of repos) {
    const found = bySlug.get(fullNameOf(r).toLowerCase());
    if (found && found.length > 0) {
      matched.push({ repoId: r.repoId, fullName: fullNameOf(r), localPath: found[0]!.dir, alsoAt: found.slice(1).map((c) => c.dir) });
    } else missing.push(r);
  }
  const outside: SandboxOutsideClone[] = [];
  for (const [slug, list] of bySlug) {
    if (wanted.has(slug)) continue;
    const c = list[0]!;
    outside.push({ fullName: `${c.remote!.owner}/${c.remote!.name}`, localPath: c.dir });
  }
  outside.sort((a, b) => (a.localPath < b.localPath ? -1 : 1));
  return { matched, missing, outside };
}

export interface LayoutRepo extends WorkspaceRepo {
  fullName: string;
  /** Absolute path inside the sandbox. */
  path: string;
  placed: 'local' | 'folder' | 'default';
}

export interface MemoryProjectChoice {
  dir: string;
  key: string;
  memoryCount: number;
}

export interface WorkspaceLayout {
  /** The one writable root (a session volume): repositories and the seed files. */
  root: string;
  /** The local folder the layout mirrors, or null. */
  folder: string | null;
  repos: LayoutRepo[];
  startDir: string;
  startDirReason: 'setting' | 'memories' | 'folder' | 'default';
  /** The ticked projects whose memories are copied (dir inside the layout or not: Codex still reads them). */
  memoryProjects: MemoryProjectChoice[];
  outside: SandboxOutsideClone[];
  /** One plain line per thing the layout could not honour (shown with the boot steps). */
  notes: string[];
}

export interface LayoutInput {
  repos: readonly WorkspaceRepo[];
  /** The checked folder (realpath), or null. */
  folder: string | null;
  match: CloneMatch | null;
  /** Ticked projects (already filtered to the ones found). */
  memoryProjects: readonly MemoryProjectChoice[];
  startDirSetting: string | null;
}

export function planLayout(input: LayoutInput): WorkspaceLayout {
  const notes: string[] = [];
  let folder = input.folder;
  if (folder != null) {
    const problem = sandboxPathProblem(folder);
    if (problem) {
      notes.push(`${problem} Repositories are placed under ${DEFAULT_ROOT} instead.`);
      folder = null;
    }
  }
  const match = folder != null ? input.match : null;
  const localOf = new Map((match?.matched ?? []).map((m) => [m.repoId, normalize(m.localPath)]));

  let root = folder ?? DEFAULT_ROOT;
  // The folder IS a clone: its parent holds the layout, so the seed files sit outside every repository.
  if (folder != null && [...localOf.values()].some((p) => p === normalize(folder!))) {
    const parent = dirname(folder);
    if (sandboxPathProblem(parent) == null) root = parent;
    else {
      notes.push(`Your folder is a repository and its parent cannot be used. Repositories are placed under ${DEFAULT_ROOT} instead.`);
      folder = null;
      localOf.clear();
      root = DEFAULT_ROOT;
    }
  }

  const taken = new Set<string>();
  const repos: LayoutRepo[] = [];
  const sorted = [...input.repos].sort((a, b) => (fullNameOf(a).toLowerCase() < fullNameOf(b).toLowerCase() ? -1 : 1));
  for (const r of sorted) {
    const local = localOf.get(r.repoId);
    if (local != null) {
      taken.add(local);
      repos.push({ ...r, fullName: fullNameOf(r), path: local, placed: 'local' });
    }
  }
  const clashes = (p: string): boolean =>
    taken.has(p) || [...taken].some((t) => inside(t, p) || inside(p, t)) || (match?.outside ?? []).some((o) => normalize(o.localPath) === p);
  for (const r of sorted) {
    if (localOf.has(r.repoId)) continue;
    let path: string;
    let placed: LayoutRepo['placed'];
    if (folder != null) {
      placed = 'folder';
      path = join(root, r.name);
      if (clashes(path)) path = join(root, `${r.owner}-${r.name}`);
      for (let i = 2; clashes(path); i += 1) path = join(root, `${r.owner}-${r.name}-${i}`);
    } else {
      placed = 'default';
      path = join(DEFAULT_ROOT, r.owner, r.name);
    }
    taken.add(path);
    repos.push({ ...r, fullName: fullNameOf(r), path, placed });
  }
  repos.sort((a, b) => (a.path < b.path ? -1 : 1));

  // Start: the reader's choice (inside the root), else the ticked project with the most memories,
  // else the folder, else the root.
  let startDir = root;
  let startDirReason: WorkspaceLayout['startDirReason'] = folder != null ? 'folder' : 'default';
  if (folder != null) startDir = folder;
  const best = [...input.memoryProjects]
    .filter((m) => inside(root, m.dir))
    .sort((a, b) => b.memoryCount - a.memoryCount || (a.dir < b.dir ? -1 : 1))[0];
  if (best && best.memoryCount > 0) {
    startDir = normalize(best.dir);
    startDirReason = 'memories';
  }
  if (input.startDirSetting != null) {
    const s = normalize(input.startDirSetting);
    if (isAbsolute(s) && inside(root, s) && sandboxPathProblem(s) == null) {
      startDir = s;
      startDirReason = 'setting';
    } else notes.push(`The starting folder ${s} is outside the layout. The agent starts in ${startDir}.`);
  }

  return {
    root,
    folder,
    repos,
    startDir,
    startDirReason,
    memoryProjects: [...input.memoryProjects],
    outside: match?.outside ?? [],
    notes,
  };
}

/** The layout's "not cloned locally" list for the check. */
export function unmatchedOf(layout: WorkspaceLayout): SandboxUnmatchedRepo[] {
  return layout.repos.filter((r) => r.placed !== 'local').map((r) => ({ repoId: r.repoId, fullName: r.fullName, sandboxPath: r.path }));
}
