// LOCAL PINNED REFS (review/local-refs.ts) and the LOCAL HEAD SOURCE (clone-manager.ts), on a REAL clone in a
// scratch clone cache, with NO network: `gh` gives no token and every GitHub URL is unreachable.
//   • `commitPatchToLocalRef` (git-ops.ts): the patch's tree on the base, ONE commit by the reader with parent
//     the base, pinned at `refs/pierre/local/<kind>/<id>/<name>` — nothing pushed; an empty patch pins the base;
//   • a branch review reads it: `localBranchDiff` with `{ localRef, sha }` (the diff of base...local commit),
//     `prepareBranchReview({ localRef })`, `prepHeadWorktree` (a detached checkout at that commit) — no fetch;
//   • a local head that is not (or no longer) at its ref is refused with a plain line;
//   • THE ONE SWEEP RULE: a held owner's refs and a keeper's ids are kept, everything else in the namespace
//     goes; a malformed ref is kept; discard drops one owner's refs; the pass is bounded by its cap.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const T = vi.hoisted(() => ({ root: '' }));

vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>();
  return { ...real, config: new Proxy(real.config, { get: (t, k) => (k === 'cloneDir' ? T.root : (t as Record<string | symbol, unknown>)[k]) }) };
});
// No GitHub: `gh` has no token, and the account's token is a dummy (any fetch would fail on the URL).
vi.mock('../github/auth.js', () => ({
  getGithubToken: () => {
    throw new Error('no gh token in this test');
  },
  getGithubTokenAsync: async () => {
    throw new Error('no gh token in this test');
  },
}));
vi.mock('../auth/account.js', () => ({
  getAccessToken: async () => 'unused-token',
  getAccountById: async () => ({ displayName: 'Uma', githubLogin: 'u1' }),
}));

T.root = mkdtempSync(join(tmpdir(), 'limn-local-refs-'));
const CLONE = join(T.root, 'acme__api');
const git = (...a: string[]): string => execFileSync('git', ['-C', CLONE, ...a], { encoding: 'utf8' }).trim();

let BASE = '';
let OTHER = '';

beforeAll(() => {
  mkdirSync(CLONE, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('remote', 'add', 'origin', 'https://github.com/acme/api.git');
  writeFileSync(join(CLONE, 'a.ts'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  BASE = git('rev-parse', 'HEAD');
  writeFileSync(join(CLONE, 'b.ts'), 'other\n');
  git('add', '-A');
  git('commit', '-qm', 'other');
  OTHER = git('rev-parse', 'HEAD');
  // An Ensemble clone has no checkout of its own.
  git('checkout', '-q', '--detach', BASE);
});
afterAll(() => rmSync(T.root, { recursive: true, force: true }));

const PATCH = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-one', '+two', ''].join('\n');

const ops = await import('../coding/git-ops.js');
const cm = await import('./clone-manager.js');
const lr = await import('./local-refs.js');
const { prepareBranchReview } = await import('./prepare.js');

const refs = (): string[] =>
  git('for-each-ref', '--format=%(refname)', 'refs/pierre/local/')
    .split('\n')
    .filter(Boolean)
    .sort();

describe('a local commit from a patch, read as a branch review head', () => {
  beforeEach(() => {
    for (const r of refs()) git('update-ref', '-d', r);
  });

  it('commits the patch on the base and pins it, pushing nothing', async () => {
    const key = { kind: 'ai-fix-loop', id: 4, name: 'r1' };
    const c = await ops.commitPatchToLocalRef({ accountId: 1, owner: 'acme', name: 'api', baseRef: 'main', baseSha: BASE, patch: PATCH, message: 'Round 1 fixes', key });
    expect(c.changed).toBe(true);
    expect(c.ref).toBe('refs/pierre/local/ai-fix-loop/4/r1');
    expect(git('rev-parse', c.ref)).toBe(c.commitSha);
    expect(git('rev-parse', `${c.commitSha}^`)).toBe(BASE);
    expect(git('rev-parse', `${c.commitSha}^{tree}`)).toBe(c.treeSha);
    expect(git('log', '-1', '--format=%an <%ae>|%s', c.commitSha)).toBe('Uma <u1@users.noreply.github.com>|Round 1 fixes');
    expect(git('show', `${c.commitSha}:a.ts`)).toBe('two');
    // No branch moved and no remote-tracking ref appeared.
    expect(git('for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/')).toBe('refs/heads/main');
    expect(git('rev-parse', 'refs/heads/main')).toBe(OTHER);

    const head = { localRef: c.ref, sha: c.commitSha };
    const diff = await cm.localBranchDiff('acme', 'api', BASE, head);
    expect(diff).toContain('diff --git a/a.ts b/a.ts');
    expect(diff).toContain('+two');
    const prep = await prepareBranchReview({ owner: 'acme', name: 'api', baseSha: BASE, headSha: c.commitSha, localRef: c.ref });
    expect(prep.changedFiles).toEqual(['a.ts']);

    const w = await cm.prepHeadWorktree('acme', 'api', head);
    try {
      expect(w.sha).toBe(c.commitSha);
      expect(readFileSync(join(w.worktreePath, 'a.ts'), 'utf8')).toBe('two\n');
    } finally {
      await cm.removeWorktreeLocked('acme', 'api', w.repoCloneDir, w.worktreePath);
    }
    expect(existsSync(w.worktreePath)).toBe(false);
  });

  it('pins the base when the patch changes nothing', async () => {
    const c = await ops.commitPatchToLocalRef({ accountId: 1, owner: 'acme', name: 'api', baseRef: 'main', baseSha: BASE, patch: '', message: 'nothing', key: { kind: 'ai-fix-loop', id: 4, name: 'r2' } });
    expect(c).toMatchObject({ changed: false, commitSha: BASE, ref: 'refs/pierre/local/ai-fix-loop/4/r2' });
  });

  it('refuses a local head that is not at its ref, or outside the namespace, without fetching', async () => {
    git('update-ref', 'refs/pierre/local/ai-fix-loop/5/r1', BASE);
    await expect(cm.localBranchDiff('acme', 'api', BASE, { localRef: 'refs/pierre/local/ai-fix-loop/5/r1', sha: OTHER })).rejects.toThrow(/no longer in Ensemble's copy/);
    await expect(cm.prepHeadWorktree('acme', 'api', { localRef: 'refs/pierre/local/ai-fix-loop/9/r1', sha: BASE })).rejects.toThrow(/no longer in Ensemble's copy/);
    await expect(cm.prepHeadWorktree('acme', 'api', { localRef: 'refs/heads/main', sha: OTHER })).rejects.toThrow(/Not a local ref/);
    await expect(cm.localBranchDiff('acme', 'other', BASE, { localRef: 'refs/pierre/local/x/1/r', sha: BASE })).rejects.toThrow(/no copy of acme\/other/);
  });

  it('spells and parses the one namespace', () => {
    expect(lr.localRefName({ kind: 'local-review', id: 12, name: 'head' })).toBe('refs/pierre/local/local-review/12/head');
    expect(() => lr.localRefName({ kind: 'Bad', id: 1, name: 'x' })).toThrow();
    expect(() => lr.localRefName({ kind: 'a', id: 0, name: 'x' })).toThrow();
    expect(() => lr.localRefName({ kind: 'a', id: 1, name: '../x' })).toThrow();
    expect(lr.parseLocalRef('refs/pierre/local/ai-fix-loop/4/r1')).toEqual({ kind: 'ai-fix-loop', id: 4, name: 'r1' });
    expect(lr.parseLocalRef('refs/pierre/local/ai-fix-loop/r1')).toBeNull();
    expect(lr.parseLocalRef('refs/pierre/ai-fix/4/1')).toBeNull();
  });
});

describe('the sweep', () => {
  beforeEach(() => {
    for (const r of refs()) git('update-ref', '-d', r);
    lr.registerLocalRefKeeper('kept-kind', null);
  });

  it('keeps held owners and what a keeper needs; drops the rest; keeps a malformed ref', async () => {
    for (const r of ['a/1/r1', 'a/1/r2', 'a/2/r1', 'kept-kind/3/r1', 'kept-kind/4/r1', 'odd']) git('update-ref', `refs/pierre/local/${r}`, BASE);
    const release = lr.holdLocalRefs('a', 1);
    lr.registerLocalRefKeeper('kept-kind', async (ids) => new Set(ids.filter((id) => id === 3)));
    const r = await lr.sweepLocalRefs();
    expect(r).toEqual({ deleted: 2, kept: 3, truncated: false });
    expect(refs()).toEqual(['refs/pierre/local/a/1/r1', 'refs/pierre/local/a/1/r2', 'refs/pierre/local/kept-kind/3/r1', 'refs/pierre/local/odd']);
    release();
    release(); // a second release is a no-op
    await lr.sweepLocalRefs();
    expect(refs()).toEqual(['refs/pierre/local/kept-kind/3/r1', 'refs/pierre/local/odd']);
  });

  it('keeps a whole kind when its keeper throws (refuse rather than guess)', async () => {
    git('update-ref', 'refs/pierre/local/kept-kind/8/r1', BASE);
    lr.registerLocalRefKeeper('kept-kind', async () => {
      throw new Error('db down');
    });
    expect((await lr.sweepLocalRefs()).deleted).toBe(0);
    expect(refs()).toEqual(['refs/pierre/local/kept-kind/8/r1']);
  });

  it('is bounded by its cap', async () => {
    for (const n of [1, 2, 3]) git('update-ref', `refs/pierre/local/b/${n}/r`, BASE);
    const r = await lr.sweepLocalRefs({ maxDeletes: 2 });
    expect(r).toMatchObject({ deleted: 2, truncated: true });
    expect(refs()).toHaveLength(1);
  });

  it('discard drops one owner only', async () => {
    for (const r of ['c/1/r1', 'c/1/r2', 'c/2/r1', 'c/11/r1']) git('update-ref', `refs/pierre/local/${r}`, BASE);
    expect(await lr.dropLocalRefs('acme', 'api', 'c', 1)).toBe(2);
    expect(refs()).toEqual(['refs/pierre/local/c/11/r1', 'refs/pierre/local/c/2/r1']);
    expect(await lr.dropLocalRefs('acme', 'missing', 'c', 1)).toBe(0);
  });
});
