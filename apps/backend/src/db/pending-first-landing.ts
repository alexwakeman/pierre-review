// ── PENDING ON THE FIRST LANDING (docs/FRONTEND.md § Pending on the first landing) ─────────────
//
// Three additions to `GET /api/attention`, all read from the database in the same request as the
// board — NOTHING ON THE PENDING BOARD MAY FETCH ON MOUNT, so the SPA never asks for them on its own:
//
//   • `summary`        — show the one-line summary over the tabs. True for `PENDING_SUMMARY_DAYS`
//                        after the account's first-onboarding batch (the earliest
//                        `repos.first_onboarding` add). The line's figures are the tabs' own totals;
//                        this decides only whether it shows.
//   • `ownOpenPrs`     — the reader's own open PRs in the workspace, with the synced merge facts, sent
//                        ONLY when every tab is empty, so an empty board can still say where the
//                        reader's work stands. Synced columns only; the SPA reads them through the
//                        PLAIN `mergeVerdict()` (no `blockFacts`): ⚠ the ranked `blockers[]` are PR
//                        detail's alone, so no review, CI or thread facts are sent.
//   • `reviewSuggestion` — the one-time "Review your PR #n with Claude" card: the reader's newest
//                        open, non-draft PR in the workspace. Only while agentic AI is on, the reader
//                        never dismissed it (`accounts.review_suggestion_dismissed_at`) and NO AI
//                        review has ever run for the account (any `claude_reviews` row, any kind,
//                        any status — once one ran, the reader has found the feature). Because no
//                        review has run at all, the PR has none at its head either. Nothing runs
//                        until the reader presses Run.
//   • `docsOffers`     — the docs folders found in the workspace's repositories, waiting for the reader's
//                        yes (reference-docs/repo-offers-store.ts). Only while agentic AI is on; nothing
//                        is built until the reader presses Add.
//
// ⚠ LIVE STATE, like the board: nothing here may enter a payload hash.
import {
  PENDING_OWN_PRS_SHOWN,
  PENDING_SUMMARY_DAYS,
  type MergeStateStatus,
  type Mergeable,
  type PendingOwnPr,
  type PendingReviewSuggestion,
  type PendingTab,
  type RepoDocsOffers,
} from '@pierre-review/shared';
import { and, count, desc, eq, inArray, isNotNull, min, sql } from 'drizzle-orm';
import { db, schema } from './client.js';
import { config } from '../config.js';
import { getAccountUserId } from '../auth/account.js';
import type { BotScope } from './queries.js';
import { docsOffersFor } from '../reference-docs/repo-offers-store.js';

const DAY_MS = 86_400_000;

export interface PendingFirstLanding {
  summary: boolean;
  ownOpenPrs?: PendingOwnPr[];
  ownOpenPrTotal?: number;
  reviewSuggestion: PendingReviewSuggestion | null;
  docsOffers?: RepoDocsOffers | null;
}

/** Is the summary's window open? `firstOnboardingAt` is the earliest first-onboarding add, or null
 *  when the account has none (an install that had repos before the mark existed). Pure. */
export function summaryWindowOpen(firstOnboardingAt: Date | null, now: number): boolean {
  if (firstOnboardingAt == null) return false;
  return now - firstOnboardingAt.getTime() < PENDING_SUMMARY_DAYS * DAY_MS;
}

/** Is every tab empty? The tabs' totals are the board's populations (review load is not counted). */
export function boardIsEmpty(tabs: readonly Pick<PendingTab, 'total'>[]): boolean {
  return tabs.every((t) => t.total === 0);
}

/** May the suggestion show at all? Pure — the PR pick is separate. */
export function reviewSuggestionAllowed(f: {
  aiEnabled: boolean;
  dismissedAt: Date | null;
  anyReviewRan: boolean;
}): boolean {
  return f.aiEnabled && f.dismissedAt == null && !f.anyReviewRan;
}

export async function getPendingFirstLanding(
  accountId: number,
  scope: BotScope,
  tabs: readonly PendingTab[],
  now: number = Date.now(),
): Promise<PendingFirstLanding> {
  const firstRows = await db
    .select({ at: min(schema.repos.createdAt) })
    .from(schema.repos)
    .where(and(eq(schema.repos.accountId, accountId), eq(schema.repos.firstOnboarding, true)))
    .execute();
  // `min()` over a timestamp column comes back raw (seconds) from SQLite — normalise it.
  const rawAt = firstRows[0]?.at as unknown;
  const firstOnboardingAt =
    rawAt == null ? null : rawAt instanceof Date ? rawAt : new Date(Number(rawAt) * 1000);
  const summary = summaryWindowOpen(firstOnboardingAt, now);

  // The docs folders found in the workspace's repositories, waiting for the reader's yes — the same
  // list the Docs page shows. Only where the library exists (agentic AI on).
  const docsOffers = config.aiEnabled ? await docsOffersFor(accountId, scope.workspaceId) : null;

  const userId = await getAccountUserId(accountId);
  if (userId == null || scope.repoIds.length === 0) return { summary, reviewSuggestion: null, docsOffers };

  const out: PendingFirstLanding = { summary, reviewSuggestion: null, docsOffers };
  if (boardIsEmpty(tabs)) {
    const { prs, total } = await ownOpenPrs(accountId, userId, scope.repoIds);
    out.ownOpenPrs = prs;
    out.ownOpenPrTotal = total;
  }
  out.reviewSuggestion = await reviewSuggestion(accountId, userId, scope.repoIds);
  return out;
}

async function ownOpenPrs(
  accountId: number,
  userId: number,
  repoIds: readonly number[],
): Promise<{ prs: PendingOwnPr[]; total: number }> {
  const pr = schema.pullRequests;
  const where = and(
    eq(pr.accountId, accountId),
    inArray(pr.repoId, [...repoIds]),
    eq(pr.authorId, userId),
    eq(pr.state, 'open'),
  );
  const totalRows = await db.select({ n: count() }).from(pr).where(where).execute();
  const total = Number(totalRows[0]?.n ?? 0);
  if (total === 0) return { prs: [], total };
  const rows = await db
    .select({
      id: pr.id,
      repoId: pr.repoId,
      owner: schema.repos.owner,
      name: schema.repos.name,
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.mergeStateStatus,
      inMergeQueue: pr.inMergeQueue,
      openedAt: pr.openedAt,
    })
    .from(pr)
    .innerJoin(schema.repos, eq(schema.repos.id, pr.repoId))
    .where(where)
    .orderBy(desc(pr.openedAt), desc(pr.id))
    .limit(PENDING_OWN_PRS_SHOWN)
    .execute();
  const prs = rows.map((r): PendingOwnPr => {
    return {
      prId: r.id,
      repoId: r.repoId,
      repoFullName: `${r.owner}/${r.name}`,
      number: r.number,
      title: r.title,
      githubUrl: `https://github.com/${r.owner}/${r.name}/pull/${r.number}`,
      isDraft: r.isDraft,
      mergeable: (r.mergeable ?? 'unknown') as Mergeable,
      mergeStateStatus: (r.mergeStateStatus ?? 'unknown') as MergeStateStatus,
      inMergeQueue: r.inMergeQueue === true,
      openedAt: r.openedAt.toISOString(),
    };
  });
  return { prs, total };
}

async function reviewSuggestion(
  accountId: number,
  userId: number,
  repoIds: readonly number[],
): Promise<PendingReviewSuggestion | null> {
  const acct = await db
    .select({ dismissedAt: schema.accounts.reviewSuggestionDismissedAt })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .limit(1)
    .execute();
  const ran = await db
    .select({ id: schema.claudeReviews.id })
    .from(schema.claudeReviews)
    .where(eq(schema.claudeReviews.accountId, accountId))
    .limit(1)
    .execute();
  if (
    !reviewSuggestionAllowed({
      aiEnabled: config.aiEnabled,
      dismissedAt: acct[0]?.dismissedAt ?? null,
      anyReviewRan: ran.length > 0,
    })
  ) {
    return null;
  }
  const pr = schema.pullRequests;
  const rows = await db
    .select({
      id: pr.id,
      owner: schema.repos.owner,
      name: schema.repos.name,
      number: pr.number,
      title: pr.title,
    })
    .from(pr)
    .innerJoin(schema.repos, eq(schema.repos.id, pr.repoId))
    .where(
      and(
        eq(pr.accountId, accountId),
        inArray(pr.repoId, [...repoIds]),
        eq(pr.authorId, userId),
        eq(pr.state, 'open'),
        eq(pr.isDraft, false),
        // A review runs on a head; a PR with none synced yet has nothing to review.
        isNotNull(pr.headSha),
      ),
    )
    .orderBy(desc(pr.openedAt), desc(pr.id))
    .limit(1)
    .execute();
  const r = rows[0];
  if (r == null) return null;
  return {
    prId: r.id,
    repoFullName: `${r.owner}/${r.name}`,
    number: r.number,
    title: r.title,
    budgetUsd: config.reviewBudgetUsd,
  };
}

/** POST /api/me/review-suggestion/dismiss — stamped once; a second press keeps the first time. */
export async function dismissReviewSuggestion(accountId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(schema.accounts)
    .set({ reviewSuggestionDismissedAt: now })
    .where(
      and(
        eq(schema.accounts.id, accountId),
        sql`${schema.accounts.reviewSuggestionDismissedAt} IS NULL`,
      ),
    )
    .execute();
}
