import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getGithubToken } from '../github/auth.js';
import {
  assertCleanOrigin,
  cloneArgv,
  hasFreshWorktrees,
  liveWorktrees,
  tightenCloneRoot,
  tightenClonePerms,
} from './clone-hygiene.js';

// Re-exported so consumers see ONE clone API. The map itself lives in clone-hygiene.ts
// because the startup sweep needs it and this module imports that one, not the reverse.
export { liveWorktrees };

const execFileAsync = promisify(execFile);

/**
 * Run a git command. Args are passed as an array (never a shell string), so
 * there's no interpolation/injection surface. Bounded by a generous timeout
 * and a fat maxBuffer (clone/fetch can be chatty on stderr).
 */
async function git(args: string[], cwd?: string): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Serialise git PREP/CLEANUP (clone / fetch / worktree add+remove) PER REPO so
// concurrent reviews of PRs in the same repo don't race on git's index / worktree
// locks (`index.lock` exists, worktree-registry contention) once reviewConcurrency
// > 1. A simple promise-chain mutex keyed by `owner/name`; only this short prep
// phase serialises — the agent runs themselves (each in its own worktree) overlap.
const repoLocks = new Map<string, Promise<unknown>>();
export async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  // The map tail resolves when WE release, so the next caller queues behind us.
  repoLocks.set(key, prev.then(() => next));
  await prev.catch(() => {}); // our turn once the previous holder releases (ignore its error)
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Absolute path to a repo's long-lived partial clone under config.cloneDir. */
function repoCloneDir(owner: string, name: string): string {
  return join(config.cloneDir, `${owner}__${name}`);
}

/** A tokenized https URL for a repo (used per git op — NEVER persisted to disk). */
function tokenizedUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

/**
 * Ensure a long-lived partial clone for `owner/name` exists and return its
 * absolute path. Reused across runs — only the first call actually clones.
 *
 * The clone is blobless (`--filter=blob:none`) and has no working tree
 * (`--no-checkout`); ephemeral per-run worktrees provide the actual checkouts.
 *
 * The clone cache is keyed `owner__name` and SHARED across accounts (in cloud two
 * tenants can watch the same repo), so no credential may ever reach `.git/config`.
 * ⚠ THAT IS STRUCTURAL, NOT A CLEAN-UP: the clone runs with a process-scoped
 * `-c url.<tokenized>.insteadOf=` (see cloneArgv) and the POSITIONAL url is the plain
 * one, so there is nothing to strip afterwards. The predecessor cloned the tokenized
 * URL and rewrote `origin` in a `.catch(() => {})`; four clones on the author's machine
 * still carried a live `gho_` token. Every later fetch/push passes the caller's own
 * tokenized URL explicitly (see fetchPrHead / pushRef).
 *
 * The reuse path re-checks — a clone made by an older build, or by a crashed run, is
 * repaired or deleted before it is handed out. `token` defaults to the local gh token
 * (the Claude Review path); the Pro fixer passes a per-account token.
 */
export async function ensureClone(
  owner: string,
  name: string,
  token: string = getGithubToken(),
): Promise<string> {
  mkdirSync(config.cloneDir, { recursive: true, mode: 0o700 });
  tightenCloneRoot();
  const dir = repoCloneDir(owner, name);

  // Reuse an existing clone (presence of .git is our "already cloned" marker), but never
  // hand out one carrying a credential: repair it, and if the credential survives, drop the
  // clone and fall through to a fresh one.
  if (existsSync(join(dir, '.git'))) {
    const outcome = await assertCleanOrigin(dir, owner, name).catch(() => 'clean' as const);
    if (outcome !== 'removed') {
      tightenClonePerms(dir);
      return dir;
    }
  }

  await git(cloneArgv(owner, name, token, dir));
  // Fail closed: if a git version or a stray global `insteadOf` somehow persisted the
  // credential anyway, assertCleanOrigin deletes the clone — and then there is nothing to
  // return. Better a hard failure here than a token on disk.
  const outcome = await assertCleanOrigin(dir, owner, name);
  if (outcome === 'removed') {
    throw new Error(
      `refusing to use the clone of ${owner}/${name}: a credential survived in .git/config`,
    );
  }
  tightenClonePerms(dir);
  return dir;
}

/**
 * Fetch one remote ref into the clone under a CALLER-SUPPLIED local ref, and return the sha
 * it resolved to. Uses an explicit tokenized URL, never the token-less `origin`.
 *
 * ⚠ `destRef` is never optional and must never be FETCH_HEAD: the clone cache is shared
 * across accounts and jobs, and FETCH_HEAD is ONE FILE per repository — two concurrent
 * fetches and the second job checks out the first job's commit. Namespace it
 * (`refs/pierre/conflict/<sessionId>/…`); the startup sweep deletes that namespace, because
 * no job survives a restart.
 */
export async function fetchRefIntoClone(args: {
  cloneDir: string;
  owner: string;
  name: string;
  token: string;
  remoteRef: string;
  destRef: string;
}): Promise<string> {
  const { cloneDir, owner, name, token, remoteRef, destRef } = args;
  await git([
    '-C',
    cloneDir,
    'fetch',
    '--no-tags',
    '--force',
    tokenizedUrl(owner, name, token),
    `${remoteRef}:${destRef}`,
  ]);
  const { stdout } = await execFileAsync('git', ['-C', cloneDir, 'rev-parse', destRef], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Fetch a PR's head ref into the clone's object store so its head commit
 * (`sha`) becomes resolvable for a worktree checkout. The current PR head
 * commit equals `pull/<n>/head`, so fetching that ref is sufficient.
 *
 * Fast path: if `sha` is already present in the local object store (a prior
 * review of the same head left it there), skip the network fetch entirely —
 * it's the dominant per-review network cost and is fully redundant when the
 * head hasn't moved.
 */
export async function fetchPrHead(
  repoCloneDir: string,
  owner: string,
  name: string,
  prNumber: number,
  sha: string,
  token: string = getGithubToken(),
): Promise<void> {
  if (await hasCommit(repoCloneDir, sha)) return;
  // Fetch via an explicit tokenized URL (not the token-less `origin`) so no
  // credential is read from / written to the shared clone's config.
  await git([
    '-C',
    repoCloneDir,
    'fetch',
    '--no-tags',
    '--force',
    tokenizedUrl(owner, name, token),
    `pull/${prNumber}/head`,
  ]);
}

/** True if `sha` resolves to a commit object already in the local store. */
async function hasCommit(repoCloneDir: string, sha: string): Promise<boolean> {
  if (!sha) return false;
  try {
    await execFileAsync('git', ['-C', repoCloneDir, 'cat-file', '-e', `${sha}^{commit}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

// Monotonic within the process; paired with the pid it makes a worktree path unique across
// every run on the machine, which is what stops one run's cleanup landing on another's tree.
let worktreeSeq = 0;

/**
 * Create an ephemeral detached worktree at `<clone>/.worktrees/<sha>-<pid>-<n>` checked out
 * at `sha`, and return its absolute path.
 *
 * ⚠ THE PATH IS PER-RUN, NOT PER-SHA, AND NOTHING IS PRE-CLEARED. Keying on the sha alone
 * meant two runs on the same head shared one directory, and the `existsSync → removeWorktree`
 * pre-clear that made that "work" DESTROYED the tree a concurrent run was reading from. A
 * leftover from a crashed run is not this function's problem: the startup sweep and
 * `git worktree prune` collect it.
 */
export async function addWorktree(
  repoCloneDir: string,
  sha: string,
): Promise<string> {
  const worktreePath = join(
    repoCloneDir,
    '.worktrees',
    `${sha}-${process.pid}-${++worktreeSeq}`,
  );
  await git([
    '-C',
    repoCloneDir,
    'worktree',
    'add',
    '--detach',
    '--force',
    worktreePath,
    sha,
  ]);
  liveWorktrees.set(worktreePath, Date.now());
  return worktreePath;
}

/**
 * Tear down a per-run worktree. Best-effort: git's own removal is tried first,
 * then a raw directory delete as a fallback. Both swallow errors so cleanup in
 * a `finally` never masks the original failure.
 */
export async function removeWorktree(
  repoCloneDir: string,
  worktreePath: string,
): Promise<void> {
  liveWorktrees.delete(worktreePath);
  try {
    await git([
      '-C',
      repoCloneDir,
      'worktree',
      'remove',
      '--force',
      worktreePath,
    ]);
  } catch {
    /* git removal failed (already gone / locked) — fall through to rmSync */
  }
  try {
    rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  // The rmSync fallback deletes the directory but leaves git's registry entry behind, and a
  // stale entry keeps the repo looking busy. Prune here so the fallback path self-heals.
  await git(['-C', repoCloneDir, 'worktree', 'prune']).catch(() => {});
}

/**
 * Prepare a worktree for a review under the per-repo lock: ensure the clone, fetch
 * the PR head, add the worktree. Serialised per repo so several concurrent reviews
 * of the same repo can't collide on git locks; returns both the clone dir (for
 * later cleanup) and the worktree path the agent runs in.
 */
export async function prepWorktree(
  owner: string,
  name: string,
  prNumber: number,
  sha: string,
  token: string = getGithubToken(),
): Promise<{ repoCloneDir: string; worktreePath: string }> {
  return withRepoLock(`${owner}/${name}`, async () => {
    const dir = await ensureClone(owner, name, token);
    await fetchPrHead(dir, owner, name, prNumber, sha, token);
    const worktreePath = await addWorktree(dir, sha);
    return { repoCloneDir: dir, worktreePath };
  });
}

/**
 * Prepare a worktree checked out at the tip of an arbitrary REF (e.g. the trunk
 * branch), under the per-repo lock. Fetches `ref` via an explicit tokenized URL (never
 * the token-less origin), resolves FETCH_HEAD, and adds a detached worktree there.
 * Used by the AI-Fix trunk-reconciliation path (coding/merge.ts pushResolved) which
 * needs a checkout at the trunk tip rather than the PR head. Returns the resolved sha
 * too. Throws if the ref can't be fetched.
 */
export async function prepWorktreeAtRef(
  owner: string,
  name: string,
  ref: string,
  token: string = getGithubToken(),
): Promise<{ repoCloneDir: string; worktreePath: string; sha: string }> {
  return withRepoLock(`${owner}/${name}`, async () => {
    const dir = await ensureClone(owner, name, token);
    await git([
      '-C',
      dir,
      'fetch',
      '--no-tags',
      '--force',
      tokenizedUrl(owner, name, token),
      ref,
    ]);
    const { stdout } = await execFileAsync(
      'git',
      ['-C', dir, 'rev-parse', 'FETCH_HEAD'],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    const sha = stdout.trim();
    const worktreePath = await addWorktree(dir, sha);
    return { repoCloneDir: dir, worktreePath, sha };
  });
}

/** Tear down a per-run worktree under the per-repo lock (matches prepWorktree). */
export async function removeWorktreeLocked(
  owner: string,
  name: string,
  repoCloneDir: string,
  worktreePath: string,
): Promise<void> {
  await withRepoLock(`${owner}/${name}`, () => removeWorktree(repoCloneDir, worktreePath));
}

/** Recursively sum file sizes and track the most-recent mtime under `dir`. */
function walkSize(dir: string): { bytes: number; mtimeMs: number } {
  let bytes = 0;
  let mtimeMs = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { bytes, mtimeMs };
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
    if (st.isDirectory()) {
      const sub = walkSize(full);
      bytes += sub.bytes;
      mtimeMs = Math.max(mtimeMs, sub.mtimeMs);
    } else {
      bytes += st.size;
    }
  }
  return { bytes, mtimeMs };
}

/**
 * Best-effort LRU eviction of the clone cache. Synchronous and never throws.
 * If the total size of all repo clones exceeds config.cloneCacheMaxBytes,
 * delete whole repo dirs oldest-mtime-first until back under the cap.
 *
 * ⚠ "In use" is `hasFreshWorktrees`, NOT "`.worktrees/` is non-empty". Under the old test a
 * SINGLE orphan left by a crashed run exempted its repo from eviction permanently, so the
 * cache grew past the cap with nothing to show for it. `now` is a parameter so a test can
 * age a worktree without touching the clock.
 */
export function cleanupCloneCache(now: number = Date.now()): void {
  try {
    if (!existsSync(config.cloneDir)) return;

    // Size + recency for each immediate child repo dir.
    const repos: { dir: string; bytes: number; mtimeMs: number }[] = [];
    let totalBytes = 0;
    for (const entry of readdirSync(config.cloneDir)) {
      const dir = join(config.cloneDir, entry);
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const { bytes, mtimeMs } = walkSize(dir);
      totalBytes += bytes;
      repos.push({ dir, bytes, mtimeMs });
    }

    if (totalBytes <= config.cloneCacheMaxBytes) return;

    // Evict least-recently-used first, skipping in-use clones.
    repos.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const repo of repos) {
      if (totalBytes <= config.cloneCacheMaxBytes) break;
      if (hasFreshWorktrees(repo.dir, now)) continue;
      try {
        rmSync(repo.dir, { recursive: true, force: true });
        totalBytes -= repo.bytes;
      } catch {
        /* couldn't delete this one — leave it and move on */
      }
    }
  } catch {
    /* cleanup is advisory; never let it break a review run */
  }
}
