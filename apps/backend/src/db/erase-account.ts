import { and, eq, inArray } from 'drizzle-orm';
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
//  1. REUSE deleteRepo per repository rather than hand-rolling a second cascade. The core
//     schema has NO `ON DELETE CASCADE` anywhere, so the FK-safe delete order is intricate
//     and has already been got wrong twice (ci_status_events was missing from both delete
//     paths at one point, which 500'd repo deletion). One implementation, one place to fix.
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
  botReviewClassification,
  teams,
  teamRepos,
  benchmarkContributions,
  searchIndex,
  autoMergeRequests,
  branchCommits,
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
    // Teams: the membership rows for surviving repos are gone with their repos, but a team
    // whose repos were all deleted still has its own row.
    const teamRows = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.accountId, accountId))
      .execute();
    const teamIds = teamRows.map((t) => t.id);
    if (teamIds.length > 0) {
      await tx.delete(teamRepos).where(inArray(teamRepos.teamId, teamIds)).execute();
    }
    // teamRepos carries its OWN accountId as well as teamId, so delete by account too — a
    // membership row whose team was already gone (or whose repo was deleted first) would
    // otherwise survive with this account's id on it. Belt and braces after the teamId sweep.
    await tx.delete(teamRepos).where(eq(teamRepos.accountId, accountId)).execute();
    await tx.delete(teams).where(eq(teams.accountId, accountId)).execute();

    // The AI spend ledger (token/credit counts — no prompt text).
    await tx.delete(aiUsage).where(eq(aiUsage.accountId, accountId)).execute();
    // Dismissals of every kind. deleteRepo only clears the PR-keyed kinds for the repos it
    // deletes; `thread` and `claude_review` dismissals key off other id spaces and would
    // otherwise survive as orphans carrying this account's id.
    await tx
      .delete(myTurnDismissals)
      .where(eq(myTurnDismissals.accountId, accountId))
      .execute();
    // Manual + auto automated-reviewer classifications.
    await tx
      .delete(botReviewClassification)
      .where(eq(botReviewClassification.accountId, accountId))
      .execute();
    // Any aggregate rows contributed to the cross-org benchmark. Consent was the basis for
    // these, so withdrawal-by-deletion must remove them too.
    await tx
      .delete(benchmarkContributions)
      .where(eq(benchmarkContributions.accountId, accountId))
      .execute();
    // Full-text search rows are keyed by (accountId, …) and are copies of comment/PR text.
    await tx.delete(searchIndex).where(eq(searchIndex.accountId, accountId)).execute();
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
    {
      name: 'botReviewClassification',
      col: botReviewClassification.accountId,
      table: botReviewClassification,
    },
    { name: 'teams', col: teams.accountId, table: teams },
    // teamRepos has its own accountId (not only teamId) — it must be on the checklist, or a
    // membership row could survive an erasure carrying this account's id.
    { name: 'teamRepos', col: teamRepos.accountId, table: teamRepos },
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
