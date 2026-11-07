// THE READER'S CLAUDE FILES THAT GO INTO A SESSION (docs/SANDBOX.md § Memories; owner decisions D1, Q1).
//
//   memories     `<claude>/projects/<key>/memory/**` of each project the reader ticked — MEMORIES ONLY,
//                never a transcript (D1). Copied under the SAME key inside the sandbox, so Claude Code
//                loads them when it starts in that folder (the layout mirrors the reader's paths).
//   CLAUDE.md    `<claude>/CLAUDE.md` (the reader's own instructions) when the workspace says so (Q1,
//                default on).
//   skills       `<claude>/skills/**` when the workspace opts in (Q1, default off).
//
// ⚠ Read-only at the source, copied as FILES (never a mount): regular files only, symlinks skipped and
// never followed, names checked, every file and the total capped. A file past a cap is left out and
// counted, never cut (a half memory is worse than none).
// ⚠ Limn's OWN project folders (its runs' worktrees and temp folders, ai/session-litter.ts) are never
// offered.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { defaultSessionCleanupPlaces, litterPrefixes, type SessionCleanupPlaces } from '../../ai/session-litter.js';

export const MEMORY_FILE_MAX_BYTES = 256 * 1024;
export const MEMORY_TOTAL_MAX_BYTES = 4 * 1024 * 1024;
export const SKILLS_FILE_MAX_BYTES = 1024 * 1024;
export const SKILLS_TOTAL_MAX_BYTES = 16 * 1024 * 1024;
export const COPY_MAX_FILES = 2_000;
export const USER_CLAUDE_MD_MAX_BYTES = 128 * 1024;

export interface ClaudePlaces {
  /** `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
  claudeDir: string;
  projectsDir: string;
  /** Key prefixes of Limn's own project folders. */
  litter: string[];
}

export function defaultClaudePlaces(env: NodeJS.ProcessEnv = process.env): ClaudePlaces {
  const p: SessionCleanupPlaces = defaultSessionCleanupPlaces(env);
  return { claudeDir: join(p.projectsDir, '..'), projectsDir: p.projectsDir, litter: litterPrefixes(p) };
}

/** The project keys that hold a memory folder, Limn's own left out. */
export function memoryProjectKeys(places: ClaudePlaces): Set<string> {
  const out = new Set<string>();
  let names: string[];
  try {
    names = readdirSync(places.projectsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (places.litter.some((p) => name.startsWith(p))) continue;
    try {
      if (lstatSync(join(places.projectsDir, name, 'memory')).isDirectory()) out.add(name);
    } catch {
      /* no memory folder */
    }
  }
  return out;
}

export interface CollectedFile {
  /** Path relative to the source folder, `/`-separated. */
  rel: string;
  content: Buffer;
  /** The permission bits kept: 0o755 for an executable, else 0o644. */
  mode: number;
}

export interface Collected {
  files: CollectedFile[];
  bytes: number;
  /** Files left out for a cap, a name or their type. */
  skipped: number;
}

const SAFE_NAME = /^[^\0/\\]{1,255}$/;

/** Every regular file under `root`, capped. Folders that start with `.` are skipped. */
export function collectFiles(
  root: string,
  caps: { fileMax: number; totalMax: number; maxFiles?: number; maxDepth?: number },
): Collected {
  const out: Collected = { files: [], bytes: 0, skipped: 0 };
  const maxFiles = caps.maxFiles ?? COPY_MAX_FILES;
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (!SAFE_NAME.test(name) || name === '.' || name === '..') {
        out.skipped += 1;
        continue;
      }
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name.startsWith('.') || name === 'node_modules' || depth >= (caps.maxDepth ?? 8)) {
          out.skipped += 1;
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      if (!st.isFile() || st.size > caps.fileMax || out.bytes + st.size > caps.totalMax || out.files.length >= maxFiles) {
        out.skipped += 1;
        continue;
      }
      try {
        const content = readFileSync(full);
        out.files.push({ rel: relative(root, full).split(sep).join('/'), content, mode: st.mode & 0o111 ? 0o755 : 0o644 });
        out.bytes += content.length;
      } catch {
        out.skipped += 1;
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Count of memory files (regular, any depth) of one project. */
export function memoryCount(places: ClaudePlaces, key: string): number {
  return collectFiles(join(places.projectsDir, key, 'memory'), { fileMax: Number.MAX_SAFE_INTEGER, totalMax: Number.MAX_SAFE_INTEGER, maxFiles: 10_000 })
    .files.length;
}

export function readMemories(places: ClaudePlaces, key: string): Collected {
  return collectFiles(join(places.projectsDir, key, 'memory'), { fileMax: MEMORY_FILE_MAX_BYTES, totalMax: MEMORY_TOTAL_MAX_BYTES });
}

export function readUserClaudeMd(places: ClaudePlaces): Buffer | null {
  return readSmallFile(join(places.claudeDir, 'CLAUDE.md'), USER_CLAUDE_MD_MAX_BYTES);
}

export function readSmallFile(path: string, max: number): Buffer | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

/** The skill folders (`<claude>/skills/<name>/`), sorted. */
export function listUserSkills(places: ClaudePlaces): string[] {
  try {
    return readdirSync(join(places.claudeDir, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && SAFE_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function readUserSkills(places: ClaudePlaces): Collected {
  return collectFiles(join(places.claudeDir, 'skills'), { fileMax: SKILLS_FILE_MAX_BYTES, totalMax: SKILLS_TOTAL_MAX_BYTES });
}
