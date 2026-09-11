import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyPatchToWorktree,
  assertPushTarget,
  captureWorktreeDiff,
  commitAll,
  pushRef,
} from './git.js';

// Exercises the AI-Fix git helpers against a REAL throwaway git repo (fast, local).
// The load-bearing property: `captureWorktreeDiff` must round-trip NEWLY-CREATED files
// (a plain `git diff` drops untracked files), and the captured patch must re-apply
// cleanly onto the same base.

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pierre-git-test-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('captureWorktreeDiff', () => {
  it('captures modified AND newly-created files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n'); // modify
    writeFileSync(join(dir, 'b.txt'), 'brand new\n'); // create (untracked)

    const { patch, filesChanged } = await captureWorktreeDiff(dir);

    expect(filesChanged).toContain('a.txt');
    expect(filesChanged).toContain('b.txt'); // the untracked file survives
    expect(patch).toContain('b.txt');
    expect(patch).toContain('brand new');
  });

  it('produces an applicable patch that round-trips onto the base', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'b.txt'), 'brand new\n');
    const { patch } = await captureWorktreeDiff(dir);

    // Return the worktree to the exact base state.
    git(['reset', '--hard', '-q', 'HEAD']);
    git(['clean', '-fdq']);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\n');

    await applyPatchToWorktree(dir, patch);

    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('brand new\n');
  });
});

describe('applyPatchToWorktree', () => {
  it('throws a coded APPLY_FAILED on a patch that does not apply', async () => {
    const bogus = `diff --git a/nope.txt b/nope.txt
index 0000000..1111111 100644
--- a/nope.txt
+++ b/nope.txt
@@ -1,1 +1,1 @@
-this line does not exist
+replacement
`;
    await expect(applyPatchToWorktree(dir, bogus)).rejects.toMatchObject({
      code: 'APPLY_FAILED',
    });
  });
});

describe('commitAll', () => {
  it('commits staged + untracked changes and returns the new sha', async () => {
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');
    const sha = await commitAll(dir, {
      message: 'fix: apply',
      authorName: 'Bot',
      authorEmail: 'bot@example.com',
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    // The new commit's tree has b.txt.
    const files = execFileSync('git', ['show', '--name-only', '--format=', sha], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(files).toContain('a.txt');
    expect(files).toContain('b.txt');
  });
});

describe('assertPushTarget', () => {
  // ⚠ The authority is `git check-ref-format`, not a regex. Every name here is one a real
  // GitHub head ref can carry, and `pushRef` is already called with real head refs — the
  // stricter regex in git-ops.ts governs branch names the advisor INVENTS and must stay there.
  it('accepts the branch names GitHub actually allows', async () => {
    for (const branch of [
      'main',
      'feature/#123',
      "user's-branch",
      'a+b',
      'ünicode/x',
      'release/v1.2.3',
      'limn/advisor/config-20260909',
    ]) {
      await expect(assertPushTarget(branch, []), branch).resolves.toBeUndefined();
    }
  });

  it('refuses malformed and reserved ref names', async () => {
    for (const branch of [
      'a..b',
      'foo bar',
      'a.lock',
      'x@{1}',
      '',
      'a//b',
      'trailing/',
      '/leading',
      '-evil',
      'HEAD',
    ]) {
      await expect(assertPushTarget(branch, []), branch).rejects.toMatchObject({
        code: 'PUSH_DENIED',
      });
    }
  });

  it('compares the protected list case-INSENSITIVELY', async () => {
    await expect(assertPushTarget('Main', ['main'])).rejects.toMatchObject({
      code: 'PUSH_DENIED',
    });
    await expect(assertPushTarget('main', ['MAIN'])).rejects.toMatchObject({
      code: 'PUSH_DENIED',
    });
    await expect(assertPushTarget('my-branch', ['main'])).resolves.toBeUndefined();
  });
});

describe('pushRef', () => {
  it('refuses BEFORE spawning a push', async () => {
    // The token is bogus and the repo does not exist: if the guard ran after the push, the
    // failure would read "git push failed (write access / protected branch?)" and send the
    // reader looking at permissions instead of at the branch name they typed.
    await expect(
      pushRef({
        worktree: dir,
        owner: 'octocat',
        name: 'hello',
        token: 'not-a-token',
        committish: 'HEAD',
        remoteBranch: 'main',
        protect: ['main'],
      }),
    ).rejects.toThrow(/protected branch for this pull request/);
  });
});
