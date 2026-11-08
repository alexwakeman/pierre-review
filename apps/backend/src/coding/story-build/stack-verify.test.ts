// A STACK FROM THE SANDBOX, CHECKED ON THE HOST — REAL GIT on both sides. The sandbox side runs Limn's own
// EXTRACT_STACK_SCRIPT (sandbox/session/stack.ts) on a local repository shaped as the mirror makes it
// (`refs/limn/base`, the session branch checked out); the host side (`verifyStackBundle`) runs against a
// local clone playing Limn's clone cache. Pinned:
//   one PR in a repository (HEAD, uncommitted work folded in) · a 3-PR stack (each patch against the one
//   before, the uncommitted work folded into the LAST only) · dirty on an earlier branch (reported, not
//   folded) · a merge commit refused · a stray ref refused · a wrong prerequisite refused · a gitlink
//   refused · PR 2 not built on PR 1 (2 and 3 fail, 1 stands) · an empty PR · a missing branch · over size.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACT_STACK_SCRIPT, parseStackExtract, type StackExtract } from '../../sandbox/session/stack.js';
import { storyBuildStackRef, verifyStackBundle, type StackPlannedPr } from './stack-verify.js';

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
const root = mkdtempSync(join(tmpdir(), 'limn-stack-verify-'));
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const K = 'limn/acme-9';

let origin = '';
let cache = '';
let box = '';
let base = '';
let n = 0;

function write(dir: string, file: string, text: string): void {
  writeFileSync(join(dir, file), text);
}
function commit(dir: string, file: string, text: string, msg: string): string {
  write(dir, file, text);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

beforeEach(() => {
  n += 1;
  origin = join(root, `origin-${n}`);
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env: ENV });
  base = commit(origin, 'a.txt', 'one\n', 'base');
  cache = join(root, `cache-${n}`);
  execFileSync('git', ['clone', '-q', origin, cache], { env: ENV });
  box = join(root, `box-${n}`);
  execFileSync('git', ['clone', '-q', origin, box], { env: ENV });
  git(box, 'update-ref', 'refs/limn/base', base);
  git(box, 'checkout', '-q', '-b', K);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function extract(branches: string[], max = 8 * 1024 * 1024): StackExtract {
  const out = execFileSync('sh', ['-c', EXTRACT_STACK_SCRIPT, 'sh', box, String(max), ...branches], { env: ENV, maxBuffer: 64 << 20 }).toString('utf8');
  return parseStackExtract(out);
}
const planned = (branches: string[]): StackPlannedPr[] => branches.map((b, i) => ({ k: i + 1, prRowId: 100 + i, key: `P${i + 1}`, branch: b }));
const verify = (branches: string[], ex: StackExtract) =>
  verifyStackBundle({ gitDir: cache, buildId: 7, baseSha: base, planned: planned(branches), extract: ex, maxPatchBytes: 1024 * 1024 });

describe('one planned PR in a repository', () => {
  it('reads HEAD and folds the uncommitted work in; the patch is computed on the host', async () => {
    commit(box, 'a.txt', 'one\ntwo\n', 'Add two');
    write(box, 'b.txt', 'new\n');
    const ex = extract([K]);
    expect(ex.bundle).not.toBeNull();
    const v = await verify([K], ex);
    expect(v.prs).toHaveLength(1);
    expect(v.prs[0]).toMatchObject({ status: 'ready', error: null });
    expect(v.prs[0]!.filesChanged.sort()).toEqual(['a.txt', 'b.txt']);
    expect(v.prs[0]!.patch).toContain('+two');
    expect(v.prs[0]!.patch).toContain('+new');
    expect(v.prs[0]!.stat).toMatchObject({ files: 2, commits: 2 });
    expect(v.prs[0]!.commitMessage).toContain('Add two');
    // The verified tip is kept in the clone cache under the PR row's own ref; its tree is the one recorded.
    expect(git(cache, 'rev-parse', storyBuildStackRef(7, 100))).toBe(v.prs[0]!.tipSha);
    expect(git(cache, 'rev-parse', `${v.prs[0]!.tipSha}^{tree}`)).toBe(v.prs[0]!.treeSha);
    expect(v.whole?.patch).toBe(v.prs[0]!.patch);
    // The agent's own branch and index are untouched by the fold.
    expect(git(box, 'status', '--porcelain')).toContain('b.txt');
  });

  it('no change ⇒ no bundle and the PR is empty', async () => {
    const ex = extract([K]);
    expect(ex.bundle).toBeNull();
    const v = await verify([K], ex);
    expect(v.prs[0]).toMatchObject({ status: 'empty', error: 'P1 has no changes.' });
    expect(v.whole).toMatchObject({ patch: '' });
  });
});

describe('a stack of three in one repository', () => {
  it('each PR is its own range; the uncommitted work goes into the LAST PR only', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'checkout', '-q', '-b', `${K}-2`);
    commit(box, 'b.txt', 'P2\n', 'P2 work');
    git(box, 'checkout', '-q', '-b', `${K}-3`);
    commit(box, 'c.txt', 'P3\n', 'P3 work');
    write(box, 'd.txt', 'uncommitted\n');
    const branches = [K, `${K}-2`, `${K}-3`];
    const ex = extract(branches);
    expect(ex.dirty).toEqual([]);
    const v = await verify(branches, ex);
    expect(v.prs.map((p) => p.status)).toEqual(['ready', 'ready', 'ready']);
    expect(v.prs.map((p) => p.filesChanged)).toEqual([['a.txt'], ['b.txt'], ['c.txt', 'd.txt']]);
    expect(v.prs[1]!.commitMessage).toBe('P2 work');
    expect(v.whole?.filesChanged.sort()).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt']);
  });

  it('dirty on an EARLIER branch is reported, not folded in', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'checkout', '-q', '-b', `${K}-2`);
    commit(box, 'b.txt', 'P2\n', 'P2 work');
    git(box, 'checkout', '-q', K);
    write(box, 'z.txt', 'left\n');
    const ex = extract([K, `${K}-2`]);
    expect(ex.dirty).toEqual([{ k: 1, branch: K }]);
    const v = await verify([K, `${K}-2`], ex);
    expect(v.prs.map((p) => p.status)).toEqual(['ready', 'ready']);
    expect(v.prs.flatMap((p) => p.filesChanged)).not.toContain('z.txt');
  });

  it('PR 2 not built on PR 1 ⇒ 2 and 3 fail with the reason; 1 stands', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'checkout', '-q', '-b', `${K}-2`, base);
    commit(box, 'b.txt', 'P2\n', 'P2 work');
    git(box, 'checkout', '-q', '-b', `${K}-3`);
    commit(box, 'c.txt', 'P3\n', 'P3 work');
    const branches = [K, `${K}-2`, `${K}-3`];
    const v = await verify(branches, extract(branches));
    expect(v.prs.map((p) => p.status)).toEqual(['ready', 'failed', 'failed']);
    expect(v.prs[1]!.error).toBe('P2 does not build on P1.');
    expect(v.prs[2]!.error).toBe('P2 does not build on P1.');
    expect(v.whole?.filesChanged).toEqual(['a.txt']);
  });

  it('an empty middle PR is empty; the next PR still builds on it', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'checkout', '-q', '-b', `${K}-2`);
    git(box, 'checkout', '-q', '-b', `${K}-3`);
    commit(box, 'c.txt', 'P3\n', 'P3 work');
    const branches = [K, `${K}-2`, `${K}-3`];
    const v = await verify(branches, extract(branches));
    expect(v.prs.map((p) => p.status)).toEqual(['ready', 'empty', 'ready']);
    expect(v.prs[2]!.filesChanged).toEqual(['c.txt']);
  });

  it('a missing branch fails it and every PR after it', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    const branches = [K, `${K}-2`, `${K}-3`];
    const ex = extract(branches);
    expect([...ex.missing.keys()]).toEqual([2, 3]);
    const v = await verify(branches, ex);
    expect(v.prs.map((p) => p.status)).toEqual(['ready', 'failed', 'failed']);
    expect(v.prs[1]!.error).toBe(`The agent did not make the branch ${K}-2 for P2.`);
  });
});

describe('refusals', () => {
  it('a merge commit', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'checkout', '-q', '-b', 'side', base);
    commit(box, 's.txt', 'side\n', 'side');
    git(box, 'checkout', '-q', K);
    git(box, 'merge', '-q', '--no-edit', 'side');
    const v = await verify([K], extract([K]));
    expect(v.prs[0]).toMatchObject({ status: 'failed' });
    expect(v.prs[0]!.error).toMatch(/merge commit/);
  });

  it('a stray ref in the bundle', async () => {
    const tip = commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    git(box, 'update-ref', 'refs/limn/stack/1', tip);
    git(box, 'update-ref', 'refs/heads/evil', tip);
    const file = join(root, `stray-${n}.bundle`);
    git(box, 'bundle', 'create', '-q', file, 'refs/limn/stack/1', 'refs/heads/evil', '^refs/limn/base');
    const ex: StackExtract = { tips: new Map([[1, tip]]), missing: new Map(), dirty: [], tooLargeBytes: null, bundle: execFileSync('cat', [file]) };
    const v = await verify([K], ex);
    expect(v.prs[0]!.error).toBe('The commits from the sandbox are not in the form Limn expects.');
    expect(() => git(cache, 'rev-parse', '-q', '--verify', 'refs/heads/evil')).toThrow();
  });

  it('a prerequisite that is not the base commit', async () => {
    const one = commit(box, 'a.txt', 'one\nP1\n', 'P1 a');
    const tip = commit(box, 'b.txt', 'b\n', 'P1 b');
    git(box, 'update-ref', 'refs/limn/stack/1', tip);
    const file = join(root, `prereq-${n}.bundle`);
    git(box, 'bundle', 'create', '-q', file, 'refs/limn/stack/1', `^${one}`);
    const ex: StackExtract = { tips: new Map([[1, tip]]), missing: new Map(), dirty: [], tooLargeBytes: null, bundle: execFileSync('cat', [file]) };
    const v = await verify([K], ex);
    expect(v.prs[0]!.error).toBe('The commits from the sandbox do not start from the commit this repository started from.');
  });

  it('a gitlink (submodule) change', async () => {
    // A nested repository added as a gitlink (the working tree keeps it, so the fold keeps it too).
    const lib = join(box, 'vendor', 'lib');
    execFileSync('git', ['init', '-q', lib], { env: ENV });
    commit(lib, 'x.txt', 'x\n', 'lib');
    git(box, 'add', 'vendor/lib');
    git(box, 'commit', '-qm', 'Add a submodule');
    const v = await verify([K], extract([K]));
    expect(v.prs[0]!.error).toBe('P1 changes a submodule (vendor/lib). Limn does not push submodule changes.');
  });

  it('over the size limit: never cut, every PR of the repository fails', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    const ex = extract([K], 10);
    expect(ex.tooLargeBytes).toBeGreaterThan(10);
    expect(ex.bundle).toBeNull();
    const v = await verify([K], ex);
    expect(v.prs[0]!.status).toBe('failed');
    expect(v.prs[0]!.error).toMatch(/more than Limn takes from the sandbox/);
  });

  it('a tip the script claims but the bundle lacks', async () => {
    commit(box, 'a.txt', 'one\nP1\n', 'P1 work');
    const ex = extract([K]);
    const v = await verify([K], { ...ex, bundle: null });
    expect(v.prs[0]!.error).toBe('Limn did not get the commits of P1 from the sandbox.');
  });
});
