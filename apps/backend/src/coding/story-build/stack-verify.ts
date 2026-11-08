// THE HOST'S CHECK OF A STACK FROM THE SANDBOX (docs/STORY-BUILD.md § Plan first → Stacks). The sandbox
// hands out ONE git bundle per repository (sandbox/session/stack.ts): `refs/limn/stack/<k>` for each planned
// PR's tip, `^refs/limn/base`. Here, in Limn's clone cache for THAT repository only, with hooks, the
// reader's config and (for the checks) the lazy fetch off — the `verifyMergeBundle` discipline:
//
//   1. `bundle list-heads`: only the expected `refs/limn/stack/<k>`, each once, and nothing else;
//   2. the bundle's prerequisites are exactly the session's base commit (`bundle verify` then finds it);
//   3. fetched with every object fsck'd into `refs/pierre/story-build/<buildId>/stack/<prRowId>`;
//   4. LINEAGE: the base is an ancestor of tip 1; tip k−1 is an ancestor of tip k; no merge commit between
//      them; at most STACK_MAX_COMMITS per PR; no gitlink and no path inside `.git`;
//   5. per PR the patch (`git diff --binary <prev> <tip>`, ≤ the patch cap, never cut), its numstat, the tip's
//      tree and the folded commit messages. An empty diff ⇒ `empty`.
//
// A failure at PR k fails k and every later PR of the repository (they build on it); other repositories
// are not touched. ⚠ What the reader reviews and what Push sends are computed HERE, never in the sandbox.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxRepoStat } from '@pierre-review/shared';
import { mergeGitEnv } from '../ai-fix/merge-verify.js';
import { foldCommitMessages } from '../../sandbox/session/patches.js';
import { STACK_REF_PREFIX, type StackExtract } from '../../sandbox/session/stack.js';
import { STORY_BUILD_REF_PREFIX } from './base-refs.js';

const SHA = /^[0-9a-f]{40}$/;
export const STACK_MAX_COMMITS = 200;
const HARDEN = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];

interface GitRun {
  code: number;
  stdout: Buffer;
  stderr: string;
}

function gitRun(dir: string, args: string[], o: { lazy?: boolean; token?: string | null } = {}): Promise<GitRun> {
  const pre = o.lazy && o.token ? ['-c', `url.https://x-access-token:${o.token}@github.com/.insteadOf=https://github.com/`] : [];
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...HARDEN, ...pre, '-C', dir, ...args],
      { env: mergeGitEnv(o.lazy ? { GIT_NO_LAZY_FETCH: '0' } : {}), timeout: 120_000, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
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

/** The ref keeping one planned PR's verified tip in the clone cache (base-refs.ts parses and sweeps it). */
export function storyBuildStackRef(buildId: number, prRowId: number): string {
  return `${STORY_BUILD_REF_PREFIX}${buildId}/stack/${prRowId}`;
}

export interface StackPlannedPr {
  /** 1..3 within the repository, in order. */
  k: number;
  prRowId: number;
  key: string;
  branch: string;
}

export interface StackPrVerdict {
  prRowId: number;
  k: number;
  status: 'ready' | 'empty' | 'failed';
  tipSha: string | null;
  treeSha: string | null;
  patch: string | null;
  patchSha: string | null;
  stat: SandboxRepoStat | null;
  filesChanged: string[];
  commitMessage: string | null;
  error: string | null;
}

export interface StackVerdict {
  prs: StackPrVerdict[];
  /** base..last usable tip: the repository's whole change (the per-repository diff, Resume). */
  whole: { patch: string; patchSha: string | null; stat: SandboxRepoStat; filesChanged: string[]; commitMessage: string | null } | null;
}

export interface VerifyStackInput {
  gitDir: string;
  buildId: number;
  baseSha: string;
  planned: readonly StackPlannedPr[];
  extract: StackExtract;
  maxPatchBytes: number;
  /** For the blobs a blobless clone cache lacks (the diffs). Absent ⇒ no network. */
  token?: string | null;
}

const failAll = (planned: readonly StackPlannedPr[], from: number, error: string, prev: StackPrVerdict[] = []): StackPrVerdict[] => [
  ...prev,
  ...planned
    .filter((p) => p.k >= from)
    .map((p) => ({ prRowId: p.prRowId, k: p.k, status: 'failed' as const, tipSha: null, treeSha: null, patch: null, patchSha: null, stat: null, filesChanged: [], commitMessage: null, error })),
];

/** The bundle file's prerequisite commits (its header's `-<sha>` lines). */
async function bundlePrerequisites(file: string): Promise<string[] | null> {
  const head = (await readFile(file)).subarray(0, 64 * 1024).toString('latin1');
  const lines = head.split('\n');
  if (!/^# v[23] git bundle$/.test(lines[0] ?? '')) return null;
  const out: string[] = [];
  for (const l of lines.slice(1)) {
    if (l === '') return out;
    if (l.startsWith('@')) continue; // v3 capabilities
    if (l.startsWith('-')) {
      const sha = l.slice(1, 41);
      if (!SHA.test(sha)) return null;
      out.push(sha);
    }
  }
  return null;
}

function parseNumstat(text: string): { files: string[]; insertions: number; deletions: number } {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const rec of text.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(rec.replace(/^\n/, ''));
    if (!m) continue;
    if (m[1] !== '-') insertions += Number(m[1]);
    if (m[2] !== '-') deletions += Number(m[2]);
    files.push(m[3]!);
  }
  return { files, insertions, deletions };
}

/** One range's numbers and patch, computed in the clone cache. */
async function rangeView(dir: string, from: string, to: string, token: string | null): Promise<{ patch: string; stat: SandboxRepoStat; filesChanged: string[]; commitMessage: string | null }> {
  const run = async (args: string[]): Promise<string> => {
    const r = await gitRun(dir, args, { lazy: true, token });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed`);
    return r.stdout.toString('utf8');
  };
  const patch = from === to ? '' : await run(['diff', '--binary', ...DIFF_FLAGS, from, to]);
  const ns = parseNumstat(from === to ? '' : await run(['diff', '--numstat', '-z', '--no-renames', from, to]));
  const count = from === to ? 0 : Number.parseInt((await run(['rev-list', '--count', `${from}..${to}`])).trim(), 10) || 0;
  const messages = from === to ? '' : await run(['log', '--reverse', '--format=%B%x1e', `${from}..${to}`]);
  return {
    patch,
    stat: { files: ns.files.length, insertions: ns.insertions, deletions: ns.deletions, commits: count },
    filesChanged: ns.files,
    commitMessage: foldCommitMessages(messages),
  };
}

const sha256 = (s: string): string | null => (s === '' ? null : createHash('sha256').update(s).digest('hex'));

/** The lineage and content rules of one PR's range (step 4). null ⇒ fine; else one sentence. */
async function rangeProblem(dir: string, prev: string, tip: string, key: string, prevLabel: string): Promise<string | null> {
  const anc = await gitRun(dir, ['merge-base', '--is-ancestor', prev, tip]);
  if (anc.code !== 0) return `${key} does not build on ${prevLabel}.`;
  const merges = await gitRun(dir, ['rev-list', '--merges', `${prev}..${tip}`]);
  if (merges.code !== 0) return `Limn could not read the commits of ${key}.`;
  if (merges.stdout.toString('utf8').trim() !== '') return `${key} has a merge commit. Each pull request must be a straight line of commits.`;
  const count = await gitRun(dir, ['rev-list', '--count', `${prev}..${tip}`]);
  if (count.code !== 0) return `Limn could not read the commits of ${key}.`;
  if (Number.parseInt(count.stdout.toString('utf8').trim(), 10) > STACK_MAX_COMMITS) return `${key} has more than ${STACK_MAX_COMMITS} commits.`;
  const raw = await gitRun(dir, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', prev, tip]);
  if (raw.code !== 0) return `Limn could not read the changes of ${key}.`;
  const parts = raw.stdout.toString('utf8').split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.replace(/^\n/, '');
    const path = parts[i + 1]!;
    const m = /^:(\d{6}) (\d{6}) /.exec(meta);
    if (!m) continue;
    if (m[1] === '160000' || m[2] === '160000') return `${key} changes a submodule (${path}). Limn does not push submodule changes.`;
    if (path.split('/').some((seg) => seg.toLowerCase() === '.git')) return `${key} changes a path inside .git (${path}).`;
  }
  return null;
}

/** Steps 1–5 for ONE repository. Never throws: a failure is a verdict on the PRs it reaches. */
export async function verifyStackBundle(a: VerifyStackInput): Promise<StackVerdict> {
  const planned = [...a.planned].sort((x, y) => x.k - y.k);
  if (!SHA.test(a.baseSha)) return { prs: failAll(planned, 1, 'Limn does not know the commit this repository started from.'), whole: null };
  if (a.extract.tooLargeBytes != null) {
    return { prs: failAll(planned, 1, `The commits are ${(a.extract.tooLargeBytes / 1024 / 1024).toFixed(1)} MB, more than Limn takes from the sandbox.`), whole: null };
  }
  const tmp = await mkdtemp(join(tmpdir(), 'limn-stack-check-'));
  try {
    const expected = new Map(planned.map((p) => [`${STACK_REF_PREFIX}${p.k}`, p]));
    /** k → the commit in the BUNDLE (the only tips Limn uses). */
    const inBundle = new Map<number, string>();
    if (a.extract.bundle != null) {
      const file = join(tmp, 'stack.bundle');
      await writeFile(file, a.extract.bundle, { mode: 0o600 });
      const heads = (await gitRun(a.gitDir, ['bundle', 'list-heads', file])).stdout
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const h of heads) {
        const m = /^([0-9a-f]{40}) (\S+)$/.exec(h);
        const p = m ? expected.get(m[2]!) : undefined;
        if (!m || !p || inBundle.has(p.k)) return { prs: failAll(planned, 1, 'The commits from the sandbox are not in the form Limn expects.'), whole: null };
        inBundle.set(p.k, m[1]!);
      }
      const prereq = await bundlePrerequisites(file);
      if (prereq == null || prereq.some((s) => s !== a.baseSha)) {
        return { prs: failAll(planned, 1, 'The commits from the sandbox do not start from the commit this repository started from.'), whole: null };
      }
      const verify = await gitRun(a.gitDir, ['bundle', 'verify', '-q', file]);
      if (verify.code !== 0) return { prs: failAll(planned, 1, 'Limn does not have the commit this repository started from.'), whole: null };
      if (inBundle.size > 0) {
        const specs = [...inBundle.keys()].map((k) => `+${STACK_REF_PREFIX}${k}:${storyBuildStackRef(a.buildId, planned.find((p) => p.k === k)!.prRowId)}`);
        const fetched = await gitRun(a.gitDir, [
          '-c', 'fetch.fsckObjects=true',
          '-c', 'transfer.fsckObjects=true',
          'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-auto-maintenance',
          file, ...specs,
        ]);
        if (fetched.code !== 0) return { prs: failAll(planned, 1, 'Limn could not read the commits from the sandbox.'), whole: null };
      }
    }

    const out: StackPrVerdict[] = [];
    let prev = a.baseSha;
    let prevLabel = 'the base commit';
    let lastGood: string | null = null;
    for (const p of planned) {
      if (a.extract.missing.has(p.k)) return { prs: failAll(planned, p.k, `The agent did not make the branch ${p.branch} for ${p.key}.`, out), whole: await wholeOf(a, lastGood) };
      const claimed = a.extract.tips.get(p.k);
      let tip: string;
      if (inBundle.has(p.k)) {
        tip = inBundle.get(p.k)!;
        if (claimed != null && claimed !== tip) return { prs: failAll(planned, p.k, 'The commits from the sandbox are not in the form Limn expects.', out), whole: await wholeOf(a, lastGood) };
      } else if (claimed === a.baseSha) {
        tip = a.baseSha;
      } else {
        return { prs: failAll(planned, p.k, `Limn did not get the commits of ${p.key} from the sandbox.`, out), whole: await wholeOf(a, lastGood) };
      }
      const problem = await rangeProblem(a.gitDir, prev, tip, p.key, prevLabel);
      if (problem) return { prs: failAll(planned, p.k, problem, out), whole: await wholeOf(a, lastGood) };
      const view = await rangeView(a.gitDir, prev, tip, a.token ?? null).catch(() => null);
      if (view == null) return { prs: failAll(planned, p.k, `Limn could not work out the diff of ${p.key}.`, out), whole: await wholeOf(a, lastGood) };
      const bytes = Buffer.byteLength(view.patch, 'utf8');
      if (bytes > a.maxPatchBytes) {
        return { prs: failAll(planned, p.k, `${p.key} is ${(bytes / 1024 / 1024).toFixed(1)} MB, more than the ${(a.maxPatchBytes / 1024 / 1024).toFixed(0)} MB Limn keeps.`, out), whole: await wholeOf(a, lastGood) };
      }
      const tree = (await gitRun(a.gitDir, ['rev-parse', '--verify', `${tip}^{tree}`])).stdout.toString('utf8').trim();
      out.push({
        prRowId: p.prRowId,
        k: p.k,
        status: view.patch === '' ? 'empty' : 'ready',
        tipSha: tip,
        treeSha: SHA.test(tree) ? tree : null,
        patch: view.patch === '' ? null : view.patch,
        patchSha: sha256(view.patch),
        stat: view.stat,
        filesChanged: view.filesChanged,
        commitMessage: view.commitMessage,
        error: view.patch === '' ? `${p.key} has no changes.` : null,
      });
      prev = tip;
      prevLabel = p.key;
      lastGood = tip;
    }
    return { prs: out, whole: await wholeOf(a, lastGood) };
  } catch {
    return { prs: failAll(planned, 1, 'Limn could not check the commits from the sandbox.'), whole: null };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function wholeOf(a: VerifyStackInput, lastGood: string | null): Promise<StackVerdict['whole']> {
  if (lastGood == null) return null;
  const v = await rangeView(a.gitDir, a.baseSha, lastGood, a.token ?? null).catch(() => null);
  if (v == null || Buffer.byteLength(v.patch, 'utf8') > a.maxPatchBytes) return null;
  return { patch: v.patch, patchSha: sha256(v.patch), stat: v.stat, filesChanged: v.filesChanged, commitMessage: v.commitMessage };
}

/** The real seam: the repository's clone cache, under its lock, the token for lazy blobs. */
export async function verifyStackInCloneCache(accountId: number, fullName: string, input: Omit<VerifyStackInput, 'gitDir' | 'token'>): Promise<StackVerdict> {
  const i = fullName.indexOf('/');
  const failed = (why: string): StackVerdict => ({ prs: failAll(input.planned, 1, why), whole: null });
  if (i <= 0) return failed('Limn does not know this repository any more.');
  const owner = fullName.slice(0, i);
  const name = fullName.slice(i + 1);
  try {
    const cm = await import('../../review/clone-manager.js');
    const token = await (await import('../../auth/account.js')).getAccessToken(accountId).catch(() => null);
    return await cm.withRepoLock(`${owner}/${name}`, () => verifyStackBundle({ ...input, gitDir: cm.repoCloneDir(owner, name), token }));
  } catch {
    return failed('Limn could not read its own copy of the repository to check the commits.');
  }
}
