// THE KEPT REPO STORE, the workspace side (docs/SANDBOX.md § The repo store). The runtime gives a named
// volume (`runtime.repoStore`, Docker only) holding ONE BARE REPOSITORY PER owner/name, kept across
// sessions; this file fills it and builds each sandbox repository from it.
//
//   1. THE COMMIT. `resolveBranchCommit` (clone-manager, under its repo lock): the clone cache's own fetch
//      and `pinRef` rules, WITHOUT a worktree. No blob is downloaded here.
//   2. IN THE SANDBOX, from the read-only store: when the store has `refs/limn/keep/<sha>`, a new
//      repository at the layout path BORROWS the store's objects (`objects/info/alternates`), is marked
//      shallow at the commit, gets `refs/limn/base` and the branch, and is checked out. Nothing crosses
//      `docker exec` but the argv. Exit 75 = the store lacks the commit.
//   3. ONLY THEN, THE MISSING OBJECTS, under a per-repository store lock: a MAINTENANCE container (Limn's
//      image, no network, root without capabilities, the store read-write) runs `git fetch --depth 1`
//      whose transport is its own stdin/stdout (`ext::`), and Limn connects that to `git upload-pack`
//      running on the HOST against the SOURCE. The store tells the source which commits it already has
//      (the keep refs), so only the objects it lacks cross, and `fetch.fsckObjects` checks every one.
//      The source is the reader's LOCAL CLONE when it has the commit and is complete (no blob from
//      GitHub at all), else the clone cache after `prepBranchWorktree` brought the base tree's blobs in.
//
// ⚠ THE READER'S CLONE IS READ, NEVER WRITTEN. Only `rev-parse`, `config --get-regexp`, `cat-file -e` and
// `upload-pack` run against its GIT DIR, each with hooks pointed at /dev/null, the fsmonitor off, no
// system or global config, no lazy fetch (no remote, no credential is ever used), no optional locks, no
// replace objects. None of them reads the working tree, the index or the stash, and none writes a file
// (pinned by store-real.test.ts with `git status` and a listing of every mtime). No transport is
// configured on the host side (upload-pack is run directly), so no `protocol.file.allow` is needed; the
// container side allows `ext` for its one fetch, by `-c`.
//
// ⚠ THE STORE IS NEVER GC'D OR PRUNED BY LIMN (`gc.auto=0`, `maintenance.auto=false`, fetch with
// `--no-auto-maintenance`): a running sandbox borrows its objects. It only grows; `limn sandbox prune
// --store` removes it whole, which the daemon refuses while a sandbox mounts it.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { STORE_MOUNT } from '../runtime/labels.js';
import type { RepoStoreRuntime, SandboxRuntime, SessionOwner } from '../runtime/types.js';
import type { RepoBaseRequest } from './mirror.js';

/** The ref, in each SANDBOX repository, that names the commit the session started from. */
export const SANDBOX_BASE_REF = 'refs/limn/base';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
/** The in-sandbox step's "the store does not have this commit" exit. */
const NEED_OBJECTS = 75;

/** The store's folder for one repository: `<owner>__<name>.git`. */
export function storeRepoDir(owner: string, name: string): string {
  const ok = (s: string): boolean => /^[A-Za-z0-9_.-]+$/.test(s) && !s.startsWith('.');
  if (!ok(owner) || !ok(name)) throw new Error(`Not a repository name: ${owner}/${name}`);
  return `${owner}__${name}.git`;
}

/** The environment every host git call against a SOURCE gets: nothing from the reader's config, no network. */
export function sourceGitEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !k.startsWith('GIT_')) out[k] = v;
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * `-c` settings for every host git call against a SOURCE (a repository's own config cannot undo them).
 * (`uploadpack.packObjectsHook` is honoured only from protected config — never a repository's own — so
 * it needs no override; an empty override would make upload-pack run an empty command.)
 */
export const SOURCE_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'uploadpack.allowAnySHA1InWant=true',
] as const;

async function sourceGit(gitDir: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', [...SOURCE_GIT_CONFIG, `--git-dir=${gitDir}`, ...args], { env: sourceGitEnv(), timeout: timeoutMs, maxBuffer: 1 << 20 });
  return stdout;
}

export type LocalSourceCheck = { ok: true; gitDir: string } | { ok: false; reason: string };

/**
 * Whether the reader's clone at `path` can give the objects of `sha`: a complete (not shallow, not
 * partial) repository that has the commit. Read-only; any error is a plain reason, never a throw.
 */
export async function checkLocalSource(path: string, sha: string): Promise<LocalSourceCheck> {
  if (!SHA.test(sha)) return { ok: false, reason: 'the base is not a commit id' };
  let gitDir: string;
  try {
    // `-C` here, not `--git-dir`: the clone's `.git` may be a file (a worktree's).
    const { stdout } = await execFileAsync('git', [...SOURCE_GIT_CONFIG, '-C', path, 'rev-parse', '--absolute-git-dir'], { env: sourceGitEnv(), timeout: 15_000 });
    gitDir = stdout.trim();
    if (!gitDir) return { ok: false, reason: 'it is not a git repository' };
  } catch {
    return { ok: false, reason: 'it is not a git repository' };
  }
  try {
    if ((await sourceGit(gitDir, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') return { ok: false, reason: 'it is a shallow clone' };
    const partial = await sourceGit(gitDir, ['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$']).catch(() => '');
    if (partial.trim() !== '') return { ok: false, reason: 'it is a partial clone' };
  } catch {
    return { ok: false, reason: 'reading it failed' };
  }
  try {
    await sourceGit(gitDir, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    return { ok: false, reason: 'it does not have the base commit' };
  }
  return { ok: true, gitDir };
}

/** The absolute git dir of a clone-cache folder. */
export async function gitDirOf(path: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...SOURCE_GIT_CONFIG, '-C', path, 'rev-parse', '--absolute-git-dir'], { env: sourceGitEnv(), timeout: 15_000 });
  return stdout.trim();
}

// The maintenance program. Everything before the fetch writes to stderr: stdout IS the protocol stream.
// The relay: a background `cat` copies our stdin (upload-pack's output) to the fetch; the foreground one
// copies the fetch's requests to our stdout. (The background one reads fd 9, never its own stdin: a
// non-interactive shell gives a background job /dev/null as stdin.)
export const STORE_FETCH = [
  'set -e',
  'case "$1" in *[!A-Za-z0-9_.-]*|.*|"") echo "Not a store folder: $1" >&2; exit 2;; esac',
  `d="${STORE_MOUNT}/$1"; sha="$2"`,
  '{',
  '  [ -d "$d" ] || git init -q --bare "$d"',
  '  cd "$d"',
  '  git config gc.auto 0; git config maintenance.auto false; git config core.logAllRefUpdates false',
  '  git config fetch.fsckObjects true; git config transfer.fsckObjects true',
  '} >&2',
  'cd "$d"',
  'exec 8>&1 9<&0',
  'git -c protocol.ext.allow=always fetch --quiet --no-tags --no-write-fetch-head --no-auto-maintenance --depth 1 \\',
  '  "ext::sh -c cat% <&9% &% exec% cat% >&8" "+$sha:refs/limn/keep/$sha" >&2',
  'git rev-parse -q --verify "refs/limn/keep/$sha^{commit}" >&2',
].join('\n');

/**
 * Bring `sha` into the store from a source git dir on the host. Throws (one plain line) on any failure;
 * the store is unchanged unless the fetch completed (git writes objects in a quarantine and the ref last).
 */
export async function transferIntoStore(
  store: RepoStoreRuntime,
  owner: SessionOwner,
  dir: string,
  sourceGitDir: string,
  sha: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  if (!SHA.test(sha)) throw new Error('Not a commit id');
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const box = store.exec(owner, ['sh', '-c', STORE_FETCH, 'sh', dir, sha], { interactive: true, timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) });
  const up = spawn('git', [...SOURCE_GIT_CONFIG, 'upload-pack', '--strict', `--timeout=${Math.ceil(timeoutMs / 1000)}`, sourceGitDir], {
    env: sourceGitEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let upErr = '';
  let boxErr = '';
  up.stderr.on('data', (d: Buffer) => (upErr = (upErr + d.toString('utf8')).slice(-2000)));
  up.stdin.on('error', () => {
    /* the fetch went away: its exit says why */
  });
  const upDone = new Promise<number | null>((r) => {
    up.on('error', () => r(null));
    up.on('close', (c) => r(c));
  });
  // upload-pack → the fetch; when it is done, the container's stdin closes (the background `cat` ends).
  up.stdout.on('data', (d: Buffer) => box.write(d));
  up.stdout.on('end', () => box.end());
  const pump = (async () => {
    for await (const ev of box.events) {
      if (ev.type === 'stdout') {
        if (!up.stdin.destroyed) up.stdin.write(ev.data);
      } else if (ev.type === 'stderr' && boxErr.length < 4000) boxErr += ev.data.toString('utf8');
    }
    up.stdin.end();
  })();
  const done = await box.done;
  await pump;
  // The fetch's own exit is the verdict (it checked every object and the ref); upload-pack only serves.
  const upTimer = setTimeout(() => up.kill('SIGKILL'), 5_000);
  await upDone;
  clearTimeout(upTimer);
  if (done.code !== 0) {
    const why = (boxErr.trim() || upErr.trim() || (done.timedOut ? 'timed out' : `exit ${done.code}`)).split('\n').slice(-3).join(' ');
    throw new Error(`Copying into the repo store failed: ${why.slice(0, 400)}`);
  }
}

// In the sandbox, as the agent. The store is read-only there; the repository borrows its objects.
export const IN_SANDBOX_FROM_STORE = [
  'set -e',
  `dest="$1"; branch="$2"; sha="$3"; src="${STORE_MOUNT}/$4"`,
  `git --git-dir="$src" rev-parse -q --verify "refs/limn/keep/$sha^{commit}" >/dev/null 2>&1 || exit ${NEED_OBJECTS}`,
  '[ -e "$dest" ] && fresh=0 || fresh=1',
  `trap 'rc=$?; [ $rc -eq 0 ] || [ $fresh = 0 ] || rm -rf "$dest"' EXIT`,
  'mkdir -p "$dest"',
  'cd "$dest"',
  'git init -q',
  'rm -rf .git/hooks',
  'printf "%s\\n" "$src/objects" > .git/objects/info/alternates',
  'printf "%s\\n" "$sha" > .git/shallow',
  `git update-ref ${SANDBOX_BASE_REF} "$sha"`,
  'git checkout --quiet -B "$branch" "$sha"',
  'git rev-parse HEAD',
].join('\n');

/** Step 2: the repository from the store. `'need'` when the store does not have the commit yet. */
export async function cloneFromStore(
  runtime: SandboxRuntime,
  container: string,
  path: string,
  branch: string,
  sha: string,
  dir: string,
): Promise<string | 'need'> {
  if (!SHA.test(sha)) throw new Error('Not a commit id');
  const r = await runtime.run(container, ['sh', '-c', IN_SANDBOX_FROM_STORE, 'sh', path, branch, sha, dir], { timeoutMs: 600_000 });
  if (r.code === NEED_OBJECTS) return 'need';
  if (r.code !== 0) throw new Error(`Cloning into ${path} failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
  const head = String(r.stdout).trim().split('\n').pop() ?? '';
  if (head !== sha) throw new Error(`Cloning into ${path} did not reach ${sha.slice(0, 7)}`);
  return head;
}

/** What the store path needs from the host. Tests replace it. */
export interface StoreSeams {
  /** The base commit (and its pin), without a worktree. */
  resolveBase(req: RepoBaseRequest): Promise<{ sha: string }>;
  checkLocal(path: string, sha: string): Promise<LocalSourceCheck>;
  /** The clone cache with the base tree's blobs in it; `gitDir` is what upload-pack serves. */
  hydrateCache(req: RepoBaseRequest, sha: string): Promise<{ gitDir: string; cleanup(): Promise<void> }>;
  transfer(store: RepoStoreRuntime, owner: SessionOwner, dir: string, gitDir: string, sha: string, signal?: AbortSignal): Promise<void>;
}

const remoteRefOf = (req: RepoBaseRequest): string => req.remoteRef ?? (req.baseRef === 'HEAD' ? 'HEAD' : `refs/heads/${req.baseRef}`);

export const defaultStoreSeams: StoreSeams = {
  async resolveBase(req) {
    const { resolveBranchCommit } = await import('../../review/clone-manager.js');
    const r = await resolveBranchCommit(req.owner, req.name, { remoteRef: remoteRefOf(req), destRef: 'refs/pierre/sandbox-base', sha: req.baseSha, pinRef: req.pinRef });
    return { sha: r.sha };
  },
  checkLocal: checkLocalSource,
  async hydrateCache(req, sha) {
    const { prepBranchWorktree, removeWorktreeLocked } = await import('../../review/clone-manager.js');
    const wt = await prepBranchWorktree(req.owner, req.name, { remoteRef: remoteRefOf(req), destRef: 'refs/pierre/sandbox-base', sha, pinRef: req.pinRef });
    const cleanup = (): Promise<void> => removeWorktreeLocked(req.owner, req.name, wt.repoCloneDir, wt.worktreePath).catch(() => {});
    try {
      return { gitDir: await gitDirOf(wt.repoCloneDir), cleanup };
    } catch (err) {
      await cleanup();
      throw err;
    }
  },
  transfer: (store, owner, dir, gitDir, sha, signal) => transferIntoStore(store, owner, dir, gitDir, sha, signal ? { signal } : {}),
};

/** Serialise store writes per repository within this process (two sessions on one repository). */
const storeLocks = new Map<string, Promise<unknown>>();
async function withStoreLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = storeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  storeLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (storeLocks.get(key) === tail) storeLocks.delete(key);
  }
}

export interface StoreRepoResult {
  sha: string;
  /** Where the objects came from this time. */
  source: 'store' | 'local' | 'cache';
  /** Why the reader's clone was not used, when it was there and was not. */
  localSkipped: string | null;
}

/**
 * One repository through the store. Throws `StoreStepError` when the step AFTER the base commit failed
 * (the caller may then try the per-session copy); any other throw is final for the repository.
 */
export async function mirrorOneViaStore(a: {
  runtime: SandboxRuntime;
  store: RepoStoreRuntime;
  owner: SessionOwner;
  container: string;
  path: string;
  branch: string;
  req: RepoBaseRequest;
  /** The reader's clones of this repository (the layout's match, shallowest first). */
  localClones: readonly string[];
  seams: StoreSeams;
  signal?: AbortSignal;
}): Promise<StoreRepoResult> {
  const { sha } = await a.seams.resolveBase(a.req);
  const dir = storeRepoDir(a.req.owner, a.req.name);
  try {
    const first = await cloneFromStore(a.runtime, a.container, a.path, a.branch, sha, dir);
    if (first !== 'need') return { sha: first, source: 'store', localSkipped: null };
    const got = await withStoreLock(dir, async (): Promise<{ source: 'store' | 'local' | 'cache'; localSkipped: string | null }> => {
      // Another session may have brought it in while we waited.
      const again = await cloneFromStore(a.runtime, a.container, a.path, a.branch, sha, dir);
      if (again !== 'need') return { source: 'store', localSkipped: null };
      let localSkipped: string | null = null;
      for (const p of a.localClones) {
        const c = await a.seams.checkLocal(p, sha);
        if (!c.ok) {
          localSkipped ??= c.reason;
          continue;
        }
        try {
          await a.seams.transfer(a.store, a.owner, dir, c.gitDir, sha, a.signal);
          return { source: 'local', localSkipped: null };
        } catch {
          localSkipped = 'copying from it failed';
        }
      }
      const cache = await a.seams.hydrateCache(a.req, sha);
      try {
        await a.seams.transfer(a.store, a.owner, dir, cache.gitDir, sha, a.signal);
      } finally {
        await cache.cleanup();
      }
      return { source: 'cache', localSkipped };
    });
    if (got.source === 'store') return { sha, ...got };
    const head = await cloneFromStore(a.runtime, a.container, a.path, a.branch, sha, dir);
    if (head === 'need') throw new Error('The repo store does not have the base commit after copying it.');
    return { sha: head, ...got };
  } catch (err) {
    throw new StoreStepError(err);
  }
}

export class StoreStepError extends Error {
  constructor(readonly inner: unknown) {
    super(inner instanceof Error ? inner.message : String(inner));
  }
}
