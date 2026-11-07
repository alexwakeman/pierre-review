// AI FIX'S MERGE ON REAL GIT (docs/SANDBOX.md § AI Fix sessions, "The merge"). No sandbox: the sandbox-side
// scripts (sandbox/session/fix-merge.ts START_MERGE_SCRIPT, EXTRACT_MERGE_SCRIPT, READ_OUT_SCRIPT) are POSIX
// sh + git, so they run here on a scratch repository shaped as the sandbox makes it — SHALLOW, holding only
// the PR head, the base tip and the merge base. The host side (merge-verify.ts) runs against a clone that
// plays Limn's clone cache.
//
//   a valid merge (with a fix on top and an uncommitted edit) passes, and its rebuilt commits have the right
//   parents, trees and author; a push from a blobless clone to a bare remote is a fast-forward;
//   REFUSED: markers left, wrong parent order, a merge of the wrong base, a fix BEFORE the merge, a second
//   merge on top, a bundle naming another ref, an unfinished merge.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXTRACT_MERGE_SCRIPT,
  MERGE_BASE_REF,
  MERGE_TARGET_REF,
  parseMergeExtract,
  READ_OUT_SCRIPT,
  START_MERGE_SCRIPT,
} from '../../sandbox/session/fix-merge.js';
import { buildMergeCommits, checkShape, verifyMergeBundle } from './merge-verify.js';

// Limn's scripts write their two out-files here, not in the shared /tmp (another test file runs them too).
const OUTDIR = mkdtempSync(join(tmpdir(), 'limn-merge-out-'));
process.env.LIMN_MERGE_OUT = OUTDIR;
const ENV = { ...process.env, LIMN_MERGE_OUT: OUTDIR, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-11-07T10:00:00Z', GIT_COMMITTER_DATE: '2026-11-07T10:00:00Z' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const sh = (cwd: string, script: string, ...args: string[]): string => execFileSync('sh', ['-c', script, 'sh', ...args], { cwd, env: ENV, encoding: 'utf8' });

let root = '';
let origin = '';
let cache = '';
let H = '';
let B = '';
let MB = '';
let n = 0;

// The case a naive resolution gets wrong: both sides edit the SAME line, and the PR also adds the line
// after it. "Take both" keeps `const limit` twice.
const BASE_FILE = ['export const name = "report";', 'export const limit = 10;', 'export const sep = ",";', ''].join('\n');
const PR_FILE = ['export const name = "report";', 'export const limit = 25;', 'export const pageSize = 50;', 'export const sep = ",";', ''].join('\n');
const MAIN_FILE = ['export const name = "report";', 'export const limit = 10; // the API caps it', 'export const sep = ",";', ''].join('\n');
const RESOLVED = ['export const name = "report";', 'export const limit = 25; // the API caps it', 'export const pageSize = 50;', 'export const sep = ",";', ''].join('\n');

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'limn-merge-verify-'));
  origin = join(root, 'origin');
  git(root, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 'o@x');
  git(origin, 'config', 'user.name', 'o');
  writeFileSync(join(origin, 'config.ts'), BASE_FILE);
  writeFileSync(join(origin, 'other.txt'), 'one\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '-qm', 'base');
  writeFileSync(join(origin, 'other.txt'), 'one\ntwo\n');
  git(origin, 'commit', '-qam', 'main 1');
  MB = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-qb', 'feature');
  writeFileSync(join(origin, 'config.ts'), PR_FILE);
  git(origin, 'commit', '-qam', 'pr: raise the limit');
  H = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  writeFileSync(join(origin, 'config.ts'), MAIN_FILE);
  git(origin, 'commit', '-qam', 'main: note the cap');
  writeFileSync(join(origin, 'other.txt'), 'one\ntwo\nthree\n');
  git(origin, 'commit', '-qam', 'main 2');
  B = git(origin, 'rev-parse', 'HEAD');
  // Limn's clone cache: a clone with both lines of history.
  cache = join(root, 'cache');
  execFileSync('git', ['clone', '-q', '--no-checkout', `file://${origin}`, cache], { env: ENV });
  git(cache, 'fetch', '-q', 'origin', 'feature:refs/heads/feature');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(OUTDIR, { recursive: true, force: true });
});

/** A sandbox-shaped repository: shallow, the three commits only, the merge started by Limn's own script. */
function sandboxRepo(): { dir: string; conflicted: string[] } {
  const dir = join(root, `sb${++n}`);
  git(root, 'init', '-q', dir);
  git(dir, 'config', 'user.email', 'sandbox@limn.invalid');
  git(dir, 'config', 'user.name', 'Limn sandbox');
  for (const [sha, ref] of [[H, 'refs/limn/base'], [B, MERGE_TARGET_REF], [MB, MERGE_BASE_REF]] as const) {
    git(dir, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--depth', '1', `file://${origin}`, `${sha}:${ref}`);
  }
  git(dir, 'checkout', '-q', '-B', 'limn/fix-pr-7', 'refs/limn/base');
  const out = sh(dir, START_MERGE_SCRIPT, dir, 'main');
  return { dir, conflicted: out.split('\n').map((l) => l.trim()).filter(Boolean) };
}

function extract(dir: string): { ex: ReturnType<typeof parseMergeExtract>; bundle: Buffer | null; resolution: string | null } {
  const ex = parseMergeExtract(sh(dir, EXTRACT_MERGE_SCRIPT, dir));
  const read = (f: string): Buffer | null => {
    try {
      return execFileSync('sh', ['-c', READ_OUT_SCRIPT, 'sh', f, String(8 * 1024 * 1024)], { env: ENV });
    } catch {
      return null;
    }
  };
  const resolution = read(join(OUTDIR, 'limn-merge-resolution.diff'));
  return { ex, bundle: read(join(OUTDIR, 'limn-merge.bundle')), resolution: resolution?.toString('utf8') ?? null };
}

const verify = (bundle: Buffer, conflicted: string[], ref = `refs/pierre/ai-fix/${n}/merge/result`) =>
  verifyMergeBundle({ gitDir: cache, bundle, headSha: H, baseSha: B, baseRef: 'main', conflictedFiles: conflicted, resultRef: ref });

describe('the merge Limn starts in the sandbox', () => {
  it('finds the conflict with the explicit merge base, in a SHALLOW repository', () => {
    const { dir, conflicted } = sandboxRepo();
    expect(git(dir, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(conflicted).toEqual(['config.ts']);
    expect(git(dir, 'rev-parse', 'MERGE_HEAD')).toBe(B);
    expect(readFileSync(join(dir, 'config.ts'), 'utf8')).toMatch(/<<<<<<< HEAD[\s\S]*=======[\s\S]*>>>>>>> main/);
    // The base's other change merged cleanly.
    expect(readFileSync(join(dir, 'other.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    // Refuses to start twice.
    expect(() => sh(dir, START_MERGE_SCRIPT, dir, 'main')).toThrow();
  });
});

describe('verifyMergeBundle', () => {
  it('passes a resolved merge with a fix on top and an uncommitted edit; the rebuilt commits are right', async () => {
    const { dir, conflicted } = sandboxRepo();
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    writeFileSync(join(dir, 'fix.ts'), 'export const fixed = true;\n');
    git(dir, 'add', 'fix.ts');
    git(dir, 'commit', '-qm', 'fix: the finding');
    writeFileSync(join(dir, 'fix.ts'), 'export const fixed = true;\nexport const more = 1;\n');
    const { ex, bundle, resolution } = extract(dir);
    expect(ex.merging).toBe(false);
    expect(ex.mergeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ex.fix.filesChanged).toEqual(['fix.ts']);
    expect(ex.fix.patch).toContain('+export const more = 1;');
    expect(ex.fix.patch).not.toContain('config.ts');
    expect(ex.fix.commitMessage).toContain('fix: the finding');
    expect(ex.resolutionFiles).toEqual(['config.ts']);
    expect(resolution).toContain('-<<<<<<< HEAD');
    expect(resolution).toContain('+export const limit = 25; // the API caps it');
    const v = await verify(bundle!, conflicted);
    expect(v).toMatchObject({ ok: true, mergeSha: ex.mergeSha, resultSha: ex.outSha, fixCommits: 2 });
    if (!v.ok) return;
    // What the reader reviews is computed on the HOST from the verified commits, not taken from the sandbox.
    expect(v.view.fixFiles).toEqual(['fix.ts']);
    expect(v.view.fixPatch).toContain('+export const more = 1;');
    expect(v.view.fixPatch).not.toContain('config.ts');
    expect(v.view.conflictedFiles).toEqual(['config.ts']);
    expect(v.view.resolutionFiles).toEqual(['config.ts']);
    expect(v.view.resolutionDiff).toContain('-<<<<<<< ');
    expect(v.view.resolutionDiff).toContain('+export const limit = 25; // the API caps it');
    const sha = await buildMergeCommits(cache, { ...v, headSha: H, baseSha: B }, { authorName: 'Reader', authorEmail: 'reader@users.noreply.github.com', mergeMessage: 'Merge main into this pull request', fixMessage: 'fix: the finding' });
    const merge = git(cache, 'rev-parse', `${sha}^`);
    expect(git(cache, 'rev-list', '--parents', '-n', '1', merge).split(' ').slice(1)).toEqual([H, B]);
    expect(git(cache, 'rev-parse', `${merge}^{tree}`)).toBe(git(cache, 'rev-parse', `${ex.mergeSha}^{tree}`));
    expect(git(cache, 'rev-parse', `${sha}^{tree}`)).toBe(git(cache, 'rev-parse', `${ex.outSha}^{tree}`));
    expect(git(cache, 'log', '-1', '--format=%an <%ae>|%s', sha)).toBe('Reader <reader@users.noreply.github.com>|fix: the finding');
    expect(git(cache, 'show', `${merge}:config.ts`)).toBe(RESOLVED.trimEnd());
    // GitHub's side: a fast-forward of the PR branch, pushed from a BLOBLESS clone.
    const remote = join(root, `remote${n}.git`);
    execFileSync('git', ['clone', '-q', '--bare', `file://${origin}`, remote], { env: ENV });
    const thin = join(root, `thin${n}`);
    execFileSync('git', ['clone', '-q', '--filter=blob:none', '--no-checkout', `file://${remote}`, thin], { env: ENV });
    git(thin, 'fetch', '-q', 'origin', 'feature:refs/heads/feature');
    const v2 = await verifyMergeBundle({ gitDir: thin, bundle: bundle!, headSha: H, baseSha: B, baseRef: 'main', conflictedFiles: conflicted, resultRef: 'refs/pierre/ai-fix/1/merge/result' });
    expect(v2.ok).toBe(true);
    if (!v2.ok) return;
    // The blobless clone fetched the blobs its diffs need lazily: the same view.
    expect(v2.view.fixPatch).toBe(v.view.fixPatch);
    expect(v2.view.resolutionDiff).toBe(v.view.resolutionDiff);
    const pushed = await buildMergeCommits(thin, { ...v2, headSha: H, baseSha: B }, { authorName: 'Reader', authorEmail: 'r@x', mergeMessage: 'Merge main', fixMessage: 'fix' });
    git(thin, 'push', '-q', remote, `${pushed}:refs/heads/feature`);
    expect(git(remote, 'rev-parse', 'refs/heads/feature')).toBe(pushed);
    expect(git(remote, 'merge-base', '--is-ancestor', B, 'refs/heads/feature')).toBe('');
  });

  it('a merge-only fix (no other change) passes with the merge as the result', async () => {
    const { dir, conflicted } = sandboxRepo();
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    const { ex, bundle } = extract(dir);
    expect(ex.fix.patch).toBe('');
    const v = await verify(bundle!, conflicted);
    expect(v).toMatchObject({ ok: true, mergeSha: ex.mergeSha, resultSha: ex.mergeSha, fixCommits: 0 });
  });

  it('the reader sees what the HOST computes: a forged auto-merge ref cannot hide a change in the merge commit', async () => {
    const { dir, conflicted } = sandboxRepo();
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    writeFileSync(join(dir, 'other.txt'), 'one\ntwo\nthree\nsneaked in\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '--no-edit');
    // The agent points the sandbox's baseline at its own merge: the sandbox's resolution diff is empty.
    git(dir, 'update-ref', 'refs/limn/auto-merge', 'HEAD');
    const { ex, bundle, resolution } = extract(dir);
    expect(resolution ?? '').toBe('');
    const v = await verify(bundle!, conflicted);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.view.resolutionFiles.sort()).toEqual(['config.ts', 'other.txt']);
    expect(v.view.resolutionDiff).toContain('+sneaked in');
    expect(v.mergeSha).toBe(ex.mergeSha);
  });

  it('the marker check uses the host\'s own list of conflicted files, not only the sandbox\'s', async () => {
    const { dir } = sandboxRepo();
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    const { bundle } = extract(dir);
    expect(await verify(bundle!, [])).toEqual({ ok: false, reason: 'config.ts still has a conflict marker in the merge commit.' });
  });

  it('refuses a merge commit that still holds a conflict marker', async () => {
    const { dir, conflicted } = sandboxRepo();
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    const { bundle } = extract(dir);
    expect(await verify(bundle!, conflicted)).toEqual({ ok: false, reason: 'config.ts still has a conflict marker in the merge commit.' });
  });

  it('refuses markers fixed only in a later commit (the merge commit itself must be clean)', async () => {
    const { dir, conflicted } = sandboxRepo();
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'commit', '-qam', 'clean up');
    const { bundle } = extract(dir);
    expect(await verify(bundle!, conflicted)).toMatchObject({ ok: false, reason: expect.stringContaining('in the merge commit') });
  });

  it('refuses the parents in the wrong order (the base first)', async () => {
    const { dir, conflicted } = sandboxRepo();
    git(dir, 'merge', '--abort');
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    const tree = (() => {
      git(dir, 'add', '-A');
      return git(dir, 'write-tree');
    })();
    const c = git(dir, 'commit-tree', tree, '-p', B, '-p', H, '-m', 'merge');
    git(dir, 'reset', '-q', '--hard', c);
    const { ex, bundle } = extract(dir);
    expect(ex.mergeSha).toBe(c);
    expect(await verify(bundle!, conflicted)).toMatchObject({ ok: false, reason: expect.stringContaining("parents are not the pull request's head") });
  });

  it('refuses a fix made BEFORE the merge, and a second merge on top', async () => {
    const { dir, conflicted } = sandboxRepo();
    git(dir, 'merge', '--abort');
    writeFileSync(join(dir, 'early.ts'), 'x\n');
    git(dir, 'add', 'early.ts');
    git(dir, 'commit', '-qm', 'early');
    const early = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'add', '-A');
    const tree = git(dir, 'write-tree');
    git(dir, 'reset', '-q', '--hard', git(dir, 'commit-tree', tree, '-p', early, '-p', B, '-m', 'merge'));
    const { bundle } = extract(dir);
    expect(await verify(bundle!, conflicted)).toMatchObject({ ok: false, reason: expect.stringContaining("parents are not the pull request's head") });

    const two = sandboxRepo();
    writeFileSync(join(two.dir, 'config.ts'), RESOLVED);
    git(two.dir, 'add', 'config.ts');
    git(two.dir, 'commit', '-q', '--no-edit');
    const m1 = git(two.dir, 'rev-parse', 'HEAD');
    git(two.dir, 'reset', '-q', '--hard', git(two.dir, 'commit-tree', `${m1}^{tree}`, '-p', m1, '-p', B, '-m', 'again'));
    const second = extract(two.dir);
    expect(await verify(second.bundle!, two.conflicted)).toEqual({ ok: false, reason: 'A second merge commit sits on top of the merge.' });
  });

  it('refuses a merge of another base commit, and a bundle that names another ref', async () => {
    const { dir, conflicted } = sandboxRepo();
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'add', 'config.ts');
    git(dir, 'commit', '-q', '--no-edit');
    const { bundle } = extract(dir);
    // Checked against the merge base as "the base": the second parent is not it.
    expect((await verifyMergeBundle({ gitDir: cache, bundle: bundle!, headSha: H, baseSha: MB, baseRef: 'main', conflictedFiles: conflicted, resultRef: 'refs/pierre/ai-fix/9/merge/result' })).ok).toBe(false);
    git(dir, 'update-ref', 'refs/heads/other', 'HEAD');
    const f = join(root, 'two-refs.bundle');
    git(dir, 'bundle', 'create', '-q', f, 'refs/limn/out', 'refs/heads/other', `^${H}`, `^${B}`);
    expect(await verify(readFileSync(f), conflicted)).toEqual({ ok: false, reason: 'The commits from the sandbox are not in the form Limn expects.' });
  });

  it('reads an unfinished merge as merging, with no merge commit', () => {
    const { dir } = sandboxRepo();
    writeFileSync(join(dir, 'config.ts'), RESOLVED);
    git(dir, 'add', 'config.ts');
    const { ex } = extract(dir);
    expect(ex.merging).toBe(true);
    expect(ex.mergeSha).toBeNull();
  });

  it('checkShape refuses a ref outside Limn namespace before reading anything', async () => {
    expect(await verifyMergeBundle({ gitDir: cache, bundle: Buffer.from(''), headSha: H, baseSha: B, baseRef: 'main', conflictedFiles: [], resultRef: 'refs/heads/main' })).toEqual({ ok: false, reason: 'Not a ref Limn keeps.' });
    void checkShape;
  });
});
