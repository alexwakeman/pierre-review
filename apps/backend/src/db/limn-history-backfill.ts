// THE LIMN HISTORY BACKFILL (docs/CLAUDE-REVIEW.md § Limn's actions are bots → The history).
//
// Owner rule (2026-11-08): "Everything Limn does on my behalf is not me." From the switch on
// (`config.limnAttributeAll`), sync stores every row Limn wrote under the poster's `limn:` bot. Rows
// stored BEFORE the ledger existed must move with it, or the history reads half one way and half the
// other. This module moves them, ONCE per account, DB only:
//
//   1. SEED THE LEDGER (`limn_actions`) from the exact records Limn already kept — every row is a
//      fact, never a guess:
//        claude_reviews.posted_review_id            → 'review'        (its GitHub review id)
//        claude_review_findings.github_comment_id   → 'review_comment' / 'pr_comment'
//        ticket_review_items.posted_comment_id      → 'review_comment' / 'pr_comment'
//        claude_still_open_posts.comment_id         → 'reply'
//        auto_merge_requests state 'merged'         → 'merge'         (the watcher landed it)
//        dependency_automation_actions merge_landed → 'merge'         (one row per PR with the above)
//        dependency_automation_actions result_sha   → 'push'          (a pushed resolution / fix)
//        dependency_automation_actions rebase_request → 'pr_comment'  (the "@dependabot rebase" Limn
//                                                     posted: the reader's comment with exactly that
//                                                     body on that PR, nearest within 2 minutes)
//        story_build_prs / story_build_repos         → 'push' (pushed_commit_sha) + 'open_pr'
//        ai_fixes.pushed_pr_number (a NEW PR)        → 'open_pr'
//      ⚠ Past AI Fix COMMITS are never seeded: no sha was stored, and timing is only a guess.
//   2. THE WRAPPER RULE BY TIMING, until sync fills `review_comments.review_database_id`: an EMPTY
//      COMMENTED review by the reader whose review id no stored comment names, with at least one Limn
//      comment by the reader on the same PR within ±2 s, and NO comment of the reader's own words in
//      that window, is the wrapper GitHub made around Limn's comment → 'review_wrapper'. Only the
//      reader's: a teammate's Limn is recognised by its marker, and its wrappers by sync.
//   3. RE-ATTRIBUTE through the ONE function sync shares (db/limn-bots.ts `reattributeLimnRows`), in
//      PR batches with a yield between them, so the write lock is never held for long.
//
// Every seeded row carries the claim key `history:…` (a push `sha:<sha>`, the key the live writer
// uses), status 'done', its source run, and `detail` 'history'. Seeding is `ON CONFLICT DO NOTHING`
// on the ledger's unique index, so a second run seeds nothing; the re-attribution is idempotent too.
// Done is RECORDED in `instance_meta` (`limn_history_backfill:v1:<accountId>`) only after every batch
// finished; a run stopped by its time limit carries on at the next boot.
//
// ⚠ Runs ONLY with `config.limnAttributeAll` on. Off, the boot reconcile and sync apply the narrow
// finding-era rule, which would hand the moved rows straight back to the person.
import { and, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { LimnActionKind, LimnActionOrigin } from '@pierre-review/shared';
import { isLimnBotLogin } from '@pierre-review/shared';
import { db, runTransaction, schema, type Executor } from './client.js';
import { commentIsLimn, reattributeLimnRows, type LimnLedgerIds } from './limn-bots.js';
import { accountLimnLedger } from './limn-actions.js';
import { config } from '../config.js';

const {
  accounts,
  users,
  pullRequests,
  reviews,
  reviewComments,
  prComments,
  commits,
  limnActions,
  claudeReviews,
  claudeReviewFindings,
  ticketReviewItems,
  claudeStillOpenPosts,
  autoMergeRequests,
  dependencyAutomationActions,
  storyBuildPrs,
  storyBuildRepos,
  aiFixes,
  instanceMeta,
} = schema;

export const LIMN_HISTORY_BACKFILL_VERSION = 1;
/** The recorded flag: one key per account in `instance_meta`. */
export const limnHistoryFlagKey = (accountId: number): string =>
  `limn_history_backfill:v${LIMN_HISTORY_BACKFILL_VERSION}:${accountId}`;

/** The wrapper window: GitHub stamps the wrapper and its comment within the same second or two. */
export const WRAPPER_WINDOW_SEC = 2;
/** How far a "@dependabot rebase" comment may sit from the action row that asked for it. */
export const REBASE_MATCH_WINDOW_SEC = 120;
const REBASE_BODIES = new Set(['@dependabot rebase', '@dependabot recreate']);

const HISTORY = 'history';
const MARKER_LIKE = '%pierre:claude-review%';

/** The ledger rows seeded, by source. A second run reports zeros. */
export interface LimnHistorySeedResult {
  reviews: number;
  findingComments: number;
  ticketComments: number;
  stillOpenReplies: number;
  merges: number;
  pushes: number;
  openedPrs: number;
  rebaseRequests: number;
}

export interface LimnHistoryBackfillResult {
  /** 'done' (recorded), 'already_done', 'stopped' (the time limit; resumes next boot), 'skipped'. */
  status: 'done' | 'already_done' | 'stopped' | 'skipped';
  reason?: string;
  seeded: LimnHistorySeedResult;
  wrappers: number;
  /** PRs looked at / PRs in the candidate set. */
  prsDone: number;
  prsTotal: number;
  moved: { reviews: number; comments: number; threads: number; commits: number; prs: number };
  ms: number;
}

const emptySeed = (): LimnHistorySeedResult => ({
  reviews: 0,
  findingComments: 0,
  ticketComments: 0,
  stillOpenReplies: 0,
  merges: 0,
  pushes: 0,
  openedPrs: 0,
  rebaseRequests: 0,
});

/** The account's own user (by login, the `getAccountUserId` rule), or null. */
export async function accountPersonId(accountId: number, exec: Executor = db): Promise<number | null> {
  const row = (
    await exec
      .select({ id: users.id, login: users.githubLogin })
      .from(accounts)
      .innerJoin(users, eq(users.githubLogin, accounts.githubLogin))
      .where(eq(accounts.id, accountId))
      .limit(1)
      .execute()
  )[0];
  return row && !isLimnBotLogin(row.login) ? row.id : null;
}

interface SeedRow {
  repoId: number;
  prId: number | null;
  prNumber: number | null;
  kind: LimnActionKind;
  claimKey: string;
  origin: LimnActionOrigin;
  githubDatabaseId?: string | null;
  commitSha?: string | null;
  source: { table: string; id: number };
  at: Date | null;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;
const when = (...ds: (Date | null | undefined)[]): Date => ds.find((d): d is Date => d instanceof Date) ?? new Date();

/** Insert seed rows; returns how many were NEW (a row already there — any claim key — is left alone). */
async function insertSeeds(exec: Executor, accountId: number, personId: number, rows: readonly SeedRow[]): Promise<number> {
  let n = 0;
  const now = new Date();
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    if (chunk.length === 0) continue;
    n += (
      await exec
        .insert(limnActions)
        .values(
          chunk.map((r) => ({
            accountId,
            repoId: r.repoId,
            prId: r.prId,
            prNumber: r.prNumber,
            kind: r.kind,
            claimKey: r.claimKey,
            status: 'done' as const,
            origin: r.origin,
            githubDatabaseId: r.githubDatabaseId ?? null,
            commitSha: r.commitSha ? r.commitSha.toLowerCase() : null,
            onBehalfUserId: personId,
            sourceTable: r.source.table,
            sourceId: r.source.id,
            detail: HISTORY,
            at: when(r.at),
            updatedAt: now,
          })),
        )
        .onConflictDoNothing({ target: [limnActions.accountId, limnActions.kind, limnActions.claimKey] })
        .returning({ id: limnActions.id })
        .execute()
    ).length;
  }
  return n;
}

/**
 * Step 1: seed the ledger from the records Limn kept (the table at the top of this file). Exact
 * ids only. DB only, one short transaction; a second run inserts nothing.
 */
export async function seedLimnHistoryLedger(accountId: number): Promise<LimnHistorySeedResult> {
  const out = emptySeed();
  const personId = await accountPersonId(accountId);
  if (personId == null) return out;
  const prOf = and(eq(pullRequests.accountId, accountId));

  // Reviews Limn posted (auto-post, "Review and post", a manual post of the draft).
  const crRows = await db
    .select({
      id: claudeReviews.id,
      prId: claudeReviews.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      postedReviewId: claudeReviews.postedReviewId,
      postedAt: claudeReviews.postedAt,
      finishedAt: claudeReviews.finishedAt,
      trigger: claudeReviews.trigger,
    })
    .from(claudeReviews)
    .innerJoin(pullRequests, and(eq(pullRequests.id, claudeReviews.prId), prOf))
    .where(and(eq(claudeReviews.accountId, accountId), isNotNull(claudeReviews.postedReviewId)))
    .execute();
  const reviewSeeds: SeedRow[] = crRows.map((r) => ({
    repoId: r.repoId,
    prId: r.prId,
    prNumber: r.number,
    kind: 'review',
    claimKey: `${HISTORY}:claude_reviews:${r.id}`,
    origin: r.trigger === 'auto' ? 'auto' : 'reader_pressed',
    githubDatabaseId: r.postedReviewId,
    source: { table: 'claude_reviews', id: r.id },
    at: when(r.postedAt, r.finishedAt),
  }));

  // Finding comments (inline or PR-level).
  const fRows = await db
    .select({
      id: claudeReviewFindings.id,
      prId: claudeReviews.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      commentId: claudeReviewFindings.githubCommentId,
      kind: claudeReviewFindings.postedCommentKind,
      postedAuto: claudeReviewFindings.postedAuto,
      postedAt: claudeReviewFindings.postedAt,
    })
    .from(claudeReviewFindings)
    .innerJoin(claudeReviews, eq(claudeReviews.id, claudeReviewFindings.reviewId))
    .innerJoin(pullRequests, and(eq(pullRequests.id, claudeReviews.prId), prOf))
    .where(and(eq(claudeReviews.accountId, accountId), isNotNull(claudeReviewFindings.githubCommentId)))
    .execute();
  const findingSeeds: SeedRow[] = fRows.map((r) => ({
    repoId: r.repoId,
    prId: r.prId,
    prNumber: r.number,
    kind: r.kind === 'pr_comment' ? 'pr_comment' : 'review_comment',
    claimKey: `${HISTORY}:claude_review_findings:${r.id}`,
    origin: r.postedAuto ? 'auto' : 'reader_pressed',
    githubDatabaseId: r.commentId,
    source: { table: 'claude_review_findings', id: r.id },
    at: r.postedAt,
  }));

  // Ticket-review (story check) items posted on a PR.
  const tRows = await db
    .select({
      id: ticketReviewItems.id,
      prId: ticketReviewItems.postedPrId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      commentId: ticketReviewItems.postedCommentId,
      path: ticketReviewItems.path,
      postedAuto: ticketReviewItems.postedAuto,
      postedAt: ticketReviewItems.postedAt,
    })
    .from(ticketReviewItems)
    .innerJoin(pullRequests, and(eq(pullRequests.id, ticketReviewItems.postedPrId), prOf))
    .where(and(eq(ticketReviewItems.accountId, accountId), isNotNull(ticketReviewItems.postedCommentId)))
    .execute();
  const ticketSeeds: SeedRow[] = tRows.map((r) => ({
    repoId: r.repoId,
    prId: r.prId,
    prNumber: r.number,
    kind: r.path != null ? 'review_comment' : 'pr_comment',
    claimKey: `${HISTORY}:ticket_review_items:${r.id}`,
    origin: r.postedAuto ? 'auto' : 'reader_pressed',
    githubDatabaseId: r.commentId,
    source: { table: 'ticket_review_items', id: r.id },
    at: r.postedAt,
  }));

  // "Still open:" replies.
  const sRows = await db
    .select({
      id: claudeStillOpenPosts.id,
      prId: claudeStillOpenPosts.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      commentId: claudeStillOpenPosts.commentId,
      at: claudeStillOpenPosts.updatedAt,
    })
    .from(claudeStillOpenPosts)
    .innerJoin(pullRequests, and(eq(pullRequests.id, claudeStillOpenPosts.prId), prOf))
    .where(and(eq(claudeStillOpenPosts.accountId, accountId), isNotNull(claudeStillOpenPosts.commentId)))
    .execute();
  const stillOpenSeeds: SeedRow[] = sRows.map((r) => ({
    repoId: r.repoId,
    prId: r.prId,
    prNumber: r.number,
    kind: 'reply',
    claimKey: `${HISTORY}:claude_still_open_posts:${r.id}`,
    origin: 'auto',
    githubDatabaseId: r.commentId,
    source: { table: 'claude_still_open_posts', id: r.id },
    at: r.at,
  }));

  // Merges the watcher landed, and Dependencies' landings: ONE row per PR (the same claim key).
  const mergeKey = (prId: number) => `${HISTORY}:merge:pr:${prId}`;
  const amRows = await db
    .select({
      id: autoMergeRequests.id,
      prId: autoMergeRequests.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      byPolicy: autoMergeRequests.armedByPolicy,
      mergedAt: pullRequests.mergedAt,
      updatedAt: autoMergeRequests.updatedAt,
    })
    .from(autoMergeRequests)
    .innerJoin(pullRequests, and(eq(pullRequests.id, autoMergeRequests.prId), prOf))
    .where(and(eq(autoMergeRequests.accountId, accountId), eq(autoMergeRequests.state, 'merged'), eq(pullRequests.state, 'merged')))
    .execute();
  const depRows = await db
    .select({
      id: dependencyAutomationActions.id,
      prId: dependencyAutomationActions.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      action: dependencyAutomationActions.action,
      state: dependencyAutomationActions.state,
      resultSha: dependencyAutomationActions.resultSha,
      createdAt: dependencyAutomationActions.createdAt,
      updatedAt: dependencyAutomationActions.updatedAt,
      prState: pullRequests.state,
      mergedAt: pullRequests.mergedAt,
    })
    .from(dependencyAutomationActions)
    .innerJoin(pullRequests, and(eq(pullRequests.id, dependencyAutomationActions.prId), prOf))
    .where(eq(dependencyAutomationActions.accountId, accountId))
    .execute();
  const mergeSeeds: SeedRow[] = [
    ...amRows.map(
      (r): SeedRow => ({
        repoId: r.repoId,
        prId: r.prId,
        prNumber: r.number,
        kind: 'merge',
        claimKey: mergeKey(r.prId),
        origin: r.byPolicy ? 'policy' : 'reader_pressed',
        source: { table: 'auto_merge_requests', id: r.id },
        at: when(r.mergedAt, r.updatedAt),
      }),
    ),
    ...depRows
      .filter((r) => r.action === 'merge_landed' && r.state === 'done' && r.prState === 'merged')
      .map(
        (r): SeedRow => ({
          repoId: r.repoId,
          prId: r.prId,
          prNumber: r.number,
          kind: 'merge',
          claimKey: mergeKey(r.prId),
          origin: 'policy',
          source: { table: 'dependency_automation_actions', id: r.id },
          at: when(r.mergedAt, r.updatedAt),
        }),
      ),
  ];

  // Pushes with a sha Limn stored: Dependencies' resolutions / fixes, Implement's pushes.
  const pushKey = (sha: string) => `sha:${sha.toLowerCase()}`;
  const pushSeeds: SeedRow[] = depRows
    .filter((r) => r.state === 'done' && r.resultSha != null && SHA_RE.test(r.resultSha))
    .map((r) => ({
      repoId: r.repoId,
      prId: r.prId,
      prNumber: r.number,
      kind: 'push',
      claimKey: pushKey(r.resultSha!),
      origin: 'policy',
      commitSha: r.resultSha,
      source: { table: 'dependency_automation_actions', id: r.id },
      at: r.updatedAt,
    }));

  // Implement (story build) pushes and the PRs they opened; a PR resolves to its local id when stored.
  const localPrIds = new Map<string, number>();
  const placePr = async (repoId: number, number: number): Promise<number | null> => {
    const k = `${repoId}:${number}`;
    if (!localPrIds.has(k)) {
      const row = (
        await db
          .select({ id: pullRequests.id })
          .from(pullRequests)
          .where(and(eq(pullRequests.accountId, accountId), eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)))
          .limit(1)
          .execute()
      )[0];
      localPrIds.set(k, row?.id ?? -1);
    }
    const id = localPrIds.get(k)!;
    return id === -1 ? null : id;
  };
  const openSeeds: SeedRow[] = [];
  const openKey = (repoId: number, number: number) => `${HISTORY}:open_pr:${repoId}:${number}`;
  const builds = [
    ...(
      await db
        .select({
          id: storyBuildPrs.id,
          repoId: storyBuildPrs.repoId,
          number: storyBuildPrs.pushedPrNumber,
          sha: storyBuildPrs.pushedCommitSha,
          at: storyBuildPrs.pushedAt,
        })
        .from(storyBuildPrs)
        .where(and(eq(storyBuildPrs.accountId, accountId), or(isNotNull(storyBuildPrs.pushedPrNumber), isNotNull(storyBuildPrs.pushedCommitSha))))
        .execute()
    ).map((r) => ({ ...r, table: 'story_build_prs' })),
    ...(
      await db
        .select({
          id: storyBuildRepos.id,
          repoId: storyBuildRepos.repoId,
          number: storyBuildRepos.pushedPrNumber,
          sha: storyBuildRepos.pushedCommitSha,
          at: storyBuildRepos.pushedAt,
        })
        .from(storyBuildRepos)
        .where(and(eq(storyBuildRepos.accountId, accountId), or(isNotNull(storyBuildRepos.pushedPrNumber), isNotNull(storyBuildRepos.pushedCommitSha))))
        .execute()
    ).map((r) => ({ ...r, table: 'story_build_repos' })),
  ];
  for (const b of builds) {
    const prId = b.number != null ? await placePr(b.repoId, b.number) : null;
    if (b.number != null) {
      openSeeds.push({
        repoId: b.repoId,
        prId,
        prNumber: b.number,
        kind: 'open_pr',
        claimKey: openKey(b.repoId, b.number),
        origin: 'reader_pressed',
        source: { table: b.table, id: b.id },
        at: b.at,
      });
    }
    if (b.sha != null && SHA_RE.test(b.sha)) {
      pushSeeds.push({
        repoId: b.repoId,
        prId,
        prNumber: b.number,
        kind: 'push',
        claimKey: pushKey(b.sha),
        origin: 'reader_pressed',
        commitSha: b.sha,
        source: { table: b.table, id: b.id },
        at: b.at,
      });
    }
  }
  // AI Fix on a NEW branch opened a PR (a number other than the fixed PR's). Its commits are not seeded.
  const fixRows = await db
    .select({
      id: aiFixes.id,
      repoId: aiFixes.repoId,
      number: aiFixes.pushedPrNumber,
      sourceNumber: pullRequests.number,
      trigger: aiFixes.trigger,
      at: aiFixes.pushedAt,
    })
    .from(aiFixes)
    .innerJoin(pullRequests, and(eq(pullRequests.id, aiFixes.prId), prOf))
    .where(and(eq(aiFixes.accountId, accountId), isNotNull(aiFixes.pushedPrNumber)))
    .execute();
  for (const f of fixRows) {
    if (f.number == null || f.number === f.sourceNumber) continue;
    openSeeds.push({
      repoId: f.repoId,
      prId: await placePr(f.repoId, f.number),
      prNumber: f.number,
      kind: 'open_pr',
      claimKey: openKey(f.repoId, f.number),
      origin: f.trigger === 'auto' ? 'auto' : 'reader_pressed',
      source: { table: 'ai_fixes', id: f.id },
      at: f.at,
    });
  }

  // "@dependabot rebase" requests: the reader's comment with exactly that body, nearest in time.
  const rebaseSeeds: SeedRow[] = [];
  const rebaseActs = depRows.filter((r) => r.action === 'rebase_request' && r.state === 'done');
  if (rebaseActs.length > 0) {
    const pcs = await db
      .select({ prId: prComments.prId, databaseId: prComments.databaseId, body: prComments.body, createdAt: prComments.createdAt })
      .from(prComments)
      .where(
        and(
          inArray(prComments.prId, [...new Set(rebaseActs.map((a) => a.prId))]),
          sql`coalesce(${prComments.limnPostedByUserId}, ${prComments.authorId}) = ${personId}`,
        ),
      )
      .execute();
    const taken = new Set<string>();
    for (const a of rebaseActs) {
      const at = a.createdAt.getTime();
      let best: { databaseId: string; d: number } | null = null;
      for (const c of pcs) {
        if (c.prId !== a.prId || c.databaseId == null || taken.has(c.databaseId)) continue;
        if (!REBASE_BODIES.has((c.body ?? '').trim().toLowerCase())) continue;
        const d = Math.abs(c.createdAt.getTime() - at);
        if (d <= REBASE_MATCH_WINDOW_SEC * 1000 && (best == null || d < best.d)) best = { databaseId: c.databaseId, d };
      }
      if (!best) continue;
      taken.add(best.databaseId);
      rebaseSeeds.push({
        repoId: a.repoId,
        prId: a.prId,
        prNumber: a.number,
        kind: 'pr_comment',
        claimKey: `${HISTORY}:dependency_automation_actions:${a.id}`,
        origin: 'policy',
        githubDatabaseId: best.databaseId,
        source: { table: 'dependency_automation_actions', id: a.id },
        at: a.createdAt,
      });
    }
  }

  return runTransaction(async (tx) => {
    out.reviews = await insertSeeds(tx, accountId, personId, reviewSeeds);
    out.findingComments = await insertSeeds(tx, accountId, personId, findingSeeds);
    out.ticketComments = await insertSeeds(tx, accountId, personId, ticketSeeds);
    out.stillOpenReplies = await insertSeeds(tx, accountId, personId, stillOpenSeeds);
    out.merges = await insertSeeds(tx, accountId, personId, mergeSeeds);
    out.pushes = await insertSeeds(tx, accountId, personId, pushSeeds);
    out.openedPrs = await insertSeeds(tx, accountId, personId, openSeeds);
    out.rebaseRequests = await insertSeeds(tx, accountId, personId, rebaseSeeds);
    return out;
  });
}

/**
 * Step 2, for a batch of PRs: seed a 'review_wrapper' row for every empty COMMENTED review of the
 * reader's that the timing rule names (top of file). `ledger` decides which comments are Limn's, with
 * the same rule sync uses (`commentIsLimn`, wide). Returns the rows NEW in the ledger.
 */
export async function seedLimnWrapperReviews(
  accountId: number,
  prIds: readonly number[],
  ledger?: LimnLedgerIds,
): Promise<number> {
  if (prIds.length === 0) return 0;
  const personId = await accountPersonId(accountId);
  if (personId == null) return 0;
  const ids: LimnLedgerIds = ledger ?? (await accountLimnLedger(db, accountId));
  const inBatch = inArray(pullRequests.id, [...prIds]);
  const candidates = await db
    .select({
      id: reviews.id,
      prId: reviews.prId,
      repoId: pullRequests.repoId,
      number: pullRequests.number,
      databaseId: reviews.databaseId,
      submittedAt: reviews.submittedAt,
    })
    .from(reviews)
    .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        inBatch,
        eq(reviews.state, 'commented'),
        sql`coalesce(trim(${reviews.body}), '') = ''`,
        isNotNull(reviews.databaseId),
        sql`coalesce(${reviews.limnPostedByUserId}, ${reviews.authorId}) = ${personId}`,
        // Sync already knows this review's comments: the exact wrapper rule (c) decides it.
        sql`not exists (select 1 from review_comments x where x.pr_id = ${reviews.prId} and x.review_database_id = ${reviews.databaseId})`,
      ),
    )
    .execute();
  if (candidates.length === 0) return 0;
  const comments = await db
    .select({
      prId: reviewComments.prId,
      body: reviewComments.body,
      databaseId: reviewComments.databaseId,
      reviewDbId: reviewComments.reviewDatabaseId,
      createdAt: reviewComments.createdAt,
      isRoot: sql<number>`not exists (select 1 from review_comments rc2 where rc2.thread_id = ${reviewComments.threadId} and (rc2.created_at < ${reviewComments.createdAt} or (rc2.created_at = ${reviewComments.createdAt} and rc2.id < ${reviewComments.id})))`,
    })
    .from(reviewComments)
    .where(
      and(
        inArray(reviewComments.prId, [...new Set(candidates.map((c) => c.prId))]),
        sql`coalesce(${reviewComments.limnPostedByUserId}, ${reviewComments.authorId}) = ${personId}`,
      ),
    )
    .execute();
  const byPr = new Map<number, { at: number; limn: boolean; reviewDbId: string | null }[]>();
  for (const c of comments) {
    const list = byPr.get(c.prId) ?? [];
    list.push({
      at: c.createdAt.getTime(),
      reviewDbId: c.reviewDbId,
      limn: commentIsLimn({ body: c.body, databaseId: c.databaseId }, c.isRoot ? 'thread_root' : 'thread_reply', { wide: true, ledger: ids }),
    });
    byPr.set(c.prId, list);
  }
  const seeds: SeedRow[] = [];
  for (const r of candidates) {
    const at = r.submittedAt.getTime();
    const near = (byPr.get(r.prId) ?? []).filter(
      // A comment sync placed in ANOTHER review is not this one's.
      (c) => Math.abs(c.at - at) <= WRAPPER_WINDOW_SEC * 1000 && (c.reviewDbId == null || c.reviewDbId === r.databaseId),
    );
    if (near.length === 0 || !near.every((c) => c.limn)) continue;
    seeds.push({
      repoId: r.repoId,
      prId: r.prId,
      prNumber: r.number,
      kind: 'review_wrapper',
      claimKey: `${HISTORY}:wrapper:${r.databaseId}`,
      origin: 'auto',
      githubDatabaseId: r.databaseId,
      source: { table: 'reviews', id: r.id },
      at: r.submittedAt,
    });
  }
  if (seeds.length === 0) return 0;
  return runTransaction((tx) => insertSeeds(tx, accountId, personId, seeds));
}

/**
 * The PRs the re-attribution must look at: any PR with a marked or already-moved row, an empty
 * commented review (a wrapper candidate), a `Limn-Run:` commit, or a ledger row. Ascending id.
 */
export async function limnHistoryCandidatePrIds(accountId: number): Promise<number[]> {
  const rows = await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        or(
          isNotNull(pullRequests.limnOpenedForUserId),
          isNotNull(pullRequests.limnMergedForUserId),
          sql`exists (select 1 from limn_actions la where la.account_id = ${accountId} and la.pr_id = ${pullRequests.id})`,
          sql`exists (select 1 from reviews r where r.pr_id = ${pullRequests.id} and (r.limn_posted_by_user_id is not null or r.body like ${MARKER_LIKE} or (r.state = 'commented' and coalesce(trim(r.body), '') = '')))`,
          sql`exists (select 1 from review_comments c where c.pr_id = ${pullRequests.id} and (c.limn_posted_by_user_id is not null or c.body like ${MARKER_LIKE}))`,
          sql`exists (select 1 from pr_comments c where c.pr_id = ${pullRequests.id} and (c.limn_posted_by_user_id is not null or c.body like ${MARKER_LIKE}))`,
          sql`exists (select 1 from ${commits} c where c.pr_id = ${pullRequests.id} and (c.limn_pushed_by_user_id is not null or c.message like '%Limn-Run:%'))`,
        ),
      ),
    )
    .orderBy(pullRequests.id)
    .execute();
  return rows.map((r) => r.id);
}

export async function limnHistoryBackfillDone(accountId: number): Promise<boolean> {
  const rows = await db
    .select({ value: instanceMeta.value })
    .from(instanceMeta)
    .where(eq(instanceMeta.key, limnHistoryFlagKey(accountId)))
    .execute();
  return rows.length > 0;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Steps 1–3 for one account. Bounded: stops at `deadlineMs` (the flag stays unwritten, so the next
 * boot carries on — every step is idempotent). `force` runs even when the flag says done (a test, a
 * copy). ⚠ Never call it with `config.limnAttributeAll` off outside a test: the narrow rule would
 * hand the rows back (`kickLimnHistoryBackfill` checks it).
 */
export async function runLimnHistoryBackfill(
  accountId: number,
  opts: { batchSize?: number; yieldMs?: number; deadlineMs?: number; force?: boolean; record?: boolean } = {},
): Promise<LimnHistoryBackfillResult> {
  const t0 = Date.now();
  const batchSize = Math.max(1, opts.batchSize ?? 100);
  const yieldMs = opts.yieldMs ?? 25;
  const deadline = t0 + (opts.deadlineMs ?? 10 * 60_000);
  const moved = { reviews: 0, comments: 0, threads: 0, commits: 0, prs: 0 };
  const base = { seeded: emptySeed(), wrappers: 0, prsDone: 0, prsTotal: 0, moved };
  if (!opts.force && (await limnHistoryBackfillDone(accountId))) {
    return { status: 'already_done', ...base, ms: Date.now() - t0 };
  }
  if ((await accountPersonId(accountId)) == null) {
    return { status: 'skipped', reason: 'the account has no user row yet', ...base, ms: Date.now() - t0 };
  }
  const seeded = await seedLimnHistoryLedger(accountId);
  const prIds = await limnHistoryCandidatePrIds(accountId);
  let wrappers = 0;
  let prsDone = 0;
  for (let i = 0; i < prIds.length; i += batchSize) {
    if (Date.now() > deadline) {
      return { status: 'stopped', reason: 'time limit', seeded, wrappers, prsDone, prsTotal: prIds.length, moved, ms: Date.now() - t0 };
    }
    const batch = prIds.slice(i, i + batchSize);
    const ledger = await accountLimnLedger(db, accountId);
    wrappers += await seedLimnWrapperReviews(accountId, batch, {
      commentIds: ledger.commentIds,
      reviewIds: ledger.reviewIds,
      commitShas: ledger.commitShas,
    });
    const r = await reattributeLimnRows(accountId, { prIds: batch });
    moved.reviews += r.reviews;
    moved.comments += r.comments;
    moved.threads += r.threads;
    moved.commits += r.commits;
    moved.prs += r.prs;
    prsDone += batch.length;
    // Let the sync, the routes and the SPA's writes in between batches.
    if (yieldMs > 0) await pause(yieldMs);
  }
  if (opts.record !== false) {
    const value = JSON.stringify({ at: new Date().toISOString(), seeded, wrappers, moved, prs: prIds.length });
    await db
      .insert(instanceMeta)
      .values({ key: limnHistoryFlagKey(accountId), value })
      .onConflictDoUpdate({ target: instanceMeta.key, set: { value } })
      .execute();
  }
  return { status: 'done', seeded, wrappers, prsDone, prsTotal: prIds.length, moved, ms: Date.now() - t0 };
}

interface Log {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

/**
 * THE BOOT JOB: after listen, never awaited, never fatal, bounded (`runLimnHistoryBackfill`'s time
 * limit). A no-op unless `config.limnAttributeAll` is on, and once the flag is recorded.
 */
export function kickLimnHistoryBackfill(accountId: number | null | undefined, log: Log): void {
  if (accountId == null || !config.limnAttributeAll) return;
  void (async () => {
    try {
      if (await limnHistoryBackfillDone(accountId)) return;
      const r = await runLimnHistoryBackfill(accountId);
      if (r.status === 'done' || r.status === 'stopped') {
        log.info({ limnHistory: r }, r.status === 'done' ? 'limn: history re-attributed' : 'limn: history re-attribution paused at its time limit; the next start carries on');
      }
    } catch (err) {
      log.warn({ err }, 'limn: history re-attribution failed; the next start tries again');
    }
  })();
}
