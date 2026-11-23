// AI VENDOR SIGNALS BACKFILL: which PRs it asks GitHub about, and what it writes back
// (docs/AI-ADOPTION-REPORT.md § The backfill). Throwaway sqlite; GitHub is mocked.
//
// What this pins:
//   1. The worklist is this account's PRs in this repo that are open or merged in the last 90 days
//      and unscanned (NULL) or scanned by an older detector — newest first.
//   2. A received node writes the SAME columns persistPr writes, the PR stamped and each stored
//      commit's verdict by (pr_id, sha). A commit the walk never stored is not created.
//   3. "NOT RECEIVED" WRITES NOTHING: a node with bodyText or a commit message nulled stays unstamped.
//      A node the batch never asked for cannot reach a write.
//   4. A PR with more than 100 commits (the connection returns its last 100) is stamped anyway.
//   5. Budget: a limited or low token costs no call; a rate limit is noted and stops the run (never
//      thrown); every response feeds the budget. A PR is asked at most once per process.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_SIGNALS_VERSION } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-signals-backfill-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

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
let backfill: typeof import('./backfill-ai-signals.js');
let budget: typeof import('../github/rate-budget.js');
let repoId = 0;
let otherRepoId = 0;
let foreignRepoId = 0;
let userId = 0;
const DAY = 86_400_000;
const H = 3_600_000;

async function mkPr(accountId: number, rid: number, n: number, over: Record<string, unknown> = {}): Promise<number> {
  const now = Date.now();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_ais_${accountId}_${n}`,
      accountId,
      repoId: rid,
      number: n,
      title: `pr ${n}`,
      authorId: userId,
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 30 * DAY),
      updatedAt: new Date(now - n * 1000),
      ...over,
    })
    .returning()
    .execute();
  return pr.id;
}

async function mkCommit(prId: number, sha: string): Promise<void> {
  await db.insert(schema.commits).values({ prId, sha, committedAt: new Date() }).execute();
}

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, id)).execute())[0];
}

async function commitOf(prId: number, sha: string): Promise<any> {
  const { and, eq } = await import('drizzle-orm');
  return (
    await db
      .select()
      .from(schema.commits)
      .where(and(eq(schema.commits.prId, prId), eq(schema.commits.sha, sha)))
      .execute()
  )[0];
}

function node(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: 'Add retry',
    bodyText: 'Adds a retry.',
    headRefName: 'feature/retry',
    author: { __typename: 'User', login: 'alice' },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'c1',
            message: 'Add retry\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>',
            author: { name: 'Alice', email: 'alice@example.com', user: { login: 'alice' } },
            committer: { name: 'GitHub', email: 'noreply@github.com', user: null },
          },
        },
      ],
    },
    ...over,
  };
}

const RATE = { remaining: 4000, resetAt: new Date(Date.now() + H).toISOString(), cost: 1 };

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  backfill = await import('./backfill-ai-signals.js');
  budget = await import('../github/rate-budget.js');
  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_ais_b', githubLogin: 'ais-b', isLocal: false }).execute();
  const mkRepo = async (accountId: number, name: string): Promise<number> =>
    (
      await db
        .insert(schema.repos)
        .values({ accountId, owner: 'acme', name, githubNodeId: `R_ais_${accountId}_${name}` })
        .returning()
        .execute()
    )[0].id;
  repoId = await mkRepo(1, 'ais');
  otherRepoId = await mkRepo(1, 'ais-other');
  foreignRepoId = await mkRepo(2, 'ais');
  userId = (await db.insert(schema.users).values({ githubLogin: 'alice', isBot: false }).returning().execute())[0].id;
});

beforeEach(() => {
  gqlCalls.length = 0;
  gqlAnswer = () => ({ nodes: [] });
  budget.__resetRateBudget();
  backfill.__aiSignalsBackfillTesting.resetAttempted();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('aiSignalsBackfillWorklist', () => {
  it("lists this account's open or recently merged, unscanned or stale PRs in this repo, newest first", async () => {
    const now = Date.now();
    const want = {
      open: await mkPr(1, repoId, 1),
      merged: await mkPr(1, repoId, 2, { state: 'merged', mergedAt: new Date(now - 10 * DAY) }),
      stale: await mkPr(1, repoId, 3, { aiSignals: '[]', aiSignalsVersion: 0, aiSignalsCheckedAt: new Date() }),
    };
    const not = {
      oldMerge: await mkPr(1, repoId, 4, { state: 'merged', mergedAt: new Date(now - 100 * DAY) }),
      closed: await mkPr(1, repoId, 5, { state: 'closed', closedAt: new Date(now - DAY) }),
      scanned: await mkPr(1, repoId, 6, { aiSignals: '[]', aiSignalsVersion: AI_SIGNALS_VERSION, aiSignalsCheckedAt: new Date() }),
      otherRepo: await mkPr(1, otherRepoId, 7),
      foreign: await mkPr(2, foreignRepoId, 8),
    };
    const ids = (await backfill.aiSignalsBackfillWorklist(1, repoId)).map((r) => r.id);
    for (const [name, id] of Object.entries(want)) expect(ids, name).toContain(id);
    for (const [name, id] of Object.entries(not)) expect(ids, name).not.toContain(id);
    expect(ids[0]).toBe(want.open); // most recently updated
    expect((await backfill.aiSignalsBackfillWorklist(2, foreignRepoId)).map((r) => r.id)).toEqual([not.foreign]);
    expect(await backfill.aiSignalsBackfillWorklist(1, foreignRepoId)).toEqual([]);
  });
});

describe('backfillAiSignals', () => {
  it('stamps what GitHub returned, writes stored commits by sha, and leaves the rest unstamped', async () => {
    const got = await mkPr(1, otherRepoId, 20);
    await mkCommit(got, 'c1');
    const nulled = await mkPr(1, otherRepoId, 21);
    const nulledCommit = await mkPr(1, otherRepoId, 22);
    gqlAnswer = () => ({
      nodes: [
        node('PR_ais_1_20', { headRefName: 'codex/add-retry', bodyText: 'Adds a retry.\n\nhttps://chatgpt.com/codex/tasks/task_e_1' }),
        node('PR_ais_1_21', { bodyText: null }),
        node('PR_ais_1_22', { commits: { nodes: [{ commit: { oid: 'x', message: null } }] } }),
        // Never asked for by this batch: must not reach a write.
        node('PR_ais_2_8'),
      ],
      rateLimit: RATE,
    });
    const stamped = await backfill.backfillAiSignals(1, otherRepoId);
    expect(stamped).toBe(1);
    const row = await rowOf(got);
    expect(JSON.parse(row.aiSignals)).toEqual([
      { vendor: 'codex', source: 'pr_body' },
      { vendor: 'codex', source: 'pr_branch' },
    ]);
    expect(row.aiSignalsVersion).toBe(AI_SIGNALS_VERSION);
    expect(row.aiSignalsCheckedAt).toBeInstanceOf(Date);
    expect(JSON.parse((await commitOf(got, 'c1')).aiSignals)).toEqual([{ vendor: 'cursor', source: 'commit_trailer' }]);
    // Only the commit the walk stored: nothing is created.
    expect(await commitOf(nulled, 'c1')).toBeUndefined();
    expect((await rowOf(nulled)).aiSignalsVersion).toBeNull();
    expect((await rowOf(nulledCommit)).aiSignalsVersion).toBeNull();
    expect(gqlCalls.flatMap((c) => c.ids)).not.toContain('PR_ais_2_8');
    const foreign = (await db.select().from(schema.pullRequests).execute()).find((r: any) => r.githubNodeId === 'PR_ais_2_8');
    expect(foreign.aiSignalsVersion).toBeNull();
  });

  it('asks a PR at most once per process, even when it came back unstamped', async () => {
    // PRs 21 and 22 from the test above are still unstamped; the attempted set was reset.
    gqlAnswer = () => ({ nodes: [], rateLimit: RATE });
    await backfill.backfillAiSignals(1, otherRepoId);
    const first = gqlCalls.flatMap((c) => c.ids);
    expect(first.length).toBeGreaterThan(0);
    gqlCalls.length = 0;
    await backfill.backfillAiSignals(1, otherRepoId);
    expect(gqlCalls).toEqual([]);
  });

  it('stamps a PR whose commit connection is full (more than 100 commits on GitHub)', async () => {
    const big = await mkPr(1, repoId, 30, { state: 'merged', mergedAt: new Date(Date.now() - DAY) });
    const nodes = Array.from({ length: 100 }, (_v, i) => ({
      commit: { oid: `big${i}`, message: i === 99 ? 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' : 'plain', author: null, committer: null },
    }));
    await mkCommit(big, 'big99');
    gqlAnswer = (ids) => ({ nodes: ids.map((id) => (id === 'PR_ais_1_30' ? node(id, { commits: { nodes } }) : null)), rateLimit: RATE });
    await backfill.backfillAiSignals(1, repoId);
    expect((await rowOf(big)).aiSignalsVersion).toBe(AI_SIGNALS_VERSION);
    expect(JSON.parse((await commitOf(big, 'big99')).aiSignals)).toEqual([{ vendor: 'claude', source: 'commit_trailer' }]);
  });

  it('feeds the budget from every response', async () => {
    await mkPr(1, repoId, 40);
    gqlAnswer = () => ({ nodes: [], rateLimit: { remaining: 50, resetAt: new Date(Date.now() + H).toISOString(), cost: 1 } });
    await backfill.backfillAiSignals(1, repoId);
    expect(budget.isBudgetLow(1)).toBe(true);
  });

  it('spends nothing when the token is limited or its budget is low', async () => {
    await mkPr(1, repoId, 41);
    budget.noteLimited(1, new Date(Date.now() + H));
    expect(await backfill.backfillAiSignals(1, repoId)).toBe(0);
    budget.__resetRateBudget();
    budget.noteBudget(1, { remaining: 10, resetAt: new Date(Date.now() + H) });
    expect(await backfill.backfillAiSignals(1, repoId)).toBe(0);
    expect(gqlCalls).toEqual([]);
  });

  it('notes a rate limit and stops at the first limited batch, never throwing it', async () => {
    const { AI_SIGNALS_NODE_BATCH } = backfill.__aiSignalsBackfillTesting;
    for (let n = 100; n < 100 + AI_SIGNALS_NODE_BATCH + 5; n += 1) await mkPr(1, repoId, n);
    gqlAnswer = () => {
      throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    };
    expect(budget.isLimited(1)).toBe(false);
    expect(await backfill.backfillAiSignals(1, repoId)).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    expect(budget.isLimited(1)).toBe(true);
  });

  it('lets a non-rate-limit failure throw — the caller logs it as non-fatal', async () => {
    const id = await mkPr(1, repoId, 50);
    gqlAnswer = () => {
      throw new Error('boom');
    };
    await expect(backfill.backfillAiSignals(1, repoId)).rejects.toThrow('boom');
    expect((await rowOf(id)).aiSignalsVersion).toBeNull();
  });
});
