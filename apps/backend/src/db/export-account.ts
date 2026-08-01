import { eq, inArray } from 'drizzle-orm';
import { db, schema } from './client.js';

// ---------------------------------------------------------------------------
// Right of access + data portability (UK/EU GDPR Arts. 15 and 20).
//
// One JSON document containing everything the server holds for one account, in a
// "commonly used, machine-readable format" as Art. 20 requires. Deliberately built from
// explicit column lists rather than `select()` so that:
//
//   • the sealed GitHub token can NEVER appear in the output. `accounts.accessTokenEnc` is
//     encrypted, but an export is a file a user emails around and drops in cloud storage —
//     shipping even a sealed credential in it would be a self-inflicted key-exposure risk,
//     and it is not personal data the subject needs. Same for `stripeCustomerId` beyond the
//     fact a subscription exists.
//   • adding a column to a table cannot silently widen the export.
//
// Scope note: the export includes the third-party GitHub activity synced into this account
// (other people's comments and logins). That is correct — it is the data held in connection
// with this account, and the subject is entitled to see what is there — but it means an
// export can contain other people's personal data, which is why the download is
// same-origin-only, behind the session, and rate-limited like every other route.
// ---------------------------------------------------------------------------

const {
  accounts,
  repos,
  pullRequests,
  reviews,
  reviewThreads,
  reviewComments,
  prComments,
  events,
  teams,
  teamRepos,
  aiUsage,
  myTurnDismissals,
  repoReviewers,
  accountReviewers,
  benchmarkContributions,
  autoMergeRequests,
} = schema;

/** Cap per collection. An export must not be a way to ask the server to build a 2 GB string;
 *  the caps are far above a normal account and the response records where one bit. */
const EXPORT_ROW_CAP = 50_000;

interface Truncation {
  collection: string;
  cap: number;
}

export interface AccountExport {
  meta: {
    generatedAt: string;
    format: 'pierre-account-export';
    formatVersion: 1;
    /** Which collections hit the row cap (empty in the normal case). */
    truncated: Truncation[];
    notes: string[];
  };
  account: Record<string, unknown>;
  repositories: Record<string, unknown>[];
  teams: Record<string, unknown>[];
  pullRequests: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  reviewThreads: Record<string, unknown>[];
  reviewComments: Record<string, unknown>[];
  prComments: Record<string, unknown>[];
  events: Record<string, unknown>[];
  aiUsage: Record<string, unknown>[];
  dismissals: Record<string, unknown>[];
  /** The bot object's JUDGEMENT grain: one row per (repo, automated reviewer). */
  repoReviewers: Record<string, unknown>[];
  /** Its IDENTITY grain: one row per reviewer — vendor kind, label, and the recorded price. */
  accountReviewers: Record<string, unknown>[];
  benchmarkContributions: Record<string, unknown>[];
  /** Armed / recently-resolved "merge when ready" intents (auto_merge_requests). */
  autoMergeRequests: Record<string, unknown>[];
}

/** Build the full export document for one account. Returns null if the account is gone. */
export async function exportAccountData(accountId: number): Promise<AccountExport | null> {
  const truncated: Truncation[] = [];
  const capped = <T>(collection: string, rows: T[]): T[] => {
    if (rows.length > EXPORT_ROW_CAP) {
      truncated.push({ collection, cap: EXPORT_ROW_CAP });
      return rows.slice(0, EXPORT_ROW_CAP);
    }
    return rows;
  };

  const accountRows = await db
    .select({
      id: accounts.id,
      githubUserId: accounts.githubUserId,
      githubLogin: accounts.githubLogin,
      displayName: accounts.displayName,
      avatarUrl: accounts.avatarUrl,
      isLocal: accounts.isLocal,
      plan: accounts.plan,
      // Deliberately NOT exported: accessTokenEnc (a credential, even sealed) and
      // stripeCustomerId (Stripe's own identifier — request billing data from Stripe).
      hasStoredGithubToken: accounts.accessTokenEnc,
      aiCreditAllowance: accounts.aiCreditAllowance,
      benchmarkOptIn: accounts.benchmarkOptIn,
      lastLoginAt: accounts.lastLoginAt,
      lastActiveAt: accounts.lastActiveAt,
      createdAt: accounts.createdAt,
    })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1)
    .execute();
  const account = accountRows[0];
  if (!account) return null;

  const repoRows = await db
    .select()
    .from(repos)
    .where(eq(repos.accountId, accountId))
    .execute();
  const repoIds = repoRows.map((r) => r.id);

  const prRows = capped(
    'pullRequests',
    await db.select().from(pullRequests).where(eq(pullRequests.accountId, accountId)).execute(),
  );
  const prIds = prRows.map((p) => p.id);

  // The child tables reach their account through prId. An account with no PRs short-circuits
  // to empty arrays rather than issuing an `IN ()`.
  const childRows = async <T>(
    fn: (ids: number[]) => Promise<T[]>,
  ): Promise<T[]> => (prIds.length === 0 ? [] : fn(prIds));

  const [
    reviewRows,
    threadRows,
    reviewCommentRows,
    prCommentRows,
    eventRows,
    teamRows,
    teamRepoRows,
    usageRows,
    dismissalRows,
    repoReviewerRows,
    accountReviewerRows,
    benchmarkRows,
    autoMergeRows,
  ] = await Promise.all([
    childRows((ids) => db.select().from(reviews).where(inArray(reviews.prId, ids)).execute()),
    childRows((ids) =>
      db.select().from(reviewThreads).where(inArray(reviewThreads.prId, ids)).execute(),
    ),
    childRows((ids) =>
      db.select().from(reviewComments).where(inArray(reviewComments.prId, ids)).execute(),
    ),
    childRows((ids) =>
      db.select().from(prComments).where(inArray(prComments.prId, ids)).execute(),
    ),
    db.select().from(events).where(eq(events.accountId, accountId)).execute(),
    db.select().from(teams).where(eq(teams.accountId, accountId)).execute(),
    repoIds.length === 0
      ? Promise.resolve([])
      : db.select().from(teamRepos).where(inArray(teamRepos.repoId, repoIds)).execute(),
    db.select().from(aiUsage).where(eq(aiUsage.accountId, accountId)).execute(),
    db
      .select()
      .from(myTurnDismissals)
      .where(eq(myTurnDismissals.accountId, accountId))
      .execute(),
    // The bot object at BOTH grains — the per-repo judgements the user (or the classifier) made,
    // and the per-actor identity + recorded price. Art. 15 covers both: one records decisions
    // about this account's data, the other a number the user typed in.
    db
      .select()
      .from(repoReviewers)
      .where(eq(repoReviewers.accountId, accountId))
      .execute(),
    db
      .select()
      .from(accountReviewers)
      .where(eq(accountReviewers.accountId, accountId))
      .execute(),
    db
      .select()
      .from(benchmarkContributions)
      .where(eq(benchmarkContributions.accountId, accountId))
      .execute(),
    // "Merge when ready" intents. A record of an action the user asked the server to take on
    // their behalf (and of merges it performed), so it belongs in an Art. 15 export even
    // though the rows are small and short-lived.
    db
      .select()
      .from(autoMergeRequests)
      .where(eq(autoMergeRequests.accountId, accountId))
      .execute(),
  ]);

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      format: 'pierre-account-export',
      formatVersion: 1,
      truncated,
      notes: [
        'Your stored GitHub access token is deliberately excluded: it is a credential, not ' +
          'personal data you need, and an export file is not a safe place for one.',
        'Payment and card data is held by Stripe, never by this server — request it from Stripe.',
        'This export includes GitHub activity by OTHER people (their logins and the comments ' +
          'they wrote) because that is what was synced into your account. Handle it accordingly.',
        'Repository content is a cache of GitHub data and is regenerable from GitHub at any time.',
      ],
    },
    account: {
      ...account,
      // Report only the PRESENCE of a token, never the sealed value.
      hasStoredGithubToken: Boolean(account.hasStoredGithubToken),
    },
    repositories: repoRows,
    teams: teamRows.map((t) => ({
      ...t,
      repoIds: teamRepoRows.filter((tr) => tr.teamId === t.id).map((tr) => tr.repoId),
    })),
    pullRequests: prRows,
    reviews: capped('reviews', reviewRows),
    reviewThreads: capped('reviewThreads', threadRows),
    reviewComments: capped('reviewComments', reviewCommentRows),
    prComments: capped('prComments', prCommentRows),
    events: capped('events', eventRows),
    aiUsage: usageRows,
    dismissals: dismissalRows,
    repoReviewers: repoReviewerRows,
    accountReviewers: accountReviewerRows,
    benchmarkContributions: benchmarkRows,
    autoMergeRequests: autoMergeRows,
  };
}
