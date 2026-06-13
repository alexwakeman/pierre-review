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
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

/**
 * Ensure a long-lived partial clone for `owner/name` exists and return its
 * absolute path. Reused across runs — only the first call actually clones.
 *
 * The clone is blobless (`--filter=blob:none`) and has no working tree
 * (`--no-checkout`); ephemeral per-run worktrees provide the actual checkouts.
 * The remote uses a tokenized https URL so private repos work without extra
 * auth wiring. That token persists only in this user's own ~/.pierre-review
 * clone config — acceptable for a local, single-user tool.
 */
export async function ensureClone(owner: string, name: string): Promise<string> {
  mkdirSync(config.cloneDir, { recursive: true });
  const dir = repoCloneDir(owner, name);

  // Reuse an existing clone (presence of .git is our "already cloned" marker).
  if (existsSync(join(dir, '.git'))) return dir;

  const token = getGithubToken();
  const url = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
  await git(['clone', '--filter=blob:none', '--no-checkout', url, dir]);
  return dir;
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
  prNumber: number,
  sha: string,
): Promise<void> {
  if (await hasCommit(repoCloneDir, sha)) return;
  await git([
    '-C',
    repoCloneDir,
    'fetch',
    '--no-tags',
    '--force',
    'origin',
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

/**
 * Create an ephemeral detached worktree at `<clone>/.worktrees/<sha>` checked
 * out at `sha`, and return its absolute path. If a stale worktree at that path
 * already exists it's removed first (best-effort) so the add can't collide.
 */
export async function addWorktree(
  repoCloneDir: string,
  sha: string,
): Promise<string> {
  const worktreePath = join(repoCloneDir, '.worktrees', sha);
  if (existsSync(worktreePath)) {
    // Clear a leftover from a crashed/aborted prior run; ignore failures.
    await removeWorktree(repoCloneDir, worktreePath);
  }
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
): Promise<{ repoCloneDir: string; worktreePath: string }> {
  return withRepoLock(`${owner}/${name}`, async () => {
    const dir = await ensureClone(owner, name);
    await fetchPrHead(dir, prNumber, sha);
    const worktreePath = await addWorktree(dir, sha);
    return { repoCloneDir: dir, worktreePath };
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

/** True if `repoDir` has a non-empty `.worktrees/` (a run may be in flight). */
function hasActiveWorktrees(repoDir: string): boolean {
  try {
    return readdirSync(join(repoDir, '.worktrees')).length > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort LRU eviction of the clone cache. Synchronous and never throws.
 * If the total size of all repo clones exceeds config.cloneCacheMaxBytes,
 * delete whole repo dirs oldest-mtime-first until back under the cap. Repo dirs
 * with live worktrees are treated as in-use and skipped.
 */
export function cleanupCloneCache(): void {
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
      if (hasActiveWorktrees(repo.dir)) continue;
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
