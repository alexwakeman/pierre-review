// THE CLONE-CACHE SIDE OF AN AI FIX'S MERGE (docs/SANDBOX.md § AI Fix sessions, "The merge"): which base
// commit is merged, the merge base, and a repository holding both for the host's checks. Every step runs
// under clone-manager's per-repository lock; every commit is pinned under the fix's own ref prefix
// (`refs/pierre/ai-fix/<fixId>/merge/*`), so `dropAiFixBaseRefs` drops them with the rest.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AI_FIX_REF_PREFIX } from '../story-build/base-refs.js';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;

/** A pin of the merge's commits in the clone cache: base tip, merge base, the head, the checked result. */
export function aiFixMergeRef(fixId: number, which: 'base' | 'merge-base' | 'head' | 'result'): string {
  return `${AI_FIX_REF_PREFIX}${fixId}/merge/${which}`;
}

export interface MergePlan {
  baseSha: string;
  mergeBaseSha: string;
}

export class NoMergeBaseError extends Error {}

/**
 * The base branch's tip NOW (the merge's second parent, pinned so it never moves for this fix) and the
 * merge base of it and the PR head. Throws `NoMergeBaseError` when the two have no common commit.
 */
export async function resolveMergePlan(a: {
  fixId: number;
  owner: string;
  name: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  /** Resume and Push: the tip picked at the start. */
  baseSha?: string | null;
}): Promise<MergePlan> {
  const cm = await import('../../review/clone-manager.js');
  await cm.resolveBranchCommit(a.owner, a.name, {
    remoteRef: `refs/pull/${a.prNumber}/head`,
    destRef: 'refs/pierre/sandbox-base',
    sha: a.headSha,
    pinRef: aiFixMergeRef(a.fixId, 'head'),
  });
  const base = await cm.resolveBranchCommit(a.owner, a.name, {
    remoteRef: `refs/heads/${a.baseRef}`,
    destRef: 'refs/pierre/sandbox-base',
    sha: a.baseSha ?? null,
    pinRef: aiFixMergeRef(a.fixId, 'base'),
  });
  const dir = cm.repoCloneDir(a.owner, a.name);
  const mergeBaseSha = await cm.withRepoLock(`${a.owner}/${a.name}`, async () => {
    let mb = '';
    try {
      mb = (await execFileAsync('git', ['-C', dir, 'merge-base', a.headSha, base.sha], { timeout: 60_000, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } })).stdout.trim();
    } catch {
      mb = '';
    }
    if (!SHA.test(mb)) throw new NoMergeBaseError(`The pull request and ${a.baseRef} have no commit in common.`);
    await execFileAsync('git', ['-C', dir, 'update-ref', aiFixMergeRef(a.fixId, 'merge-base'), mb], { timeout: 30_000 });
    return mb;
  });
  return { baseSha: base.sha, mergeBaseSha };
}

/**
 * Run `fn` on Limn's clone of the PR repository once it holds the PR head and the base tip (fetched again
 * when the cache was evicted), under the repository's lock.
 */
export async function withMergeRepo<T>(
  a: { fixId: number; owner: string; name: string; prNumber: number; headSha: string; baseRef: string; baseSha: string },
  fn: (gitDir: string) => Promise<T>,
): Promise<T> {
  const cm = await import('../../review/clone-manager.js');
  await cm.resolveBranchCommit(a.owner, a.name, { remoteRef: `refs/pull/${a.prNumber}/head`, destRef: 'refs/pierre/sandbox-base', sha: a.headSha, pinRef: aiFixMergeRef(a.fixId, 'head') });
  await cm.resolveBranchCommit(a.owner, a.name, { remoteRef: `refs/heads/${a.baseRef}`, destRef: 'refs/pierre/sandbox-base', sha: a.baseSha, pinRef: aiFixMergeRef(a.fixId, 'base') });
  const dir = cm.repoCloneDir(a.owner, a.name);
  return cm.withRepoLock(`${a.owner}/${a.name}`, () => fn(dir));
}
