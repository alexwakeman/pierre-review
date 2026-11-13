// STORY CHAT — THE SHARED REPOSITORY TREES (docs/STORY-CHAT.md § Shared trees). A chat reads every
// workspace repository at its default branch. Instead of a fresh worktree per chat (a fetch round trip
// and a full file copy per repository, every time), each repository's default branch is kept as ONE
// read-only folder per commit, shared by every chat:
//
//   <dataDir>/chat-trees/<owner>__<name>/<sha>/       the files at that commit (no .git), immutable
//   <dataDir>/chat-trees/<owner>__<name>/<sha>.part-…  being written (removed at boot)
//
//   acquire    the tree for the commit sync last saw (`repos.defaultBranchHeadSha`) when it is there —
//              no git work, no network; else the newest tree there is (a refresh is started in the
//              background); else one is built now (the first chat on this repository).
//   refresh    sync saw the default branch move (sync/branch-status.ts) → for a repository that already
//              has a tree, the new commit's tree is built in the background, one at a time.
//   prune      a tree goes when a newer one is complete and no live chat holds it; at boot, every
//              repository keeps only its newest tree, and repositories Limn no longer has go.
//
// READ-ONLY by construction: the chat agent has no shell and no write tool, and the path guard treats
// every root as read-only, so sharing one folder between chats is safe. Building a tree checks the
// commit out through the clone cache (a worktree, which fetches the blobs in batches) and COPIES its
// files out, so a tree never depends on the clone cache, whose LRU may evict a clone at any time.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../config.js';
import { prepDefaultBranchCheckouts } from '../review/clone-manager.js';
import { withWorktreeOwner } from '../review/worktree-owner.js';

const COMPLETE = '.limn-tree-complete';
const SHA = /^[0-9a-f]{40}$/;

export interface TreeRepo {
  owner: string;
  name: string;
  /** The default branch; null = the remote's HEAD. */
  branch: string | null;
  /** The commit sync last saw at the default branch's tip, when known. */
  headSha: string | null;
}

export interface AcquiredTree {
  path: string;
  sha: string;
  /** The tree was older than sync's commit (a refresh is under way). */
  stale: boolean;
  release(): void;
}

// ---- seams (tests) ------------------------------------------------------------------------------

export interface TreeDeps {
  root(): string;
  /** Check the default branch out (a worktree) and say at which commit; `cleanup` removes it. */
  checkout(repo: TreeRepo): Promise<{ path: string | null; sha: string | null; error: string | null; cleanup: () => Promise<void> }>;
}

const realDeps: TreeDeps = {
  root: () => join(config.dataDir, 'chat-trees'),
  async checkout(repo) {
    const { checkouts, cleanup } = await withWorktreeOwner({ kind: 'chat' }, () =>
      prepDefaultBranchCheckouts([{ owner: repo.owner, name: repo.name, branch: repo.branch }]),
    );
    const c = checkouts[0];
    return { path: c?.path ?? null, sha: c?.sha ?? null, error: c?.error ?? 'checkout failed', cleanup };
  },
};
let deps: TreeDeps = realDeps;
export function setTreeDepsForTest(d: Partial<TreeDeps> | null): void {
  deps = d == null ? realDeps : { ...realDeps, ...d };
}

// ---- state ----------------------------------------------------------------------------------------

/** Live holds per tree path. */
const holds = new Map<string, number>();
/** One build per repository at a time. */
const building = new Map<string, Promise<string | null>>();

const repoKey = (owner: string, name: string): string => `${owner}__${name}`.toLowerCase();
const repoDir = (owner: string, name: string): string => join(deps.root(), repoKey(owner, name));

function isComplete(dir: string): boolean {
  return existsSync(join(dir, COMPLETE));
}

/** The complete trees of a repository, newest first (by when they were finished). */
export function treesOf(owner: string, name: string): Array<{ sha: string; path: string; at: number }> {
  const dir = repoDir(owner, name);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => SHA.test(n) && isComplete(join(dir, n)))
    .map((n) => ({ sha: n, path: join(dir, n), at: statSync(join(dir, n, COMPLETE)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

/** Does any chat use this repository (a complete tree exists)? Cheap: one directory read. */
export function hasTrees(owner: string, name: string): boolean {
  return treesOf(owner, name).length > 0;
}

/** Build the tree of the branch's CURRENT tip (or reuse it). Returns its path, or null on failure. */
function build(repo: TreeRepo): Promise<string | null> {
  const key = repoKey(repo.owner, repo.name);
  const running = building.get(key);
  if (running) return running;
  const p = (async (): Promise<string | null> => {
    const co = await deps.checkout(repo);
    try {
      if (!co.path || !co.sha || !SHA.test(co.sha)) return null;
      const dir = repoDir(repo.owner, repo.name);
      const target = join(dir, co.sha);
      if (isComplete(target)) return target;
      mkdirSync(dir, { recursive: true });
      const part = `${target}.part-${process.pid}-${Date.now()}`;
      // The files only: `.git` (a worktree's pointer file) stays behind.
      await cp(co.path, part, { recursive: true, filter: (src) => !/[\\/]\.git$/.test(src) });
      writeFileSync(join(part, COMPLETE), `${co.sha}\n`);
      rmSync(target, { recursive: true, force: true });
      renameSync(part, target);
      return target;
    } finally {
      await co.cleanup().catch(() => {});
    }
  })()
    .catch(() => null)
    .finally(() => {
      building.delete(key);
      prune(repo.owner, repo.name);
    });
  building.set(key, p);
  return p;
}

function hold(path: string, sha: string, stale: boolean): AcquiredTree {
  holds.set(path, (holds.get(path) ?? 0) + 1);
  let released = false;
  return {
    path,
    sha,
    stale,
    release() {
      if (released) return;
      released = true;
      const n = (holds.get(path) ?? 1) - 1;
      if (n <= 0) holds.delete(path);
      else holds.set(path, n);
    },
  };
}

/**
 * The repository's tree for a chat. Fast path: the tree of sync's commit is there. Otherwise the newest
 * tree is used at once and a refresh starts; with no tree at all, one is built now. null on failure.
 */
export async function acquireTree(repo: TreeRepo): Promise<AcquiredTree | null> {
  const trees = treesOf(repo.owner, repo.name);
  const want = repo.headSha && SHA.test(repo.headSha) ? trees.find((t) => t.sha === repo.headSha) : undefined;
  if (want) return hold(want.path, want.sha, false);
  const newest = trees[0];
  if (newest) {
    // Sync knows a newer commit: read the newest tree now, bring it up to date behind. Sync not knowing
    // the commit yet is no reason to rebuild: the sync hook refreshes once it does.
    const behind = repo.headSha != null && repo.headSha !== newest.sha;
    if (behind) void build(repo);
    return hold(newest.path, newest.sha, behind);
  }
  const built = await build(repo);
  if (!built) return null;
  const sha = built.split(/[\\/]/).pop()!;
  return hold(built, sha, false);
}

/** Sync saw the default branch at `headSha`: refresh a repository a chat has used. Never throws. */
export function noteDefaultBranchHead(repo: TreeRepo): void {
  try {
    if (!repo.headSha || !SHA.test(repo.headSha)) return;
    const trees = treesOf(repo.owner, repo.name);
    if (trees.length === 0 || trees.some((t) => t.sha === repo.headSha)) return;
    void build(repo);
  } catch {
    /* a refresh is a nicety */
  }
}

/** Remove a repository's trees that are neither the newest nor held by a live chat. */
export function prune(owner: string, name: string): number {
  const trees = treesOf(owner, name);
  let removed = 0;
  for (const t of trees.slice(1)) {
    if (holds.has(t.path)) continue;
    rmSync(t.path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Boot: unfinished trees go; each repository keeps only its newest tree; a repository not in
 * `known` (owner/name, any case) goes entirely. Never throws.
 */
export function sweepTreesAtBoot(known: ReadonlyArray<{ owner: string; name: string }>): { removed: number } {
  let removed = 0;
  const keep = new Set(known.map((k) => repoKey(k.owner, k.name)));
  let repos: string[];
  try {
    repos = readdirSync(deps.root());
  } catch {
    return { removed };
  }
  for (const r of repos) {
    const dir = join(deps.root(), r);
    try {
      if (!keep.has(r.toLowerCase())) {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
        continue;
      }
      const names = readdirSync(dir);
      for (const n of names) {
        if (!SHA.test(n) || !isComplete(join(dir, n))) {
          rmSync(join(dir, n), { recursive: true, force: true });
          removed += 1;
        }
      }
      const [owner, name] = r.split('__') as [string, string];
      removed += prune(owner, name);
    } catch {
      /* the next boot tries again */
    }
  }
  return { removed };
}

/** Tests only. */
export function resetTreesForTest(): void {
  holds.clear();
  building.clear();
}
