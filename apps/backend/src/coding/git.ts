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

// ── The push guard ──────────────────────────────────────────────────────────────────────
// Everything that writes a ref on GitHub goes through pushRef / pushForceWithLease, and both
// go through assertPushTarget FIRST. The branch name reaching them is not always ours: it can
// be a PR's own head ref, and in the resolver it can be a name the user typed.
//
// ⚠ THE AUTHORITY IS `git check-ref-format`, NOT A REGEX. git-ops.ts's
// `/^[A-Za-z0-9][A-Za-z0-9._/-]*$/` is a stricter NAMING CONVENTION on branches the advisor
// INVENTS; it is not a general push guard and must not be hoisted here. `feature/#123`,
// `user's-branch`, `a+b` and `ünicode/x` are all valid GitHub head refs that regex rejects,
// and pushRef is already called with real head refs.

/**
 * Names git's own format check accepts but that must never be a push target: they are
 * pseudo-refs or a leading-dash argument git would read as an option. Compared
 * case-INSENSITIVELY — on a case-folding filesystem `head` and `HEAD` are the same file.
 */
const RESERVED_REF_NAMES = new Set([
  'HEAD',
  'FETCH_HEAD',
  'ORIG_HEAD',
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_HEAD',
  'AUTO_MERGE',
]);

/** Where a push may land, and where it may not. `protect` is REQUIRED — a new call site
 *  must type `[]` deliberately rather than inherit an empty default it never thought about. */
export interface PushTarget {
  worktree: string;
  owner: string;
  name: string;
  token: string;
  committish: string;
  remoteBranch: string;
  /** Branch names this push must never land on (repo default branch, PR base ref). */
  protect: string[];
}

/**
 * Refuse a push target before any process is spawned: a malformed ref name, a reserved
 * pseudo-ref, or a protected branch. Throws a coded 'PUSH_DENIED'.
 * ⚠ Runs BEFORE the push, deliberately — a refusal that arrives as "git push failed" reads
 * as a network or permission problem and sends the reader looking in the wrong place.
 */
export async function assertPushTarget(
  remoteBranch: string,
  protect: string[],
): Promise<void> {
  const deny = (why: string): never => {
    throw codedError('PUSH_DENIED', `refusing to push to '${remoteBranch}': ${why}`);
  };

  if (!remoteBranch) deny('the branch name is empty');
  // check-ref-format accepts a leading `-`, which git would then read as an option, and it
  // has nothing to say about the double / trailing slashes some git versions tolerate.
  if (remoteBranch.startsWith('-')) deny('a branch name may not start with a dash');
  if (remoteBranch.startsWith('/') || remoteBranch.endsWith('/')) {
    deny('a branch name may not start or end with a slash');
  }
  if (remoteBranch.includes('//')) deny('a branch name may not contain an empty component');
  if (RESERVED_REF_NAMES.has(remoteBranch.toUpperCase())) {
    deny(`${remoteBranch} is one of git's own ref names`);
  }
  try {
    await execFileAsync('git', ['check-ref-format', `refs/heads/${remoteBranch}`], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    deny('git does not accept it as a branch name');
  }
  const lowered = remoteBranch.toLowerCase();
  if (protect.some((p) => p.toLowerCase() === lowered)) {
    deny('it is a protected branch for this pull request');
  }
}

/** The tokenized push URL. Built per op and never persisted (clone-manager owns the same rule). */
function pushUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

/**
 * Push a local committish to a remote branch via an explicit tokenized URL (never the
 * clone's persisted remote). Throws a coded 'PUSH_DENIED' error on failure (no write
 * access, protected branch, non-fast-forward on an existing branch).
 */
export async function pushRef(t: PushTarget): Promise<void> {
  await assertPushTarget(t.remoteBranch, t.protect);
  try {
    await git(
      ['push', pushUrl(t.owner, t.name, t.token), `${t.committish}:refs/heads/${t.remoteBranch}`],
      t.worktree,
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

/**
 * Force-push with a lease: the push aborts unless the remote branch is still at `leaseSha`,
 * so a concurrent push is never blown away.
 * ⚠ This is the DANGEROUS half and it lived in merge.ts, below every guard. It is here so
 * that "a force push goes through assertPushTarget" is true by construction.
 */
export async function pushForceWithLease(
  t: PushTarget & { leaseSha: string },
): Promise<void> {
  await assertPushTarget(t.remoteBranch, t.protect);
  try {
    await git(
      [
        'push',
        `--force-with-lease=refs/heads/${t.remoteBranch}:${t.leaseSha}`,
        pushUrl(t.owner, t.name, t.token),
        `${t.committish}:refs/heads/${t.remoteBranch}`,
      ],
      t.worktree,
    );
  } catch (err) {
    throw codedError(
      'PUSH_DENIED',
      `force-with-lease push failed (branch moved since / protected / no write): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
