// THE LOCAL DATA DIRECTORY — ~/.ensemble, and the one-time move from ~/.limn or ~/.pierre-review.
//
// Everything the app keeps on a user's machine lives under ONE directory: the installed CLI's SQLite
// database, the clone cache, `config.json` (the per-review budget), Codex's own home (`codex/`), and
// the AI and ML runtimes downloaded on first use (`ai-runtime/`, `ml-runtime/`, `ml-models/`). It was
// `~/.pierre-review` (package `pierre-review`), then `~/.limn` (package `limn-review`), and is
// `~/.ensemble` since the package became `ensemble-review`. Every path inside is computed from
// `resolveDataDir`, so all of it moves with the one rename below.
//
// ⚠ THE MOVE IS ONE `rename`, AND IT NEVER CLOBBERS. On the first local boot after the upgrade the
// NEWEST old directory that exists (`~/.limn`, else `~/.pierre-review`) is renamed to `~/.ensemble`
// — DB, WAL files, clones, config, everything, in one atomic step on the same filesystem (both live
// in the home directory). If `~/.ensemble` already exists nothing is moved and nothing is deleted:
// the old directory is simply left where it is. A copy-then-delete would be the dangerous version (a
// half-copied SQLite file next to a deleted original), which is why there is none.
//
// ⚠ AN EXPLICIT LOCATION WINS AND IS NEVER MIGRATED INTO. `ENSEMBLE_DATA_DIR` (or the older
// `LIMN_DATA_DIR`, env-name.ts) names the directory; when it is set this module moves nothing,
// because the user chose where their data lives. The finer overrides keep working on top of either:
// `DATABASE_URL` / `--db` (the database file) and `CLONE_DIR` (the clone cache).
//
// ⚠ A PINNED PATH INSIDE THE OLD DIRECTORY STOPS THE MOVE. An old README told people to pass
// `--db ~/.pierre-review/pierre-review.sqlite`, so a shell profile may still say so (or the same
// inside ~/.limn). Moving the directory out from under that value would make the next open CREATE
// an empty database at the old path while the real one sat unseen in ~/.ensemble. So nothing moves
// (`pinned_path`), and everything keeps using the old directory (below).
//
// ⚠ UNTIL THE MOVE HAS HAPPENED, THE OLD DIRECTORY IS THE DATA DIRECTORY. `resolveDataDir` answers
// the old directory while it exists and `~/.ensemble` does not — after a pinned path, or a rename
// that failed (Windows EBUSY on an open SQLite file, EXDEV, EACCES). Answering `~/.ensemble` there
// would create it, fresh and empty, and from then on every boot would stop at `target_exists` with
// the user's history stranded. Instead the next boot simply tries the move again.
//
// No imports outside `node:*` and env-name.ts (itself import-free), so cli.ts can load it before
// config.ts reads the environment.
import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { readEnv } from './env-name.js';

/** The directory name under the home directory. */
export const DATA_DIR_NAME = '.ensemble';
/** The earlier directory names, NEWEST first; the newest one that exists is moved once on boot. */
export const LEGACY_DATA_DIR_NAMES: readonly string[] = ['.limn', '.pierre-review'];

/** `ENSEMBLE_DATA_DIR`, else `LIMN_DATA_DIR`, trimmed; null when neither is set. */
function explicitDataDir(env: NodeJS.ProcessEnv): string | null {
  return readEnv(env, 'DATA_DIR')?.trim() || null;
}

/** The newest old directory that exists, or null. */
function existingLegacyDir(home: string): string | null {
  for (const name of LEGACY_DATA_DIR_NAMES) {
    const dir = join(home, name);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * The local data directory: `ENSEMBLE_DATA_DIR` / `LIMN_DATA_DIR` when set; else `~/.ensemble` when it
 * exists; else the newest old directory that exists (the move has not happened yet — see the
 * header); else `~/.ensemble`.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = explicitDataDir(env);
  if (explicit) return resolve(explicit);
  const target = join(home, DATA_DIR_NAME);
  if (existsSync(target)) return target;
  return existingLegacyDir(home) ?? target;
}

export type DataDirMigration =
  | { moved: true; from: string; to: string }
  | {
      moved: false;
      reason: 'explicit_dir' | 'no_legacy_dir' | 'target_exists' | 'pinned_path' | 'rename_failed';
      error?: string;
    };

/** The database file the CLI and the server open by default (the name predates both renames). */
export const DB_FILE = 'pierre-review.sqlite';

/**
 * THE REFERENCE-DOCS ROOT FOR ONE DATABASE (when ENSEMBLE_DOCS_DIR / LIMN_DOCS_DIR is not set). ⚠ Two databases never
 * share one: each one's boot janitor deletes every docs folder its own rows do not account for, so a
 * shared root let a second backend (a worktree's `pnpm dev`, the installed CLI) wipe the first one's
 * library (docs/REFERENCE-DOCS.md § On disk).
 *
 *   - The data directory's own database (`<dataDir>/pierre-review.sqlite`, the installed CLI's
 *     default) keeps `<dataDir>/docs` — where every installed library already is; nothing moves.
 *   - Any other database (`pnpm dev`'s `apps/backend/data/pierre-review.sqlite`, a `--db`, a
 *     DATABASE_URL) gets `<dataDir>/docs/db-<12 hex of sha256(absolute DB path)>`. The `db-` prefix
 *     keeps it non-numeric, so the default root's janitor — which only walks `<accountId>` folders,
 *     in this version and every earlier one — never enters it.
 */
export function defaultDocsDir(dbPath: string, dataDir: string): string {
  const abs = resolve(dbPath);
  const root = join(dataDir, 'docs');
  if (abs === join(resolve(dataDir), DB_FILE)) return root;
  return join(root, `db-${createHash('sha256').update(abs).digest('hex').slice(0, 12)}`);
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

// The same failure can be reported by the CLI's call and the server's; say it once per process.
const said = new Set<string>();

/**
 * Move the newest old directory (`~/.limn`, else `~/.pierre-review`) to `~/.ensemble`, once. Safe to
 * call on every boot: after the first move there is no old directory left, so it is two `existsSync`.
 */
export function migrateLegacyDataDir(
  opts: {
    env?: NodeJS.ProcessEnv;
    home?: string;
    log?: (msg: string) => void;
    /** How a relative `DATABASE_URL` / `CLONE_DIR` resolves. Default: against the CWD. */
    resolvePath?: (p: string) => string;
  } = {},
): DataDirMigration {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const say = (msg: string): void => {
    if (said.has(msg)) return;
    said.add(msg);
    opts.log?.(msg);
  };
  if (explicitDataDir(env)) return { moved: false, reason: 'explicit_dir' };
  const from = existingLegacyDir(home);
  const to = join(home, DATA_DIR_NAME);
  if (from == null) return { moved: false, reason: 'no_legacy_dir' };
  // Never clobber: an existing ~/.ensemble is the user's data too. The old directory stays as it
  // is — but a ~/.ensemble with no database next to an old one that has one is worth a line.
  if (existsSync(to)) {
    if (!existsSync(join(to, DB_FILE)) && existsSync(join(from, DB_FILE))) {
      say(
        `Your earlier data is still in ${from}, and ${to} already exists, so it was not moved. To use it, stop Ensemble and move ${join(from, DB_FILE)} into ${to}.`,
      );
    }
    return { moved: false, reason: 'target_exists' };
  }
  // A database or clone path pinned inside the old directory: moving it would orphan that path.
  const resolvePath = opts.resolvePath ?? ((p: string) => resolve(p));
  for (const key of ['DATABASE_URL', 'CLONE_DIR'] as const) {
    const raw = env[key]?.trim();
    if (raw && isInside(from, resolvePath(raw))) {
      say(
        `Your data stays in ${from} because ${key} points inside it. To move it to ${to}, stop Ensemble, move the folder, and update ${key}.`,
      );
      return { moved: false, reason: 'pinned_path' };
    }
  }
  try {
    renameSync(from, to);
  } catch (err) {
    // Leave everything where it was. `resolveDataDir` keeps answering the old directory while
    // ~/.ensemble does not exist, so this boot runs on the user's real data and the next one tries
    // the move again.
    const error = err instanceof Error ? err.message : String(err);
    say(`Could not move ${from} to ${to} (${error}). Ensemble is using ${from} for now and will try again next time.`);
    return { moved: false, reason: 'rename_failed', error };
  }
  say(`Moved your data from ${from} to ${to}.`);
  return { moved: true, from, to };
}
