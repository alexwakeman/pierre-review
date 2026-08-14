// Emoji reactions — the ONLY database work the feature does.
//
// Reactions are never stored. This module exists for exactly one reason: turn the
// (kind, LOCAL id) pairs a client sends into GitHub node ids, and do it through a join that
// is scoped by accountId — so tenancy is STRUCTURAL rather than a check some handler has to
// remember.
//
// Why local ids on the wire at all, when GitHub's mutation wants a node id?
//   • An unvalidated node-id list would be BOTH an existence oracle over other tenants' GitHub
//     content AND a way to spend this account's GitHub quota on arbitrary nodes. Resolving
//     local ids removes the class: a client cannot name an id it does not own, because the
//     join simply returns nothing.
//   • The local ids are already on CommentDetail / PrCommentDetail / ReviewDetail, so no read
//     payload had to grow a field and no getter had to change.
//
// The three kinds live in THREE SEPARATE ID SPACES (`review_comments`, `pr_comments`,
// `reviews`) — the same hazard `ml_comment_labels` documents — so every lookup carries the
// kind and the three are queried separately. A bare numeric id means nothing on its own.

import { and, eq, inArray } from 'drizzle-orm';
import type { ReactionTargetKind, ReactionTargetRef } from '@pierre-review/shared';
import { db, schema } from './client.js';

const { pullRequests, prComments, reviewComments, reviews } = schema;

export interface ResolvedReactionTarget extends ReactionTargetRef {
  /** The GitHub node id — the `subjectId` of addReaction/removeReaction. */
  nodeId: string;
  /** The owning PR, carried so a caller can log/attribute without a second lookup. */
  prId: number;
}

/**
 * Resolve a batch of (kind, local id) pairs to GitHub node ids, scoped to `accountId`.
 *
 * A pair that does not resolve — unknown id, wrong kind, another tenant's row — is simply
 * ABSENT from the result. It is never an error and never a 404: distinguishing "does not
 * exist" from "is not yours" is the oracle this design avoids, and the client's honest
 * rendering for both is the same (no reaction bar).
 *
 * Three indexed `IN` lookups at most, and only for the kinds actually present.
 */
export async function resolveReactionTargets(
  accountId: number,
  targets: ReactionTargetRef[],
): Promise<ResolvedReactionTarget[]> {
  const byKind = new Map<ReactionTargetKind, Set<number>>();
  for (const t of targets) {
    if (!Number.isInteger(t.id) || t.id <= 0) continue;
    let set = byKind.get(t.kind);
    if (!set) {
      set = new Set<number>();
      byKind.set(t.kind, set);
    }
    set.add(t.id);
  }

  const out: ResolvedReactionTarget[] = [];

  const reviewCommentIds = byKind.get('review_comment');
  if (reviewCommentIds && reviewCommentIds.size > 0) {
    const rows = await db
      .select({
        id: reviewComments.id,
        nodeId: reviewComments.githubNodeId,
        prId: reviewComments.prId,
      })
      .from(reviewComments)
      // The comment tables carry no accountId of their own — they reach their tenant through
      // pr_id, exactly as ml_comment_labels' cleanup does. The join IS the isolation.
      .innerJoin(pullRequests, eq(pullRequests.id, reviewComments.prId))
      .where(
        and(
          eq(pullRequests.accountId, accountId),
          inArray(reviewComments.id, [...reviewCommentIds]),
        ),
      )
      .execute();
    for (const r of rows) {
      out.push({ kind: 'review_comment', id: r.id, nodeId: r.nodeId, prId: r.prId });
    }
  }

  const prCommentIds = byKind.get('pr_comment');
  if (prCommentIds && prCommentIds.size > 0) {
    const rows = await db
      .select({ id: prComments.id, nodeId: prComments.githubNodeId, prId: prComments.prId })
      .from(prComments)
      .innerJoin(pullRequests, eq(pullRequests.id, prComments.prId))
      .where(
        and(eq(pullRequests.accountId, accountId), inArray(prComments.id, [...prCommentIds])),
      )
      .execute();
    for (const r of rows) {
      out.push({ kind: 'pr_comment', id: r.id, nodeId: r.nodeId, prId: r.prId });
    }
  }

  const reviewIds = byKind.get('review');
  if (reviewIds && reviewIds.size > 0) {
    const rows = await db
      .select({ id: reviews.id, nodeId: reviews.githubNodeId, prId: reviews.prId })
      .from(reviews)
      .innerJoin(pullRequests, eq(pullRequests.id, reviews.prId))
      .where(and(eq(pullRequests.accountId, accountId), inArray(reviews.id, [...reviewIds])))
      .execute();
    for (const r of rows) {
      out.push({ kind: 'review', id: r.id, nodeId: r.nodeId, prId: r.prId });
    }
  }

  return out;
}

/** Single-target convenience for the write route. `null` ⇒ unknown or not this account's. */
export async function resolveReactionTarget(
  accountId: number,
  target: ReactionTargetRef,
): Promise<ResolvedReactionTarget | null> {
  const rows = await resolveReactionTargets(accountId, [target]);
  return rows[0] ?? null;
}
