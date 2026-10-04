// prepPeerWorktrees (clone-manager.ts): several PRs checked out at once for a ticket review / a deep
// review's peers — the clone-manager.test.ts mocking pattern (no git binary, no filesystem).
//   pnpm --filter @pierre-review/backend test review/clone-peers
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  statSync: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: { cloneDir: '/tmp/pierre-clones-peers-test', cloneCacheMaxBytes: 100, worktreeTtlMs: 3_600_000 },
}));
vi.mock('../github/auth.js', () => ({ getGithubToken: () => 'TESTTOKEN' }));

import { execFile } from 'node:child_process';
import { liveWorktrees, prepPeerWorktrees, scrubGitError } from './clone-manager.js';

const mockExecFile = vi.mocked(execFile) as unknown as Mock;
type ExecCb = (err: Error | null, out: { stdout: string; stderr: string }) => void;

// Every git call is logged as start/end with its repo dir, and completes on a later tick, so
// overlapping work across repos is observable.
const log: string[] = [];
const repoOf = (args: string[]): string => {
  const c = args.indexOf('-C');
  if (c >= 0) return (args[c + 1] ?? '').split('/').find((s) => s.includes('__')) ?? '?';
  const dest = args[args.length - 1] ?? '';
  return dest.split('/').find((s) => s.includes('__')) ?? '?';
};

beforeEach(() => {
  log.length = 0;
  liveWorktrees.clear();
  mockExecFile.mockReset();
  mockExecFile.mockImplementation((...callArgs: unknown[]) => {
    const args = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as ExecCb;
    const repo = repoOf(args);
    const op = args.includes('worktree') ? `worktree-${args[args.indexOf('worktree') + 1]}` : (args.find((a) => ['clone', 'fetch', 'cat-file', 'config', 'remote'].includes(a)) ?? 'git');
    log.push(`start ${repo} ${op}`);
    setTimeout(() => {
      log.push(`end ${repo} ${op}`);
      // `cat-file -e` fails, so every head is fetched; the bad repo's fetch fails with a URL.
      if (op === 'cat-file') return cb(new Error('missing'), { stdout: '', stderr: '' });
      if (repo === 'acme__bad' && op === 'fetch') {
        return cb(
          new Error('Command failed: git fetch https://x-access-token:TESTTOKEN@github.com/acme/bad.git pull/9/head\nfatal: no'),
          { stdout: '', stderr: '' },
        );
      }
      cb(null, { stdout: '', stderr: '' });
    }, 2);
    return undefined;
  });
});

describe('prepPeerWorktrees', () => {
  it('prepares each peer into its own path, in request order; a failure is per peer and scrubbed', async () => {
    const { peers, cleanup } = await prepPeerWorktrees([
      { owner: 'acme', name: 'api', number: 1, headSha: 'aaa' },
      { owner: 'acme', name: 'bad', number: 9, headSha: 'bbb' },
      { owner: 'acme', name: 'api', number: 2, headSha: 'ccc' },
    ]);
    expect(peers.map((p) => p.number)).toEqual([1, 9, 2]);
    expect(peers[0]!.path).toMatch(/acme__api\/\.worktrees\/aaa-/);
    expect(peers[2]!.path).toMatch(/acme__api\/\.worktrees\/ccc-/);
    expect(peers[0]!.path).not.toBe(peers[2]!.path);
    expect(peers[1]!.path).toBeNull();
    expect(peers[1]!.error).toBeTruthy();
    expect(peers[1]!.error).not.toContain('TESTTOKEN');
    expect(liveWorktrees.size).toBe(2);
    await cleanup();
    await cleanup();
    expect(liveWorktrees.size).toBe(0);
    const removes = mockExecFile.mock.calls.filter((c) => (c[1] as string[]).includes('remove'));
    expect(removes).toHaveLength(2);
  });

  it('the same repo prepares sequentially; different repos overlap', async () => {
    await prepPeerWorktrees([
      { owner: 'acme', name: 'api', number: 1, headSha: 'aaa' },
      { owner: 'acme', name: 'api', number: 2, headSha: 'ccc' },
      { owner: 'acme', name: 'web', number: 3, headSha: 'ddd' },
    ]);
    const apiAdds = log
      .map((l, i) => [l, i] as const)
      .filter(([l]) => l.includes('acme__api worktree-add'));
    // start(1), end(1), start(2), end(2): the second add starts only after the first ended.
    expect(apiAdds.map(([l]) => l.split(' ')[0])).toEqual(['start', 'end', 'start', 'end']);
    const firstWeb = log.findIndex((l) => l.startsWith('start acme__web'));
    const lastApi = log.map((l) => l.startsWith('end acme__api')).lastIndexOf(true);
    expect(firstWeb).toBeLessThan(lastApi);
    // Never FETCH_HEAD.
    expect(mockExecFile.mock.calls.some((c) => (c[1] as string[]).includes('FETCH_HEAD'))).toBe(false);
  });

  it('scrubGitError strips credentials and keeps one line', () => {
    expect(scrubGitError(new Error('x https://x-access-token:gho_abc123@github.com/a/b\nmore'))).toBe(
      'x https://x-access-token:***@github.com/a/b',
    );
    expect(scrubGitError('token ghp_ABCdef012 leaked')).toBe('token *** leaked');
  });
});
