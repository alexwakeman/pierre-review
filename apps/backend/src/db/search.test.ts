// searchPrs — cross-team text search over search_index, on a THROWAWAY sqlite DB. Verifies
// multi-term AND, kind filtering, author (people) matching, the review-comment threadId anchor, and
// LIKE-metacharacter escaping — all through the same portable query cloud (Postgres) runs.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-search-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let searchPrs: any;

const now = new Date();
let prId = 0;
let threadId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ searchPrs } = await import('./search.js'));
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, searchIndex } = schema;
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_s', inboxWatch: true })
    .returning()
    .execute();
  const [author] = await db
    .insert(users)
    .values({ githubLogin: 'alice', displayName: 'Alice Ng', githubNodeId: 'U_s' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_s',
      accountId: 1,
      repoId: repo.id,
      number: 42,
      title: 'Fix the flaky auth retry',
      state: 'open',
      isDraft: false,
      authorId: author.id,
      openedAt: now,
      updatedAt: now,
    })
    .returning()
    .execute();
  prId = pr.id;
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_s',
      prId: pr.id,
      path: 'auth.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: author.id,
      createdAt: now,
    })
    .returning()
    .execute();
  threadId = thread.id;

  await db
    .insert(searchIndex)
    .values([
      { accountId: 1, repoId: repo.id, prId: pr.id, kind: 'pr', refId: pr.id, authorId: author.id, body: 'Fix the flaky auth retry — handles a 50% failure', createdAt: now },
      { accountId: 1, repoId: repo.id, prId: pr.id, kind: 'review_comment', refId: 999, threadId: thread.id, authorId: author.id, body: 'this retry loop needs a jitter backoff', createdAt: now },
      { accountId: 1, repoId: repo.id, prId: pr.id, kind: 'pr_comment', refId: 1001, authorId: author.id, body: 'unrelated chit chat about lunch', createdAt: now },
    ])
    .execute();
});

afterAll(() => closeDb?.());

describe('searchPrs', () => {
  it('matches a body substring and returns the PR context', async () => {
    const r = await searchPrs(1, { query: 'jitter', repoIds: null, limit: 25, offset: 0 });
    expect(r.total).toBe(1);
    expect(r.hits[0].kind).toBe('review_comment');
    expect(r.hits[0].prNumber).toBe(42);
    expect(r.hits[0].repoFullName).toBe('acme/api');
  });

  it('a review_comment hit carries its threadId for deep-linking', async () => {
    const r = await searchPrs(1, { query: 'jitter', repoIds: null, limit: 25, offset: 0 });
    expect(r.hits[0].threadId).toBe(threadId);
  });

  it('ANDs multiple terms (all must appear in one row)', async () => {
    const both = await searchPrs(1, { query: 'flaky auth', repoIds: null, limit: 25, offset: 0 });
    expect(both.hits.some((h: any) => h.kind === 'pr')).toBe(true);
    // "flaky" and "lunch" never co-occur in one row → no hit.
    const neither = await searchPrs(1, { query: 'flaky lunch', repoIds: null, limit: 25, offset: 0 });
    expect(neither.total).toBe(0);
  });

  it('matches by author login/display name and surfaces People', async () => {
    const byLogin = await searchPrs(1, { query: 'alice', repoIds: null, limit: 25, offset: 0 });
    expect(byLogin.total).toBeGreaterThan(0); // every row is authored by alice
    expect(byLogin.people.some((p: any) => p.login === 'alice')).toBe(true);
  });

  it('filters by kind', async () => {
    const prsOnly = await searchPrs(1, { query: 'retry', repoIds: null, kinds: ['pr'], limit: 25, offset: 0 });
    expect(prsOnly.hits.every((h: any) => h.kind === 'pr')).toBe(true);
  });

  it('is scoped: an empty repo set returns nothing', async () => {
    const none = await searchPrs(1, { query: 'jitter', repoIds: [], limit: 25, offset: 0 });
    expect(none.total).toBe(0);
  });

  it('escapes LIKE metacharacters (a literal % is not a wildcard)', async () => {
    // '50%' exists in the PR body; a bare '%' must match literally, not as a wildcard.
    const pct = await searchPrs(1, { query: '50%', repoIds: null, limit: 25, offset: 0 });
    expect(pct.hits.some((h: any) => h.kind === 'pr')).toBe(true);
    // '%%%' (all wildcards if unescaped) must NOT match everything.
    const wild = await searchPrs(1, { query: 'zzz%%%zzz', repoIds: null, limit: 25, offset: 0 });
    expect(wild.total).toBe(0);
  });

  it('backfill indexes un-indexed PRs but never clobbers already-indexed ones', async () => {
    const { backfillSearchIndex } = await import('./search.js');
    const { repos, pullRequests, searchIndex } = schema;
    const [repo] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_s2', inboxWatch: true })
      .returning()
      .execute();
    const [pr2] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_s2',
        accountId: 1,
        repoId: repo.id,
        number: 7,
        title: 'Add a widget dashboard',
        state: 'open',
        isDraft: false,
        openedAt: now,
        updatedAt: now,
      })
      .returning()
      .execute();
    // PR (#42) already has 3 manually-seeded rows; PR2 (#7) has none.
    const before = (await db.select().from(searchIndex).execute()) as any[];
    const pr1Before = before.filter((r) => r.prId === prId).length;
    expect(pr1Before).toBe(3);

    await backfillSearchIndex();

    const after = (await db.select().from(searchIndex).execute()) as any[];
    // Already-indexed PR untouched (no clobber, no duplicate).
    expect(after.filter((r) => r.prId === prId).length).toBe(3);
    // Un-indexed PR2 now searchable from its title.
    expect(after.some((r) => r.prId === pr2.id)).toBe(true);
    const found = await searchPrs(1, { query: 'widget', repoIds: null, limit: 25, offset: 0 });
    expect(found.hits.some((h: any) => h.prNumber === 7)).toBe(true);
  });
});
