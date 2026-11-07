// LIMN'S CLAUDE SESSION LITTER — the one-off cleanup of `~/.claude/projects`.
//
// Before `persistSession: false` (ai/agent-isolation.ts `NO_SESSION_FILES`), every Agent SDK run
// saved its transcript under `~/.claude/projects/<encoded cwd>/`. Limn's runs work in throw-away
// directories (clone-cache worktrees, the docs library's staging dirs, `$TMPDIR/limn-*` and
// `$TMPDIR/pierre-*`), so each run left a NEW directory: ~2,000 / 3.5 GB measured on one machine.
// New runs write nothing; this module removes what older runs left.
//
// ⚠ IT DELETES ONLY WHAT IS PROVABLY LIMN'S, BY NAME. Claude Code names a project directory by its
// working directory with every non-alphanumeric character replaced by `-` (`projectKey`). A
// directory is removed ONLY when its name starts with:
//   (a) the key of Limn's data directory + `-` (`~/.limn` → `-Users-alex--limn-`), or the legacy
//       `~/.pierre-review`; refused when that data directory is `/`, the home directory or an
//       ancestor of it, or an ancestor of the temp dir (a custom LIMN_DATA_DIR there would match the
//       reader's own projects);
//   (b) the key of the OS temp dir + `-limn-` or `-pierre-` — the prefixes of every temp dir Limn's
//       runs are given (`mkdtemp(join(tmpdir(), 'limn-…' | 'pierre-…'))`). Both `os.tmpdir()` and its
//       realpath are tried: on macOS `/var/…` is `/private/var/…`, and the CLI records the real one.
// ⚠ The name is LOSSY (`~/.limn.bak/x` has a key that starts like `~/.limn`'s), so a directory whose
// transcripts record a working directory that is NOT Limn's is kept (`recordedCwds`, `isLimnCwd`).
// Anything else — the reader's own projects, `$TMPDIR/stories-agent-*`, the bare temp dir — is
// never touched. Only real directories go (a symlink is skipped, never followed).
//
// It runs ONCE per machine: at boot (index.ts, in the background after listen, bounded by
// `maxMs`) and on demand as `limn ai clean-sessions [--dry-run]`. A completed real run writes a
// flag file in the data directory so later boots do not rescan; a run that stopped at its time
// limit writes none, so the next boot carries on.
//
// No imports outside `node:*` and data-dir.ts, so cli.ts can load it before config.ts.
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LEGACY_DATA_DIR_NAME, resolveDataDir } from '../data-dir.js';

/** Bump when the matching rules change, so a machine cleaned under the old rules runs once more. */
export const SESSION_CLEANUP_VERSION = 1;
/** The one-time flag, in the data directory. */
export const SESSION_CLEANUP_FLAG = 'claude-sessions-cleaned.json';
/** The boot run's time limit. */
export const SESSION_CLEANUP_BOOT_MAX_MS = 120_000;

/** Claude Code's project directory name for a working directory. */
export function projectKey(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface SessionCleanupPlaces {
  /** `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`). */
  projectsDir: string;
  /** Limn's data directory (also where the flag lives). */
  dataDir: string;
  home: string;
  /** `os.tmpdir()` and its realpath (deduplicated). */
  tmpDirs: string[];
}

export function defaultSessionCleanupPlaces(env: NodeJS.ProcessEnv = process.env): SessionCleanupPlaces {
  const home = homedir();
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : join(home, '.claude');
  const t = tmpdir();
  let real = t;
  try {
    real = realpathSync(t);
  } catch {
    /* keep the plain one */
  }
  return { projectsDir: join(claudeDir, 'projects'), dataDir: resolveDataDir(env, home), home, tmpDirs: [...new Set([t, real])] };
}

/** `a` is `b` or contains it. */
function isAncestorOrSelf(a: string, b: string): boolean {
  const r = relative(resolve(a), resolve(b));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** Limn's data directories that are safe to match (see (a) above). */
function safeDataDirs(p: Omit<SessionCleanupPlaces, 'projectsDir'>): string[] {
  const out: string[] = [];
  for (const dir of [p.dataDir, join(p.home, LEGACY_DATA_DIR_NAME)]) {
    const d = resolve(dir);
    const unsafe =
      d === resolve('/') || isAncestorOrSelf(d, p.home) || p.tmpDirs.some((t) => isAncestorOrSelf(d, t));
    if (!unsafe) out.push(d);
  }
  return out;
}

/** The name prefixes that mark a directory as Limn's. */
export function litterPrefixes(p: Omit<SessionCleanupPlaces, 'projectsDir'>): string[] {
  const out: string[] = [];
  for (const d of safeDataDirs(p)) out.push(`${projectKey(d)}-`);
  for (const t of p.tmpDirs) {
    const k = projectKey(resolve(t));
    out.push(`${k}-limn-`, `${k}-pierre-`);
  }
  return [...new Set(out)];
}

/** True when a recorded working directory is one of Limn's (inside its data dir, or a `limn-` /
 *  `pierre-` folder directly in the temp dir). */
export function isLimnCwd(cwd: string, p: Omit<SessionCleanupPlaces, 'projectsDir'>): boolean {
  if (!isAbsolute(cwd)) return false;
  const c = resolve(cwd);
  if (safeDataDirs(p).some((d) => c !== d && isAncestorOrSelf(d, c))) return true;
  return p.tmpDirs.some((t) => {
    const r = relative(resolve(t), c);
    if (r === '' || r.startsWith('..') || isAbsolute(r)) return false;
    const first = r.split(/[\\/]/)[0] ?? '';
    return first.startsWith('limn-') || first.startsWith('pierre-');
  });
}

/**
 * The working directories the CLI recorded in a project directory's transcripts (the `cwd` field of
 * the first lines of up to three top-level `.jsonl` files). ⚠ The name is LOSSY (`~/.limn.bak` and
 * `~/.limn/bak` share a key), so a recorded `cwd` that is NOT Limn's keeps the directory.
 */
export function recordedCwds(dir: string): string[] {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().slice(0, 3);
  } catch {
    return [];
  }
  for (const f of files) {
    let head: string;
    try {
      const fd = openSync(join(dir, f), 'r');
      try {
        const buf = Buffer.alloc(64 * 1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        head = buf.subarray(0, n).toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      continue;
    }
    for (const m of head.matchAll(/"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
      try {
        const v = JSON.parse(m[1]!) as unknown;
        if (typeof v === 'string' && v !== '') out.add(v);
      } catch {
        /* not a JSON string */
      }
    }
  }
  return [...out];
}

export interface SessionCleanupReport {
  /** Directory names removed (or, on a dry run, that would be). */
  matched: string[];
  /** How many directories were left alone. */
  kept: number;
  removed: number;
  failed: number;
  dryRun: boolean;
  /** Stopped at the time limit before every match was removed. */
  timedOut: boolean;
  /** No `projects` directory at all. */
  missing: boolean;
}

/** Scan (and, unless `dryRun`, delete) the litter. Never throws for one entry. */
export async function cleanSessionLitter(
  places: SessionCleanupPlaces,
  opts: { dryRun?: boolean; maxMs?: number; now?: () => number } = {},
): Promise<SessionCleanupReport> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? Date.now;
  const deadline = opts.maxMs !== undefined ? now() + opts.maxMs : Infinity;
  const report: SessionCleanupReport = { matched: [], kept: 0, removed: 0, failed: 0, dryRun, timedOut: false, missing: false };
  let names: string[];
  try {
    names = readdirSync(places.projectsDir);
  } catch {
    report.missing = true;
    return report;
  }
  const prefixes = litterPrefixes(places);
  for (const name of names.sort()) {
    const ours = prefixes.some((p) => name.startsWith(p));
    let isDir = false;
    try {
      isDir = lstatSync(join(places.projectsDir, name)).isDirectory();
    } catch {
      /* gone */
    }
    if (!ours || !isDir || recordedCwds(join(places.projectsDir, name)).some((c) => !isLimnCwd(c, places))) {
      report.kept++;
      continue;
    }
    report.matched.push(name);
  }
  if (dryRun) return report;
  for (const name of report.matched) {
    if (now() >= deadline) {
      report.timedOut = true;
      break;
    }
    try {
      await rm(join(places.projectsDir, name), { recursive: true, force: true });
      report.removed++;
    } catch {
      report.failed++;
    }
  }
  return report;
}

export function sessionCleanupDone(dataDir: string): boolean {
  const f = join(dataDir, SESSION_CLEANUP_FLAG);
  if (!existsSync(f)) return false;
  try {
    const { version } = JSON.parse(readFileSync(f, 'utf8')) as { version?: unknown };
    return version === SESSION_CLEANUP_VERSION;
  } catch {
    return false;
  }
}

/** Write the one-time flag after a COMPLETE real run (nothing timed out, nothing failed). */
export function recordSessionCleanup(dataDir: string, r: SessionCleanupReport, at: Date = new Date()): boolean {
  if (r.dryRun || r.timedOut || r.failed > 0) return false;
  try {
    writeFileSync(
      join(dataDir, SESSION_CLEANUP_FLAG),
      `${JSON.stringify({ version: SESSION_CLEANUP_VERSION, at: at.toISOString(), removed: r.removed })}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * The boot run: once per machine, in the background, bounded. Returns the report, or null when the
 * flag says it already ran (or the data directory is missing). Never throws.
 */
export async function runBootSessionCleanup(
  places: SessionCleanupPlaces = defaultSessionCleanupPlaces(),
  maxMs: number = SESSION_CLEANUP_BOOT_MAX_MS,
): Promise<SessionCleanupReport | null> {
  try {
    if (!existsSync(places.dataDir) || sessionCleanupDone(places.dataDir)) return null;
    const r = await cleanSessionLitter(places, { maxMs });
    recordSessionCleanup(places.dataDir, r);
    return r;
  } catch {
    return null;
  }
}
