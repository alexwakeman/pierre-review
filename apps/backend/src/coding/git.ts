import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CodingErrorCode } from '../pro/contract.js';

const execFileAsync = promisify(execFile);

// Low-level git helpers for the AI-Fix write path. Args are ALWAYS an array (never a
// shell string), so there's no interpolation/injection surface — the same discipline
// as clone-manager.ts. A tokenized push URL is passed per-op and never persisted.

/** An Error carrying a `.code` the push route maps to an HTTP status. */
export function codedError(code: CodingErrorCode, message: string): Error {
  const err = new Error(message) as Error & { code: CodingErrorCode };
  err.code = code;
  return err;
}

async function git(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
}

/**
 * Stage everything (including NEW and deleted files) and capture the change as a
 * binary-safe unified diff against HEAD, plus the changed-file list. `git add -A`
 * before `git diff --cached` is what makes newly-created files round-trip — a plain
 * `git diff` silently omits untracked files. `--binary` round-trips assets too.
 */
export async function captureWorktreeDiff(
  worktree: string,
): Promise<{ patch: string; filesChanged: string[] }> {
  await git(['add', '-A'], worktree);
  const { stdout: patch } = await git(
    ['diff', '--cached', '--binary'],
    worktree,
  );
  const { stdout: names } = await git(
    ['diff', '--cached', '--name-only'],
    worktree,
  );
  const filesChanged = names
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { patch, filesChanged };
}

/**
 * Apply a stored unified-diff patch onto the worktree (checked out at the patch's
 * exact base commit). `--3way` is a safety net if the tree isn't byte-identical.
 * Throws a coded 'APPLY_FAILED' error if the patch doesn't apply.
 */
export async function applyPatchToWorktree(
  worktree: string,
  patch: string,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'pierre-fix-'));
  const patchFile = join(tmp, 'fix.patch');
  try {
    writeFileSync(patchFile, patch, 'utf-8');
    await git(['apply', '--3way', patchFile], worktree);
  } catch (err) {
    throw codedError(
      'APPLY_FAILED',
      `patch did not apply cleanly: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* advisory */
    }
  }
}

/**
 * Stage everything and create a single commit with the given author identity. Returns
 * the new commit SHA. `--no-verify` skips any inherited hooks (the fix is machine-made
 * and pre-reviewed by the user). Uses `-c user.*` so we never touch global git config.
 */
export async function commitAll(
  worktree: string,
  opts: { message: string; authorName: string; authorEmail: string },
): Promise<string> {
  await git(['add', '-A'], worktree);
  await git(
    [
      '-c',
      `user.name=${opts.authorName}`,
      '-c',
      `user.email=${opts.authorEmail}`,
      'commit',
      '--no-verify',
      '-m',
      opts.message,
    ],
    worktree,
  );
  const { stdout } = await git(['rev-parse', 'HEAD'], worktree);
  return stdout.trim();
}

/**
 * Push a local committish to a remote branch via an explicit tokenized URL (never the
 * clone's persisted remote). Throws a coded 'PUSH_DENIED' error on failure (no write
 * access, protected branch, non-fast-forward on an existing branch).
 */
export async function pushRef(
  worktree: string,
  owner: string,
  name: string,
  token: string,
  committish: string,
  remoteBranch: string,
): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
  try {
    await git(
      ['push', url, `${committish}:refs/heads/${remoteBranch}`],
      worktree,
    );
  } catch (err) {
    throw codedError(
      'PUSH_DENIED',
      `git push failed (write access / protected branch?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
