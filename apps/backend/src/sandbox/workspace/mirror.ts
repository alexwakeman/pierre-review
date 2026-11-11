// THE WORKSPACE MIRROR (docs/SANDBOX.md § The workspace mirror): every workspace repository, cloned
// INSIDE the sandbox at its layout path, on the ticket-key branch (`sessionBranch`), with no remote; then the reader's
// memories, CLAUDE.md and skills, then the seed files.
//
// ⚠ THE BASE COMMIT COMES FROM LIMN'S CLONE CACHE (plan invariant 4); the reader's checkout is never
// copied (its objects may be READ into the repo store, below). THE PER-SESSION COPY, per repository, on
// the HOST:
//   1. `prepBranchWorktree` at the base (the clone cache's own fetch, under its repo lock; the base is
//      pinned by the caller's `pinRef`). The cache is a BLOBLESS clone: the worktree checkout is what
//      brings the base tree's blobs in (measured: a shallow fetch from a blobless clone without it
//      fails "possible repository corruption on the remote side");
//   2. a throw-away SHALLOW repository (depth 1) fetched from the cache at that commit — complete on
//      its own, the real commit id, no remote, no credential;
//   3. its `.git` is streamed into the sandbox as a tar on `tar -x`'s stdin, as the agent, into the
//      session volume; the working tree is checked out there. The worktree and the shallow repository
//      are removed at once.
// No host folder is mounted for this (a mount would need the agent's uid to read the cache's 0700
// folders on Linux), and no remote, credential or hook crosses: only objects, refs and `shallow`.
//
// The commit Limn starts from is kept as `refs/limn/base` in each sandbox repository: the patch
// extraction (WP7) is `git format-patch refs/limn/base..<branch>`.
//
// ⚠ ON DOCKER THE REPO STORE REPLACES STEPS 2–3 (store.ts, docs/SANDBOX.md § The repo store): a kept,
// read-only volume the sandbox borrows objects from, filled from the reader's own clone when it has the
// base commit. The per-session copy above stays for a runtime without a store (microsandbox), when the
// store could not be made, and as the per-repository fallback when a store step fails.
//
// Repositories are prepared MIRROR_CONCURRENCY at a time; each host step still takes clone-manager's
// per-repository lock, and a failed repository is one boot note (the session goes on).
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { promisify } from 'node:util';
import type { FileToCopy, SandboxRuntime, SessionOwner } from '../runtime/types.js';
import type { LayoutRepo, WorkspaceLayout } from './layout.js';
import { readMemories, readUserClaudeMd, readUserSkills, type ClaudePlaces } from './memories.js';
import { SANDBOX_HOME, type SeedMemoryProject } from './seed.js';
import { defaultStoreSeams, mirrorOneViaStore, SANDBOX_BASE_REF, StoreStepError, type StoreSeams } from './store.js';

const execFileAsync = promisify(execFile);

export { SANDBOX_BASE_REF };
/** How many repositories are prepared at once. */
export const MIRROR_CONCURRENCY = 3;
const SHA = /^[0-9a-f]{40}$/;

export interface RepoBaseRequest {
  repoId: number;
  owner: string;
  name: string;
  /** A branch name, or 'HEAD' (the remote's default). */
  baseRef: string;
  /** The commit, when known (a stacked PR's head); else the ref's tip. */
  baseSha: string | null;
  /** The caller's ref that keeps the base reachable in the clone cache (`storyBuildBaseRef`). */
  pinRef: string;
  /**
   * The ref to fetch, when not the branch: an AI Fix reads the PR's head through the BASE repository's
   * `refs/pull/<n>/head` (a fork's head included). Absent ⇒ `refs/heads/<baseRef>` (or `HEAD`).
   */
  remoteRef?: string;
}

/** A complete depth-1 repository on the host, ready to stream in. */
export interface PreparedSource {
  sha: string;
  /** The folder whose `.git` is streamed. */
  dir: string;
  cleanup(): Promise<void>;
}

export interface MirrorSeams {
  prepare(req: RepoBaseRequest): Promise<PreparedSource>;
  /** A tar of `<dir>/.git`, streamed (chunks). */
  tarGitDir(dir: string): AsyncIterable<Buffer>;
}

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Steps 1–2 on the host, from a clone directory already holding the base tree's objects. */
export async function shallowFromClone(cloneDir: string, sha: string): Promise<PreparedSource> {
  if (!SHA.test(sha)) throw new Error('Not a commit id');
  const dir = await mkdtemp(join(tmpdir(), 'limn-mirror-'));
  try {
    // `-c` keeps every setting off the global config; the source is a local path (file transport).
    await git(['init', '--quiet', dir]);
    await git([
      '-C', dir, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--depth', '1',
      '--upload-pack', 'git -c uploadpack.allowAnySHA1InWant=true upload-pack',
      `file://${cloneDir}`, sha,
    ]);
    await git(['-C', dir, 'update-ref', SANDBOX_BASE_REF, sha]);
    // Nothing the sandbox should inherit: no hooks, no config beyond `init`'s own.
    await rm(join(dir, '.git', 'hooks'), { recursive: true, force: true });
    await rm(join(dir, '.git', 'FETCH_HEAD'), { force: true });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { sha, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const defaultMirrorSeams: MirrorSeams = {
  async prepare(req) {
    const { prepBranchWorktree, removeWorktreeLocked } = await import('../../review/clone-manager.js');
    const remoteRef = req.remoteRef ?? (req.baseRef === 'HEAD' ? 'HEAD' : `refs/heads/${req.baseRef}`);
    const wt = await prepBranchWorktree(req.owner, req.name, {
      remoteRef,
      destRef: 'refs/pierre/sandbox-base',
      sha: req.baseSha,
      pinRef: req.pinRef,
    });
    try {
      return await shallowFromClone(wt.repoCloneDir, wt.sha);
    } finally {
      await removeWorktreeLocked(req.owner, req.name, wt.repoCloneDir, wt.worktreePath).catch(() => {});
    }
  },
  async *tarGitDir(dir) {
    // ⚠ macOS's tar adds AppleDouble `._*` files and xattr headers (measured: `._.git` showed up as an
    // untracked file in every repository): COPYFILE_DISABLE + --no-xattrs, and the extract excludes `._*`.
    const child = spawn('tar', ['--no-xattrs', '-c', '-f', '-', '-C', dir, '.git'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8').slice(0, 2000)));
    const exited = new Promise<number | null>((r) => child.on('close', (c) => r(c)));
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const code = await exited;
    if (code !== 0) throw new Error(`tar failed: ${err.trim()}`);
  },
};

export interface MirroredRepo {
  repoId: number;
  fullName: string;
  path: string;
  sha: string;
}

export type MirrorProgress = (line: string) => void;

const IN_SANDBOX_CLONE = [
  'set -e',
  'dest="$1"; branch="$2"; sha="$3"',
  'mkdir -p "$dest"',
  'tar -x --no-same-owner --exclude="._*" -f - -C "$dest" 2>/tmp/limn-tar.err || { cat /tmp/limn-tar.err >&2; exit 1; }',
  'cd "$dest"',
  'git checkout --quiet -B "$branch" "$sha"',
  'git rev-parse HEAD',
].join('\n');

/** Step 3 for one repository: the stream into the sandbox and the checkout. */
export async function cloneIntoSandbox(
  runtime: SandboxRuntime,
  container: string,
  repo: Pick<LayoutRepo, 'path'>,
  branch: string,
  source: PreparedSource,
  seams: Pick<MirrorSeams, 'tarGitDir'> = defaultMirrorSeams,
): Promise<string> {
  const h = runtime.exec(container, ['sh', '-c', IN_SANDBOX_CLONE, 'sh', repo.path, branch, source.sha], { interactive: true, timeoutMs: 600_000 });
  let stdout = '';
  let stderr = '';
  const drain = (async () => {
    for await (const ev of h.events) {
      if (ev.type === 'stdout') stdout += ev.data.toString('utf8');
      else if (ev.type === 'stderr' && stderr.length < 4000) stderr += ev.data.toString('utf8');
    }
  })();
  try {
    for await (const chunk of seams.tarGitDir(source.dir)) h.write(chunk);
  } catch (err) {
    h.kill();
    await drain.catch(() => {});
    throw err;
  } finally {
    h.end();
  }
  const done = await h.done;
  await drain;
  if (done.code !== 0) throw new Error(`Cloning into ${repo.path} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
  const head = stdout.trim().split('\n').pop() ?? '';
  if (head !== source.sha) throw new Error(`Cloning into ${repo.path} did not reach ${source.sha.slice(0, 7)}`);
  return head;
}

/** The sandbox's git identity and start folder (once per session). */
export async function prepareSandboxGit(runtime: SandboxRuntime, container: string, layout: WorkspaceLayout, identity: { name: string; email: string }): Promise<void> {
  const r = await runtime.run(
    container,
    [
      'sh', '-c',
      'set -e; git config --global user.name "$1"; git config --global user.email "$2"; git config --global init.defaultBranch main; git config --global advice.detachedHead false; mkdir -p "$3"',
      'sh', identity.name, identity.email, layout.startDir,
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0) throw new Error(`Preparing git in the sandbox failed: ${r.stderr.trim()}`);
}

export interface MirrorResult {
  repos: MirroredRepo[];
  /** One plain line per repository that could not be cloned (the session goes on without it). */
  failed: Array<{ repoId: number; fullName: string; reason: string }>;
  /** Plain lines for the boot notes (at most one about the reader's clones). */
  notes: string[];
}

export interface MirrorOptions {
  seams?: MirrorSeams;
  onProgress?: MirrorProgress;
  signal?: AbortSignal;
  /**
   * The repo store, when the sandbox was started with it mounted (`sandboxMountsFor`). Absent ⇒ the
   * per-session copy for every repository.
   */
  store?: { owner: SessionOwner; seams?: StoreSeams } | null;
  /** The reader's clones per repository (the layout's match: the first path, then `alsoAt`). */
  localClones?: ReadonlyMap<number, readonly string[]>;
  concurrency?: number;
}

/** The repos step's progress line. Pure. */
export function mirrorProgressLine(n: number, total: number, fullName: string): string {
  return `Loading repositories ${n}/${total}: ${fullName}`;
}

/** `fn` over `items`, at most `limit` at a time; results in the items' order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Every repository of the layout, `MIRROR_CONCURRENCY` at a time (each host step takes that repository's lock). */
export async function mirrorRepos(
  runtime: SandboxRuntime,
  container: string,
  layout: WorkspaceLayout,
  bases: ReadonlyMap<number, RepoBaseRequest>,
  branch: string,
  opts: MirrorOptions = {},
): Promise<MirrorResult> {
  const seams = opts.seams ?? defaultMirrorSeams;
  const store = opts.store && runtime.repoStore ? { ...opts.store, runtime: runtime.repoStore } : null;
  type One = { ok: MirroredRepo } | { failed: MirrorResult['failed'][number] } | null;
  const skippedLocal: string[] = [];
  // "Loading repositories 3/7: owner/name" as each one starts (3 at a time), so the reader sees how far along it is.
  const total = layout.repos.length;
  let started = 0;
  const results = await mapBounded<LayoutRepo, One>(layout.repos, opts.concurrency ?? MIRROR_CONCURRENCY, async (r) => {
    if (opts.signal?.aborted) return null;
    const req = bases.get(r.repoId);
    if (req == null) return { failed: { repoId: r.repoId, fullName: r.fullName, reason: 'No base was chosen.' } };
    started += 1;
    opts.onProgress?.(mirrorProgressLine(started, total, r.fullName));
    if (store) {
      try {
        const got = await mirrorOneViaStore({
          runtime,
          store: store.runtime,
          owner: store.owner,
          container,
          path: r.path,
          branch,
          req,
          localClones: opts.localClones?.get(r.repoId) ?? [],
          seams: store.seams ?? defaultStoreSeams,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        if (got.localSkipped) skippedLocal.push(`${r.fullName} (${got.localSkipped})`);
        return { ok: { repoId: r.repoId, fullName: r.fullName, path: r.path, sha: got.sha } };
      } catch (err) {
        // Before the base commit was known: final. After: the per-session copy, once.
        if (!(err instanceof StoreStepError)) return { failed: { repoId: r.repoId, fullName: r.fullName, reason: scrub(err) } };
      }
    }
    let source: PreparedSource | null = null;
    try {
      source = await seams.prepare(req);
      const sha = await cloneIntoSandbox(runtime, container, r, branch, source, seams);
      return { ok: { repoId: r.repoId, fullName: r.fullName, path: r.path, sha } };
    } catch (err) {
      return { failed: { repoId: r.repoId, fullName: r.fullName, reason: scrub(err) } };
    } finally {
      await source?.cleanup().catch(() => {});
    }
  });
  if (opts.signal?.aborted) throw new Error('Stopped');
  const out: MirrorResult = { repos: [], failed: [], notes: [] };
  for (const x of results) {
    if (x == null) continue;
    if ('ok' in x) out.repos.push(x.ok);
    else out.failed.push(x.failed);
  }
  if (skippedLocal.length > 0) out.notes.push(`Copied from Limn's own clone, not yours: ${skippedLocal.join(', ')}.`);
  return out;
}

/** An error's message with anything URL-credential-shaped removed. */
function scrub(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.replace(/https?:\/\/[^@\s/]*@/g, 'https://').split('\n').slice(0, 3).join(' ').slice(0, 400);
}

export interface ReaderFilesChoice {
  memoryProjects: ReadonlyArray<{ dir: string; key: string }>;
  userClaudeMd: boolean;
  userSkills: boolean;
}

export interface ReaderFiles {
  files: FileToCopy[];
  memories: SeedMemoryProject[];
  userClaudeMd: string | null;
  skills: string[];
  skippedSkills: number;
}

/** The reader's files to copy (memories, CLAUDE.md, skills), read from the host. Pure of the sandbox. */
export function readerFiles(places: ClaudePlaces, choice: ReaderFilesChoice): ReaderFiles {
  const files: FileToCopy[] = [];
  const memories: SeedMemoryProject[] = [];
  for (const p of choice.memoryProjects) {
    const got = readMemories(places, p.key);
    const base = posix.join(SANDBOX_HOME, '.claude/projects', p.key, 'memory');
    const paths = got.files.map((f) => posix.join(base, f.rel));
    got.files.forEach((f, i) => files.push({ path: paths[i]!, content: f.content, mode: 0o644 }));
    memories.push({ dir: p.dir, key: p.key, files: paths, skipped: got.skipped });
  }
  let userClaudeMd: string | null = null;
  if (choice.userClaudeMd) {
    const b = readUserClaudeMd(places);
    if (b != null) {
      userClaudeMd = posix.join(SANDBOX_HOME, '.claude/CLAUDE.md');
      files.push({ path: userClaudeMd, content: b, mode: 0o644 });
    }
  }
  const skills = new Set<string>();
  let skippedSkills = 0;
  if (choice.userSkills) {
    const got = readUserSkills(places);
    skippedSkills = got.skipped;
    for (const f of got.files) {
      skills.add(f.rel.split('/')[0]!);
      files.push({ path: posix.join(SANDBOX_HOME, '.claude/skills', f.rel), content: f.content, mode: f.mode });
    }
  }
  return { files, memories, userClaudeMd, skills: [...skills].sort(), skippedSkills };
}
