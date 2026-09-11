import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeTargetPath, resolveContainedTargetPath } from './safe-path.js';

// Against a REAL repo holding a REAL committed symlink, because that is the case no amount
// of string inspection can see: `link/evil.txt` contains no `..`, no leading slash and no
// `.git`, and it writes wherever `link` points.

let root: string;
let repo: string;
let outside: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
}

/** What git-ops.ts does at the write site: resolve, then create + write. */
async function guardedWrite(path: string, body: string): Promise<void> {
  const target = resolveContainedTargetPath(repo, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pierre-safepath-'));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  mkdirSync(repo);
  mkdirSync(outside);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  // The escape hatch, committed the way a hostile repo would ship it.
  symlinkSync('../outside', join(repo, 'link'));
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('resolveContainedTargetPath', () => {
  it('refuses a write through a COMMITTED symlink, and nothing lands outside', async () => {
    expect(git(['ls-files', '-s'])).toContain('120000'); // git really recorded a symlink

    await expect(guardedWrite('link/evil.txt', 'pwned')).rejects.toThrow();
    // The non-vacuous half: the refusal is what kept the byte out of `outside/`.
    // ⚠ Mutation check — delete the isSymbolicLink() branch and THIS assertion fails.
    expect(existsSync(join(outside, 'evil.txt'))).toBe(false);
  });

  it('is what a naive join would have gotten wrong', async () => {
    // Same path, written the old way: it escapes. This is why the lexical guard alone is
    // not enough, stated as a fact rather than as a comment.
    const naive = join(repo, 'link', 'evil.txt');
    await mkdir(dirname(naive), { recursive: true });
    await writeFile(naive, 'pwned', 'utf8');
    expect(existsSync(join(outside, 'evil.txt'))).toBe(true);
  });

  it('allows an ordinary nested path, resolving the ROOT too', () => {
    // /tmp is a symlink to /private/tmp on macOS: comparing an unresolved root against a
    // resolved child would refuse every legitimate write.
    expect(resolveContainedTargetPath(repo, 'docs/x.md')).toBe(
      join(realpathSync(repo), 'docs', 'x.md'),
    );
  });

  it('refuses `.git` at any depth and in any case', () => {
    for (const path of [
      '.git/config',
      '.GIT/config',
      'a/.git/hooks/pre-commit',
      'A/.Git/x',
    ]) {
      expect(() => resolveContainedTargetPath(repo, path), path).toThrow();
    }
  });
});

describe('assertSafeTargetPath', () => {
  it('refuses traversal, absolute paths, drive letters and .git at any depth', () => {
    for (const path of [
      '',
      '../evil.txt',
      '/etc/passwd',
      'a/../../b',
      'a//b',
      'C:whatever',
      '.git/config',
      '.GIT/config',
      'a/.git/hooks/pre-commit',
      'A/.Git/x',
      'a/./b',
    ]) {
      expect(() => assertSafeTargetPath(path), path).toThrow();
    }
  });

  it('accepts an ordinary repo-relative path', () => {
    expect(() => assertSafeTargetPath('docs/x.md')).not.toThrow();
    expect(() => assertSafeTargetPath('.github/coderabbit.yaml')).not.toThrow();
  });

  it('does NOT see the symlink — which is why the second guard exists', () => {
    // Documented deliberately: `link/evil.txt` is lexically spotless.
    expect(() => assertSafeTargetPath('link/evil.txt')).not.toThrow();
  });
});
