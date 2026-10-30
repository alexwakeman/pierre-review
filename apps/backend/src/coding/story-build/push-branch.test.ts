// THE NO-PR PUSH VARIANT (coding/git-ops.ts `applyAndPushBranch`) on a REAL scratch worktree with a fake
// GitHub: a fresh tree at the base, the stored patch applied, ONE commit, a NEW branch (never an existing
// one), the protected refs refused before any process runs, the PR opened as a draft when asked — and a
// PR that GitHub refused to open said so in a sentence naming the branch that WAS pushed. Plus
// `createPullRequest`'s draft flag on the wire.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const T = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-story-push-')));
  process.env.DATABASE_URL = path.join(root, 'unused.sqlite');
  process.env.DISABLE_SCHEDULER = 'true';
  return {
    root,
    prepped: [] as any[],
    removed: [] as string[],
    pushed: [] as any[],
    prs: [] as any[],
    posts: [] as any[],
    branchExists: false,
    prFails: false,
    worktree: '' as string,
    base: '' as string,
  };
});

vi.mock('../../auth/account.js', () => ({
  getAccessToken: async () => 'gh-token',
  getAccountById: async () => ({ displayName: 'Uma', githubLogin: 'u1' }),
}));
vi.mock('../../sync/sync-one-pr.js', () => ({ syncOnePr: async () => {} }));
vi.mock('../../sync/resync-after-write.js', () => ({ settlePrAfterWrite: async () => {} }));
vi.mock('../../github/client.js', () => ({
  ghRestGetText: async () => ({ ok: T.branchExists }),
  ghRestGetFor: async () => ({}),
  ghRestPostFor: async (_t: string, path: string, body: unknown) => {
    T.posts.push({ path, body });
    return { number: 77, html_url: 'https://github.com/acme/web/pull/77' };
  },
}));
vi.mock('../../github/mutations.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../github/mutations.js')>();
  return {
    ...real,
    createPullRequest: async (_t: string, a: any) => {
      T.prs.push(a);
      if (T.prFails) throw new Error('Validation Failed');
      return { number: 77, url: 'https://github.com/acme/web/pull/77' };
    },
  };
});
vi.mock('../git.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../git.js')>();
  return {
    ...real,
    // The real ref checks (protected names refused before any process), then a recorder for the push.
    pushRef: async (t: any) => {
      await real.assertPushTarget(t.remoteBranch, t.protect);
      T.pushed.push(t);
    },
  };
});
vi.mock('../../review/clone-manager.js', () => ({
  prepBranchWorktree: async (owner: string, name: string, ref: any) => {
    T.prepped.push({ owner, name, ref });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cp = require('node:child_process') as typeof import('node:child_process');
    const wt = fs.mkdtempSync(path.join(T.root, 'wt-'));
    const git = (...a: string[]) => cp.execFileSync('git', ['-C', wt, ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(wt, 'app.ts'), 'export const x = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    T.worktree = wt;
    return { repoCloneDir: T.root, worktreePath: wt, sha: ref.sha };
  },
  prepWorktree: async () => {
    throw new Error('not in this test');
  },
  removeWorktreeLocked: async (_o: string, _n: string, _c: string, wt: string) => {
    T.removed.push(wt);
  },
  cleanupCloneCache: () => {},
}));

const { applyAndPushBranch } = await import('../git-ops.js');

const PATCH = [
  'diff --git a/refund.ts b/refund.ts',
  'new file mode 100644',
  'index 0000000..1b2c3d4',
  '--- /dev/null',
  '+++ b/refund.ts',
  '@@ -0,0 +1 @@',
  '+export const refund = 1;',
  '',
].join('\n');

const args = (over: Record<string, unknown> = {}): any => ({
  accountId: 1,
  owner: 'acme',
  name: 'web',
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
  patch: PATCH,
  commitMessage: 'feat: refund button',
  branch: 'acme-214-refunds-web',
  prBase: 'main',
  title: 'ACME-214: Refunds by card',
  body: 'Body.',
  draft: true,
  protect: ['main'],
  ...over,
});

beforeEach(() => {
  T.prepped.length = 0;
  T.removed.length = 0;
  T.pushed.length = 0;
  T.prs.length = 0;
  T.posts.length = 0;
  T.branchExists = false;
  T.prFails = false;
});
afterAll(() => rmSync(T.root, { recursive: true, force: true }));

describe('applyAndPushBranch — the no-PR push', () => {
  it('a fresh tree at the base, the patch, ONE commit by the reader, a new branch, a DRAFT PR', async () => {
    const r = await applyAndPushBranch(args());
    expect(r).toMatchObject({ pushedBranch: 'acme-214-refunds-web', prNumber: 77, prUrl: 'https://github.com/acme/web/pull/77' });
    expect(T.prepped[0]).toEqual({ owner: 'acme', name: 'web', ref: { remoteRef: 'refs/heads/main', destRef: 'refs/pierre/story-build-base', sha: 'b'.repeat(40) } });
    const log = execFileSync('git', ['-C', T.worktree, 'log', '--format=%an <%ae>|%s'], { encoding: 'utf8' }).trim().split('\n');
    expect(log[0]).toBe('Uma <u1@users.noreply.github.com>|feat: refund button');
    expect(log).toHaveLength(2);
    expect(T.pushed[0]).toMatchObject({ remoteBranch: 'acme-214-refunds-web', committish: 'HEAD', protect: ['main'] });
    expect(T.prs[0]).toMatchObject({ head: 'acme-214-refunds-web', base: 'main', draft: true, title: 'ACME-214: Refunds by card', body: 'Body.' });
    // The temporary tree is always removed.
    expect(T.removed).toEqual([T.worktree]);
  });

  it('never lands on an existing branch: BRANCH_EXISTS before any checkout', async () => {
    T.branchExists = true;
    await expect(applyAndPushBranch(args())).rejects.toMatchObject({ code: 'BRANCH_EXISTS' });
    expect(T.prepped).toEqual([]);
  });

  it('refuses a protected branch (the default branch, a stacked PR’s head) before pushing', async () => {
    await expect(applyAndPushBranch(args({ branch: 'main' }))).rejects.toMatchObject({ code: 'PUSH_DENIED' });
    await expect(applyAndPushBranch(args({ branch: 'u1/refunds-base', protect: ['main', 'u1/refunds-base'] }))).rejects.toMatchObject({ code: 'PUSH_DENIED' });
    expect(T.pushed).toEqual([]);
    expect(T.prs).toEqual([]);
  });

  it('a patch that does not apply is APPLY_FAILED, nothing pushed', async () => {
    await expect(applyAndPushBranch(args({ patch: 'diff --git a/nope b/nope\n--- a/nope\n+++ b/nope\n@@ -1 +1 @@\n-a\n+b\n' }))).rejects.toMatchObject({ code: 'APPLY_FAILED' });
    expect(T.pushed).toEqual([]);
  });

  it('a PR GitHub refused to open names the branch that WAS pushed', async () => {
    T.prFails = true;
    const err = await applyAndPushBranch(args()).catch((e) => e);
    expect(err.code).toBe('PR_NOT_OPENED');
    expect(err.message).toContain('The branch acme-214-refunds-web was pushed, but GitHub did not open the pull request');
    expect(err.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(T.pushed).toHaveLength(1);
  });
});

describe('createPullRequest’s draft flag', () => {
  it('sends draft:true only when asked; absent otherwise (as before)', async () => {
    const real = await vi.importActual<typeof import('../../github/mutations.js')>('../../github/mutations.js');
    await real.createPullRequest('t', { owner: 'acme', name: 'web', head: 'h', base: 'main', title: 't', body: 'b', draft: true });
    await real.createPullRequest('t', { owner: 'acme', name: 'web', head: 'h', base: 'main', title: 't', body: 'b' });
    expect(T.posts[0].body).toMatchObject({ draft: true });
    expect('draft' in T.posts[1].body).toBe(false);
  });
});
