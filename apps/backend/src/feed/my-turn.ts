import { and, eq, gt, inArray, ne } from 'drizzle-orm';
import type { ConsolidatedFeedItem, MyTurnReason, ReasonTag } from '@pierre-review/shared';
import { db, schema } from '../db/client.js';
import { getAccountUserId } from '../auth/account.js';

// "My Turn" participation intelligence — CORE / free. The Consolidated Feed is a plain
// chronological activity stream; this flags each item `isMyTurn` when it's an event on a PR
// the viewer PARTICIPATES in (authored / merged / a requested reviewer / previously reviewed
// or commented on) AND the actor isn't the viewer (your own actions don't need your attention).
//
// This USED to live in the @pierre/pro plugin behind a `feedMyTurn` capability, wired through a
// `registerFyiProvider` seam. It was moved back to open-core: the pull-based "whose turn is it"
// situational-awareness view is the product's wedge, so EVERY tier gets it (a paywalled wedge
// can't drive adoption). The items carry plain defaults (isMyTurn:false / myTurnReasons:[]), so
// an un-flagged item is a valid plain feed row.

interface Participation {
  all: Set<number>;
  authored: Set<number>;
  requested: Set<number>;
  reviewed: Set<number>;
  commented: Set<number>;
  merged: Set<number>;
}

// Participation over a candidate set of ACCOUNT-OWNED PR ids (they come from the account-scoped
// feed): the subset the viewer authored, merged, is a requested reviewer on, or previously
// reviewed / commented on. Isolation rides on prId ∈ the account-owned candidate set, so the
// child tables need no accountId predicate. The sets are broken out to colour the reason pills.
async function resolveParticipation(
  accountId: number,
  localUserId: number | null,
  prIds: number[],
): Promise<Participation> {
  const authored = new Set<number>();
  const requested = new Set<number>();
  const reviewed = new Set<number>();
  const commented = new Set<number>();
  const merged = new Set<number>();
  const all = new Set<number>();
  if (localUserId == null || prIds.length === 0)
    return { all, authored, requested, reviewed, commented, merged };

  const { pullRequests, reviewRequests, reviews, prComments, reviewComments } = schema;

  for (const row of await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.authorId, localUserId),
        inArray(pullRequests.id, prIds),
      ),
    )
    .execute()) {
    authored.add(row.id);
    all.add(row.id);
  }
  // A merge is a strong "I own the outcome of this" signal, so later activity is my turn.
  for (const row of await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.accountId, accountId),
        eq(pullRequests.mergedById, localUserId),
        inArray(pullRequests.id, prIds),
      ),
    )
    .execute()) {
    merged.add(row.id);
    all.add(row.id);
  }
  for (const row of await db
    .select({ prId: reviewRequests.prId })
    .from(reviewRequests)
    .where(and(eq(reviewRequests.userId, localUserId), inArray(reviewRequests.prId, prIds)))
    .execute()) {
    requested.add(row.prId);
    all.add(row.prId);
  }
  for (const row of await db
    .select({ prId: reviews.prId })
    .from(reviews)
    .where(and(eq(reviews.authorId, localUserId), inArray(reviews.prId, prIds)))
    .execute()) {
    reviewed.add(row.prId);
    all.add(row.prId);
  }
  for (const row of await db
    .select({ prId: prComments.prId })
    .from(prComments)
    .where(and(eq(prComments.authorId, localUserId), inArray(prComments.prId, prIds)))
    .execute()) {
    commented.add(row.prId);
    all.add(row.prId);
  }
  for (const row of await db
    .select({ prId: reviewComments.prId })
    .from(reviewComments)
    .where(and(eq(reviewComments.authorId, localUserId), inArray(reviewComments.prId, prIds)))
    .execute()) {
    commented.add(row.prId);
    all.add(row.prId);
  }
  return { all, authored, requested, reviewed, commented, merged };
}

// Ordered reason pills for a my-turn card (most-relevant first; the UI shows the primary).
// Empty when the viewer doesn't participate.
function myTurnReasonsFor(participation: Participation, prId: number | null): MyTurnReason[] {
  if (prId == null) return [];
  const reasons: MyTurnReason[] = [];
  if (participation.requested.has(prId)) reasons.push('requested');
  if (participation.authored.has(prId)) reasons.push('authored');
  if (participation.merged.has(prId)) reasons.push('merged');
  if (participation.reviewed.has(prId)) reasons.push('reviewed');
  if (participation.commented.has(prId)) reasons.push('commented');
  return reasons;
}

// The coarse badge colour: a requested review is "awaiting your review"; activity on your own
// PR is "your PR, new comments"; otherwise none.
function reasonTagFor(participation: Participation, prId: number | null): ReasonTag | null {
  if (prId == null) return null;
  if (participation.requested.has(prId)) return 'awaiting_your_review';
  if (participation.authored.has(prId)) return 'your_pr_new_comments';
  return null;
}

// Flag each feed item `isMyTurn` by the viewer's participation in its PR. Mutates the items in
// place. Runs BEFORE the feed's cap so uncapped my-turn rows survive. Claude Review items stay
// OUT of the my-turn flow (their own lane). No-op when there's no viewer identity (offline /
// not-yet-synced) → the feed stays a plain chronological stream.
export async function enrichMyTurn(
  accountId: number,
  items: ConsolidatedFeedItem[],
): Promise<void> {
  const flaggable = items.filter((i) => i.kind !== 'claude_review');
  const candidatePrIds = [
    ...new Set(flaggable.map((i) => i.prId).filter((x): x is number => x != null)),
  ];
  if (candidatePrIds.length === 0) return;
  const localUserId = await getAccountUserId(accountId);
  if (localUserId == null) return;
  const participation = await resolveParticipation(accountId, localUserId, candidatePrIds);
  for (const it of flaggable) {
    const mine =
      it.prId != null && it.actorId !== localUserId && participation.all.has(it.prId);
    if (!mine) continue;
    it.isMyTurn = true;
    it.myTurnReasons = myTurnReasonsFor(participation, it.prId);
    it.reasonTag = reasonTagFor(participation, it.prId);
  }
}

// How many "My Turn" feed items are NEW since `since` — activity events (all feed types except
// plain commit pushes) after `since`, on a PR the viewer participates in, by someone other than
// the viewer. Drives the Welcome-back banner count (/api/me). Cheap because `since` is normally
// recent. 0 when there's no viewer identity or no matching rows.
export async function countNewMyTurnFeedItems(
  accountId: number,
  since: Date,
): Promise<number> {
  const localUserId = await getAccountUserId(accountId);
  if (localUserId == null) return 0;
  const { events } = schema;
  const rows = await db
    .select({ prId: events.prId, actorId: events.actorId })
    .from(events)
    .where(
      and(
        eq(events.accountId, accountId),
        gt(events.occurredAt, since),
        ne(events.type, 'commit_pushed'),
      ),
    )
    .execute();
  const prIds = [...new Set(rows.map((r) => r.prId).filter((x): x is number => x != null))];
  if (prIds.length === 0) return 0;
  const participation = await resolveParticipation(accountId, localUserId, prIds);
  let n = 0;
  for (const r of rows) {
    if (r.prId != null && r.actorId !== localUserId && participation.all.has(r.prId)) n++;
  }
  return n;
}
