// THE LOCAL DATA DIRECTORY — ~/.limn, and the one-time move from ~/.pierre-review.
//
// Everything Limn keeps on a user's machine lives under ONE directory: the installed CLI's SQLite
// database, the clone cache, `config.json` (the per-review budget) and the AI runtime the agentic
// features download on first use (`ai-runtime/`, see ai/runtime.ts). Before the npm package was
// renamed `pierre-review` → `limn-review` that directory was `~/.pierre-review`.
//
// ⚠ THE MOVE IS ONE `rename`, AND IT NEVER CLOBBERS. On the first local boot after the upgrade an
// existing `~/.pierre-review` is renamed to `~/.limn` — DB, WAL files, clones, config, everything,
// in one atomic step on the same filesystem (both live in the home directory). If `~/.limn`
// already exists nothing is moved and nothing is deleted: the old directory is simply left where
// it is. A copy-then-delete would be the dangerous version (a half-copied SQLite file next to a
// deleted original), which is why there is none.
//
// ⚠ AN EXPLICIT LOCATION WINS AND IS NEVER MIGRATED INTO. `LIMN_DATA_DIR` names the directory; when
// it is set this module moves nothing, because the user chose where their data lives. The finer
// overrides keep working on top of either: `DATABASE_URL` / `--db` (the database file) and
// `CLONE_DIR` (the clone cache).
//
// ⚠ A PINNED PATH INSIDE THE OLD DIRECTORY STOPS THE MOVE. The old README told people to pass
// `--db ~/.pierre-review/pierre-review.sqlite`, so a shell profile may still say so. Moving the
// directory out from under that value would make the next open CREATE an empty database at the old
// path while the real one sat unseen in ~/.limn. So nothing moves (`pinned_path`), and everything
// keeps using the old directory (below).
//
// ⚠ UNTIL THE MOVE HAS HAPPENED, THE OLD DIRECTORY IS THE DATA DIRECTORY. `resolveDataDir` answers
// `~/.pierre-review` while it exists and `~/.limn` does not — after a pinned path, or a rename that
// failed (Windows EBUSY on an open SQLite file, EXDEV, EACCES). Answering `~/.limn` there would
// create it, fresh and empty, and from then on every boot would stop at `target_exists` with the
// user's history stranded. Instead the next boot simply tries the move again.
//
// No imports outside `node:*`, so cli.ts can load it before config.ts reads the environment.
import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

/** The directory name under the home directory. */
export const DATA_DIR_NAME = '.limn';
/** The pre-rename directory name, moved once on first boot. */
export const LEGACY_DATA_DIR_NAME = '.pierre-review';

/**
 * The local data directory: `LIMN_DATA_DIR` when set; else `~/.pierre-review` while it exists and
 * `~/.limn` does not (the move has not happened yet — see the header); else `~/.limn`.
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const explicit = env.LIMN_DATA_DIR?.trim();
  if (explicit) return resolve(explicit);
  const target = join(home, DATA_DIR_NAME);
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  if (existsSync(legacy) && !existsSync(target)) return legacy;
  return target;
}

export type DataDirMigration =
  | { moved: true; from: string; to: string }
  | {
      moved: false;
      reason: 'explicit_dir' | 'no_legacy_dir' | 'target_exists' | 'pinned_path' | 'rename_failed';
      error?: string;
    };

/** The database file the CLI and the server open by default (the name predates the rename). */
const DB_FILE = 'pierre-review.sqlite';

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

// The same failure can be reported by the CLI's call and the server's; say it once per process.
const said = new Set<string>();

/**
 * Move `~/.pierre-review` to `~/.limn`, once. Safe to call on every boot: after the first move
 * there is no legacy directory left, so it is a single `existsSync`.
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
  if (env.LIMN_DATA_DIR?.trim()) return { moved: false, reason: 'explicit_dir' };
  const from = join(home, LEGACY_DATA_DIR_NAME);
  const to = join(home, DATA_DIR_NAME);
  if (!existsSync(from)) return { moved: false, reason: 'no_legacy_dir' };
  // Never clobber: an existing ~/.limn is the user's data too. The old directory stays as it is —
  // but a ~/.limn with no database next to an old one that has one is worth a line.
  if (existsSync(to)) {
    if (!existsSync(join(to, DB_FILE)) && existsSync(join(from, DB_FILE))) {
      say(
        `Your earlier Limn data is still in ${from}, and ${to} already exists, so it was not moved. To use it, stop Limn and move ${join(from, DB_FILE)} into ${to}.`,
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
        `Your data stays in ${from} because ${key} points inside it. To move it to ${to}, stop Limn, move the folder, and update ${key}.`,
      );
      return { moved: false, reason: 'pinned_path' };
    }
  }
  try {
    renameSync(from, to);
  } catch (err) {
    // Leave everything where it was. `resolveDataDir` keeps answering the old directory while
    // ~/.limn does not exist, so this boot runs on the user's real data and the next one tries
    // the move again.
    const error = err instanceof Error ? err.message : String(err);
    say(`Could not move ${from} to ${to} (${error}). Limn is using ${from} for now and will try again next time.`);
    return { moved: false, reason: 'rename_failed', error };
  }
  say(`Moved your Limn data from ${from} to ${to}.`);
  return { moved: true, from, to };
}
