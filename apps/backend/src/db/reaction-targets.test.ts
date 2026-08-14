// `resolveReactionTargets` on a THROWAWAY sqlite DB — the cross-account IDOR guarantee for the
// emoji-reaction routes.
//
// WHY THIS FILE EXISTS. The reaction routes take (kind, LOCAL id) pairs from a client and turn
// them into GitHub node ids that are then spent against the account's GraphQL budget. If that
// resolution were not accountId-scoped, the route would be BOTH an existence oracle over another
// tenant's GitHub content AND a way to make one account pay for reads of another's. The three
// comment tables carry NO accountId of their own — they reach their tenant through `pr_id` —
// so the join IS the isolation, and a join is precisely the kind of thing a later refactor
// "simplifies" away. `verify:isolation` iterates its own hard-coded list of getters and does not
// know about this one, so the guarantee is pinned here instead.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReactionTargetRef } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-reaction-targets-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let resolveReactionTargets: (
  accountId: number,
  targets: ReactionTargetRef[],
) => Promise<Array<{ kind: string; id: number; nodeId: string; prId: number }>>;
let resolveReactionTarget: (
  accountId: number,
  target: ReactionTargetRef,
) => Promise<{ nodeId: string } | null>;

interface Seeded {
  accountId: number;
  reviewCommentId: number;
  prCommentId: number;
  reviewId: number;
}

// One account with one repo, one PR and one of each reactable kind.
async function seedAccount(tag: string): Promise<Seeded> {
  const {
    accounts,
    repos,
    pullRequests,
    reviewThreads,
    reviewComments,
    prComments,
    reviews,
  } = schema;
  const at = new Date();
  const [account] = await db
    .insert(accounts)
    .values({ githubUserId: `U_${tag}`, githubLogin: `login_${tag}` })
    .returning()
    .execute();
  const [repo] = await db
    .insert(repos)
    .values({
      accountId: account.id,
      owner: `o_${tag}`,
      name: `r_${tag}`,
      githubNodeId: `R_${tag}`,
    })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: account.id,
      repoId: repo.id,
      number: 1,
      title: `pr ${tag}`,
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: `RT_${tag}`,
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      createdAt: at,
    })
    .returning()
    .execute();
  const [reviewComment] = await db
    .insert(reviewComments)
    .values({
      githubNodeId: `PRRC_${tag}`,
      threadId: thread.id,
      prId: pr.id,
      createdAt: at,
    })
    .returning()
    .execute();
  const [prComment] = await db
    .insert(prComments)
    .values({ githubNodeId: `IC_${tag}`, prId: pr.id, createdAt: at })
    .returning()
    .execute();
  const [review] = await db
    .insert(reviews)
    .values({
      githubNodeId: `PRR_${tag}`,
      prId: pr.id,
      state: 'commented',
      submittedAt: at,
    })
    .returning()
    .execute();
  return {
    accountId: account.id,
    reviewCommentId: reviewComment.id,
    prCommentId: prComment.id,
    reviewId: review.id,
  };
}

let mine: Seeded;
let theirs: Seeded;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ resolveReactionTargets, resolveReactionTarget } = await import('./reaction-targets.js'));
  await runMigrations();
  mine = await seedAccount('mine');
  theirs = await seedAccount('theirs');
});

afterAll(() => closeDb?.());

describe('resolveReactionTargets', () => {
  it('resolves all three kinds to their GitHub node ids', async () => {
    const rows = await resolveReactionTargets(mine.accountId, [
      { kind: 'review_comment', id: mine.reviewCommentId },
      { kind: 'pr_comment', id: mine.prCommentId },
      { kind: 'review', id: mine.reviewId },
    ]);
    expect(rows.map((r) => r.nodeId).sort()).toEqual(['IC_mine', 'PRRC_mine', 'PRR_mine']);
  });

  // THE guarantee. Another tenant's ids resolve to NOTHING — not an error, not a 404, and
  // above all not a node id we would then hand to GitHub on this account's quota.
  it('returns nothing for another account rows, in every kind', async () => {
    const rows = await resolveReactionTargets(mine.accountId, [
      { kind: 'review_comment', id: theirs.reviewCommentId },
      { kind: 'pr_comment', id: theirs.prCommentId },
      { kind: 'review', id: theirs.reviewId },
    ]);
    expect(rows).toEqual([]);
  });

  // A mixed batch must not leak on the strength of one legitimate id — the foreign ones are
  // dropped individually, the owned one survives.
  it('drops only the foreign ids from a mixed batch', async () => {
    const rows = await resolveReactionTargets(mine.accountId, [
      { kind: 'review_comment', id: mine.reviewCommentId },
      { kind: 'review_comment', id: theirs.reviewCommentId },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nodeId).toBe('PRRC_mine');
  });

  // The three ids live in three SEPARATE id spaces, so a bare number means nothing on its own.
  // Naming an id under the wrong kind must not resolve to whatever row happens to share the
  // number in another table.
  it('does not cross id spaces when the kind is wrong', async () => {
    // Look up this account's review-comment id AS a pr_comment. It may or may not collide
    // numerically; either way the answer must never be the review comment's node id.
    const rows = await resolveReactionTargets(mine.accountId, [
      { kind: 'pr_comment', id: mine.reviewCommentId },
    ]);
    expect(rows.every((r) => r.nodeId !== 'PRRC_mine')).toBe(true);
  });

  it('ignores non-positive and non-integer ids instead of querying for them', async () => {
    const rows = await resolveReactionTargets(mine.accountId, [
      { kind: 'review_comment', id: 0 },
      { kind: 'review_comment', id: -1 },
      { kind: 'review_comment', id: 1.5 },
    ]);
    expect(rows).toEqual([]);
  });

  it('single-target convenience mirrors the batch, including the foreign case', async () => {
    await expect(
      resolveReactionTarget(mine.accountId, {
        kind: 'review',
        id: mine.reviewId,
      }),
    ).resolves.toMatchObject({ nodeId: 'PRR_mine' });
    await expect(
      resolveReactionTarget(mine.accountId, {
        kind: 'review',
        id: theirs.reviewId,
      }),
    ).resolves.toBeNull();
  });
});
