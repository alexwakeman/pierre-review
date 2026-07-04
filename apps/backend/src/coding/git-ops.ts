import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import {
  createPullRequest,
  fetchPrHeadInfo,
} from '../github/mutations.js';
import type {
  ApplyAndPushArgs,
  ApplyAndPushResult,
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
