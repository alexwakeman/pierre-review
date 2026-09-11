import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Mock the seams clone-manager touches so we exercise the git-arg construction
// without a real git binary, filesystem, or gh auth:
//  - execFile: a spy that always invokes its trailing callback (success by
//    default) so the promisify(execFile) form resolves;
//  - node:fs: existsSync returns false (so .git / worktree paths look absent →
//    ensureClone clones), mkdirSync/rmSync/chmodSync are no-op spies;
//  - config: a fixed cloneDir / cloneCacheMaxBytes / worktreeTtlMs;
//  - getGithubToken: a stable token we can assert NEVER ends up on disk.
const CLONE_DIR = '/tmp/pierre-clones-test';
const TTL_MS = 6 * 3_600_000;

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));
// NOTE: the factory is hoisted above the CLONE_DIR const, so it must inline the
// literals (referencing them here would hit the temporal dead zone).
vi.mock('../config.js', () => ({
  config: {
    cloneDir: '/tmp/pierre-clones-test',
    // Small on purpose: any repo dir with content is over the cap, so the eviction
    // tests below are about WHICH repos are skipped, not about arithmetic.
    cloneCacheMaxBytes: 100,
    worktreeTtlMs: 6 * 3_600_000,
  },
}));
vi.mock('../github/auth.js', () => ({ getGithubToken: () => 'TESTTOKEN' }));

import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import {
  addWorktree,
  cleanupCloneCache,
  ensureClone,
  liveWorktrees,
  removeWorktree,
} from './clone-manager.js';

// promisify(execFile) calls execFile(cmd, args, opts, callback); the spy must
// invoke the LAST argument (the callback) so the promisified form settles.
const mockExecFile = vi.mocked(execFile) as unknown as Mock;
const mockExists = existsSync as unknown as Mock;
const mockReaddir = readdirSync as unknown as Mock;
const mockRm = rmSync as unknown as Mock;
const mockStat = statSync as unknown as Mock;

type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

/** Default behaviour: invoke the trailing callback with a success payload. */
function resolveOk(): void {
  mockExecFile.mockImplementation((...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as ExecCb;
    cb(null, { stdout: '', stderr: '' });
    return undefined;
  });
}

/**
 * Find the git invocation whose args array contains `marker` and return that
 * args array. Each execFile call is (cmd, args, opts, callback).
 */
function gitArgsContaining(marker: string): string[] {
  for (const call of mockExecFile.mock.calls) {
    const args = call[1];
    if (Array.isArray(args) && args.includes(marker)) return args as string[];
  }
  throw new Error(`no execFile call had a git arg matching "${marker}"`);
}

/** True if any git invocation's args contain every one of `markers`. */
function anyGitCallWith(...markers: string[]): boolean {
  return mockExecFile.mock.calls.some(
    (call) =>
      Array.isArray(call[1]) && markers.every((m) => (call[1] as string[]).includes(m)),
  );
}

beforeEach(() => {
  mockExecFile.mockReset();
  resolveOk();
  mockExists.mockReset();
  mockExists.mockReturnValue(false);
  mockReaddir.mockReset();
  mockReaddir.mockReturnValue([]);
  mockRm.mockReset();
  mockStat.mockReset();
  liveWorktrees.clear();
});

describe('ensureClone', () => {
  it('returns the owner__name path under config.cloneDir', async () => {
    const dir = await ensureClone('octocat', 'hello');
    expect(dir).toBe(join(CLONE_DIR, 'octocat__hello'));
  });

  it('never puts the token in the clone URL — it rides a process-scoped -c BEFORE `clone`', async () => {
    const dir = await ensureClone('octocat', 'hello');
    const args = gitArgsContaining('clone');

    expect(mockExecFile.mock.calls[0]?.[0]).toBe('git'); // first arg of the call is the binary
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('--no-checkout');
    expect(args).toContain(dir);

    // The POSITIONAL url is the plain one. Nothing to strip afterwards, because nothing
    // tokenized was ever written.
    const url = args[args.length - 2];
    expect(url).toBe('https://github.com/octocat/hello.git');
    expect(url).not.toContain('@');

    // Exactly one argv entry carries the token, and it is the insteadOf rewrite.
    const withToken = args.filter((a) => a.includes('TESTTOKEN'));
    expect(withToken).toHaveLength(1);
    const rewrite = withToken[0] as string;
    expect(rewrite.startsWith('url.')).toBe(true);
    expect(rewrite.endsWith('.insteadOf=https://github.com/')).toBe(true);

    // ⚠ THE POSITION IS THE POINT: before `clone` it is process-scoped; after `clone` it is
    // `--config` and git writes it into the new repo's .git/config.
    expect(args.indexOf(rewrite)).toBeLessThan(args.indexOf('clone'));
  });

  it('re-checks a REUSED clone rather than handing it straight back', async () => {
    mockExists.mockReturnValue(true); // .git present → the reuse path
    await ensureClone('octocat', 'hello');
    // The reuse path used to return before reading anything. It must now read the local
    // config — that is what repairs a clone an older build left a token in.
    expect(anyGitCallWith('config', '--local', '--get', 'remote.origin.url')).toBe(true);
    expect(anyGitCallWith('clone')).toBe(false);
  });
});

describe('addWorktree', () => {
  it('adds a detached, forced worktree under .worktrees/', async () => {
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = await addWorktree(repoDir, 'abc123');
    expect(wt.startsWith(join(repoDir, '.worktrees', 'abc123-'))).toBe(true);

    const args = gitArgsContaining('worktree');
    expect(args).toEqual(
      expect.arrayContaining(['worktree', 'add', '--detach', '--force', wt, 'abc123']),
    );
    expect(liveWorktrees.has(wt)).toBe(true);
  });

  it('gives two runs on the SAME sha two different paths', async () => {
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const first = await addWorktree(repoDir, 'abc123');
    const second = await addWorktree(repoDir, 'abc123');
    expect(first).not.toBe(second);
  });

  it('never pre-clears the path, even when it exists', async () => {
    // The pre-clear is what destroyed a concurrent run's checkout. With a per-run path there
    // is nothing to clear, so an existing path must NOT produce a `worktree remove`.
    mockExists.mockReturnValue(true);
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    await addWorktree(repoDir, 'abc123');
    expect(anyGitCallWith('worktree', 'remove')).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('removes the worktree, forgets it, and prunes the registry', async () => {
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = await addWorktree(repoDir, 'abc123');
    mockExecFile.mockClear();

    await removeWorktree(repoDir, wt);
    expect(anyGitCallWith('worktree', 'remove', '--force', wt)).toBe(true);
    // The rmSync fallback leaves git's record behind; the prune is what stops that record
    // making the repo look busy forever.
    expect(anyGitCallWith('worktree', 'prune')).toBe(true);
    expect(liveWorktrees.has(wt)).toBe(false);
  });

  it('still resolves when git removal errors', async () => {
    // Make the git call fail; removeWorktree must swallow it and fall through.
    mockExecFile.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as ExecCb;
      cb(new Error('worktree remove failed'), { stdout: '', stderr: '' });
      return undefined;
    });

    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = join(repoDir, '.worktrees', 'abc123-1-1');
    await expect(removeWorktree(repoDir, wt)).resolves.toBeUndefined();
  });
});

describe('cleanupCloneCache', () => {
  const repoDir = join(CLONE_DIR, 'octocat__hello');
  const wtRoot = join(repoDir, '.worktrees');
  const worktree = join(wtRoot, 'abc123-1-1');
  const NOW = 1_000 * 3_600_000;

  /** One over-cap repo clone holding one worktree with the given mtime. */
  function tree(worktreeMtimeMs: number): void {
    mockExists.mockImplementation((p: unknown) => String(p) === CLONE_DIR);
    mockReaddir.mockImplementation((p: unknown) => {
      const at = String(p);
      if (at === CLONE_DIR) return ['octocat__hello'];
      if (at === repoDir) return ['big.pack', '.worktrees'];
      if (at === wtRoot) return ['abc123-1-1'];
      return [];
    });
    mockStat.mockImplementation((p: unknown) => {
      const at = String(p);
      const isDir = at === CLONE_DIR || at === repoDir || at === wtRoot || at === worktree;
      return {
        isDirectory: () => isDir,
        size: isDir ? 0 : 4096,
        mtimeMs: at === worktree ? worktreeMtimeMs : 0,
      };
    });
  }

  it('evicts a repo whose only worktree is past the TTL', () => {
    // This is the case the old `hasActiveWorktrees` check got wrong: ONE orphan left by a
    // crashed run exempted the whole clone from eviction, permanently.
    tree(NOW - TTL_MS - 1);
    cleanupCloneCache(NOW);
    expect(mockRm).toHaveBeenCalledWith(repoDir, { recursive: true, force: true });
  });

  it('skips a repo whose worktree is still inside the TTL', () => {
    tree(NOW - 1_000);
    cleanupCloneCache(NOW);
    expect(mockRm).not.toHaveBeenCalledWith(repoDir, { recursive: true, force: true });
  });

  it('skips a repo whose backdated worktree is one THIS process owns', () => {
    // Identity beats the clock: a long agent run touches nothing under its worktree for
    // hours. Delete the liveWorktrees branch and this test fails.
    tree(NOW - TTL_MS - 1);
    liveWorktrees.set(worktree, NOW);
    cleanupCloneCache(NOW);
    expect(mockRm).not.toHaveBeenCalledWith(repoDir, { recursive: true, force: true });
  });
});
