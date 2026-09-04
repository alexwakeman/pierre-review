import { and, eq } from 'drizzle-orm';
import { db, runTransaction, schema } from './client.js';
import { deleteRepo } from './queries.js';

// ---------------------------------------------------------------------------
// Right to erasure (UK/EU GDPR Art. 17, CCPA "right to delete").
//
// A privacy policy that promises deletion and a codebase with no delete path is worse than
// having neither — so this is the machinery behind that promise, not a soft "deactivate".
// It removes the account row, its sealed GitHub token, every repository it added, every PR
// subtree under those repositories, and every account-keyed row in between.
//
// Two design rules:
//
//  1. REUSE deleteRepo per repository rather than hand-rolling a second cascade. Almost none
//     of the core schema declares `ON DELETE CASCADE` (the workspace tables and
//     auto_merge_requests are the exceptions), so the FK-safe delete order is intricate and has
//     already been got wrong twice (ci_status_events was missing from both delete paths at one
//     point, which 500'd repo deletion). One implementation, one place to fix. Where a cascade
//     DOES exist, this file still deletes explicitly and child-first: SQLite enforces FKs only
//     under `foreign_keys=ON` while Postgres enforces them immediately, and an erasure promise
//     must not depend on which dialect is running.
//
//  2. Enumerate the account-level tables EXPLICITLY and keep this list next to the schema in
//     review. A table added later that carries `accountId` and is not listed here becomes a
//     silent erasure leak — data that survives a deletion the user was told was complete.
//     `eraseAccountData` is covered by a test that asserts every accountId-bearing table is
//     empty afterwards, so the omission fails CI rather than shipping.
//
// The `users` and `commitFiles` tables are deliberately NOT touched: they are global,
// deduplicated across tenants (a GitHub login is the same person for everyone, an immutable
// commit's file list is the same list), so deleting rows there would corrupt other accounts'
// data. `users` holds only what GitHub publishes on a public profile — login, display name,
// avatar — and never anything the erasing user contributed.
// ---------------------------------------------------------------------------

const {
  accounts,
  repos,
  aiUsage,
  myTurnDismissals,
  workspaces,
  workspaceRepos,
  workspaceReviewers,
  benchmarkContributions,
  searchIndex,
  autoMergeRequests,
  branchCommits,
  trunkCiStatusEvents,
  mlCommentLabels,
  prMentions,
  pendingMutedRepos,
} = schema;

/**
 * A plugin-owned erasure hook, mirroring `registerRetentionHandler`. `@pierre/pro` owns its
 * own tables (review_learnings, repo_digests, pro_settings, ai_fixes, …) and core cannot name
 * them across the open-core boundary — so the plugin registers a handler here and core calls
 * it as part of the same erasure. Empty in OSS, where those tables do not exist.
 */
export type AccountErasureHandler = (args: {
  accountId: number;
}) => Promise<void> | void;
const erasureHandlers: AccountErasureHandler[] = [];
export function registerAccountErasureHandler(h: AccountErasureHandler): void {
  erasureHandlers.push(h);
}

export interface EraseResult {
  reposDeleted: number;
}

/**
 * Irreversibly delete everything belonging to one account. Returns how many repositories
 * were removed. Safe to call for an id that no longer exists (returns 0).
 */
export async function eraseAccountData(accountId: number): Promise<EraseResult> {
  // 1. Per-repository subtrees first, via the single canonical cascade. Sequential rather
  //    than parallel: each call opens its own transaction, and on SQLite a second concurrent
  //    write transaction would contend on the database lock.
  const repoRows = await db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  let reposDeleted = 0;
  for (const r of repoRows) {
    if (await deleteRepo(r.id, accountId)) reposDeleted += 1;
  }

  // 2. Plugin-owned tables, BEFORE the account row disappears — a handler may want to read
  //    the account while resolving its own rows. A plugin failure must not abort the core
  //    erasure: the user asked to be deleted, and leaving them half-deleted because an
  //    optional plugin threw is the worse outcome. Logged by the caller.
  for (const handler of erasureHandlers) {
    await handler({ accountId });
  }

  // 3. Account-level core tables, then the account itself. One transaction so an account can
  //    never be left present-but-stripped (or absent-but-referenced) if this fails midway.
  await runTransaction(async (tx) => {
    // Workspaces and everything keyed to one, CHILD BEFORE PARENT. All three tables carry
    // `accountId`, so each delete is a single indexed predicate and none of them depends on
    // another's result set — but the ORDER still matters and is not belt-and-braces alone:
    //
    //   workspace_reviewers ─┐
    //                        ├─ composite FK (workspace_id, account_id) → workspaces(id, account_id)
    //   workspace_repos ─────┘   ON DELETE CASCADE
    //
    // Postgres checks FKs immediately, so deleting `workspaces` first would rely entirely on the
    // cascade firing; SQLite only enforces them at all with `foreign_keys=ON`. Deleting the
    // children explicitly, first, makes the erasure independent of both — the cascades then find
    // nothing to do, which is exactly the property the checklist below asserts.
    //
    // `workspace_reviewers` is the one that must never be left to a cascade: it holds the manual
    // judgements, the human-set vendor names and `monthly_cents` — a price the user typed — so a
    // row surviving here survives an erasure the user was told was complete.
    await tx
      .delete(workspaceReviewers)
      .where(eq(workspaceReviewers.accountId, accountId))
      .execute();
    // Membership rows for surviving repos are already gone with their repos (the repo half of
    // the composite FK cascades), but a workspace whose repos were all deleted, and any row the
    // repo loop above could not reach, still carries this account's id.
    await tx.delete(workspaceRepos).where(eq(workspaceRepos.accountId, accountId)).execute();
    // The REPO half of the Pending mute (migration 0058 / pg 0045). Deleted BEFORE `workspaces`
    // only for tidiness — it has no FK to a workspace at all (a repo belongs to exactly one
    // workspace already, so copying that fact onto the mute row would give the account two
    // answers to it). Its composite FK to `repos` cascades and the repo loop above has normally
    // taken it; explicit for the same reason as every other entry here — the guarantee must not
    // depend on which dialect enforces FKs, nor on the repo loop having succeeded. The row is a
    // preference the user expressed by hand.
    await tx
      .delete(pendingMutedRepos)
      .where(eq(pendingMutedRepos.accountId, accountId))
      .execute();
    await tx.delete(workspaces).where(eq(workspaces.accountId, accountId)).execute();

    // The AI spend ledger (token/credit counts — no prompt text).
    await tx.delete(aiUsage).where(eq(aiUsage.accountId, accountId)).execute();
    // Dismissals of every kind. deleteRepo only clears the PR-keyed kinds for the repos it
    // deletes; `thread` and `claude_review` dismissals key off other id spaces and would
    // otherwise survive as orphans carrying this account's id.
    await tx
      .delete(myTurnDismissals)
      .where(eq(myTurnDismissals.accountId, accountId))
      .execute();
    // Any aggregate rows contributed to the cross-org benchmark. Consent was the basis for
    // these, so withdrawal-by-deletion must remove them too.
    await tx
      .delete(benchmarkContributions)
      .where(eq(benchmarkContributions.accountId, accountId))
      .execute();
    // Full-text search rows are keyed by (accountId, …) and are copies of comment/PR text.
    await tx.delete(searchIndex).where(eq(searchIndex.accountId, accountId)).execute();
    // ML severity/category labels. Their FKs cascade from repos/pull_requests, so the repo loop
    // above has normally taken them already — explicit for the same reason as every other entry
    // here: the guarantee must not depend on which dialect enforces FKs, or on the repo loop
    // having succeeded. Each row is a machine judgement ABOUT this account's bot comments.
    await tx
      .delete(mlCommentLabels)
      .where(eq(mlCommentLabels.accountId, accountId))
      .execute();
    // "@you" mention rows (migration 0056 / pg 0043). Same reasoning as the labels above — the
    // repo loop and the cascading repo/PR FKs normally take them, and this makes the guarantee
    // independent of both. Each row records that a named person typed THIS user's login on a
    // specific PR, which is exactly the kind of trace an erasure promise covers.
    await tx.delete(prMentions).where(eq(prMentions.accountId, accountId)).execute();
    // Standing auto-merge intents. Their FKs cascade from pull_requests, so deleteRepo above
    // has already taken most of them — but a row is only as safe as the repo loop that ran,
    // and an intent naming a PR id is a record of what this user was about to ship. Explicit.
    await tx
      .delete(autoMergeRequests)
      .where(eq(autoMergeRequests.accountId, accountId))
      .execute();
    // Default-branch commit snapshots (author names, commit subjects) — same reasoning: the
    // repo cascade normally clears them, this makes the guarantee independent of it.
    await tx.delete(branchCommits).where(eq(branchCommits.accountId, accountId)).execute();
    // The trunk CI transition log (migration 0052 / pg 0039). Same reasoning again: the repo
    // loop and the cascade normally clear it, and this makes the guarantee independent of both.
    // Unlike `ci_status_events` it is NOT anchored to a PR, so the time-based retention sweep
    // can never reach it either — the only bounds are its own per-repo trim and this delete.
    await tx
      .delete(trunkCiStatusEvents)
      .where(eq(trunkCiStatusEvents.accountId, accountId))
      .execute();

    // Finally the account: identity + the AES-256-GCM sealed GitHub token.
    await tx.delete(accounts).where(eq(accounts.id, accountId)).execute();
  });

  return { reposDeleted };
}

/**
 * Every core table that carries an `accountId`, with its column — the checklist
 * `eraseAccountData` is tested against. Exported so the test iterates THIS list rather than a
 * copy of it, which is what makes "a new accountId table was added and not erased" a test
 * failure instead of a silent leak.
 */
export function accountScopedTables(): {
  name: string;
  count: (accountId: number) => Promise<number>;
}[] {
  const { pullRequests, events, claudeReviews } = schema;
  const rows = [
    { name: 'accounts', col: accounts.id, table: accounts },
    { name: 'repos', col: repos.accountId, table: repos },
    { name: 'pullRequests', col: pullRequests.accountId, table: pullRequests },
    { name: 'events', col: events.accountId, table: events },
    { name: 'claudeReviews', col: claudeReviews.accountId, table: claudeReviews },
    { name: 'aiUsage', col: aiUsage.accountId, table: aiUsage },
    { name: 'myTurnDismissals', col: myTurnDismissals.accountId, table: myTurnDismissals },
    // THE WORKSPACE TRIO (migrations 0044/0045). FOUR entries left here when they arrived —
    // `repoReviewers`, `accountReviewers`, `teams`, `teamRepos` — and THREE replaced them. The net
    // drop of one is correct and intended: the two bot tables collapsed onto a single
    // (account, workspace, actor) row. It is written out because an off-by-one in a checklist is
    // exactly how a table gets missed.
    { name: 'workspaces', col: workspaces.accountId, table: workspaces },
    // workspaceRepos carries its OWN accountId (not only workspaceId/repoId) — it must be on the
    // checklist, or a membership row could survive an erasure carrying this account's id.
    { name: 'workspaceRepos', col: workspaceRepos.accountId, table: workspaceRepos },
    // The bot object, now one grain. It holds the human judgements, the human-set vendor names
    // and `monthly_cents` — the one column no classifier can regenerate — so this is the entry
    // whose omission would cost the user data they entered by hand.
    { name: 'workspaceReviewers', col: workspaceReviewers.accountId, table: workspaceReviewers },
    {
      name: 'benchmarkContributions',
      col: benchmarkContributions.accountId,
      table: benchmarkContributions,
    },
    { name: 'searchIndex', col: searchIndex.accountId, table: searchIndex },
    {
      name: 'autoMergeRequests',
      col: autoMergeRequests.accountId,
      table: autoMergeRequests,
    },
    { name: 'branchCommits', col: branchCommits.accountId, table: branchCommits },
    // The trunk CI transition log. On the checklist rather than in the KNOWN_UNCHECKED
    // exemption that `ci_status_events` sits in, because this one has NO parent PR: neither the
    // retention sweep nor `deletePrSubtree` can ever reach it, so `deleteRepo` + this delete are
    // the ONLY things that bound it.
    {
      name: 'trunkCiStatusEvents',
      col: trunkCiStatusEvents.accountId,
      table: trunkCiStatusEvents,
    },
    { name: 'mlCommentLabels', col: mlCommentLabels.accountId, table: mlCommentLabels },
    // "@you was mentioned on this PR" (migration 0056 / pg 0043).
    { name: 'prMentions', col: prMentions.accountId, table: prMentions },
    // The REPO half of the Pending mute (migration 0058 / pg 0045). The WORKSPACE half is a
    // COLUMN on `workspaces`, already on this checklist, so there is nothing separate to count
    // for it — the row it lives on is deleted.
    { name: 'pendingMutedRepos', col: pendingMutedRepos.accountId, table: pendingMutedRepos },
  ];
  return rows.map(({ name, col, table }) => ({
    name,
    count: async (accountId: number) => {
      const found = await db
        .select({ id: col })
        .from(table)
        .where(and(eq(col, accountId)))
        .execute();
      return found.length;
    },
  }));
}
