// THE MERGE ITEM IN A STORE-BORROWING REPOSITORY, ON REAL GIT (slow project; docs/SANDBOX.md § The repo
// store, § The merge). No daemon: the in-sandbox scripts run in `sh` on the host, with the store mount
// pointed at a temp folder.
//
// The bug (PR #610, 2026-11-09): the sandbox repository borrows the store's objects and is shallow at the
// PR head only. The store holds an OLDER depth-1 keep ref whose parent it lacks. The MERGE item's
// `git fetch --depth 1` of the base tip walked that keep ref in its connectivity check (alternate refs are
// positive tips in a deepening fetch, and the store's `shallow` file does not travel through alternates),
// and failed with "remote did not send all necessary objects". The negative control below runs the SAME
// script without `core.alternateRefsCommand=true` and must still fail that way, so this test proves the
// flag is what fixes it.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORE_MOUNT } from '../runtime/labels.js';
import { defaultMirrorSeams, shallowFromClone } from '../workspace/mirror.js';
import { IN_SANDBOX_FROM_STORE, SANDBOX_BASE_REF } from '../workspace/store.js';
import { FETCH_INTO_REPO_SCRIPT, MERGE_BASE_REF, MERGE_TARGET_REF, RESTORE_BUNDLE_SCRIPT, START_MERGE_SCRIPT } from './fix-merge.js';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (args: string[], cwd?: string): string => execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();

let scratch = '';
let src = '';
let storeRoot = '';
const STORE_DIR = 'acme__api.git';
const c: Record<string, string> = {};

function commit(files: Record<string, string>, msg: string): string {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(src, f, '..'), { recursive: true });
    writeFileSync(join(src, f), text);
  }
  git(['add', '-A'], src);
  git(['commit', '-qm', msg], src);
  return git(['rev-parse', 'HEAD'], src);
}

/** As STORE_FETCH does it: one depth-1 keep ref per commit, in the bare store. */
function keepInStore(sha: string): void {
  const d = join(storeRoot, STORE_DIR);
  git([
    '-C', d, '-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--depth', '1',
    '--upload-pack', 'git -c uploadpack.allowAnySHA1InWant=true upload-pack',
    `file://${src}`, `+${sha}:refs/limn/keep/${sha}`,
  ]);
}

/** Run an in-sandbox script with `sh -c`, the store mount pointed at the temp store. */
function sh(script: string, args: string[], stdin?: AsyncIterable<Buffer>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', script.split(STORE_MOUNT).join(storeRoot), 'sh', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    void (async () => {
      if (stdin) for await (const chunk of stdin) child.stdin.write(chunk);
      child.stdin.end();
    })().catch(reject);
  });
}

/** A sandbox repository built exactly as IN_SANDBOX_FROM_STORE builds it: borrows the store, shallow at the head. */
async function sandboxRepo(name: string): Promise<string> {
  const dest = join(scratch, 'workspace', name);
  const r = await sh(IN_SANDBOX_FROM_STORE, [dest, 'pr-branch', c.head!, STORE_DIR]);
  expect(r.code, r.stderr).toBe(0);
  return dest;
}

/** The MERGE item's fetch of `sha` into `ref`, from a depth-1 copy made on the host (mirror.ts). */
async function bringIn(repo: string, ref: string, sha: string, script = FETCH_INTO_REPO_SCRIPT) {
  const source = await shallowFromClone(src, sha);
  try {
    return await sh(script, [repo, ref, sha], defaultMirrorSeams.tarGitDir(source.dir));
  } finally {
    await source.cleanup();
  }
}

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'limn-fix-merge-store-')));
  src = join(scratch, 'src');
  storeRoot = join(scratch, 'store');
  mkdirSync(src, { recursive: true });
  mkdirSync(storeRoot, { recursive: true });
  git(['init', '-q', '-b', 'main', src]);
  c.one = commit({ 'a.txt': 'one\n', 'b.txt': 'b\n' }, 'one');
  c.oldMain = commit({ 'a.txt': 'two\n' }, 'old main tip'); // kept by an earlier session; its parent is never in the store
  c.mergeBase = commit({ 'c.txt': 'c\n' }, 'merge base');
  git(['checkout', '-qb', 'pr'], src);
  c.head = commit({ 'a.txt': 'from the pr\n' }, 'pr head');
  git(['checkout', '-q', 'main'], src);
  c.base = commit({ 'a.txt': 'from main\n' }, 'new main tip');
  git(['init', '-q', '--bare', join(storeRoot, STORE_DIR)]);
  keepInStore(c.oldMain);
  keepInStore(c.head);
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('the MERGE item in a repository that borrows the repo store', () => {
  it('without the flag, a deepening fetch walks the store\'s keep refs and fails (the bug, still in git)', async () => {
    const repo = await sandboxRepo('control');
    const unfixed = FETCH_INTO_REPO_SCRIPT.replace('-c core.alternateRefsCommand=true ', '');
    expect(unfixed).not.toBe(FETCH_INTO_REPO_SCRIPT);
    const r = await bringIn(repo, MERGE_TARGET_REF, c.base!, unfixed);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/remote did not send all necessary objects/);
  });

  it('brings the base tip and the merge base in, and the merge starts', async () => {
    const repo = await sandboxRepo('fixed');
    for (const [ref, sha] of [[MERGE_TARGET_REF, c.base!], [MERGE_BASE_REF, c.mergeBase!]] as const) {
      const r = await bringIn(repo, ref, sha);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n').pop()).toBe(sha);
      expect(git(['rev-parse', ref], repo)).toBe(sha);
    }
    expect(git(['rev-parse', SANDBOX_BASE_REF], repo)).toBe(c.head);
    const started = await sh(START_MERGE_SCRIPT, [repo, 'main']);
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout.trim().split('\n')).toEqual(['a.txt']);
    expect(git(['rev-parse', 'MERGE_HEAD'], repo)).toBe(c.base);
  });

  it('a stored merge bundle comes back into a fresh store-borrowing repository', async () => {
    const repo = await sandboxRepo('restore');
    git(['commit', '-q', '--allow-empty', '-m', 'the fix'], repo);
    const fixSha = git(['rev-parse', 'HEAD'], repo);
    git(['update-ref', 'refs/limn/out', fixSha], repo);
    const bundle = join(scratch, 'out.bundle');
    git(['bundle', 'create', '-q', bundle, `${SANDBOX_BASE_REF}..refs/limn/out`], repo);
    const fresh = await sandboxRepo('restore-fresh');
    const r = await sh(RESTORE_BUNDLE_SCRIPT, [fresh, bundle]);
    expect(r.code, r.stderr).toBe(0);
    expect(git(['rev-parse', 'HEAD'], fresh)).toBe(fixSha);
  });
});
