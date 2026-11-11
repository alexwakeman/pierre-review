import { and, eq } from 'drizzle-orm';
import { getAccessToken, getAccountById } from '../auth/account.js';
import {
  cleanupCloneCache,
  prepBranchWorktree,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import {
  createPullRequest,
  fetchPrHeadInfo,
} from '../github/mutations.js';
import { ghRestGetFor, ghRestGetText } from '../github/client.js';
import { withLimnRunTrailer, type LimnActionOrigin } from '@pierre-review/shared';
import { limnOriginForPrNumber, limnRunRef, orReader } from '../db/limn-actions.js';
import type { WriteOrigin } from '../github/write-origin.js';
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
  assertPushTarget,
  codedError,
  commitAll,
  commitsAdded,
  headTree,
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
  // LIMN'S WORK IS BOT WORK: the commit carries the run's trailer, the push and any PR it opens are
  // recorded in the ledger (github/write-origin.ts).
  const origin: WriteOrigin = orReader(
    await limnOriginForPrNumber(accountId, owner, name, prNumber, args.limnRun.origin, { source: args.limnRun.source }).catch(() => null),
  );
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
      message: withLimnRunTrailer(commitMessage, limnRunRef(args.limnRun.source)),
      authorName,
      authorEmail,
    });

    const push = { worktree: worktreePath, owner, name, token, committish: 'HEAD', protect, origin, limnCommits: [commitSha] };
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
    }, origin);
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

export interface ApplyAndPushBranchArgs {
  accountId: number;
  owner: string;
  name: string;
  /** The commit the patch was built on, and the branch it was read from (for the fetch). */
  baseSha: string;
  baseRef: string;
  patch: string;
  commitMessage: string;
  /** The NEW branch (never an existing one: `BRANCH_EXISTS`). */
  branch: string;
  /** The branch the new PR targets (the default branch, or the stacked PR's head branch). */
  prBase: string;
  title: string;
  body: string;
  draft: boolean;
  /** Branch names this push must never land on (the default branch, a stacked PR's head). */
  protect: string[];
  /** Runs once the new PR has synced (it is a local row then); never awaited, a throw is swallowed. */
  afterSync?: (prNumber: number) => Promise<void>;
  /**
   * Plan first (a stacked PR): the tree the commit must have — the host-verified tip's tree. A mismatch is
   * `TREE_MISMATCH`, refused BEFORE anything is pushed.
   */
  expectTree?: string;
}

export const TREE_MISMATCH_LINE = "Limn's copy of the earlier pull request does not match. Push it again from Limn.";

/**
 * THE NO-PR VARIANT of `applyAndPush` (a story build's push, coding/story-build/push.ts): the same
 * stateless steps — a FRESH worktree at `baseSha` (`prepBranchWorktree`, no PR to fetch), the stored
 * patch applied, ONE commit by the reader, pushed to a NEW branch (refused with `BRANCH_EXISTS` when
 * it is live; never forced; `protect` refused before any process runs), then a PR opened against
 * `prBase` — as a DRAFT when `draft`. The new PR is synced in the background (`syncNewPrInRepo`, never
 * rejects); after the push lands nothing here throws.
 */
export async function applyAndPushBranch(
  args: ApplyAndPushBranchArgs,
): Promise<{ pushedBranch: string; commitSha: string; prNumber: number; prUrl: string }> {
  const { accountId, owner, name } = args;
  const token = await getAccessToken(accountId);
  const account = await getAccountById(accountId);
  const authorName = account?.displayName || account?.githubLogin || 'pierre-review';
  const authorEmail = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';
  // AN IMPLEMENT PR IS THE READER'S (owner decision 2026-11-11): no ledger row, no `Limn-Run:` trailer, so
  // sync attributes the PR and its commit to the reader, never to their `limn:` bot — and the reader's own
  // auto review picks it up like any PR of theirs (docs/STORY-BUILD.md § Push).
  const origin: WriteOrigin = 'reader';

  // The name is the reader's (or the plan's slug): git's own check and the protected names FIRST, before
  // it is spelled into a GitHub URL — each segment encoded (`#`, `%` and the like are valid in a ref).
  await assertPushTarget(args.branch, args.protect);
  const refPath = args.branch.split('/').map(encodeURIComponent).join('/');
  const existing = await ghRestGetText(token, `/repos/${owner}/${name}/git/ref/heads/${refPath}`);
  if (existing.ok) {
    throw codedError('BRANCH_EXISTS', `branch ${args.branch} already exists on ${owner}/${name}`);
  }

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    ({ repoCloneDir, worktreePath } = await prepBranchWorktree(
      owner,
      name,
      { remoteRef: `refs/heads/${args.baseRef}`, destRef: 'refs/pierre/story-build-base', sha: args.baseSha },
      token,
    ));
    await applyPatchToWorktree(worktreePath, args.patch);
    const commitSha = await commitAll(worktreePath, {
      message: args.commitMessage,
      authorName,
      authorEmail,
    });
    if (args.expectTree != null && (await headTree(worktreePath)) !== args.expectTree) throw codedError('TREE_MISMATCH', TREE_MISMATCH_LINE);
    await pushRef({
      worktree: worktreePath,
      owner,
      name,
      token,
      committish: 'HEAD',
      protect: args.protect,
      remoteBranch: args.branch,
      origin,
      limnCommits: [commitSha],
    });
    let pr: { number: number; url: string };
    try {
      pr = await createPullRequest(token, {
        owner,
        name,
        head: args.branch,
        base: args.prBase,
        title: args.title,
        body: args.body,
        draft: args.draft,
      }, origin);
    } catch (err) {
      // The branch IS on GitHub: say so, so nobody presses Push again into BRANCH_EXISTS.
      const e = new Error(
        `The branch ${args.branch} was pushed, but GitHub did not open the pull request (${err instanceof Error ? err.message : String(err)}). Open it on GitHub.`,
      ) as Error & { code: string; commitSha: string };
      e.code = 'PR_NOT_OPENED';
      e.commitSha = commitSha;
      throw e;
    }
    // ── The PR exists: nothing below may throw. Synced in the background (see applyAndPush). ──
    const opened = pr.number;
    void syncNewPrInRepo(accountId, owner, name, opened)
      .then(() => args.afterSync?.(opened))
      .catch(() => {});
    return { pushedBranch: args.branch, commitSha, prNumber: pr.number, prUrl: pr.url };
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

// The silent logger the visibility tails above sync with.
const quietLogger: Logger = {
  info: () => {},
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a),
};

// ---- AI FIX WITH A MERGE (docs/SANDBOX.md § AI Fix sessions, "The merge") ----

export interface PushMergeArgs {
  accountId: number;
  fixId: number;
  owner: string;
  name: string;
  prNumber: number;
  /** The PR head the fix started from: the merge's first parent, and the compare-and-set on the branch. */
  headSha: string;
  baseRef: string;
  /** The base tip picked at the start: the merge's second parent. */
  baseSha: string;
  /** The agent's commits from the sandbox (a git bundle). */
  bundle: Buffer;
  conflictedFiles: readonly string[];
  /** The merge commit and the last commit Limn checked after the turn (what the reader reviewed). */
  expectedMergeSha: string;
  expectedResultSha: string;
  mergeMessage: string;
  fixMessage: string;
  /** Why it is pushed: a press, an automatic push, the Dependencies policy (the ledger's origin). */
  limnOrigin: LimnActionOrigin;
}

/**
 * Push a fix that resolved merge conflicts: re-check the sandbox's bundle in the clone cache
 * (`verifyMergeBundle`: parents, markers, fixes on top), rebuild the merge commit (and ONE fix commit
 * on top) from the verified trees under the reader's name, and push onto the PR's own branch. Never
 * forced: the live head must still be `headSha` (HEAD_MOVED), and the push is a fast-forward of it. A
 * fork's branch is refused (PUSH_DENIED): Limn pushes a merge only within the repository.
 */
export async function pushMergeResult(args: PushMergeArgs): Promise<ApplyAndPushResult> {
  const { accountId, owner, name, prNumber } = args;
  const token = await getAccessToken(accountId);
  const account = await getAccountById(accountId);
  const authorName = account?.displayName || account?.githubLogin || 'pierre-review';
  const authorEmail = account?.githubLogin
    ? `${account.githubLogin}@users.noreply.github.com`
    : 'pierre-review@users.noreply.github.com';
  const info = await fetchPrHeadInfo(token, owner, name, prNumber);
  if (info.isFork || info.headRepoFullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
    throw codedError('PUSH_DENIED', "the pull request's branch is in a fork; Limn pushes a merge only to a branch in the same repository");
  }
  if (info.headSha !== args.headSha) {
    throw codedError(
      'HEAD_MOVED',
      `the PR head advanced (now ${info.headSha.slice(0, 7)}, the merge was made on ${args.headSha.slice(0, 7)})`,
    );
  }
  const protect = await protectedRefsFor(accountId, owner, name, prNumber, owner, name);
  const source = { table: 'ai_fixes', id: args.fixId };
  const origin: WriteOrigin = orReader(await limnOriginForPrNumber(accountId, owner, name, prNumber, args.limnOrigin, { source }).catch(() => null));
  const trailerRef = limnRunRef(source);
  const { withMergeRepo, aiFixMergeRef } = await import('./ai-fix/merge-host.js');
  const { verifyMergeBundle, buildMergeCommits } = await import('./ai-fix/merge-verify.js');
  const commitSha = await withMergeRepo(
    { fixId: args.fixId, owner, name, prNumber, headSha: args.headSha, baseRef: args.baseRef, baseSha: args.baseSha },
    async (dir) => {
      const v = await verifyMergeBundle({
        gitDir: dir,
        bundle: args.bundle,
        headSha: args.headSha,
        baseSha: args.baseSha,
        baseRef: args.baseRef,
        conflictedFiles: args.conflictedFiles,
        resultRef: aiFixMergeRef(args.fixId, 'result'),
        token,
      });
      if (!v.ok) throw codedError('APPLY_FAILED', `the merge failed Limn's check: ${v.reason}`);
      // Exactly the commits the reader reviewed (their diffs were computed from these), nothing else.
      if (v.mergeSha !== args.expectedMergeSha || v.resultSha !== args.expectedResultSha) {
        throw codedError('APPLY_FAILED', 'the stored merge is not the one Limn checked after the turn');
      }
      const sha = await buildMergeCommits(
        dir,
        { mergeSha: v.mergeSha, resultSha: v.resultSha, headSha: args.headSha, baseSha: args.baseSha },
        {
          authorName,
          authorEmail,
          mergeMessage: withLimnRunTrailer(args.mergeMessage, trailerRef),
          fixMessage: withLimnRunTrailer(args.fixMessage, trailerRef),
        },
      );
      // The merge commit and (when there is one) the fix on top: both Limn's.
      const pushed = await commitsAdded(dir, args.headSha, sha, 2).catch(() => [sha]);
      await pushRef({ worktree: dir, owner, name, token, committish: sha, remoteBranch: info.headRef, protect, origin, limnCommits: pushed.length > 0 ? pushed : [sha] });
      return sha;
    },
  );
  // ── The push LANDED: nothing below may throw (a retry would double-push). Not awaited (applyAndPush). ──
  void settlePushedPr(accountId, owner, name, prNumber, commitSha);
  return { pushedBranch: info.headRef, commitSha };
}

