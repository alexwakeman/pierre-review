import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The sweep against REAL git repositories. Nothing here is mocked, because the properties
// under test are filesystem and git-registry facts: a token in `.git/config`, a worktree
// record whose directory is gone, a directory older than the TTL.
//
// ⚠ CLONE_DIR is redirected to a temp tree BEFORE config.js is loaded (the dynamic import in
// beforeAll), or the sweep would run over the developer's own ~/.pierre-review/clones.
const ROOT = mkdtempSync(join(tmpdir(), 'pierre-hygiene-'));
const CLONE_DIR = join(ROOT, 'clones');
process.env.CLONE_DIR = CLONE_DIR;

const TOKENIZED = 'https://x-access-token:gho_TESTTOKEN@github.com/octocat/hello.git';
const PLAIN = 'https://github.com/octocat/hello.git';

let hygiene: typeof import('./clone-hygiene.js');
let TTL_MS: number;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

/** A real, tiny repo at `<CLONE_DIR>/<owner>__<name>` with one commit and an origin. */
function makeClone(entry: string, originUrl: string): string {
  const dir = join(CLONE_DIR, entry);
  mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['remote', 'add', 'origin', originUrl], dir);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}

/** Add a detached worktree under `.worktrees/<name>` and return its path. */
function addWorktreeDir(repo: string, name: string): string {
  const path = join(repo, '.worktrees', name);
  git(['worktree', 'add', '--detach', '--force', path, 'HEAD'], repo);
  return path;
}

/** Push a path's mtime `ms` into the past. */
function backdate(path: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}

beforeAll(async () => {
  hygiene = await import('./clone-hygiene.js');
  TTL_MS = (await import('../config.js')).config.worktreeTtlMs;
});

beforeEach(() => {
  rmSync(CLONE_DIR, { recursive: true, force: true });
  mkdirSync(CLONE_DIR, { recursive: true });
  hygiene.liveWorktrees.clear();
});

afterEach(() => {
  hygiene.liveWorktrees.clear();
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('urlHasUserinfo', () => {
  it('reads the AUTHORITY, not "does it contain an @"', () => {
    expect(hygiene.urlHasUserinfo(TOKENIZED)).toBe(true);
    expect(hygiene.urlHasUserinfo('https://user@github.com/o/n.git')).toBe(true);
    expect(hygiene.urlHasUserinfo(PLAIN)).toBe(false);
    // scp-like syntax: no scheme, so no URL userinfo to leak.
    expect(hygiene.urlHasUserinfo('git@github.com:o/n')).toBe(false);
    // the @ is in the PATH.
    expect(hygiene.urlHasUserinfo('https://github.com/o/n@2.git')).toBe(false);
    expect(hygiene.urlHasUserinfo('')).toBe(false);
  });
});

describe('cloneArgv', () => {
  it('keeps the token out of the positional URL and ahead of `clone`', () => {
    const argv = hygiene.cloneArgv('octocat', 'hello', 'gho_TESTTOKEN', '/tmp/x');
    expect(argv[argv.length - 2]).toBe(PLAIN);
    const rewrite = argv.filter((a) => a.includes('gho_TESTTOKEN'));
    expect(rewrite).toHaveLength(1);
    expect(argv.indexOf(rewrite[0] as string)).toBeLessThan(argv.indexOf('clone'));
  });
});

describe('sweepCloneCache — credentials', () => {
  it('repairs a tokenized origin in place', async () => {
    const repo = makeClone('octocat__hello', TOKENIZED);
    const report = await hygiene.sweepCloneCache();

    expect(report.scanned).toBe(1);
    expect(report.credentialsRepaired).toBe(1);
    expect(report.clonesRemoved).toBe(0);
    expect(git(['remote', 'get-url', 'origin'], repo).trim()).toBe(PLAIN);
    expect(git(['config', '--local', '--list'], repo)).not.toContain('gho_TESTTOKEN');
  });

  it('leaves a clean clone alone', async () => {
    makeClone('octocat__hello', PLAIN);
    const report = await hygiene.sweepCloneCache();
    expect(report.scanned).toBe(1);
    expect(report.credentialsRepaired).toBe(0);
    expect(report.clonesRemoved).toBe(0);
  });

  it('DELETES a clone whose credential survives the repair', async () => {
    // `origin` is not the only hiding place: an `insteadOf` written by an old
    // `clone --config` survives `remote set-url`. A clone is a rebuildable cache, so the
    // fail-closed answer is to delete it rather than hand out a live token.
    const repo = makeClone('octocat__hello', TOKENIZED);
    git(
      [
        'config',
        '--local',
        'url.https://x-access-token:gho_TESTTOKEN@github.com/.insteadOf',
        'https://github.com/',
      ],
      repo,
    );

    const report = await hygiene.sweepCloneCache();
    expect(report.clonesRemoved).toBe(1);
    expect(existsSync(repo)).toBe(false);
  });

  it('DELETES a clone whose token hides in a multivar origin', async () => {
    // ⚠ A MULTIVAR ORIGIN CANNOT BE REPAIRED, so the whole-config check is the only thing
    // standing between this clone and a live token on disk. Verified on git 2.54:
    // `remote set-url` refuses outright ("fatal: could not set 'remote.origin.url'") and
    // `config --get` prints only the LAST value with exit 0 — so a tokenized FIRST value is
    // invisible to a `--get` read and survives every repair. Deletion is the guarantee here.
    const repo = makeClone('octocat__hello', TOKENIZED);
    git(['config', '--local', '--add', 'remote.origin.url', PLAIN], repo);

    const report = await hygiene.sweepCloneCache();
    expect(report.clonesRemoved).toBe(1);
    expect(existsSync(repo)).toBe(false);
  });

  it('tightens permissions on the clone tree and its .git/config', async () => {
    const repo = makeClone('octocat__hello', PLAIN);
    await hygiene.sweepCloneCache();
    expect(statSync(repo).mode & 0o777).toBe(0o700);
    expect(statSync(join(repo, '.git', 'config')).mode & 0o777).toBe(0o600);
  });
});

describe('sweepCloneCache — worktrees', () => {
  it('prunes a record whose directory was deleted', async () => {
    const repo = makeClone('octocat__hello', PLAIN);
    const wt = addWorktreeDir(repo, 'gone');
    rmSync(wt, { recursive: true, force: true });
    expect(git(['worktree', 'list', '--porcelain'], repo)).toContain('gone');

    const report = await hygiene.sweepCloneCache();
    expect(report.worktreeRecordsPruned).toBeGreaterThan(0);
    expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain('gone');
  });

  it('removes a backdated worktree and keeps a fresh one', async () => {
    const repo = makeClone('octocat__hello', PLAIN);
    const stale = addWorktreeDir(repo, 'stale');
    const fresh = addWorktreeDir(repo, 'fresh');
    backdate(stale, TTL_MS * 2);

    const report = await hygiene.sweepCloneCache();
    expect(report.worktreeDirsRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // ⚠ The SECOND prune is what collects the record the delete above just orphaned, and it
    // is gated on the delete COUNT so a sweep that deletes nothing skips a no-op git spawn.
    // Delete that call, or widen the gate to something that is not the count, and the stale
    // record survives here while `worktreeDirsRemoved` still reads 1.
    const listed = git(['worktree', 'list', '--porcelain'], repo);
    expect(listed).not.toContain('stale');
    expect(listed).toContain('fresh');
  });

  it('keeps a backdated worktree THIS process owns', async () => {
    // Identity beats the clock — a long agent run writes nothing under its worktree for
    // hours. Delete the `liveWorktrees.has` branch and this test fails.
    const repo = makeClone('octocat__hello', PLAIN);
    const mine = addWorktreeDir(repo, 'mine');
    backdate(mine, TTL_MS * 2);
    hygiene.liveWorktrees.set(mine, Date.now());

    const report = await hygiene.sweepCloneCache();
    expect(report.worktreeDirsRemoved).toBe(0);
    expect(existsSync(mine)).toBe(true);
  });

  it('drops the resolver fetch refs — no job survives a restart', async () => {
    const repo = makeClone('octocat__hello', PLAIN);
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    git(['update-ref', 'refs/pierre/conflict/abc/head', head], repo);
    git(['update-ref', 'refs/heads/keep-me', head], repo);

    await hygiene.sweepCloneCache();
    const refs = git(['for-each-ref', '--format=%(refname)'], repo);
    expect(refs).not.toContain('refs/pierre/conflict/');
    expect(refs).toContain('refs/heads/keep-me');
  });
});

describe('hasFreshWorktrees', () => {
  it('is false for a repo whose only worktree is past the TTL', () => {
    const repo = makeClone('octocat__hello', PLAIN);
    const stale = addWorktreeDir(repo, 'stale');
    backdate(stale, TTL_MS * 2);
    expect(hygiene.hasFreshWorktrees(repo, Date.now())).toBe(false);
  });

  it('is false for a repo with no .worktrees at all', () => {
    const repo = makeClone('octocat__hello', PLAIN);
    expect(hygiene.hasFreshWorktrees(repo, Date.now())).toBe(false);
  });
});
