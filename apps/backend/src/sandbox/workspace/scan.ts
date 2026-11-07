// THE FOLDER WALK (docs/SANDBOX.md § The workspace mirror): the reader's clones under their local
// folder, and the Claude projects under it that hold memories. Disk only, read-only, bounded.
//
//   CLONES     a folder holding `.git` (a folder, or a file `gitdir: …` for a worktree), at depth ≤ 3
//              below the root. Its remote comes from its git config, read as text (no `git` process).
//              A clone found INSIDE another clone is not a clone of the layout (a submodule, a vendored
//              copy): the walk does not register it.
//   PROJECTS   Claude Code keys a project by its folder with every non-alphanumeric character as `-`
//              (`projectKey`). The walk ENCODES each folder it visits and looks the key up in the set
//              of keys that exist — never the reverse: the encoding is lossy, so a key cannot be
//              decoded. A subtree is entered only while some key starts with its prefix, so the
//              deeper memory walk (≤ 6) costs nothing where no project is.
//   SKIPPED    dot-folders, `node_modules`, symlinks (never followed).
//   BOUNDS     MAX_DIRS folders and MAX_MS in total; past either the result says `truncated`.
import { lstatSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { projectKey } from '../../ai/session-litter.js';
import { pickRemote, remotesFromGitConfig, parseGitRemote, type ParsedRemote } from './remote.js';

export const CLONE_MAX_DEPTH = 3;
export const PROJECT_MAX_DEPTH = 6;
export const SCAN_MAX_DIRS = 20_000;
export const SCAN_MAX_MS = 5_000;

export interface FoundClone {
  dir: string;
  /** null: no remote Limn can read (left out silently). */
  remote: ParsedRemote | null;
  depth: number;
}

export interface FolderScan {
  root: string;
  clones: FoundClone[];
  /** Every visited folder whose project key is in `projectKeys` (the root included). */
  projectDirs: Array<{ dir: string; key: string }>;
  truncated: boolean;
}

const SKIP = new Set(['node_modules']);

function readText(path: string, max = 256 * 1024): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The config file of a clone at `dir` whose `.git` entry is `entry`. */
function gitConfigText(dir: string, entry: Dirent): string | null {
  if (entry.isDirectory()) return readText(join(dir, '.git', 'config'));
  if (!entry.isFile()) return null;
  const pointer = readText(join(dir, '.git'), 4096);
  const m = pointer ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer) : null;
  if (!m) return null;
  const gitdir = isAbsolute(m[1]!) ? m[1]! : resolve(dir, m[1]!);
  // A linked worktree's config lives in the main repository (`commondir`).
  const common = readText(join(gitdir, 'commondir'), 4096)?.trim();
  return readText(join(common ? resolve(gitdir, common) : gitdir, 'config'));
}

export function scanFolder(
  root: string,
  opts: { projectKeys?: ReadonlySet<string>; maxDirs?: number; maxMs?: number; now?: () => number } = {},
): FolderScan {
  const keys = opts.projectKeys ?? new Set<string>();
  const keyList = [...keys];
  const maxDirs = opts.maxDirs ?? SCAN_MAX_DIRS;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.maxMs ?? SCAN_MAX_MS);
  const clones: FoundClone[] = [];
  const projectDirs: Array<{ dir: string; key: string }> = [];
  let visited = 0;
  let truncated = false;

  const projectBelow = (key: string): boolean => keyList.some((k) => k.startsWith(`${key}-`));

  // Iterative, breadth-first: the shallowest clone of a repository is found first.
  const queue: Array<{ dir: string; depth: number; inClone: boolean }> = [{ dir: root, depth: 0, inClone: false }];
  while (queue.length > 0) {
    const { dir, depth, inClone } = queue.shift()!;
    if (visited >= maxDirs || now() > deadline) {
      truncated = true;
      break;
    }
    visited += 1;
    const key = projectKey(dir);
    if (keys.has(key)) projectDirs.push({ dir, key });
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    let isClone = false;
    if (!inClone) {
      const git = entries.find((e) => e.name === '.git');
      if (git) {
        isClone = true;
        const text = gitConfigText(dir, git);
        const url = text ? pickRemote(remotesFromGitConfig(text)) : null;
        clones.push({ dir, remote: url ? parseGitRemote(url) : null, depth });
      }
    }
    const nowInClone = inClone || isClone;
    // Clones are looked for to CLONE_MAX_DEPTH; inside a clone, or past that depth, only a folder
    // that can still lead to a Claude project is entered.
    const wantClones = !nowInClone && depth < CLONE_MAX_DEPTH;
    const wantProjects = depth < PROJECT_MAX_DEPTH && projectBelow(key);
    if (!wantClones && !wantProjects) continue;
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const child = join(dir, e.name);
      if (!wantClones && !projectBelow(projectKey(child)) && !keys.has(projectKey(child))) continue;
      queue.push({ dir: child, depth: depth + 1, inClone: nowInClone });
    }
  }
  return { root, clones, projectDirs, truncated };
}
