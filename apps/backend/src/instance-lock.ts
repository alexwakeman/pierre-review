// ONE BACKEND PER DATA DIRECTORY (docs/SANDBOX.md § Labels and the sweep, docs/TESTING.md § Scratch
// stack). Every mode: the installed CLI, `pnpm dev`, `pnpm dev:scratch`.
//
// The boot sweeps are keyed on the DATA DIRECTORY, not on the database: the sandbox sweep removes every
// container labelled with a hash of it, the worktree GC removes every clone-cache worktree its OWN
// ledger does not know, and the Claude session cleanup keeps its flag there. A second backend on the
// same data directory (a worktree's `pnpm dev:backend` with only PORT changed, the CLI next to
// `pnpm dev`) would therefore delete the first one's live sandboxes and kept worktrees. So the second
// one refuses to start instead.
//
// `<dataDir>/server.lock` holds `{ pid, port, dbPath, startedAt }`. It is created with O_EXCL. A lock
// whose pid is dead (a crash, a SIGKILL, a Ctrl-C that skipped the exit hook) is STALE and is taken
// over, so a crash never bricks the next boot. The lock is removed on exit when it is still ours.
//
// ⚠ A pid can be reused after a reboot. On macOS / Linux the holder must also LOOK like a Node process
// (`ps -o command=`), so an unrelated program that inherited the number does not hold the lock forever.
// ⚠ Taking over a stale lock is not atomic: two processes that both find the SAME dead lock at the
// same instant can both start. That needs a crash plus two starts in the same millisecond; accepted.
//
// No imports outside `node:*`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTANCE_LOCK_FILE = 'server.lock';

export interface InstanceLockInfo {
  pid: number;
  port: number;
  dbPath: string;
  startedAt: string;
}

export class InstanceLockedError extends Error {
  readonly holder: InstanceLockInfo | null;
  constructor(dataDir: string, holder: InstanceLockInfo | null) {
    const who = holder
      ? `process ${holder.pid}, port ${holder.port}, database ${holder.dbPath}`
      : 'a process that is starting now';
    super(
      `Another Limn is already running on the data folder ${dataDir} (${who}). ` +
        'Stop it first, or start this one with LIMN_DATA_DIR set to a different folder ' +
        '(`pnpm dev:scratch` does this for you).',
    );
    this.name = 'InstanceLockedError';
    this.holder = holder;
  }
}

export interface InstanceLockDeps {
  /** Is this pid a live process that could be a Limn backend? */
  isAlive: (pid: number) => boolean;
  /** The current pid (a test seam). */
  pid: number;
  now: () => number;
}

/** A pid is live when signal 0 reaches it (EPERM: it exists, but is not ours). */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** pidExists, and (where `ps` exists) the process is a Node program — a reused pid is not a holder. */
export function isLiveNodeProcess(pid: number): boolean {
  if (!pidExists(pid)) return false;
  if (process.platform === 'win32') return true;
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    if (!cmd.trim()) return false;
    return /node|tsx|limn/i.test(cmd);
  } catch {
    // `ps` missing or refused: trust the signal check.
    return true;
  }
}

const defaultDeps: InstanceLockDeps = { isAlive: isLiveNodeProcess, pid: process.pid, now: Date.now };

/** How long an EMPTY or unreadable lock file counts as "being written by a starting process". */
const UNREADABLE_GRACE_MS = 5_000;

function readHolder(path: string): InstanceLockInfo | null | 'missing' {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return null;
  }
  try {
    const v = JSON.parse(raw) as Partial<InstanceLockInfo>;
    if (typeof v.pid !== 'number') return null;
    return {
      pid: v.pid,
      port: typeof v.port === 'number' ? v.port : 0,
      dbPath: typeof v.dbPath === 'string' ? v.dbPath : '',
      startedAt: typeof v.startedAt === 'string' ? v.startedAt : '',
    };
  } catch {
    return null;
  }
}

export interface InstanceLock {
  path: string;
  /** Remove the lock file if it still names this process. Idempotent. */
  release: () => void;
  /** The stale holder this boot took over, when there was one. */
  tookOverFrom: InstanceLockInfo | null;
}

/**
 * Take `<dataDir>/server.lock`, or throw InstanceLockedError when a live backend holds it. A stale
 * lock (dead pid, or unreadable for longer than a few seconds) is taken over.
 */
export function acquireInstanceLock(
  dataDir: string,
  info: { port: number; dbPath: string },
  deps: InstanceLockDeps = defaultDeps,
): InstanceLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, INSTANCE_LOCK_FILE);
  const mine: InstanceLockInfo = {
    pid: deps.pid,
    port: info.port,
    dbPath: info.dbPath,
    startedAt: new Date(deps.now()).toISOString(),
  };
  const body = `${JSON.stringify(mine)}\n`;
  let tookOverFrom: InstanceLockInfo | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
      return { path, release: () => releaseIfMine(path, deps.pid), tookOverFrom };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const holder = readHolder(path);
    if (holder === 'missing') continue; // released between our create and our read: try again
    if (holder === null) {
      // Empty or unparseable: a starting process may be mid-write. Wait out a short grace.
      let age = Infinity;
      try {
        age = deps.now() - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age < UNREADABLE_GRACE_MS) throw new InstanceLockedError(dataDir, null);
    } else if (holder.pid === deps.pid) {
      // Our own lock (start() called twice in one process): keep it.
      writeFileSync(path, body, { mode: 0o600 });
      return { path, release: () => releaseIfMine(path, deps.pid), tookOverFrom };
    } else if (deps.isAlive(holder.pid)) {
      throw new InstanceLockedError(dataDir, holder);
    } else {
      tookOverFrom = holder;
    }
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new InstanceLockedError(dataDir, null);
}

function releaseIfMine(path: string, pid: number): void {
  const holder = readHolder(path);
  if (holder === 'missing' || holder === null || holder.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}
