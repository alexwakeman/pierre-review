// THE SHARED TREES (trees.ts) on a scratch disk, with the git checkout faked: the first chat builds a
// repository's tree; later chats reuse it with no checkout at all; when sync's commit moves, the newest
// tree is read at once and the new one is built behind; an old tree goes once no chat holds it; the
// boot sweep removes unfinished trees, older trees and repositories Limn no longer has.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { acquireTree, hasTrees, noteDefaultBranchHead, prune, resetTreesForTest, setTreeDepsForTest, sweepTreesAtBoot, treesOf } from './trees.js';

const base = mkdtempSync(join(tmpdir(), 'chat-trees-'));
const root = join(base, 'trees');
const A = 'a'.repeat(40);
const Bsha = 'b'.repeat(40);
let tip = A;
let checkouts = 0;

setTreeDepsForTest({
  root: () => root,
  async checkout() {
    checkouts += 1;
    const dir = join(base, `wt-${checkouts}`);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), `export const at = '${tip}';\n`);
    writeFileSync(join(dir, '.git'), 'gitdir: /somewhere\n');
    return { path: dir, sha: tip, error: null, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  },
});
const repo = (headSha: string | null) => ({ owner: 'Acme', name: 'api', branch: 'main', headSha });
const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetTreesForTest();
  tip = A;
  checkouts = 0;
});
afterAll(() => {
  setTreeDepsForTest(null);
  rmSync(base, { recursive: true, force: true });
});

describe('the shared repository trees', () => {
  it('the first chat builds the tree (files only, no .git); the next reuses it with no checkout', async () => {
    const t1 = await acquireTree(repo(A));
    expect(t1).toMatchObject({ sha: A, stale: false });
    expect(readFileSync(join(t1!.path, 'src', 'index.ts'), 'utf8')).toContain(A);
    expect(existsSync(join(t1!.path, '.git'))).toBe(false);
    expect(checkouts).toBe(1);
    const t2 = await acquireTree(repo(A));
    expect(t2!.path).toBe(t1!.path);
    expect(checkouts).toBe(1);
    expect(hasTrees('Acme', 'api')).toBe(true);
    // Sync not knowing the commit yet: the newest tree, and no rebuild.
    tip = Bsha;
    const t3 = await acquireTree(repo(null));
    await settle();
    expect(t3).toMatchObject({ sha: A, stale: false });
    expect(checkouts).toBe(1);
  });

  it('sync moved the branch: the newest tree is read at once, the new one is built behind', async () => {
    (await acquireTree(repo(A)))!.release();
    tip = Bsha;
    const t = await acquireTree(repo(Bsha));
    expect(t).toMatchObject({ sha: A, stale: true });
    await settle();
    expect(treesOf('Acme', 'api').map((x) => x.sha)).toEqual([Bsha, A]); // A is held
    t!.release();
    expect(prune('Acme', 'api')).toBe(1);
    expect(treesOf('Acme', 'api').map((x) => x.sha)).toEqual([Bsha]);
    expect((await acquireTree(repo(Bsha)))!.stale).toBe(false);
  });

  it('a sync note builds the new tree only for a repository a chat has read', async () => {
    noteDefaultBranchHead(repo(Bsha));
    await settle();
    expect(checkouts).toBe(0);
    (await acquireTree(repo(A)))!.release();
    tip = Bsha;
    noteDefaultBranchHead(repo(Bsha));
    await settle();
    expect(treesOf('Acme', 'api').map((x) => x.sha)).toEqual([Bsha]); // the old one was not held
  });

  it('at boot: unfinished trees, older trees and unknown repositories go', async () => {
    (await acquireTree(repo(A)))!.release();
    mkdirSync(join(root, 'acme__api', `${Bsha}.part-1-2`), { recursive: true });
    mkdirSync(join(root, 'gone__repo', A), { recursive: true });
    const out = sweepTreesAtBoot([{ owner: 'ACME', name: 'API' }]);
    expect(out.removed).toBe(2);
    expect(treesOf('Acme', 'api').map((x) => x.sha)).toEqual([A]);
    expect(existsSync(join(root, 'gone__repo'))).toBe(false);
  });
});
