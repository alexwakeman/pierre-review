// searchPrs — cross-workspace text search over search_index, on a THROWAWAY sqlite DB. Verifies
// multi-term AND, kind filtering, author (people) matching, the review-comment threadId anchor, and
// LIKE-metacharacter escaping — all through the same portable query cloud (Postgres) runs.
//
// ⚠ `SearchOpts.repoIds` IS A CONCRETE `number[]` AND IS NEVER NULL. It used to carry the
// `number[] | null` tri-state where `null` meant "every repo the account has"; under the workspace
// model the caller has already resolved the active workspace's membership (intersected with any
// explicit `?repoIds=` narrow) before it gets here, and `[]` means "this workspace is empty" rather
// than "unscoped". That sentinel is exactly how a scope resolving to zero repos silently widened to
// the whole account, so these tests pass real repo ids everywhere and pin the empty case as
// returning nothing.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-search-test.sqlite`;
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
// The seeded workspace's repo membership — the concrete list every call passes.
let repoIds: number[] = [];

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
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_s' })
    .returning()
    .execute();
  repoIds = [repo.id];
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
    const r = await searchPrs(1, { query: 'jitter', repoIds, limit: 25, offset: 0 });
    expect(r.total).toBe(1);
    expect(r.hits[0].kind).toBe('review_comment');
    expect(r.hits[0].prNumber).toBe(42);
    expect(r.hits[0].repoFullName).toBe('acme/api');
  });

  it('a review_comment hit carries its threadId for deep-linking', async () => {
    const r = await searchPrs(1, { query: 'jitter', repoIds, limit: 25, offset: 0 });
    expect(r.hits[0].threadId).toBe(threadId);
  });

  it('ANDs multiple terms (all must appear in one row)', async () => {
    const both = await searchPrs(1, { query: 'flaky auth', repoIds, limit: 25, offset: 0 });
    expect(both.hits.some((h: any) => h.kind === 'pr')).toBe(true);
    // "flaky" and "lunch" never co-occur in one row → no hit.
    const neither = await searchPrs(1, { query: 'flaky lunch', repoIds, limit: 25, offset: 0 });
    expect(neither.total).toBe(0);
  });

  it('matches by author login/display name and surfaces People', async () => {
    const byLogin = await searchPrs(1, { query: 'alice', repoIds, limit: 25, offset: 0 });
    expect(byLogin.total).toBeGreaterThan(0); // every row is authored by alice
    expect(byLogin.people.some((p: any) => p.login === 'alice')).toBe(true);
  });

  it('filters by kind', async () => {
    const prsOnly = await searchPrs(1, { query: 'retry', repoIds, kinds: ['pr'], limit: 25, offset: 0 });
    expect(prsOnly.hits.every((h: any) => h.kind === 'pr')).toBe(true);
  });

  // The two halves of the "no null sentinel" contract. `[]` is a real answer ("the active
  // workspace has no repos"), NOT a request to search everything — under the old tri-state the
  // caller collapsed an empty scope to `null` and got the whole account back.
  it('is scoped: an empty repo set returns nothing (an empty workspace, not "all repos")', async () => {
    const none = await searchPrs(1, { query: 'jitter', repoIds: [], limit: 25, offset: 0 });
    expect(none.total).toBe(0);
  });

  it('is scoped: a repo outside the list is not searched', async () => {
    // The seeded hit lives in `repoIds[0]`; scoping to any other repo must not reach it.
    const elsewhere = await searchPrs(1, { query: 'jitter', repoIds: [999_999], limit: 25, offset: 0 });
    expect(elsewhere.total).toBe(0);
  });

  it('escapes LIKE metacharacters (a literal % is not a wildcard)', async () => {
    // '50%' exists in the PR body; a bare '%' must match literally, not as a wildcard.
    const pct = await searchPrs(1, { query: '50%', repoIds, limit: 25, offset: 0 });
    expect(pct.hits.some((h: any) => h.kind === 'pr')).toBe(true);
    // '%%%' (all wildcards if unescaped) must NOT match everything.
    const wild = await searchPrs(1, { query: 'zzz%%%zzz', repoIds, limit: 25, offset: 0 });
    expect(wild.total).toBe(0);
  });

  it('backfill indexes un-indexed PRs but never clobbers already-indexed ones', async () => {
    const { backfillSearchIndex } = await import('./search.js');
    const { repos, pullRequests, searchIndex } = schema;
    const [repo] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_s2' })
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
    // Un-indexed PR2 now searchable from its title — but only once its repo is IN SCOPE. The
    // second repo is deliberately not in `repoIds`, so this also pins that a freshly-indexed row
    // outside the scope stays invisible.
    expect(after.some((r) => r.prId === pr2.id)).toBe(true);
    const outOfScope = await searchPrs(1, { query: 'widget', repoIds, limit: 25, offset: 0 });
    expect(outOfScope.total).toBe(0);
    const found = await searchPrs(1, {
      query: 'widget',
      repoIds: [...repoIds, repo.id],
      limit: 25,
      offset: 0,
    });
    expect(found.hits.some((h: any) => h.prNumber === 7)).toBe(true);
  });
});

describe('findStories — the Stories facet (ticket matches lead the search)', () => {
  let findStories: any;
  let otherRepoId = 0;
  beforeAll(async () => {
    ({ findStories } = await import('./search.js'));
    const { repos, pullRequests, trackerTickets } = schema;
    const [other] = await db.insert(repos).values({ accountId: 1, owner: 'acme', name: 'stories-web', githubNodeId: 'R_t' }).returning().execute();
    otherRepoId = other.id;
    const [merged] = await db
      .insert(pullRequests)
      .values({ githubNodeId: 'PR_t1', accountId: 1, repoId: repoIds[0], number: 43, title: 'BMD-1051 part two', state: 'merged', isDraft: false, openedAt: now, updatedAt: now })
      .returning()
      .execute();
    const [elsewhere] = await db
      .insert(pullRequests)
      .values({ githubNodeId: 'PR_t2', accountId: 1, repoId: other.id, number: 7, title: 'BMD-1099 web', state: 'open', isDraft: false, openedAt: now, updatedAt: now })
      .returning()
      .execute();
    const row = (pr: number, key: string, title: string) => ({
      accountId: 1, workspaceId: 1, prId: pr, provider: 'jira', issueKey: key, detectedFrom: 'title', detectOrder: 0,
      apiRoot: 'https://acme.atlassian.net', url: `https://acme.atlassian.net/browse/${key}`, state: 'ok', title, statusName: 'In Progress',
      checkedAt: now, nextCheckAt: now,
    });
    await db.insert(trackerTickets).values([
      row(prId, 'BMD-1051', 'Strategic significance import'),
      row(merged.id, 'BMD-1051', 'Strategic significance import'),
      row(prId, 'BMD-10512', 'A longer key'),
      row(merged.id, 'BMD-2000', 'Handle null import data'),
      row(elsewhere.id, 'BMD-1099', 'Outside the searched repos'),
    ]).execute();
  });

  it('puts the exact key first, counts its PRs once each, and builds the story ident', async () => {
    const s = await findStories(1, repoIds, null, 'bmd-1051');
    expect(s.map((x: any) => [x.key, x.match])).toEqual([['BMD-1051', 'key'], ['BMD-10512', 'key_prefix']]);
    expect(s[0]).toMatchObject({ ident: 'jira:https://acme.atlassian.net#BMD-1051', prCount: 2, openPrCount: 1, status: 'In Progress' });
  });
  it('matches a title for a 3+ character query, after any key match', async () => {
    const s = await findStories(1, repoIds, null, 'null import');
    expect(s.map((x: any) => [x.key, x.match])).toEqual([['BMD-2000', 'title']]);
  });
  it('never reaches a ticket only named by a PR outside the searched repos', async () => {
    expect(await findStories(1, repoIds, null, 'BMD-1099')).toEqual([]);
    expect((await findStories(1, [otherRepoId], null, 'BMD-1099')).map((x: any) => x.key)).toEqual(['BMD-1099']);
    expect(await findStories(2, repoIds, null, 'BMD-1051')).toEqual([]);
  });
  it('rides searchPrs on the first page only', async () => {
    const first = await searchPrs(1, { query: 'BMD-1051', repoIds, limit: 25, offset: 0 });
    expect(first.stories[0]?.key).toBe('BMD-1051');
    const later = await searchPrs(1, { query: 'BMD-1051', repoIds, limit: 25, offset: 25 });
    expect(later.stories).toEqual([]);
  });
});
