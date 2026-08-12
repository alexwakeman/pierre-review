import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  cleanupCloneCache,
  prepWorktree,
  prepWorktreeAtRef,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import {
  createPullRequest,
  fetchPrHeadInfo,
} from '../github/mutations.js';
import { ghRestGetFor, ghRestGetText } from '../github/client.js';
import { db, schema } from '../db/client.js';
import { syncOnePr } from '../sync/sync-one-pr.js';
import type { Logger } from '../sync/sync-repo.js';
import type {
  ApplyAndPushArgs,
  ApplyAndPushResult,
  CommitFilesAndOpenPrArgs,
  CommitFilesAndOpenPrResult,
} from '../pro/contract.js';
import {
  applyPatchToWorktree,
  codedError,
  commitAll,
  pushRef,
} from './git.js';

// The implementation behind ctx.coding.applyAndPush. STATELESS: it re-preps a fresh
// worktree at the patch's exact base commit and `git apply`s the stored patch, so a
// fix survives a restart and works on ephemeral cloud disk. Owns the head-moved guard
// (existing-branch only) and does all git writes (the agent never can).
export async function applyAndPush(
  args: ApplyAndPushArgs,
): Promise<ApplyAndPushResult> {
  const { accountId, owner, name, prNumber, baseSha, patch, commitMessage, target } =
    args;
  const token = await getAccessToken(accountId);
  const account = await getAccountById(accountId);
  const authorName =
    account?.displayName || account?.githubLogin || 'pierre-review';
  const authorEmail = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';

  // Head-moved / un-pushable-fork guard applies ONLY to the existing-branch path
  // (pushing onto the PR's own head). A new branch is self-contained off baseSha and
  // is immune to the head having advanced.
  if (target.kind === 'existing') {
    const info = await fetchPrHeadInfo(token, owner, name, prNumber);
    if (info.headSha !== baseSha) {
      throw codedError(
        'HEAD_MOVED',
        `the PR head advanced (now ${info.headSha.slice(0, 7)}, fix was built on ${baseSha.slice(0, 7)})`,
      );
    }
    if (info.isFork && !info.maintainerCanModify) {
      throw codedError(
        'PUSH_DENIED',
        'the PR head is a fork this account cannot push to — push to a new branch instead',
      );
    }
  }

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    ({ repoCloneDir, worktreePath } = await prepWorktree(
      owner,
      name,
      prNumber,
      baseSha,
      token,
    ));
    await applyPatchToWorktree(worktreePath, patch);
    const commitSha = await commitAll(worktreePath, {
      message: commitMessage,
      authorName,
      authorEmail,
    });

    if (target.kind === 'existing') {
      await pushRef(worktreePath, owner, name, token, 'HEAD', target.headRef);
      return { pushedBranch: target.headRef, commitSha };
    }

    // New branch → push then open a PR against the base.
    await pushRef(worktreePath, owner, name, token, 'HEAD', target.branch);
    const pr = await createPullRequest(token, {
      owner,
      name,
      head: target.branch,
      base: target.base,
      title: target.title,
      body: target.body,
    });
    return {
      pushedBranch: target.branch,
      commitSha,
      prNumber: pr.number,
      prUrl: pr.url,
    };
  } finally {
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(
        () => {},
      );
    }
    if (repoCloneDir) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}

// ── commitFilesAndOpenPr — the advisor's config-PR primitive ────────────────────────────────
// The implementation behind ctx.coding.commitFilesAndOpenPr: worktree at the repo's DEFAULT
// branch → write LITERAL file contents (the adapter merged them against the fetched originals
// upstream — this function writes bytes, it never merges) → commit → push a NEW branch (a
// plain push, never force; an existing branch is a refusal, not an overwrite) → open the PR →
// the syncOnePr visibility tail. After GitHub 201s the PR, nothing here may throw — a failed
// confirming sync is `visible: false`, and the caller's copy contract ("it'll show up here
// shortly", never a retry) does the rest.

// Repo-relative, no traversal, no .git internals — file paths reach this seam from adapter
// plans whose config locations can be influenced by REPO CONTENT (a T3 manifest proposes a
// configPath), i.e. attacker-suppliable in cloud.
function assertSafeTargetPath(path: string): void {
  const norm = path.replace(/\\/g, '/');
  const segments = norm.split('/');
  if (
    !norm ||
    norm.startsWith('/') ||
    /^[A-Za-z]:/.test(norm) ||
    segments.some((s) => s === '' || s === '.' || s === '..') ||
    norm === '.git' ||
    norm.startsWith('.git/')
  ) {
    throw codedError('APPLY_FAILED', `invalid target path: ${path}`);
  }
  // The OAuth token has no `workflow` scope, so a push touching .github/workflows/* is
  // rejected by GitHub AFTER the branch exists — refuse outright instead of half-failing.
  if (norm === '.github/workflows' || norm.startsWith('.github/workflows/')) {
    throw codedError(
      'PUSH_DENIED',
      `refusing to write ${path}: workflow files need the \`workflow\` OAuth scope, which this token does not carry`,
    );
  }
}

const quietLogger: Logger = {
  info: () => {},
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

export async function commitFilesAndOpenPr(
  args: CommitFilesAndOpenPrArgs,
): Promise<CommitFilesAndOpenPrResult> {
  const { accountId, owner, name, files, branch, title, body } = args;
  if (files.length === 0) throw codedError('APPLY_FAILED', 'no files to commit');
  for (const f of files) assertSafeTargetPath(f.path);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
    throw codedError('APPLY_FAILED', `invalid branch name: ${branch}`);
  }
  const token = await getAccessToken(accountId);
  const account = await getAccountById(accountId);
  const authorName = account?.displayName || account?.githubLogin || 'pierre-review';
  const authorEmail = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';

  // NEW branch, never force: a live ref under this name means someone (possibly an earlier
  // advisor run) already owns it — refuse rather than clobber or confuse two PRs.
  const existing = await ghRestGetText(
    token,
    `/repos/${owner}/${name}/git/ref/heads/${branch}`,
  );
  if (existing.ok) {
    throw codedError('BRANCH_EXISTS', `branch ${branch} already exists on ${owner}/${name}`);
  }

  // The DEFAULT branch is the base: the config that governs FUTURE reviews is the default
  // branch's copy (repo grain — a head-branch config affects only that PR's reviews).
  const repoMeta = await ghRestGetFor<{ default_branch?: string }>(
    token,
    `/repos/${owner}/${name}`,
  );
  const base = repoMeta.default_branch;
  if (!base) throw codedError('TRUNK_FETCH_FAILED', `no default branch for ${owner}/${name}`);

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    ({ repoCloneDir, worktreePath } = await prepWorktreeAtRef(owner, name, base, token));
    for (const f of files) {
      const target = join(worktreePath, f.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf8');
    }
    await commitAll(worktreePath, { message: title, authorName, authorEmail });
    await pushRef(worktreePath, owner, name, token, 'HEAD', branch);
    const pr = await createPullRequest(token, { owner, name, head: branch, base, title, body });

    // ── After this point the PR EXISTS on GitHub: nothing below may throw. ──────────────
    // Visibility tail (the resync-after-write contract): targeted-sync the new PR so the
    // SPA's next read of the local DB sees it, and CONFIRM with a SELECT rather than trust
    // the sync's return value.
    let visible = false;
    try {
      const { repos, pullRequests } = schema;
      const [repoRow] = await db
        .select({ id: repos.id })
        .from(repos)
        .where(and(eq(repos.accountId, accountId), eq(repos.owner, owner), eq(repos.name, name)))
        .execute();
      if (repoRow) {
        await syncOnePr(repoRow.id, pr.number, quietLogger, { waitForInFlight: true });
        const [prRow] = await db
          .select({ id: pullRequests.id })
          .from(pullRequests)
          .where(and(eq(pullRequests.repoId, repoRow.id), eq(pullRequests.number, pr.number)))
          .execute();
        visible = Boolean(prRow);
      }
    } catch {
      /* the PR is real; a failed confirmation is visible:false, never an error */
    }
    return { prNumber: pr.number, url: pr.url, visible };
  } finally {
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(() => {});
    }
    if (repoCloneDir) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}
