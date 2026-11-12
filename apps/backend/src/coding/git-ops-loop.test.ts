// THE REVIEW LOOP'S GIT STEPS (git-ops.ts) on a REAL scratch repository with a fake GitHub:
//   • `pushFastForward`: an unchanged tree with no extra parent pushes NOTHING; a new tree is ONE commit by
//     the reader whose parents are [the pushed commit, ...extra] (a stacked PR's merge parent), pushed
//     without force; the live branch moved ⇒ HEAD_MOVED before anything is written;
//   • `treeOfPatch`: the tree a patch makes on its base (the objects land in the clone);
//   • `openPrForBranch`: the PR opens READY unless asked, as the reader's;
//   • `liveBranchSha`: 404 ⇒ null.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = vi.hoisted(() => ({ live: null as null | { status: number; sha?: string }, pushed: [] as any[], prs: [] as any[], repo: '' }));

vi.mock('../auth/account.js', () => ({
  getAccessToken: async () => 'gh-token',
  getAccountById: async () => ({ displayName: 'Uma', githubLogin: 'u1' }),
}));
vi.mock('../sync/sync-one-pr.js', () => ({ syncOnePr: async () => {} }));
vi.mock('../sync/resync-after-write.js', () => ({ settlePrAfterWrite: async () => {} }));
vi.mock('../github/client.js', () => ({
  ghRestGetText: async () =>
    T.live == null ? { ok: false, status: 404, text: '' } : { ok: T.live.status === 200, status: T.live.status, text: JSON.stringify({ object: { sha: T.live.sha } }) },
  ghRestGetFor: async () => ({}),
}));
vi.mock('../github/mutations.js', async (orig) => ({
  ...(await orig<typeof import('../github/mutations.js')>()),
  createPullRequest: async (_t: string, a: any, origin: unknown) => {
    T.prs.push({ ...a, origin });
    return { number: 9, url: 'https://github.com/acme/api/pull/9' };
  },
}));
vi.mock('./git.js', async (orig) => {
  const real = await orig<typeof import('./git.js')>();
  return { ...real, pushRef: async (t: any) => void T.pushed.push(t) };
});
vi.mock('../review/clone-manager.js', () => ({
  resolveBranchCommit: async () => ({ repoCloneDir: T.repo, sha: '' }),
  prepBranchWorktree: async (_o: string, _n: string, ref: any) => {
    const wt = mkdtempSync(join(tmpdir(), 'limn-ff-wt-'));
    execFileSync('git', ['-C', T.repo, 'worktree', 'add', '--detach', wt, ref.sha]);
    return { repoCloneDir: T.repo, worktreePath: wt, sha: ref.sha };
  },
  removeWorktreeLocked: async (_o: string, _n: string, dir: string, wt: string) => {
    execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', wt]);
  },
  cleanupCloneCache: () => {},
  prepWorktree: async () => {
    throw new Error('unused');
  },
}));

const git = (...a: string[]): string => execFileSync('git', ['-C', T.repo, ...a], { encoding: 'utf8' }).trim();
T.repo = mkdtempSync(join(tmpdir(), 'limn-ff-'));
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t');
git('config', 'user.name', 't');
writeFileSync(join(T.repo, 'a.ts'), 'one\n');
git('add', '-A');
git('commit', '-qm', 'base');
const BASE = git('rev-parse', 'HEAD');
writeFileSync(join(T.repo, 'a.ts'), 'two\n');
git('commit', '-qam', 'pushed');
const PUSHED = git('rev-parse', 'HEAD');
const PUSHED_TREE = git('rev-parse', 'HEAD^{tree}');
git('checkout', '-q', '--detach', BASE);
afterAll(() => rmSync(T.repo, { recursive: true, force: true }));

const ops = await import('./git-ops.js');

beforeEach(() => {
  T.live = { status: 200, sha: PUSHED };
  T.pushed.length = 0;
  T.prs.length = 0;
});

const ff = (over: Partial<Parameters<typeof ops.pushFastForward>[0]> = {}) =>
  ops.pushFastForward({ accountId: 1, owner: 'acme', name: 'api', branch: 'PAY-142', pushedSha: PUSHED, tree: PUSHED_TREE, message: 'Address review round 1', protect: ['main'], destRef: 'refs/pierre/story-loop/1/repo-1', ...over });

describe('pushFastForward', () => {
  it('pushes nothing when the tree did not change', async () => {
    expect(await ff()).toEqual({ commitSha: PUSHED, pushed: false });
    expect(T.pushed).toEqual([]);
  });

  it('commits the new tree on the pushed commit (plus a merge parent), by the reader, and pushes it', async () => {
    const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-one\n+three\n';
    const tree = await ops.treeOfPatch(1, 'acme', 'api', 'main', BASE, patch);
    expect(git('cat-file', '-t', tree)).toBe('tree');
    const r = await ff({ tree, extraParents: [BASE] });
    expect(r.pushed).toBe(true);
    expect(git('show', '-s', '--format=%T %P %an', r.commitSha)).toBe(`${tree} ${PUSHED} ${BASE} Uma`);
    expect(T.pushed).toHaveLength(1);
    expect(T.pushed[0]).toMatchObject({ committish: r.commitSha, remoteBranch: 'PAY-142', origin: 'reader', protect: ['main'] });
    expect(git('rev-parse', 'refs/pierre/story-loop/1/repo-1')).toBe(r.commitSha);
  });

  it('refuses when someone pushed to the branch outside Limn', async () => {
    T.live = { status: 200, sha: BASE };
    await expect(ff({ tree: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'HEAD_MOVED' });
    T.live = null;
    await expect(ff({ tree: 'f'.repeat(40) })).rejects.toMatchObject({ code: 'HEAD_MOVED' });
    expect(T.pushed).toEqual([]);
  });
});

describe('openPrForBranch and liveBranchSha', () => {
  it('opens the PR ready for review, as the reader', async () => {
    const r = await ops.openPrForBranch({ accountId: 1, owner: 'acme', name: 'api', branch: 'PAY-142', prBase: 'main', title: 'PAY-142: Refunds', body: 'b', draft: false });
    expect(r).toEqual({ prNumber: 9, prUrl: 'https://github.com/acme/api/pull/9' });
    expect(T.prs[0]).toMatchObject({ head: 'PAY-142', base: 'main', draft: false, origin: 'reader' });
  });

  it('reads a missing branch as null', async () => {
    T.live = null;
    expect(await ops.liveBranchSha(1, 'acme', 'api', 'PAY-142')).toBeNull();
    T.live = { status: 200, sha: PUSHED };
    expect(await ops.liveBranchSha(1, 'acme', 'api', 'PAY-142')).toBe(PUSHED);
  });
});
