// `POST /api/prs/:id/review-comment` AND its post-write resync tail
// (sync/resync-after-write.ts) on a THROWAWAY sqlite DB (the webhooks.test.ts pattern): env
// is set BEFORE importing config/client, and the real route, real anchoring helpers, real
// query layer and real resync all run — only GitHub (github/mutations.js), the token source,
// the targeted sync and the hydration invalidator are stubbed.
//
// Both layers share ONE file on purpose: each DB-backed test file pays for its own
// `runMigrations()`, and the combined `src/api src/sync` run on a loaded machine already sits
// close to vitest's 10s hook default (see the timeout note on beforeAll).
//
// The point of the suite is the CONTRACT the frontend copy depends on:
//   • posted + confirmed locally  → visible:true + the new thread's local id;
//   • posted but NOT confirmed    → visible:false with a NON-NULL commentId, and a 200 —
//     never an error, because the comment IS on GitHub and a retry would double-post;
//   • nothing posted (no addable diff line / GitHub 422) → commentId null, visible:false;
// plus the ordering the flag rests on (cache busted, then sync, then the verifying SELECT)
// and the account scoping of that SELECT.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-review-comment-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const fetchHeadShaFor = vi.fn(async () => 'headsha');
const fetchPrFilesWithPatch = vi.fn();
const postInlineComment = vi.fn();
// Spread the real module so the exports this route file (and its siblings) don't stub still
// resolve — a bare factory would break every unmocked import.
vi.mock('../../github/mutations.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchHeadShaFor,
  fetchPrFilesWithPatch,
  postInlineComment,
}));
vi.mock('../../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken: vi.fn(async () => 'tok'),
}));

// The targeted sync stands in for "GitHub state came back": a test that wants the comment
// confirmed has it write the row the real persistPr would have written.
const syncOnePr = vi.fn<() => Promise<boolean>>();
vi.mock('../../sync/sync-one-pr.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncOnePr,
}));
// Spied, not exercised (its own behaviour is covered by sync/hydrate-detail.test.ts) — here
// it only has to prove the cache is busted BEFORE the sync runs.
const invalidatePrHydration = vi.fn();
vi.mock('../../sync/hydrate-detail.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidatePrHydration,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let resyncPrAfterWrite: any;
let confirmPostedReviewComment: any;
let findPostedReviewComment: any;
let prId = 0;
let repoId = 0;
let foreignPrId = 0;
let threadId = 0;
let foreignThreadId = 0;

// A header-less REST patch (what GET /pulls/:n/files returns): new-side lines 10-12 are
// addable, so a RIGHT comment on 11 anchors exactly and one on 900 does not.
const PATCH = '@@ -10,2 +10,3 @@\n unchanged\n+added\n unchanged again\n';

const POSTED = { databaseId: 5150, nodeId: 'PRRC_new', url: 'https://github.com/c/1' };

async function post(id: number, body: unknown): Promise<any> {
  return app.inject({
    method: 'POST',
    url: `/api/prs/${id}/review-comment`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

// The row a successful sync would persist for the just-posted comment. `databaseId: null`
// models GraphQL returning no fullDatabaseId; a different id/node models a DIFFERENT comment.
async function insertSyncedComment(
  opts: {
    databaseId?: string | null;
    nodeId?: string;
    onPrId?: number;
    onThreadId?: number;
  } = {},
): Promise<void> {
  await db
    .insert(schema.reviewComments)
    .values({
      githubNodeId: opts.nodeId ?? POSTED.nodeId,
      threadId: opts.onThreadId ?? threadId,
      prId: opts.onPrId ?? prId,
      body: 'nit',
      databaseId:
        opts.databaseId === undefined ? String(POSTED.databaseId) : opts.databaseId,
      createdAt: new Date(),
    })
    .execute();
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();

  const now = new Date();
  const seedPr = async (
    accountId: number,
    owner: string,
    number: number,
  ): Promise<{ repoId: number; prId: number; threadId: number }> => {
    const rid = (
      await db
        .insert(schema.repos)
        .values({ accountId, owner, name: 'api', githubNodeId: `R_${owner}` })
        .returning({ id: schema.repos.id })
        .execute()
    )[0].id;
    const pid = (
      await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_${owner}`,
          accountId,
          repoId: rid,
          number,
          title: 'a pr',
          state: 'open',
          openedAt: now,
          updatedAt: now,
          headSha: 'headsha',
        })
        .returning({ id: schema.pullRequests.id })
        .execute()
    )[0].id;
    const tid = (
      await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: `PRRT_${owner}`,
          prId: pid,
          path: 'src/a.ts',
          line: 11,
          isResolved: false,
          derivedState: 'untouched',
          createdAt: now,
        })
        .returning({ id: schema.reviewThreads.id })
        .execute()
    )[0].id;
    return { repoId: rid, prId: pid, threadId: tid };
  };

  // Account 1 (the migration-seeded local account) owns the PR under test; account 2 owns a
  // mirror-image one, which is what keeps the isolation checks below from passing vacuously.
  ({ repoId, prId, threadId } = await seedPr(1, 'acme', 7));
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  ({ prId: foreignPrId, threadId: foreignThreadId } = await seedPr(2, 'other', 9));

  ({ resyncPrAfterWrite, confirmPostedReviewComment, findPostedReviewComment } =
    await import('../../sync/resync-after-write.js'));
  const { prRoutes } = await import('./prs.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  await app.register(prRoutes);
  await app.ready();
  // Generous: this hook runs the real migrations and loads the whole query layer + route
  // tree, which is a few seconds on a cold transform — past vitest's 10s hook default.
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  fetchHeadShaFor.mockResolvedValue('headsha');
  fetchPrFilesWithPatch.mockResolvedValue({
    files: [{ filename: 'src/a.ts', patch: PATCH, additions: 1, deletions: 0 }],
    truncated: false,
  });
  postInlineComment.mockResolvedValue(POSTED);
  await db.delete(schema.reviewComments).execute();
});

describe('POST /api/prs/:id/review-comment', () => {
  it('reports the comment VISIBLE once the resync has landed its row, with its thread id', async () => {
    syncOnePr.mockImplementation(async () => {
      await insertSyncedComment();
      return true;
    });

    const res = await post(prId, { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      commentId: POSTED.databaseId,
      url: POSTED.url,
      line: 11,
      side: 'RIGHT',
      anchored: true,
      visible: true,
      threadId,
    });
    // The resync ran AFTER the post — the route must never resync a comment it hasn't sent.
    expect(postInlineComment).toHaveBeenCalledTimes(1);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
  });

  it('still reports the comment POSTED (200, commentId set) when the resync fails', async () => {
    // The failure path that matters most: the comment is on GitHub, our mirror is behind.
    // A 502/422-style answer here would tell the user to retry and double-post.
    syncOnePr.mockRejectedValue(new Error('github down'));

    const res = await post(prId, { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      commentId: POSTED.databaseId,
      url: POSTED.url,
      anchored: true,
      visible: false,
      threadId: null,
    });
  });

  it('re-anchors to the first changed line when the requested line is not in the diff', async () => {
    syncOnePr.mockImplementation(async () => {
      await insertSyncedComment();
      return true;
    });

    const res = await post(prId, { path: 'src/a.ts', line: 900, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(200);
    // firstAdded on this patch is new-side line 11.
    expect(res.json()).toMatchObject({
      anchored: false,
      line: 11,
      side: 'RIGHT',
      visible: true,
    });
  });

  it('posts nothing when the file has no addable diff line', async () => {
    fetchPrFilesWithPatch.mockResolvedValue({ files: [], truncated: false });

    const res = await post(prId, { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      commentId: null,
      url: null,
      line: 11,
      side: 'RIGHT',
      anchored: false,
      visible: false,
      threadId: null,
    });
    expect(postInlineComment).not.toHaveBeenCalled();
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  it('maps a GitHub 422 to the structured "couldn’t place" result, not an error', async () => {
    postInlineComment.mockRejectedValue(
      new Error('POST /repos/acme/api/pulls/7/comments -> 422 Unprocessable Entity'),
    );

    const res = await post(prId, { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      commentId: null,
      url: null,
      line: 11,
      side: 'RIGHT',
      anchored: false,
      visible: false,
      threadId: null,
    });
    // Nothing was posted, so nothing was resynced.
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  it('502s when GitHub fails for any other reason (the post genuinely didn’t happen)', async () => {
    postInlineComment.mockRejectedValue(new Error('POST … -> 500 Server Error'));

    const res = await post(prId, { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'nit' });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('GitHubError');
  });

  it('404s on another account’s PR without touching GitHub', async () => {
    const res = await post(foreignPrId, {
      path: 'src/a.ts',
      line: 11,
      side: 'RIGHT',
      body: 'nit',
    });

    expect(res.statusCode).toBe(404);
    expect(postInlineComment).not.toHaveBeenCalled();
  });
});

describe('resyncPrAfterWrite', () => {
  it('busts the hydration cache BEFORE running the sync, and joins an in-flight run', async () => {
    const order: string[] = [];
    invalidatePrHydration.mockImplementation(() => order.push('invalidate'));
    syncOnePr.mockImplementation(async () => {
      order.push('sync');
      return true;
    });

    await expect(resyncPrAfterWrite({ prId, accountId: 1, log })).resolves.toBe(true);

    // Order is load-bearing: a sync failure must not be able to leave a pre-write snapshot
    // cacheable for the client's follow-up GET.
    expect(order).toEqual(['invalidate', 'sync']);
    expect(invalidatePrHydration).toHaveBeenCalledWith(1, 'acme', 'api', 7);
    // waitForInFlight is what closes the race: a sync already running for this PR may have
    // read GitHub BEFORE our write, so we queue behind it and fetch ourselves.
    expect(syncOnePr).toHaveBeenCalledWith(repoId, 7, expect.anything(), {
      waitForInFlight: true,
    });
  });

  it('still busts the cache when the sync throws, and never throws itself', async () => {
    syncOnePr.mockRejectedValue(new Error('github down'));

    await expect(resyncPrAfterWrite({ prId, accountId: 1, log })).resolves.toBe(false);
    expect(invalidatePrHydration).toHaveBeenCalledTimes(1);
  });

  it('is account-scoped: a foreign PR id resolves to nothing (no sync, no invalidation)', async () => {
    syncOnePr.mockResolvedValue(true);

    await expect(
      resyncPrAfterWrite({ prId: foreignPrId, accountId: 1, log }),
    ).resolves.toBe(false);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(invalidatePrHydration).not.toHaveBeenCalled();

    // …and the PR is genuinely resyncable by ITS owner, so the above isn't passing because
    // the row is missing.
    await expect(
      resyncPrAfterWrite({ prId: foreignPrId, accountId: 2, log }),
    ).resolves.toBe(true);
  });
});

describe('confirmPostedReviewComment', () => {
  const confirm = (): Promise<unknown> =>
    confirmPostedReviewComment({
      prId,
      accountId: 1,
      githubDatabaseId: String(POSTED.databaseId),
      githubNodeId: POSTED.nodeId,
      log,
    });

  it('verifies AFTER the sync: a row the sync writes is reported visible, with its thread', async () => {
    // The sync is the only thing that writes the row, so `visible:true` can only mean the
    // SELECT ran after the write — not before it, and not alongside it.
    syncOnePr.mockImplementation(async () => {
      await insertSyncedComment();
      return true;
    });

    await expect(confirm()).resolves.toEqual({ visible: true, threadId });
  });

  it('reports NOT visible when the sync no-ops', async () => {
    // The comment is on GitHub, our mirror is behind. The route must be told visible:false
    // so the copy never claims the thread is on screen — and never that the post failed.
    syncOnePr.mockResolvedValue(false);

    await expect(confirm()).resolves.toEqual({ visible: false, threadId: null });
  });

  it('reports NOT visible when the sync succeeds but the comment is not in the page', async () => {
    // Real case, not a bug: the targeted query pages reviewThreads(first: 50), so on a
    // bot-flooded PR the new thread may not come back at all.
    syncOnePr.mockResolvedValue(true);

    await expect(confirm()).resolves.toEqual({ visible: false, threadId: null });
  });
});

describe('findPostedReviewComment', () => {
  const dbId = String(POSTED.databaseId);

  it('matches on the numeric database id', async () => {
    await insertSyncedComment();
    await expect(
      findPostedReviewComment(prId, 1, dbId, 'PRRC_some_other_node'),
    ).resolves.toEqual({ id: expect.any(Number), threadId });
  });

  it('falls back to the node id when database_id was not stored', async () => {
    // REST's numeric id and GraphQL's fullDatabaseId are the same value, but a null
    // fullDatabaseId must not leave `visible` permanently false with no error anywhere.
    await insertSyncedComment({ databaseId: null });
    await expect(
      findPostedReviewComment(prId, 1, dbId, POSTED.nodeId),
    ).resolves.toEqual({ id: expect.any(Number), threadId });
  });

  it('does not match a different comment on the same PR', async () => {
    await insertSyncedComment({ databaseId: '999', nodeId: 'PRRC_other' });
    await expect(
      findPostedReviewComment(prId, 1, dbId, POSTED.nodeId),
    ).resolves.toBeNull();
  });

  it('never finds another account’s comment (and the check is not vacuous)', async () => {
    await insertSyncedComment({ onPrId: foreignPrId, onThreadId: foreignThreadId });

    // The same row, asked for by its owner: found. By the neighbour: null.
    await expect(
      findPostedReviewComment(foreignPrId, 2, dbId, POSTED.nodeId),
    ).resolves.not.toBeNull();
    await expect(
      findPostedReviewComment(foreignPrId, 1, dbId, POSTED.nodeId),
    ).resolves.toBeNull();
  });
});
