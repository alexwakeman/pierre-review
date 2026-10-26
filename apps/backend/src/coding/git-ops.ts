import { and, eq } from 'drizzle-orm';
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
import { ghRestGetFor, ghRestGetText } from '../github/client.js';
import { db, schema } from '../db/client.js';
import { settlePrAfterWrite } from '../sync/resync-after-write.js';
import { syncOnePr } from '../sync/sync-one-pr.js';
import type { Logger } from '../sync/sync-repo.js';
import type {
  ApplyAndPushArgs,
  ApplyAndPushResult,
} from '../platform/contract.js';
import {
  applyPatchToWorktree,
  codedError,
  commitAll,
  pushRef,
} from './git.js';

/**
 * The names a push for this PR must never land on: the repo's default branch and the PR's
 * base ref, read from the LOCAL DB (no GitHub call).
 *
 * Returns [] when the push target repo is NOT the watched repo — a fork PR pushes to the
 * FORK, where `main` is the contributor's own branch and protecting it would refuse a
 * legitimate push.
 */
export async function protectedRefsFor(
  accountId: number,
  owner: string,
  name: string,
  prNumber: number,
  pushOwner: string,
  pushName: string,
): Promise<string[]> {
  if (
    pushOwner.toLowerCase() !== owner.toLowerCase() ||
    pushName.toLowerCase() !== name.toLowerCase()
  ) {
    return [];
  }
  const { repos, pullRequests } = schema;
  const [repoRow] = await db
    .select({ id: repos.id, defaultBranch: repos.defaultBranch })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), eq(repos.owner, owner), eq(repos.name, name)))
    .execute();
  if (!repoRow) return [];
  const [prRow] = await db
    .select({ baseRefName: pullRequests.baseRefName })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoRow.id), eq(pullRequests.number, prNumber)))
    .execute();
  const names = [repoRow.defaultBranch, prRow?.baseRefName];
  return [...new Set(names.filter((n): n is string => Boolean(n)))];
}

// The local repo id for (account, owner/name), or null. Account-scoped: an owner/name another
// tenant tracks resolves only to THIS account's row.
async function localRepoId(
  accountId: number,
  owner: string,
  name: string,
): Promise<number | null> {
  const { repos } = schema;
  const [repoRow] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(and(eq(repos.accountId, accountId), eq(repos.owner, owner), eq(repos.name, name)))
    .execute();
  return repoRow?.id ?? null;
}

// After a push onto an EXISTING PR's head: settle-and-verify that PR against the pushed commit.
// The PR number resolves ONLY within (accountId, repoId) — numbers are unique per repo. Never
// throws: the push has already landed.
async function settlePushedPr(
  accountId: number,
  owner: string,
  name: string,
  prNumber: number,
  commitSha: string,
): Promise<void> {
  try {
    const repoId = await localRepoId(accountId, owner, name);
    if (repoId == null) return;
    const { pullRequests } = schema;
    const [prRow] = await db
      .select({ id: pullRequests.id })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          eq(pullRequests.repoId, repoId),
          eq(pullRequests.number, prNumber),
        ),
      )
      .execute();
    if (!prRow) return;
    await settlePrAfterWrite({
      accountId,
      prId: prRow.id,
      log: quietLogger,
      expect: { headSha: commitSha },
    });
  } catch {
    /* the push is real; a failed confirmation only delays what the SPA sees */
  }
}

// After a push that OPENED a new PR in (owner/name): targeted-sync it. Never throws.
async function syncNewPrInRepo(
  accountId: number,
  owner: string,
  name: string,
  prNumber: number,
): Promise<void> {
  try {
    const repoId = await localRepoId(accountId, owner, name);
    if (repoId == null) return;
    await syncOnePr(repoId, prNumber, quietLogger, { waitForInFlight: true });
  } catch {
    /* the PR is real; the next walk picks it up */
  }
}

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
  //
  // Whether the PR's head branch lives in THIS repo — read here, used by the post-push settle
  // below. ⚠ A FORK PR's head lives in the fork, but the push below goes to `owner/name` (the
  // base repo), so for a fork it writes a same-named branch the PR does not track. That is a
  // latent defect of this path (the conflict resolver pushes to `headRepoFullName` instead) and
  // it is NOT changed here; the settle is simply skipped for it, because the PR's head can
  // never become the pushed commit and the ladder would run to exhaustion for nothing.
  let pushedToPrHeadRepo = false;
  if (target.kind === 'existing') {
    const info = await fetchPrHeadInfo(token, owner, name, prNumber);
    pushedToPrHeadRepo =
      !info.isFork &&
      info.headRepoFullName.toLowerCase() === `${owner}/${name}`.toLowerCase();
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
  } else {
    // NEW branch, never force: a live ref under this name means someone (an earlier fix run,
    // a person) already owns it — refuse rather than clobber. (This path used to discover the
    // collision as a push rejection instead.)
    const existing = await ghRestGetText(
      token,
      `/repos/${owner}/${name}/git/ref/heads/${target.branch}`,
    );
    if (existing.ok) {
      throw codedError(
        'BRANCH_EXISTS',
        `branch ${target.branch} already exists on ${owner}/${name}`,
      );
    }
  }

  const protect = await protectedRefsFor(accountId, owner, name, prNumber, owner, name);

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

    const push = { worktree: worktreePath, owner, name, token, committish: 'HEAD', protect };
    if (target.kind === 'existing') {
      await pushRef({ ...push, remoteBranch: target.headRef });
      // ── The push LANDED: nothing below may throw (a retry would double-push). ──────────
      // Settle-and-verify against the pushed commit (sync/resync-after-write.ts), so the stored
      // head and conflict/CI verdict catch up; when they move, persistPr raises the SPA change
      // signal and the SPA's post-write poll window refetches. Only when the pushed repo IS the
      // PR's head repo — see `pushedToPrHeadRepo` above.
      // ⚠ NOT AWAITED. The caller records the push (the plugin's `markFixPushed`) only AFTER this
      // returns, and awaiting the settle's ~7s inline wait widened "pushed on GitHub but not
      // recorded here" from milliseconds to seconds — a restart in that window left the fix row
      // unmarked. `settlePushedPr` never rejects.
      if (pushedToPrHeadRepo) {
        void settlePushedPr(accountId, owner, name, prNumber, commitSha);
      }
      return { pushedBranch: target.headRef, commitSha };
    }

    // New branch → push then open a PR against the base.
    await pushRef({ ...push, remoteBranch: target.branch });
    const pr = await createPullRequest(token, {
      owner,
      name,
      head: target.branch,
      base: target.base,
      title: target.title,
      body: target.body,
    });
    // The new PR exists on GitHub: sync it so it becomes local. ⚠ NOT AWAITED, for the same
    // reason as above: the caller records the new PR's number and URL only after this returns.
    // The sync's first sighting raises the SPA change signal. `syncNewPrInRepo` never rejects.
    void syncNewPrInRepo(accountId, owner, name, pr.number);
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

// The silent logger the visibility tails above sync with.
const quietLogger: Logger = {
  info: () => {},
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};
