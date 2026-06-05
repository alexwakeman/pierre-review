import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Mock the seams clone-manager touches so we exercise the git-arg construction
// without a real git binary, filesystem, or gh auth:
//  - execFile: a spy that always invokes its trailing callback (success by
//    default) so the promisify(execFile) form resolves;
//  - node:fs: existsSync returns false (so .git / worktree paths look absent →
//    ensureClone clones, addWorktree doesn't pre-remove), mkdirSync/rmSync are
//    no-op spies;
//  - config: a fixed cloneDir / cloneCacheMaxBytes;
//  - getGithubToken: a stable token we can assert ends up in the remote URL.
const CLONE_DIR = '/tmp/pierre-clones-test';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));
// NOTE: the factory is hoisted above the CLONE_DIR const, so it must inline the
// literal (referencing CLONE_DIR here would hit the temporal dead zone).
vi.mock('../config.js', () => ({
  config: { cloneDir: '/tmp/pierre-clones-test', cloneCacheMaxBytes: 1_000_000_000 },
}));
vi.mock('../github/auth.js', () => ({ getGithubToken: () => 'TESTTOKEN' }));

import { execFile } from 'node:child_process';
import { addWorktree, ensureClone, removeWorktree } from './clone-manager.js';

// promisify(execFile) calls execFile(cmd, args, opts, callback); the spy must
// invoke the LAST argument (the callback) so the promisified form settles.
const mockExecFile = vi.mocked(execFile) as unknown as Mock;

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

beforeEach(() => {
  mockExecFile.mockReset();
  resolveOk();
});

describe('ensureClone', () => {
  it('returns the owner__name path under config.cloneDir', async () => {
    const dir = await ensureClone('octocat', 'hello');
    expect(dir).toBe(join(CLONE_DIR, 'octocat__hello'));
  });

  it('clones bloblessly with a tokenized remote when .git is absent', async () => {
    const dir = await ensureClone('octocat', 'hello');
    const args = gitArgsContaining('clone');

    // first arg of the call is the binary
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('git');

    expect(args).toContain('clone');
    expect(args).toContain('--filter=blob:none');
    expect(args).toContain('--no-checkout');
    expect(args).toContain(dir);

    const url = args.find((a) => a.includes('github.com/octocat/hello'));
    expect(url).toBeDefined();
    expect(url).toContain('x-access-token:TESTTOKEN@github.com/octocat/hello');
  });
});

describe('addWorktree', () => {
  it('returns the .worktrees/<sha> path and adds a detached, forced worktree', async () => {
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = await addWorktree(repoDir, 'abc123');
    expect(wt).toBe(join(repoDir, '.worktrees', 'abc123'));

    const args = gitArgsContaining('worktree');
    expect(args).toEqual(
      expect.arrayContaining([
        'worktree',
        'add',
        '--detach',
        '--force',
        wt,
        'abc123',
      ]),
    );
  });
});

describe('removeWorktree', () => {
  it('removes the worktree with git worktree remove --force', async () => {
    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = join(repoDir, '.worktrees', 'abc123');
    await removeWorktree(repoDir, wt);

    const args = gitArgsContaining('worktree');
    expect(args).toEqual(
      expect.arrayContaining(['worktree', 'remove', '--force', wt]),
    );
  });

  it('still resolves when git removal errors', async () => {
    // Make the git call fail; removeWorktree must swallow it and fall through.
    mockExecFile.mockImplementation((...callArgs: unknown[]) => {
      const cb = callArgs[callArgs.length - 1] as ExecCb;
      cb(new Error('worktree remove failed'), { stdout: '', stderr: '' });
      return undefined;
    });

    const repoDir = join(CLONE_DIR, 'octocat__hello');
    const wt = join(repoDir, '.worktrees', 'abc123');
    await expect(removeWorktree(repoDir, wt)).resolves.toBeUndefined();
  });
});
