// THE HOST'S CHECK OF AN AI FIX'S MERGE (docs/SANDBOX.md § AI Fix sessions, "The merge"). The sandbox hands
// out a git bundle of `refs/limn/out ^<PR head> ^<base tip>` (sandbox/session/fix-merge.ts). Here, in Limn's
// clone cache (which has both prerequisite commits), with git's lazy fetch, hooks and the reader's config
// off:
//
//   1. the bundle names exactly ONE ref (`refs/limn/out`) and its prerequisites are present;
//   2. it is fetched under a namespaced ref with every object fsck'd;
//   3. THE SHAPE: the commits it adds form ONE first-parent line from the PR head: the oldest is a merge
//      commit with EXACTLY two parents, (the PR head, the base tip), in that order; every later one has one
//      parent (the fixes sit ON TOP of the merge); nothing else (no side branch, no second merge);
//   4. THE MARKERS: in the merge commit and in the last commit, no file that was in conflict holds a
//      conflict marker (`<<<<<<< `, `>>>>>>> `, `||||||| `). A file whose blob is one side's own version is
//      taken as resolved; a new blob is read and checked; one Limn cannot read fails the check.
//
// Nothing here touches another repository: the bundle is the PR repository's, fetched into its own cache.
// The push (`buildMergeCommits` + coding/git-ops.ts `pushMergeResult`) rebuilds the commits from the
// VERIFIED trees under the reader's own name, so nothing about the agent's commit objects reaches GitHub.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasConflictMarkers } from '../merge.js';

const SHA = /^[0-9a-f]{40}$/;
/** At most this many commits past the PR head (a fix is a handful). */
export const MERGE_MAX_COMMITS = 200;
const OUT_REF = 'refs/limn/out';

/** The environment of every git call here: nothing from the reader's config, no network, no lazy fetch. */
export function mergeGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    ...extra,
  };
}

const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function gitRun(dir: string, args: string[], env?: Record<string, string>): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...HARDEN, '-C', dir, ...args],
      { env: mergeGitEnv(env), timeout: 120_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
        const e = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr);
        if (err) {
          const code = (err as { code?: unknown }).code;
          if (typeof code === 'number') return resolve({ code, stdout: out, stderr: e });
          return reject(err);
        }
        resolve({ code: 0, stdout: out, stderr: e });
      },
    );
  });
}

async function gitText(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await gitRun(dir, args, env);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}`.slice(0, 300));
  return r.stdout.toString('utf8');
}

/** The blob id at `commit:path`, or null when the path is not a file there. */
async function blobAt(dir: string, commit: string, path: string): Promise<string | null> {
  const r = await gitRun(dir, ['rev-parse', '-q', '--verify', `${commit}:${path}`]);
  if (r.code !== 0) return null;
  const oid = r.stdout.toString('utf8').trim();
  if (!SHA.test(oid)) return null;
  const t = await gitRun(dir, ['cat-file', '-t', oid]);
  return t.code === 0 && t.stdout.toString('utf8').trim() === 'blob' ? oid : null;
}

/**
 * WHAT THE READER REVIEWS, computed HERE from the verified commits — never the sandbox's own diffs (the
 * agent controls the sandbox: its refs, its git config, even its `git`). Push sends exactly these trees,
 * so the diffs shown are the diffs pushed.
 */
export interface HostMergeView {
  /** The fix ON TOP of the merge (merge..result), `git diff --binary`. */
  fixPatch: string;
  fixFiles: string[];
  /** The merge commit against git's own automatic merge of (PR head, base tip), markers and all. */
  resolutionDiff: string;
  resolutionFiles: string[];
  /** The files git's own merge (on the host) leaves in conflict. */
  conflictedFiles: string[];
}

export type MergeVerdict =
  | { ok: true; mergeSha: string; resultSha: string; fixCommits: number; view: HostMergeView }
  | { ok: false; reason: string };

type ShapeVerdict = { ok: true; mergeSha: string; resultSha: string; fixCommits: number } | { ok: false; reason: string };

export interface VerifyMergeInput {
  /** A repository holding the PR head and the base tip (Limn's clone cache for the PR repository). */
  gitDir: string;
  bundle: Buffer;
  headSha: string;
  baseSha: string;
  baseRef: string;
  /** The files git found in conflict when Limn started the merge. */
  conflictedFiles: readonly string[];
  /** Where the bundle's commit is kept in `gitDir` (namespaced: `aiFixMergeRef(fixId, 'result')`). */
  resultRef: string;
  /** For the blobs a blobless clone cache lacks (the diffs below). Absent ⇒ no network (a full clone). */
  token?: string | null;
}

/** Steps 1–4. Never throws: any failure is a verdict with one plain sentence. */
export async function verifyMergeBundle(a: VerifyMergeInput): Promise<MergeVerdict> {
  if (!SHA.test(a.headSha) || !SHA.test(a.baseSha)) return { ok: false, reason: 'Limn does not know the commits to check the merge against.' };
  if (!a.resultRef.startsWith('refs/pierre/')) return { ok: false, reason: 'Not a ref Limn keeps.' };
  const tmp = await mkdtemp(join(tmpdir(), 'limn-merge-check-'));
  try {
    const file = join(tmp, 'out.bundle');
    await writeFile(file, a.bundle, { mode: 0o600 });
    const heads = (await gitRun(a.gitDir, ['bundle', 'list-heads', file])).stdout
      .toString('utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (heads.length !== 1 || !/^[0-9a-f]{40} refs\/limn\/out$/.test(heads[0]!)) {
      return { ok: false, reason: 'The commits from the sandbox are not in the form Limn expects.' };
    }
    const verify = await gitRun(a.gitDir, ['bundle', 'verify', '-q', file]);
    if (verify.code !== 0) return { ok: false, reason: 'The merge does not start from the pull request\'s head and the base Limn picked.' };
    const fetched = await gitRun(a.gitDir, [
      '-c', 'fetch.fsckObjects=true',
      '-c', 'transfer.fsckObjects=true',
      'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance',
      file, `+${OUT_REF}:${a.resultRef}`,
    ]);
    if (fetched.code !== 0) return { ok: false, reason: 'Limn could not read the commits from the sandbox.' };
    // Git's own merge, HERE: its conflicted files join the marker check (the sandbox's list is the agent's
    // machine's word), and its tree is the baseline of the resolution diff.
    const auto = await hostAutoMerge(a.gitDir, a.headSha, a.baseSha, a.token ?? null);
    const conflictedFiles = [...new Set([...a.conflictedFiles, ...(auto?.conflictedFiles ?? [])])];
    const shape = await checkShape({ ...a, conflictedFiles });
    if (!shape.ok) return shape;
    const view = await hostMergeView(a.gitDir, { ...shape, headSha: a.headSha }, auto, a.token ?? null).catch(() => null);
    if (view == null) return { ok: false, reason: 'Limn could not work out the diff of the merge to show.' };
    return { ...shape, view: { ...view, conflictedFiles } };
  } catch {
    return { ok: false, reason: 'Limn could not check the merge.' };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Steps 3–4 on a commit already in `gitDir` (`resultRef`). Exported for the push's re-check. */
export async function checkShape(a: Omit<VerifyMergeInput, 'bundle'>): Promise<ShapeVerdict> {
  const result = (await gitText(a.gitDir, ['rev-parse', '--verify', `${a.resultRef}^{commit}`])).trim();
  const lines = (await gitText(a.gitDir, ['rev-list', '--parents', `--max-count=${MERGE_MAX_COMMITS + 1}`, result, `^${a.headSha}`, `^${a.baseSha}`]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: false, reason: 'There is no merge commit.' };
  if (lines.length > MERGE_MAX_COMMITS) return { ok: false, reason: `There are more than ${MERGE_MAX_COMMITS} commits on top of the pull request.` };
  const parents = new Map<string, string[]>();
  for (const l of lines) {
    const [c, ...ps] = l.split(' ');
    parents.set(c!, ps);
  }
  // The first-parent line from the result down to the first commit that is not new.
  const chain: string[] = [];
  let c: string | undefined = result;
  while (c != null && parents.has(c)) {
    chain.push(c);
    c = parents.get(c)![0];
  }
  const merge = chain[chain.length - 1]!;
  const mp = parents.get(merge)!;
  if (mp.length !== 2 || mp[0] !== a.headSha || mp[1] !== a.baseSha) {
    return {
      ok: false,
      reason: `The merge commit's parents are not the pull request's head (${a.headSha.slice(0, 7)}) and ${a.baseRef} (${a.baseSha.slice(0, 7)}), in that order.`,
    };
  }
  for (const x of chain.slice(0, -1)) {
    if (parents.get(x)!.length !== 1) return { ok: false, reason: 'A second merge commit sits on top of the merge.' };
  }
  if (chain.length !== parents.size) return { ok: false, reason: 'Commits from outside the pull request\'s line are in the result.' };

  for (const commit of [merge, result]) {
    for (const path of a.conflictedFiles) {
      const oid = await blobAt(a.gitDir, commit, path);
      if (oid == null) continue; // deleted, or no longer a file: nothing to hold a marker
      if (oid === (await blobAt(a.gitDir, a.headSha, path)) || oid === (await blobAt(a.gitDir, a.baseSha, path))) continue;
      const blob = await gitRun(a.gitDir, ['cat-file', 'blob', oid]);
      if (blob.code !== 0) return { ok: false, reason: `Limn could not read ${path} to check it.` };
      if (hasConflictMarkers(blob.stdout.toString('latin1'))) {
        return { ok: false, reason: `${path} still has a conflict marker${commit === merge ? ' in the merge commit' : ''}.` };
      }
    }
  }
  return { ok: true, mergeSha: merge, resultSha: result, fixCommits: chain.length - 1 };
}

/** git with lazy blob fetch ON (a blobless cache) and the token only in a process-scoped `insteadOf`. */
async function gitLazy(dir: string, args: string[], token: string | null): Promise<GitRun> {
  const pre = token ? ['-c', `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`] : [];
  return gitRun(dir, [...pre, ...args], { GIT_NO_LAZY_FETCH: '0' });
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

/** `git merge-tree --write-tree` of (head, base) on the host: the tree, markers and all, and the conflicted files. null on an old git. */
async function hostAutoMerge(dir: string, headSha: string, baseSha: string, token: string | null): Promise<{ tree: string; conflictedFiles: string[] } | null> {
  const r = await gitLazy(dir, ['merge-tree', '--write-tree', '--no-messages', '--name-only', '-z', headSha, baseSha], token);
  if (r.code !== 0 && r.code !== 1) return null;
  const parts = r.stdout.toString('utf8').split('\0');
  const tree = (parts[0] ?? '').trim();
  if (!SHA.test(tree)) return null;
  const files: string[] = [];
  for (const p of parts.slice(1)) {
    if (p === '') break;
    files.push(p);
  }
  return { tree, conflictedFiles: [...new Set(files)].slice(0, 1000) };
}

async function hostMergeView(
  dir: string,
  v: { mergeSha: string; resultSha: string; headSha: string },
  auto: { tree: string } | null,
  token: string | null,
): Promise<Omit<HostMergeView, 'conflictedFiles'>> {
  const run = async (args: string[]): Promise<string> => {
    const r = await gitLazy(dir, args, token);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed`);
    return r.stdout.toString('utf8');
  };
  const names = (t: string): string[] => t.split('\0').filter(Boolean);
  const fixPatch = v.resultSha === v.mergeSha ? '' : await run(['diff', '--binary', ...DIFF_FLAGS, v.mergeSha, v.resultSha]);
  const fixFiles = v.resultSha === v.mergeSha ? [] : names(await run(['diff', '--name-only', '-z', '--no-renames', v.mergeSha, v.resultSha]));
  // No `merge-tree --write-tree` (git < 2.38): the merge against the PR head — everything the merge brings
  // in, a superset of the resolution, never less.
  const from = auto?.tree ?? v.headSha;
  const resolutionDiff = await run(['diff', ...DIFF_FLAGS, from, v.mergeSha]);
  const resolutionFiles = names(await run(['diff', '--name-only', '-z', '--no-renames', from, v.mergeSha])).slice(0, 1000);
  return { fixPatch, fixFiles, resolutionDiff, resolutionFiles };
}

/**
 * The commits Push sends, rebuilt from the VERIFIED trees under the reader's name: the merge (parents
 * the PR head and the base tip, the merge's own tree) and, when there is a fix on top, ONE commit with the
 * last commit's tree. Returns the commit to push.
 */
export async function buildMergeCommits(
  gitDir: string,
  v: { mergeSha: string; resultSha: string; headSha: string; baseSha: string },
  o: { authorName: string; authorEmail: string; mergeMessage: string; fixMessage: string },
): Promise<string> {
  const who = {
    GIT_AUTHOR_NAME: o.authorName,
    GIT_AUTHOR_EMAIL: o.authorEmail,
    GIT_COMMITTER_NAME: o.authorName,
    GIT_COMMITTER_EMAIL: o.authorEmail,
  };
  const tree = async (c: string): Promise<string> => (await gitText(gitDir, ['rev-parse', '--verify', `${c}^{tree}`])).trim();
  const merged = (await gitText(gitDir, ['commit-tree', await tree(v.mergeSha), '-p', v.headSha, '-p', v.baseSha, '-m', o.mergeMessage], who)).trim();
  if (v.resultSha === v.mergeSha) return merged;
  const fixTree = await tree(v.resultSha);
  if (fixTree === (await tree(v.mergeSha))) return merged;
  return (await gitText(gitDir, ['commit-tree', fixTree, '-p', merged, '-m', o.fixMessage], who)).trim();
}
