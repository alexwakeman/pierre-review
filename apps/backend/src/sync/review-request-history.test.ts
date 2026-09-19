// REVIEW-REQUEST HISTORY: what persistReviewRequestHistory writes, and what the one-time backfill
// asks GitHub for. Throwaway sqlite; GitHub is mocked.
//
// What this pins:
//   1. "NOT RECEIVED" WRITES NOTHING — neither rows nor the stamp. A fixture without the selection
//      and a token GitHub nulled it for must not become "never requested" in Chronology.
//   2. An EMPTY list is a positive statement and IS stamped.
//   3. Events are immutable: writing the same history twice leaves one row per event.
//   4. The backfill reads only this account's merged, un-stamped PRs inside the window, writes only
//      PRs its own query returned, and stamps them so they are never fetched again.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-review-request-history-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const gqlCalls: { ids: string[] }[] = [];
let gqlAnswer: (ids: string[]) => unknown = () => ({ nodes: [] });

vi.mock('../auth/account.js', async (orig) => ({
  ...(await orig<object>()),
  getAccessToken: async () => 'test-token',
}));
vi.mock('../github/client.js', async (orig) => ({
  ...(await orig<object>()),
  getGraphqlClientFor: () => ({}),
  graphqlTolerant: async (_c: unknown, _q: string, vars: { ids: string[] }) => {
    gqlCalls.push({ ids: vars.ids });
    return gqlAnswer(vars.ids);
  },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: any;
let backfill: any;
let repoId = 0;
let otherRepoId = 0;
const H = 3_600_000;

async function mkPr(accountId: number, rid: number, n: number, over: Record<string, unknown> = {}): Promise<number> {
  const now = Date.now();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_rr_${accountId}_${n}`,
      accountId,
      repoId: rid,
      number: n,
      title: `pr ${n}`,
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - 10 * 24 * H),
      mergedAt: new Date(now - 9 * 24 * H),
      updatedAt: new Date(now - 9 * 24 * H),
      ...over,
    })
    .returning()
    .execute();
  return pr.id;
}

const requested = (id: string, iso: string, reviewer: unknown) => ({
  __typename: 'ReviewRequestedEvent',
  id,
  createdAt: iso,
  requestedReviewer: reviewer,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  backfill = await import('./backfill-review-requests.js');
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_rr_b', githubLogin: 'rr-b', isLocal: false })
    .execute();
  const [r1] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'rr', githubNodeId: 'R_rr_1' })
    .returning()
    .execute();
  const [r2] = await db
    .insert(schema.repos)
    .values({ accountId: 2, owner: 'other', name: 'rr', githubNodeId: 'R_rr_2' })
    .returning()
    .execute();
  repoId = r1.id;
  otherRepoId = r2.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function eventsOf(prId: number): Promise<any[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.reviewRequestEvents).where(eq(schema.reviewRequestEvents.prId, prId)).execute();
}
async function stampOf(prId: number): Promise<Date | null> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, prId)).execute())[0]
    .reviewRequestsSyncedAt;
}

describe('persistReviewRequestHistory', () => {
  it('writes nothing — not even the stamp — when the selection was not received', async () => {
    const prId = await mkPr(1, repoId, 1);
    const resolver = upsert.createUserResolver();
    await upsert.persistReviewRequestHistory(db, prId, undefined, resolver);
    await upsert.persistReviewRequestHistory(db, prId, null, resolver);
    expect(await eventsOf(prId)).toEqual([]);
    expect(await stampOf(prId)).toBeNull();
  });

  it('stamps an empty list: a positive statement that nobody was asked', async () => {
    const prId = await mkPr(1, repoId, 2);
    await upsert.persistReviewRequestHistory(db, prId, [], upsert.createUserResolver());
    expect(await eventsOf(prId)).toEqual([]);
    expect(await stampOf(prId)).not.toBeNull();
  });

  it('records a person, a team and a withdrawal, once each however often it is written', async () => {
    const prId = await mkPr(1, repoId, 3);
    const nodes = [
      requested('RRE_1', '2026-09-01T10:00:00Z', { __typename: 'User', id: 'U_rev_1', login: 'reviewer-one' }),
      requested('RRE_2', '2026-09-01T10:00:00Z', { __typename: 'Team', id: 'T_1', slug: 'platform' }),
      { __typename: 'ReviewRequestRemovedEvent', id: 'RRE_3', createdAt: '2026-09-01T11:00:00Z', requestedReviewer: { __typename: 'Team', id: 'T_1', slug: 'platform' } },
      requested('RRE_4', '2026-09-01T12:00:00Z', null),
    ];
    await upsert.persistReviewRequestHistory(db, prId, nodes, upsert.createUserResolver());
    await upsert.persistReviewRequestHistory(db, prId, nodes, upsert.createUserResolver());
    const rows = await eventsOf(prId);
    expect(rows).toHaveLength(4);
    const byNode = Object.fromEntries(rows.map((r: any) => [r.githubNodeId, r]));
    expect(byNode.RRE_1).toMatchObject({ kind: 'requested', reviewerKind: 'user' });
    expect(byNode.RRE_1.reviewerUserId).not.toBeNull();
    expect(byNode.RRE_2).toMatchObject({ kind: 'requested', reviewerKind: 'team', teamSlug: 'platform' });
    expect(byNode.RRE_3).toMatchObject({ kind: 'removed', reviewerKind: 'team' });
    // A reviewer the token could not see is a request, but not a person or a team.
    expect(byNode.RRE_4).toMatchObject({ kind: 'requested', reviewerKind: 'unknown', reviewerUserId: null });
  });
});

describe('backfillReviewRequestHistory', () => {
  it('asks only for this account’s merged, un-stamped PRs in the window, and stamps what it writes', async () => {
    const want = await mkPr(1, repoId, 10);
    const old = await mkPr(1, repoId, 11, { mergedAt: new Date(Date.now() - 200 * 24 * H) });
    const open = await mkPr(1, repoId, 12, { state: 'open', mergedAt: null });
    const foreign = await mkPr(2, otherRepoId, 13);
    const missing = await mkPr(1, repoId, 14);
    gqlCalls.length = 0;
    gqlAnswer = (ids) => ({
      nodes: [
        ...ids
          .filter((id) => id === 'PR_rr_1_10')
          .map((id) => ({
            id,
            reviewRequestHistory: {
              nodes: [requested('RRE_10', '2026-09-02T09:00:00Z', { __typename: 'User', id: 'U_rev_2', login: 'reviewer-two' })],
            },
          })),
        // A node the worklist never asked for must not reach a write.
        { id: 'PR_rr_2_13', reviewRequestHistory: { nodes: [requested('RRE_X', '2026-09-02T09:00:00Z', null)] } },
        // Returned, but with the selection nulled: not received, left for a later walk.
        { id: 'PR_rr_1_14', reviewRequestHistory: null },
      ],
      rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + H).toISOString(), cost: 1 },
    });
    const written = await backfill.backfillReviewRequestHistory(1, repoId);
    const asked = gqlCalls.flatMap((c) => c.ids);
    expect(asked).toContain('PR_rr_1_10');
    expect(asked).toContain('PR_rr_1_14');
    expect(asked).not.toContain('PR_rr_1_11');
    expect(asked).not.toContain('PR_rr_1_12');
    expect(asked).not.toContain('PR_rr_2_13');
    expect(written).toBe(1);
    expect(await eventsOf(want)).toHaveLength(1);
    expect(await stampOf(want)).not.toBeNull();
    expect(await eventsOf(foreign)).toEqual([]);
    expect(await stampOf(foreign)).toBeNull();
    expect(await stampOf(missing)).toBeNull();
    expect(await stampOf(old)).toBeNull();
    expect(await stampOf(open)).toBeNull();

    // A second run does not ask for the stamped PR again.
    gqlCalls.length = 0;
    await backfill.backfillReviewRequestHistory(1, repoId);
    expect(gqlCalls.flatMap((c) => c.ids)).not.toContain('PR_rr_1_10');
  });
});
