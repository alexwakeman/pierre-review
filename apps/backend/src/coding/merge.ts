import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import { fetchPrHeadInfo } from '../github/mutations.js';
import { codedError, pushForceWithLease, pushRef } from './git.js';
import { protectedRefsFor } from './git-ops.js';

const execFileAsync = promisify(execFile);

// CORE (free tier): "Update branch from trunk" — rebase or merge the trunk into a PR's own
// head branch and push — plus `hasConflictMarkers`, which the in-app conflict resolver
// (src/conflict/) imports. Same discipline as git.ts / clone-manager.ts: args are ALWAYS arrays
// (no shell), a tokenized URL is passed per-op and never persisted, and there is no agent here
// at all. ANY conflict aborts the rebase/merge and throws CONFLICTS_UNRESOLVED — nothing is
// ever resolved on this path, so a tree with conflicts is never pushed.
//
// (This file used to also hold AI Fix's trunk reconciliation — merge preview, rebase-resolve,
// merge-resolve-and-push, push-resolved, and the agentic conflict resolver they called. All of
// it was removed: an AI Fix now pushes as-is through git-ops.ts `applyAndPush`.)

// Non-interactive git env: no credential prompt, no editor, no merge-message editor.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

interface GitResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git, throwing on a non-zero exit (for ops that MUST succeed). */
async function git(args: string[], cwd: string): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd,
    env: GIT_ENV,
    timeout: 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  return { ok: true, code: 0, stdout, stderr };
}

/** Run git WITHOUT throwing; returns the exit code + output (for merge/rebase). */
async function gitTry(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: GIT_ENV,
      timeout: 120_000,
      maxBuffer: 128 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      ok: false,
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (err instanceof Error ? err.message : String(err)),
    };
  }
}

function tokenizedUrl(owner: string, name: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
}

function lines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

interface Ident {
  name: string;
  email: string;
}

async function identFor(accountId: number): Promise<Ident> {
  const account = await getAccountById(accountId);
  const name = account?.displayName || account?.githubLogin || 'pierre-review';
  const email = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';
  return { name, email };
}

function identArgs(ident: Ident): string[] {
  return ['-c', `user.name=${ident.name}`, '-c', `user.email=${ident.email}`];
}

async function scheduleCleanup(repoCloneDir: string | null): Promise<void> {
  if (!repoCloneDir) return;
  setImmediate(() => {
    try {
      cleanupCloneCache();
    } catch {
      /* advisory */
    }
  });
}

async function teardown(
  owner: string,
  name: string,
  repoCloneDir: string | null,
  worktreePath: string | null,
): Promise<void> {
  if (repoCloneDir && worktreePath) {
    await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(
      () => {},
    );
  }
  void scheduleCleanup(repoCloneDir);
}

/** Fetch a branch into the worktree's object store and return its tip sha. */
async function fetchTrunk(
  worktree: string,
  owner: string,
  name: string,
  token: string,
  trunk: string,
): Promise<string> {
  const res = await gitTry(
    ['fetch', '--no-tags', '--force', tokenizedUrl(owner, name, token), trunk],
    worktree,
  );
  if (!res.ok) {
    throw codedError(
      'TRUNK_FETCH_FAILED',
      `couldn't fetch trunk '${trunk}': ${res.stderr || res.stdout}`,
    );
  }
  const { stdout } = await git(['rev-parse', 'FETCH_HEAD'], worktree);
  return stdout.trim();
}

/** True if `ancestor` is an ancestor of `descendant` (i.e. already contained). */
async function isAncestor(
  worktree: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const res = await gitTry(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    worktree,
  );
  return res.ok;
}

/** The currently-unmerged (conflicted) paths. */
async function conflictedFiles(worktree: string): Promise<string[]> {
  const { stdout } = await git(
    ['diff', '--name-only', '--diff-filter=U'],
    worktree,
  );
  return lines(stdout);
}

// A leftover conflict marker: `<<<<<<< `, `>>>>>>> ` or diff3's `||||||| ` (the
// `=======` divider alone is ambiguous — real files contain it — so we rely on the
// unambiguous open/close markers plus git's own unmerged-index check).
const MARKER_RE = /^(<{7}|>{7}|\|{7})[ \t]/m;

/** True if `text` still contains an (unambiguous) unresolved conflict marker. */
export function hasConflictMarkers(text: string): boolean {
  return MARKER_RE.test(text);
}

/** True if a rebase or merge is currently in progress in this worktree. */
async function opInProgress(
  worktree: string,
  kind: 'rebase' | 'merge',
): Promise<boolean> {
  const probes = kind === 'rebase' ? ['rebase-merge', 'rebase-apply'] : ['MERGE_HEAD'];
  for (const p of probes) {
    try {
      const { stdout } = await git(['rev-parse', '--git-path', p], worktree);
      const rel = stdout.trim();
      const abs = isAbsolute(rel) ? rel : join(worktree, rel);
      if (existsSync(abs)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

// ---- rebase the checked-out branch onto the trunk (aborts on the first conflict) ----
async function runRebase(
  worktree: string,
  trunkSha: string,
  ident: Ident,
): Promise<void> {
  const gc = identArgs(ident);

  let res = await gitTry([...gc, 'rebase', trunkSha], worktree);
  let step = 0;
  while (!res.ok) {
    if (!(await opInProgress(worktree, 'rebase'))) {
      // The rebase never started / hard-failed (not a conflict stop).
      throw codedError('REBASE_FAILED', res.stderr || res.stdout || 'rebase failed');
    }
    const files = await conflictedFiles(worktree);
    if (files.length > 0) {
      await gitTry(['rebase', '--abort'], worktree);
      throw codedError(
        'CONFLICTS_UNRESOLVED',
        `rebase conflicts in ${files.join(', ')}`,
      );
    }
    // A stop with no conflicted file (e.g. a commit that became empty): continue or skip it,
    // capped so a pathological history can't spin.
    if (++step > config.aiFixRebaseMaxSteps) {
      await gitTry(['rebase', '--abort'], worktree);
      throw codedError(
        'REBASE_FAILED',
        `rebase exceeded ${config.aiFixRebaseMaxSteps} conflict steps`,
      );
    }
    res = await continueOrSkip(worktree, gc);
  }
}

// `git rebase --continue`, falling back to `--skip` when a commit became empty (its
// changes are already on the trunk).
async function continueOrSkip(
  worktree: string,
  gc: string[],
): Promise<GitResult> {
  const cont = await gitTry([...gc, 'rebase', '--continue'], worktree);
  if (cont.ok) return cont;
  const blob = `${cont.stderr}\n${cont.stdout}`.toLowerCase();
  if (
    blob.includes('no changes') ||
    blob.includes('nothing to commit') ||
    blob.includes('did you forget') ||
    blob.includes('patch is empty')
  ) {
    return gitTry([...gc, 'rebase', '--skip'], worktree);
  }
  return cont;
}

// ---- merge the trunk into the checked-out branch (aborts on any conflict) ----
async function runMerge(
  worktree: string,
  trunkSha: string,
  trunk: string,
  branchLabel: string,
  ident: Ident,
): Promise<void> {
  const gc = identArgs(ident);
  if (await isAncestor(worktree, trunkSha, 'HEAD')) {
    return; // already contains the trunk
  }
  const res = await gitTry(
    [...gc, 'merge', '--no-ff', '--no-edit', '-m', `Merge ${trunk} into ${branchLabel}`, trunkSha],
    worktree,
  );
  if (res.ok) return;

  const files = await conflictedFiles(worktree);
  if (files.length === 0) {
    await gitTry(['merge', '--abort'], worktree);
    throw codedError('MERGE_FAILED', res.stderr || res.stdout || 'merge failed');
  }
  await gitTry(['merge', '--abort'], worktree);
  throw codedError('CONFLICTS_UNRESOLVED', `merge conflicts in ${files.join(', ')}`);
}

// ---- CORE (free tier): update a PR's OWN branch from its base/trunk ----
// Rebase (default) or merge the trunk into the PR's head branch and push. This is the local,
// clone-based path for the free-tier "Update branch from trunk": on ANY conflict runRebase /
// runMerge abort the op and throw CONFLICTS_UNRESOLVED (nothing here resolves a conflict — the
// in-app resolver in src/conflict/ is a separate, reader-driven flow). No stored patch is
// involved: we check the PR head out as-is and reconcile it.
export async function updatePrBranchFromTrunk(args: {
  accountId: number;
  owner: string;
  name: string;
  prNumber: number;
  headRef: string;
  headSha: string;
  trunk: string;
  strategy: 'rebase' | 'merge';
}): Promise<{ headSha: string; strategy: 'rebase' | 'merge' }> {
  const { accountId, owner, name, prNumber, headRef, headSha, trunk, strategy } = args;
  const token = await getAccessToken(accountId);
  const ident = await identFor(accountId);

  // The head must not have moved out from under us, and a fork head must be pushable.
  const info = await fetchPrHeadInfo(token, owner, name, prNumber);
  if (info.headSha !== headSha) {
    throw codedError(
      'HEAD_MOVED',
      `the PR head advanced (now ${info.headSha.slice(0, 7)}, expected ${headSha.slice(0, 7)})`,
    );
  }
  if (info.isFork && !info.maintainerCanModify) {
    throw codedError(
      'PUSH_DENIED',
      'the PR head is a fork this account cannot push to — update it on GitHub instead',
    );
  }
  // The PR head branch lives in the HEAD repo, which for a fork PR is NOT the base (watched)
  // repo — push there, or a merge would create a stray branch on the base and a rebase's lease
  // would target the wrong ref. The clone/fetch still uses the base repo below (pull/N/head
  // resolves there); only the PUSH target is the head repo. full_name is always `owner/name`.
  const slash = info.headRepoFullName.indexOf('/');
  const headOwner = slash > 0 ? info.headRepoFullName.slice(0, slash) : owner;
  const headName = slash > 0 ? info.headRepoFullName.slice(slash + 1) : name;

  // The push lands in the HEAD repo, which for a fork PR is not the watched one — then there
  // is nothing of ours to protect there (see protectedRefsFor).
  const push = {
    worktree: '',
    owner: headOwner,
    name: headName,
    token,
    committish: 'HEAD',
    remoteBranch: headRef,
    protect: await protectedRefsFor(accountId, owner, name, prNumber, headOwner, headName),
  };

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    // Check out the PR head branch (prepWorktree checks out at the given sha).
    ({ repoCloneDir, worktreePath } = await prepWorktree(owner, name, prNumber, headSha, token));
    const trunkSha = await fetchTrunk(worktreePath, owner, name, token, trunk);

    if (strategy === 'rebase') {
      await runRebase(worktreePath, trunkSha, ident); // throws CONFLICTS_UNRESOLVED on conflict
      const newSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
      // Rewriting history requires a force push; the lease pins to the sha we cloned so a
      // concurrent push aborts it (never blows away someone else's work).
      await pushForceWithLease({ ...push, worktree: worktreePath, leaseSha: headSha });
      return { headSha: newSha, strategy };
    }

    await runMerge(worktreePath, trunkSha, trunk, headRef, ident); // throws on conflict
    const newSha = (await git(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
    // A merge only adds a commit (the old head is its ancestor) → a plain push. Already
    // up-to-date (runMerge no-op) leaves HEAD unchanged → nothing to push.
    if (newSha !== headSha) {
      await pushRef({ ...push, worktree: worktreePath });
    }
    return { headSha: newSha, strategy };
  } finally {
    await teardown(owner, name, repoCloneDir, worktreePath);
  }
}
