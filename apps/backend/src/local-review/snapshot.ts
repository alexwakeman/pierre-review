// THE READER'S BRANCH, AS A GIT BUNDLE (docs/CLAUDE-REVIEW.md § Reviewing a local branch → The client). Runs in
// the CLIENT (`ensemble mcp` / `ensemble review`: the reader's own process, in the reader's own repository) —
// never in the server, which takes no filesystem path.
//
//   THE SCOPE   merge-base(HEAD, the base) .. HEAD, PLUS the uncommitted TRACKED changes (what the index
//               tracks, staged or not) unless the reader opts out. UNTRACKED FILES ARE NEVER INCLUDED. The
//               base: the reader's `--base`, else the branch's upstream when it is ANOTHER branch (a stacked
//               branch), else origin's default branch. It must be on a branch of origin (GitHub has it), else a
//               plain refusal.
//   THE SNAPSHOT  of the uncommitted changes is a commit made in a TEMPORARY repository: its own object
//               directory, its own index (HEAD's tree, then the changed tracked paths `git diff HEAD` lists), its
//               own ref. `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` point there; the reader's objects
//               are BORROWED (`GIT_ALTERNATE_OBJECT_DIRECTORIES`) only by commands that read — git touches an
//               existing object it is asked to write, in an alternate too, so every blob and tree is written
//               without one.
//   THE BUNDLE  `git bundle create` from that temporary repository: base..head, one branch.
//
// ⚠ THE READER'S .git IS READ, NEVER WRITTEN (as the sandbox's repo store reads it: sandbox/workspace/store.ts).
// Against it run only read commands (rev-parse, symbolic-ref, config --get, merge-base, for-each-ref, log),
// each with the hardened environment (`sourceGitEnv`: no system or global config, no lazy fetch, NO OPTIONAL
// LOCKS — so no index refresh) and `SOURCE_GIT_CONFIG` (hooks to /dev/null, no fsmonitor). Everything that
// writes — objects, the index, a ref, the bundle — writes into the temporary directory, removed at the end.
// Pinned by snapshot-real.test.ts (every file under .git, its mtime, size and bytes, unchanged).
import { execFile, spawn } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LOCAL_REVIEW_BUNDLE_MAX_BYTES, LOCAL_REVIEW_SUBJECTS_MAX } from '@pierre-review/shared';
import { SOURCE_GIT_CONFIG, sourceGitEnv } from '../sandbox/workspace/store.js';
import { parseGitRemote } from '../sandbox/workspace/remote.js';

const execFileAsync = promisify(execFile);

/** A snapshot the client will not make: one plain line for the reader. */
export class SnapshotRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotRefusal';
  }
}

export interface BranchSnapshot {
  root: string;
  owner: string;
  name: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  /** The commit HEAD points at (headSha differs when uncommitted changes were snapshotted). */
  commitSha: string;
  includeUncommitted: boolean;
  uncommittedChanges: boolean;
  /** Uncommitted tracked files left at HEAD's version because a clean filter (e.g. Git LFS) applies to them. */
  skippedFiltered: string[];
  subjects: string[];
  bundle: Buffer;
}

export interface SnapshotOptions {
  /** A folder in the repository (the reader's working folder). */
  cwd: string;
  includeUncommitted: boolean;
  /** A ref or commit to diff against, in place of the upstream / origin's default branch. */
  base?: string | null;
  /** Test seam: the bundle cap. */
  maxBytes?: number;
}

/** A READ of the reader's repository (see the header). */
async function readGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', [...SOURCE_GIT_CONFIG, '-C', cwd, ...args], { env: sourceGitEnv(), timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const tryRead = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    return (await readGit(cwd, args)).trim();
  } catch {
    return null;
  }
};

/**
 * `-c` settings carrying the reader's line-ending config from EVERY scope (system, global, repository). `git config
 * --get` only reads; it runs without the NOSYSTEM / GLOBAL override but keeps the rest of the hardened environment.
 */
async function readerEolConfig(root: string): Promise<string[]> {
  const env: Record<string, string> = { ...sourceGitEnv() };
  delete env.GIT_CONFIG_NOSYSTEM;
  delete env.GIT_CONFIG_GLOBAL;
  const out: string[] = [];
  for (const key of ['core.autocrlf', 'core.eol', 'core.safecrlf']) {
    try {
      const { stdout } = await execFileAsync('git', [...SOURCE_GIT_CONFIG, '-C', root, 'config', '--get', key], { env, timeout: 30_000 });
      const v = stdout.trim();
      if (/^[A-Za-z0-9]+$/.test(v)) out.push('-c', `${key}=${v}`);
    } catch {
      /* not set */
    }
  }
  return out;
}

/** The paths (of `paths`) a `filter` attribute applies to. Reads attributes only; runs no filter. */
async function filteredPaths(root: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (paths.length === 0) return out;
  const child = spawn('git', [...SOURCE_GIT_CONFIG, '-C', root, 'check-attr', '-z', '--stdin', 'filter'], { env: sourceGitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => chunks.push(c));
  child.stdin.on('error', () => {});
  const done = new Promise<number | null>((resolve) => {
    child.on('error', () => resolve(1));
    child.on('close', resolve);
  });
  child.stdin.end(paths.map((p) => `${p}\0`).join(''));
  if ((await done) !== 0) return out;
  // -z output: path NUL attribute NUL value NUL, repeated.
  const parts = Buffer.concat(chunks).toString('utf8').split('\0');
  for (let k = 0; k + 2 < parts.length; k += 3) {
    const v = parts[k + 2]!;
    if (v !== 'unspecified' && v !== 'unset') out.add(parts[k]!);
  }
  return out;
}

/** The branch-name characters the server takes; anything else becomes '-'. */
const safeBranch = (b: string): string => b.replace(/[^A-Za-z0-9._/+-]/g, '-').replace(/\.\.+/g, '.').replace(/^\/+|\/+$/g, '').slice(0, 200) || 'branch';

/** The repository a folder is in: its root, origin's owner/name, HEAD and the branch name. Reads only. */
export async function repoOf(cwd: string): Promise<{ root: string; owner: string; name: string; commitSha: string; branchName: string | null; branch: string }> {
  const root = await tryRead(cwd, ['rev-parse', '--show-toplevel']);
  if (!root) throw new SnapshotRefusal('This folder is not inside a git repository.');
  const originUrl = await tryRead(root, ['config', '--get', 'remote.origin.url']);
  const remote = originUrl ? parseGitRemote(originUrl) : null;
  if (!remote) throw new SnapshotRefusal('This repository has no origin remote on GitHub.');
  const commitSha = await tryRead(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!commitSha) throw new SnapshotRefusal('This repository has no commits yet.');
  const branchName = (await tryRead(root, ['symbolic-ref', '--short', '-q', 'HEAD'])) || null;
  return { root, owner: remote.owner, name: remote.name, commitSha, branchName, branch: safeBranch(branchName || `detached-${commitSha.slice(0, 12)}`) };
}

/** Make the snapshot (see the header). Throws `SnapshotRefusal` with a plain line. */
export async function snapshotBranch(o: SnapshotOptions): Promise<BranchSnapshot> {
  const { root, owner, name, commitSha, branchName, branch } = await repoOf(o.cwd);
  const remote = { owner, name };

  // THE BASE.
  let baseRef: string;
  if (o.base != null && o.base.trim() !== '') {
    baseRef = o.base.trim();
    if (baseRef.startsWith('-')) throw new SnapshotRefusal(`"${baseRef}" is not a ref.`);
  } else {
    const upstream = branchName ? await tryRead(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
    const stacked = upstream != null && upstream.startsWith('origin/') && upstream !== `origin/${branchName}`;
    if (stacked) baseRef = upstream;
    else {
      const head = await tryRead(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
      const fallback = head ? null : (await tryRead(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])) ? 'origin/main' : (await tryRead(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'])) ? 'origin/master' : null;
      const def = head ?? fallback;
      if (!def) throw new SnapshotRefusal("Ensemble could not find origin's default branch. Fetch it (git fetch origin), or pass a base.");
      baseRef = def;
    }
  }
  const baseTip = await tryRead(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  if (!baseTip) throw new SnapshotRefusal(`The base "${baseRef}" is not a commit in this repository.`);
  const baseSha = await tryRead(root, ['merge-base', commitSha, baseTip]);
  if (!baseSha) throw new SnapshotRefusal(`This branch shares no history with ${baseRef}.`);
  // GitHub has the base when a branch of origin contains it (a fetched remote-tracking ref).
  const onOrigin = await tryRead(root, ['for-each-ref', '--count=1', `--contains=${baseSha}`, '--format=%(refname)', 'refs/remotes/origin/']);
  if (!onOrigin) throw new SnapshotRefusal(`The base commit ${baseSha.slice(0, 12)} is on no branch of origin, so GitHub may not have it. Push it, or pass another base.`);
  const subjects = ((await tryRead(root, ['log', '--no-color', '--format=%s', `-n${LOCAL_REVIEW_SUBJECTS_MAX}`, `${baseSha}..${commitSha}`])) ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // The reader's line-ending settings, read (never written) from EVERY config scope — Git for Windows sets
  // core.autocrlf in the SYSTEM config, which the hardened environment hides — and passed to every git call below,
  // so the content hashed is what the reader would commit.
  const eolConfig = await readerEolConfig(root);

  // THE TEMPORARY REPOSITORY (everything that writes, writes here).
  const objects = await tryRead(root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']);
  if (!objects) throw new SnapshotRefusal('Ensemble could not read this repository.');
  const tmp = mkdtempSync(join(tmpdir(), 'ensemble-review-'));
  try {
    const gitDir = join(tmp, 'repo.git');
    const index = join(tmp, 'index');
    // ⚠ TWO ENVIRONMENTS. git "freshens" (touches the mtime of) an object it is asked to write when that object
    // already exists — in an ALTERNATE too. So nothing that WRITES an object runs with the reader's objects as an
    // alternate: the blobs and trees are written with `own` (the temporary object directory alone), and the
    // reader's objects are borrowed only by commands that READ (`borrow`: read-tree, the index, the bundle) or that
    // write an object that cannot already exist (the snapshot commit, new by its timestamp).
    const own = {
      ...sourceGitEnv(),
      GIT_DIR: gitDir,
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: join(gitDir, 'objects'),
      GIT_AUTHOR_NAME: 'Ensemble',
      GIT_AUTHOR_EMAIL: 'ensemble@localhost',
      GIT_COMMITTER_NAME: 'Ensemble',
      GIT_COMMITTER_EMAIL: 'ensemble@localhost',
    };
    const borrow = { ...own, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects };
    const cfg = [...SOURCE_GIT_CONFIG, ...eolConfig];
    const tmpGit = (args: string[], e: NodeJS.ProcessEnv, input?: string, timeoutMs = 300_000): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn('git', [...cfg, ...args], { env: e, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
        const out: Buffer[] = [];
        const err: Buffer[] = [];
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
        child.stdout.on('data', (c: Buffer) => out.push(c));
        child.stderr.on('data', (c: Buffer) => err.push(c));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
          else reject(Object.assign(new Error(`git ${args[0]} failed`), { stderr: Buffer.concat(err).toString('utf8') }));
        });
        // A git command that reads no stdin may exit before the write is flushed: an EPIPE here is not an error
        // (the exit code says how the command went), and an unhandled one would kill the client.
        child.stdin.on('error', () => {});
        if (input != null) child.stdin.end(input);
        else child.stdin.end();
      });
    await execFileAsync('git', ['init', '--bare', '-q', '--template=', gitDir], { env: { ...sourceGitEnv() }, cwd: tmp, timeout: 30_000 });

    let headSha = commitSha;
    let uncommittedChanges = false;
    const skippedFiltered: string[] = [];
    if (o.includeUncommitted) {
      // The tracked paths that differ from HEAD (staged or not): a READ of the reader's repository (no optional
      // locks, so its index is not refreshed). Untracked files are not in this list, ever.
      const raw = await readGit(root, [...eolConfig, 'diff', '--no-ext-diff', '--no-renames', '--ignore-submodules=all', '--name-status', '-z', commitSha], 300_000);
      const parts = raw.split('\0').filter((x) => x !== '');
      const changed: Array<{ status: string; path: string }> = [];
      for (let k = 0; k + 1 < parts.length; k += 2) changed.push({ status: parts[k]!, path: parts[k + 1]! });
      if (changed.length > 0) {
        await tmpGit(['read-tree', commitSha], borrow);
        const lines: string[] = [];
        const write: Array<{ path: string; mode: string }> = [];
        for (const c of changed) {
          const abs = join(root, c.path);
          let st;
          try {
            st = lstatSync(abs);
          } catch {
            st = null;
          }
          if (c.status.startsWith('D') || st == null) {
            lines.push(`0 ${'0'.repeat(40)}\t${c.path}`);
            continue;
          }
          if (st.isDirectory()) continue; // a submodule: its pointer is not sent
          write.push({ path: c.path, mode: st.isSymbolicLink() ? '120000' : st.mode & 0o111 ? '100755' : '100644' });
        }
        // A path with a clean FILTER (Git LFS, git-crypt …) keeps HEAD's version: the filter is the reader's program
        // and may write into their .git (LFS does), so it is never run, and the raw file is not what they would commit.
        const filtered = await filteredPaths(root, write.filter((w) => w.mode !== '120000').map((w) => w.path));
        // The blobs, into the temporary object directory ONLY (`own`): a symlink is its target's text.
        const files = write.filter((w) => w.mode !== '120000' && !filtered.has(w.path));
        skippedFiltered.push(...[...filtered].sort());
        const shas = files.length > 0 ? (await tmpGit(['hash-object', '-w', '--stdin-paths'], own, `${files.map((f) => f.path).join('\n')}\n`)).split('\n') : [];
        files.forEach((f, n) => lines.push(`${f.mode} ${shas[n]}\t${f.path}`));
        for (const l of write.filter((w) => w.mode === '120000')) {
          const sha = await tmpGit(['hash-object', '-w', '--stdin'], own, readlinkSync(join(root, l.path)));
          lines.push(`120000 ${sha}\t${l.path}`);
        }
        await tmpGit(['update-index', '-z', '--index-info'], borrow, lines.map((l) => `${l}\0`).join(''));
        // The trees, into the temporary object directory ONLY; the unchanged subtrees are named, never rewritten.
        const tree = await tmpGit(['write-tree', '--missing-ok'], own);
        const headTree = await tmpGit(['rev-parse', `${commitSha}^{tree}`], borrow);
        if (tree !== headTree) {
          headSha = await tmpGit(['commit-tree', tree, '-p', commitSha, '-m', 'Uncommitted changes (not committed yet)'], borrow);
          uncommittedChanges = true;
        }
      }
    }
    if (headSha === baseSha) {
      throw new SnapshotRefusal(`Nothing to review: the branch has no commits after ${baseRef}${o.includeUncommitted ? ' and no uncommitted changes' : ''}.`);
    }
    await tmpGit(['update-ref', 'refs/heads/review', headSha], borrow);
    const file = join(tmp, 'branch.bundle');
    await tmpGit(['bundle', 'create', '-q', file, 'refs/heads/review', `^${baseSha}`], borrow);
    const max = o.maxBytes ?? LOCAL_REVIEW_BUNDLE_MAX_BYTES;
    const size = statSync(file).size;
    if (size > max) throw new SnapshotRefusal(`The branch is too large to send (${(size / (1024 * 1024)).toFixed(1)} MB; the limit is ${Math.round(max / (1024 * 1024))} MB).`);
    return {
      root,
      owner: remote.owner,
      name: remote.name,
      branch,
      baseRef,
      baseSha,
      headSha,
      commitSha,
      includeUncommitted: o.includeUncommitted,
      uncommittedChanges,
      skippedFiltered,
      subjects,
      bundle: readFileSync(file),
    };
  } catch (err) {
    if (err instanceof SnapshotRefusal) throw err;
    const line = (err as { stderr?: string }).stderr?.split('\n').find((l) => l.trim() !== '') ?? (err instanceof Error ? err.message.split('\n')[0] : String(err));
    throw new SnapshotRefusal(`Ensemble could not package the branch: ${String(line).replace(/^(fatal|error):\s*/i, '').slice(0, 200)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
