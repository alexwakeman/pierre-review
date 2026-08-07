// The legacy NULL-body write-back (hydrate-detail's writeBackNullBodies, driven through
// backfillPrNullBodies), on a THROWAWAY sqlite DB with only the GitHub boundary mocked — the
// SQL is the thing under test, because the whole feature is a set of WHERE clauses:
//
//   • only `body IS NULL` rows are touched (a stored body is NEVER overwritten),
//   • only a REAL STRING from GitHub is written (graphqlTolerant NULLs forbidden selections,
//     and null-over-null must not count as a repair),
//   • `diffHunk` stays untouched (lean-gated on purpose),
//   • a repaired row becomes an ML candidate — the badge-less-comment symptom this exists for.
import { rmSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-hydrate-backfill-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

vi.mock('../auth/account.js', () => ({ getAccessToken: vi.fn(async () => 'tok') }));
vi.mock('../github/client.js', () => ({
  getGraphqlClientFor: vi.fn(() => ({})),
  graphqlTolerant: vi.fn(),
  isSamlBlock: () => false,
  graphqlChecksHint: () => '',
  summarizeGraphqlErrors: () => '',
}));
vi.mock('./upsert.js', () => ({ checkRunsFrom: () => [] }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let hydrate: typeof import('./hydrate-detail.js');
let mlLabels: any;
let queries: any;
let mockGraphql: any;

let scope: { workspaceId: number; repoIds: number[] };
let prId = 0;
let botId = 0;
let rcNullId = 0; // NULL body, GitHub has text  → repaired
let rcKeptId = 0; // stored body                 → untouched even though GitHub differs
let pcNullId = 0; // NULL body, GitHub has text  → repaired
let rvNullId = 0; // NULL body, GitHub has text  → repaired
let rvForbiddenId = 0; // NULL body, GraphQL NULLED the selection → stays NULL

// The PR node the mocked PR_DETAIL_QUERY answers with. `RV_forbidden`'s body is null exactly
// as graphqlTolerant leaves a forbidden selection.
const ghNode = {
  repository: {
    pullRequest: {
      body: 'pr body',
      reviews: {
        nodes: [
          { id: 'RV_null', body: 'review body from github' },
          { id: 'RV_forbidden', body: null },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            comments: {
              nodes: [
                { id: 'RC_null', body: 'inline comment from github', diffHunk: '@@ -1 +1 @@' },
                { id: 'RC_kept', body: 'github moved on', diffHunk: null },
              ],
            },
          },
        ],
      },
      comments: { nodes: [{ id: 'PC_null', body: 'pr comment from github' }] },
      commits: { nodes: [] },
      headCommit: { nodes: [] },
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      files: { nodes: [] },
    },
  },
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mlLabels = await import('../db/ml-labels.js');
  queries = await import('../db/queries.js');
  hydrate = await import('./hydrate-detail.js');
  const gh = await import('../github/client.js');
  mockGraphql = vi.mocked(gh.graphqlTolerant);
  mockGraphql.mockResolvedValue(ghNode);

  const at = new Date();
  const { repos, pullRequests, users, reviews, reviewThreads, reviewComments, prComments } =
    schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_hb' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_hb',
      accountId: 1,
      repoId: repo.id,
      number: 7,
      title: 'pr',
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  prId = pr.id;
  const [bot] = await db
    .insert(users)
    .values({ githubNodeId: 'U_hb_bot', githubLogin: 'somebot', isBot: true })
    .returning()
    .execute();
  botId = bot.id;

  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_hb',
      prId,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      originalCommenterId: botId,
      createdAt: at,
    })
    .returning()
    .execute();

  const rc = async (nodeId: string, body: string | null) =>
    (
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: nodeId,
          threadId: thread.id,
          prId,
          authorId: botId,
          body,
          excerpt: 'excerpt',
          createdAt: at,
        })
        .returning()
        .execute()
    )[0].id;
  rcNullId = await rc('RC_null', null);
  rcKeptId = await rc('RC_kept', 'the body sync stored');

  pcNullId = (
    await db
      .insert(prComments)
      .values({ githubNodeId: 'PC_null', prId, authorId: botId, body: null, createdAt: at })
      .returning()
      .execute()
  )[0].id;

  const rv = async (nodeId: string) =>
    (
      await db
        .insert(reviews)
        .values({
          githubNodeId: nodeId,
          prId,
          authorId: botId,
          state: 'commented',
          body: null,
          submittedAt: at,
        })
        .returning()
        .execute()
    )[0].id;
  rvNullId = await rv('RV_null');
  rvForbiddenId = await rv('RV_forbidden');

  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  scope = (await queries.workspaceScopeForRepo(1, repo.id))!;
  await queries.setWorkspaceReviewer(1, botId, {
    workspaceId: scope.workspaceId,
    automated: true,
  });
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('legacy NULL-body write-back', () => {
  it('starts with the rows invisible to pending but counted as unscorable', async () => {
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    // Only the stored-body review comment is scorable work; the four NULLs are not pending.
    expect(rollup.pending).toBe(1);
    expect(rollup.unscorable).toBe(4);
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    expect(candidates.map((c: any) => c.targetId)).toEqual([rcKeptId]);
    // The account-wide backlog (what /api/ml-status serves) agrees.
    expect(await mlLabels.getMlBacklogForAccount(1)).toEqual({
      pending: 1,
      unscorable: 4,
      labelled: 0,
    });
  });

  it('fills exactly the NULLs GitHub still has text for', async () => {
    // RC_null + PC_null + RV_null repaired; RV_forbidden (nulled selection) and RC_kept
    // (stored body) are not.
    expect(await hydrate.backfillPrNullBodies(prId, 1)).toBe(3);

    const { reviewComments, prComments, reviews } = schema;
    const rcRows = await db.select().from(reviewComments).execute();
    const byId = (rows: any[], id: number) => rows.find((r) => r.id === id);
    expect(byId(rcRows, rcNullId).body).toBe('inline comment from github');
    // diffHunk is lean-gated: the write-back must not start persisting it.
    expect(byId(rcRows, rcNullId).diffHunk).toBeNull();
    // A stored body is never overwritten, even when GitHub's current text differs.
    expect(byId(rcRows, rcKeptId).body).toBe('the body sync stored');

    const pcRows = await db.select().from(prComments).execute();
    expect(byId(pcRows, pcNullId).body).toBe('pr comment from github');

    const rvRows = await db.select().from(reviews).execute();
    expect(byId(rvRows, rvNullId).body).toBe('review body from github');
    // POSITIVE-STATEMENT RULE: a nulled selection is "we never received it", not "empty".
    expect(byId(rvRows, rvForbiddenId).body).toBeNull();
  });

  it('moves the repaired rows from unscorable into pending — the honest jump', async () => {
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(rollup.pending).toBe(4);
    // RV_forbidden is all that is left un-storable.
    expect(rollup.unscorable).toBe(1);
    // The worker now sees them: candidacy is what the repair exists to restore.
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    expect(new Set(candidates.map((c: any) => c.targetId))).toEqual(
      new Set([rcNullId, rcKeptId, pcNullId, rvNullId]),
    );
  });

  it('is idempotent — a second run writes nothing', async () => {
    expect(await hydrate.backfillPrNullBodies(prId, 1)).toBe(0);
    const { reviews } = schema;
    const forbidden = (
      await db
        .select()
        .from(reviews)
        .where(and(eq(reviews.id, rvForbiddenId), isNull(reviews.body)))
        .execute()
    );
    expect(forbidden).toHaveLength(1); // still NULL, still not "repaired" to null
  });

  it('returns null for a PR another tenant owns (no write, no fetch reuse)', async () => {
    expect(await hydrate.backfillPrNullBodies(prId, 2)).toBeNull();
  });
});
