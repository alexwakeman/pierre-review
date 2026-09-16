import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.js';
import { hasFreshWorktrees } from '../review/clone-hygiene.js';
import { cleanupCloneCache, withRepoLock } from '../review/clone-manager.js';
import { liveSessionIds, runningJobCount } from './session.js';

/**
 * THE CLONE-CACHE JANITOR — what makes the resolver safe to leave running.
 *
 * Every opened resolver fetches two refs into the shared clone
 * (`refs/pierre/conflict/<sessionId>/{head,base}`, review/clone-manager.ts). ONLY the commit path
 * deletes them, in `land.ts`'s `finally` — so a reader who opens the resolver, looks, and closes
 * the tab leaves two refs behind, and each ref pins the objects it names against every repack.
 * Nothing collected those until the next restart. On a developer's laptop that is the next
 * `pnpm dev`; on a server it is never, and the disk grows with every session anyone ever opened.
 *
 * This is the same work the boot sweep does (`review/clone-hygiene.ts`), on a clock, with the one
 * difference that matters:
 *
 * ⚠ IT MUST EXCLUDE LIVE SESSIONS. At boot every conflict ref is an orphan BY DEFINITION, because
 * no job survives a restart — so the boot sweep deletes the whole namespace unconditionally and is
 * right to. A running process is the opposite case: a session sitting at `ready` for twenty
 * minutes still owns its two refs, and its commit re-reads them. Deleting those mid-resolution
 * breaks a resolution somebody is in the middle of. `liveSessionIds()` is the keep-list, and it is
 * read INSIDE the per-repo lock so a session that starts mid-sweep cannot have written a ref we
 * are about to decide on.
 *
 * ⚠ SEQUENTIAL, ONE CLONE AT A TIME, AND DO NOT PARALLELISE IT. MEASURED in this repo: 16
 * concurrent `git config` calls took 1,779ms against 131ms for one — git does not scale with
 * concurrency here the way an ordinary process does. A worker pool over the same cache came out
 * inside the noise of running it straight through. The full argument is in clone-hygiene.ts.
 *
 * ⚠ ONE PROCESS, ONE CACHE. The keep-list is this process's in-memory session map. That is exact
 * because the clone cache lives on the container's own filesystem and is never shared between
 * replicas or between deploys — the reason `config.cloneDir` is ephemeral in cloud and NOT a
 * mounted volume. A shared volume would make this keep-list wrong, which is one more reason not
 * to add one.
 */

const execFileAsync = promisify(execFile);

async function gitOut(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export interface ConflictJanitorReport {
  clonesScanned: number;
  /** Refs belonging to sessions that no longer exist, deleted. */
  refsDeleted: number;
  /** Refs left alone because their session is still open. */
  refsKept: number;
  reposGarbageCollected: number;
}

const EMPTY: ConflictJanitorReport = {
  clonesScanned: 0,
  refsDeleted: 0,
  refsKept: 0,
  reposGarbageCollected: 0,
};

const REF_PREFIX = 'refs/pierre/conflict/';

/**
 * The session id inside one conflict ref, or null.
 *
 * The layout is `refs/pierre/conflict/<sessionId>/<head|base>`. Anything shorter or shaped
 * differently is not ours to reason about, and an unrecognised ref is KEPT — a janitor that
 * guesses deletes somebody's objects.
 */
export function sessionIdOfRef(ref: string): string | null {
  if (!ref.startsWith(REF_PREFIX)) return null;
  const rest = ref.slice(REF_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

/** Loose objects in this clone, per `git count-objects -v`. -1 when git could not be asked. */
async function looseObjectCount(dir: string): Promise<number> {
  try {
    const out = await gitOut(['count-objects', '-v'], dir);
    for (const line of out.split('\n')) {
      if (line.startsWith('count:')) {
        const n = Number.parseInt(line.slice('count:'.length).trim(), 10);
        return Number.isFinite(n) ? n : -1;
      }
    }
  } catch {
    /* an unreadable clone is the LRU's problem, not this step's */
  }
  return -1;
}

/**
 * One clone's whole unit of work, UNDER ITS REPO LOCK.
 *
 * The lock is the same `withRepoLock` every resolver and every fix takes, keyed `owner/name`, so
 * this cannot run while a build is fetching into the clone it is deleting refs out of. It is also
 * why the keep-list is read here rather than once for the whole sweep.
 */
async function sweepOneClone(
  dir: string,
  owner: string,
  name: string,
): Promise<ConflictJanitorReport> {
  return withRepoLock(`${owner}/${name}`, async () => {
    const report: ConflictJanitorReport = { ...EMPTY, clonesScanned: 1 };
    const live = liveSessionIds();

    let refs: string[] = [];
    try {
      refs = (await gitOut(['for-each-ref', '--format=%(refname)', REF_PREFIX], dir))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      // Can't read this clone's refs — leave the whole clone to the next tick. Falling through
      // to gc on a repository we could not enumerate is how a janitor prunes something live.
      return report;
    }

    for (const ref of refs) {
      const sessionId = sessionIdOfRef(ref);
      if (sessionId == null || live.has(sessionId)) {
        report.refsKept += 1;
        continue;
      }
      try {
        await gitOut(['update-ref', '-d', ref], dir);
        report.refsDeleted += 1;
      } catch {
        /* another tick will get it */
      }
    }

    // ⚠ GC ONLY WHEN NOTHING IS RUNNING ANYWHERE. `--prune=now` drops unreachable objects with no
    // grace period, and a repack on a large repository is tens of seconds during which this lock
    // is held — which a reader opening the resolver on this repo would wait behind. Both reasons
    // point the same way: when the process is busy, do it next tick. Under the threshold gc
    // repacks nothing and costs a ~120ms spawn, so the count is checked first.
    //
    // ⚠ TWO SEPARATE "BUSY" TESTS, AND BOTH ARE NEEDED. `runningJobCount()` sees RESOLVER jobs
    // only; the same clones are also used by the AI fixer and Claude Review, which hold live
    // WORKTREES outside this lock. `hasFreshWorktrees` is the one test that sees those (identity
    // first, then the TTL — clone-hygiene.ts), so a repack never runs under an agent's checkout.
    if (runningJobCount() === 0 && !hasFreshWorktrees(dir, Date.now())) {
      const loose = await looseObjectCount(dir);
      if (loose > config.cloneGcLooseObjects) {
        try {
          await gitOut(['gc', '--prune=now', '--quiet'], dir);
          report.reposGarbageCollected += 1;
        } catch {
          /* best effort — the LRU is the backstop for disk */
        }
      }
    }
    return report;
  });
}

/**
 * Whether a tick is already in flight.
 *
 * ⚠ SET AND RELEASED IN A try/finally SO EVERY BAIL PATH RELEASES IT, thrown lookups included.
 * The standing rule in this codebase, and the reason is that a leaked flag here is silent: the
 * cron keeps firing, every tick returns immediately, and the disk grows with nothing in the log.
 */
let running = false;

/**
 * Walk every clone in the cache once. Never throws and never runs twice at once.
 *
 * Returns the report so a test can assert on it; the caller logs only when it did something.
 */
export async function runConflictJanitorTick(
  log: FastifyBaseLogger,
): Promise<ConflictJanitorReport> {
  if (running) return { ...EMPTY };
  running = true;
  const total: ConflictJanitorReport = { ...EMPTY };
  try {
    let entries: string[];
    try {
      entries = readdirSync(config.cloneDir);
    } catch {
      return total; // no cache yet — nothing to clean, and that is not an error
    }

    for (const entry of entries) {
      const dir = join(config.cloneDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(join(dir, '.git'))) continue;
      // `owner__name` is the key `ensureClone` minted, and the FIRST `__` splits it: a GitHub
      // login cannot contain an underscore, a repository name can. Reconstructing it is what
      // lets this take the SAME lock key the resolver takes.
      const split = entry.indexOf('__');
      if (split <= 0) continue;

      const one = await sweepOneClone(dir, entry.slice(0, split), entry.slice(split + 2));
      total.clonesScanned += one.clonesScanned;
      total.refsDeleted += one.refsDeleted;
      total.refsKept += one.refsKept;
      total.reposGarbageCollected += one.reposGarbageCollected;
    }

    // The LRU last, on the sizes the steps above left behind: a clone that just lost its refs and
    // got repacked may now fit under the cap that would otherwise have evicted it. Synchronous,
    // swallows its own errors, and skips clones with live worktrees.
    cleanupCloneCache();
  } catch (err) {
    log.warn({ err }, 'conflict clone janitor failed');
  } finally {
    running = false;
  }
  return total;
}

/** Test seam only. */
export const __testing = {
  reset: (): void => {
    running = false;
  },
};
