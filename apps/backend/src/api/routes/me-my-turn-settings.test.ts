// PUT /api/me/my-turn-settings and its echo on GET /api/me, end to end on a THROWAWAY sqlite DB —
// the sibling of blast-radius-config.test.ts, with one difference that matters: the request hook
// here is the REAL local-mode one (`registerAccountContext`), which serves `req.account` from the
// process's cached local account. So these tests see exactly what the SPA sees after a save.
//
// WHAT THIS PINS:
//  1. THE MIGRATION IS REGISTERED (0068): reading and writing `accounts.my_turn_settings` at all.
//  2. /api/me ECHOES THE SAVE AT ONCE. Without `refreshLocalAccountCache` in the setter, the write
//     route answers correctly and /api/me keeps the value the process booted with — the SPA's
//     `['me']` refetch then reverts the form the user just saved.
//  3. ONE SWITCH: the body is `{ settings: { showNewPrs } }`, stored as the legacy-compatible
//     `{ show: { watched_repo_pr: true } }` (NULL when off), echoed resolved. An old client's body
//     (type switches, an order, weights) 400s rather than saving as nothing.
//  4. A SAVE REACHES THE DAILY BRIEF AT ONCE. Its roll-up counts sit in a five-minute cache; without
//     the route dropping them, "Elsewhere" lines keep counting the survey just switched off.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-me-my-turn-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let eq: any;
let closeDb: (() => Promise<void>) | undefined;

const me = async (): Promise<any> => (await app.inject({ method: 'GET', url: '/api/me' })).json();
const put = async (body: unknown): Promise<any> =>
  app.inject({ method: 'PUT', url: '/api/me/my-turn-settings', payload: body });
/** What the column holds, read past every cache. */
const stored = async (): Promise<unknown> =>
  (
    await db
      .select({ s: schema.accounts.myTurnSettings })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, 1))
      .execute()
  )[0].s;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ eq } = await import('drizzle-orm'));
  await runMigrations();

  // Make the seeded local account "fresh", so `ensureLocalAccount` caches the row without asking
  // `gh api user` — the cache is the thing under test.
  await db
    .update(schema.accounts)
    .set({
      githubUserId: 'U_viewer',
      githubLogin: 'viewer',
      displayName: 'Viewer',
      lastLoginAt: new Date(),
    })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const { ensureLocalAccount } = await import('../../auth/account.js');
  await ensureLocalAccount();

  const { registerAccountContext } = await import('../plugins/auth.js');
  const { meRoutes } = await import('./me.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(meRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the My Turn settings', () => {
  it('start off, with nothing stored', async () => {
    expect((await me()).myTurnSettings).toEqual({ showNewPrs: false });
    expect(await stored()).toBeNull();
  });

  it('store the switch, echo it, and reach /api/me at once', async () => {
    const res = await put({ settings: { showNewPrs: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', myTurnSettings: { showNewPrs: true } });
    expect(await stored()).toEqual({ show: { watched_repo_pr: true } });
    // ⚠ THROUGH THE LOCAL ACCOUNT CACHE — the real request hook, not a per-request row read.
    expect((await me()).myTurnSettings).toEqual({ showNewPrs: true });
  });

  it('drops an undeclared key rather than storing it', async () => {
    const res = await put({ settings: { showNewPrs: true, weights: { proximity: 50, stall: 30, relevance: 20 } } });
    expect(res.statusCode).toBe(200);
    expect(await stored()).toEqual({ show: { watched_repo_pr: true } });
  });

  it('store NULL when switched off, clearing an older blob', async () => {
    await db
      .update(schema.accounts)
      .set({ myTurnSettings: { show: { watched_repo_pr: true, mention: false }, weights: { proximity: 80, stall: 10, relevance: 10 } } })
      .where(eq(schema.accounts.id, 1))
      .execute();
    const res = await put({ settings: { showNewPrs: false } });
    expect(res.json().myTurnSettings).toEqual({ showNewPrs: false });
    expect(await stored()).toBeNull();
    expect((await me()).myTurnSettings).toEqual({ showNewPrs: false });
  });

  it.each<[unknown, string]>([
    [{}, 'a missing settings key'],
    [{ settings: null }, 'a null settings object'],
    [{ settings: {} }, 'a missing switch'],
    [{ settings: { showNewPrs: 'yes' } }, 'a switch that is not a boolean'],
    [{ settings: { show: { watched_repo_pr: true } } }, 'an old client’s type switches'],
  ])('400s a body of the wrong SHAPE: %s', async (body) => {
    expect((await put(body)).statusCode).toBe(400);
  });
});

describe('a save and the daily brief', () => {
  let workspaceId = 0;

  beforeAll(async () => {
    const { users, repos, pullRequests, reviewRequests, events } = schema;
    const DAY = 86_400_000;
    const user = async (login: string) =>
      (
        await db
          .insert(users)
          .values({ githubLogin: login, githubNodeId: `U_mmts_${login}`, isBot: false })
          .returning()
          .execute()
      )[0].id as number;
    const viewer = await user('viewer');
    const alice = await user('alice');
    const bob = await user('bob');
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: 'api',
        githubNodeId: 'R_mmts_api',
        viewerPermission: 'WRITE',
        defaultBranch: 'main',
        createdAt: new Date(Date.now() - 30 * DAY),
      })
      .returning()
      .execute();
    // One summons: alice asked you to review her PR.
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_mmts_1',
        accountId: 1,
        repoId: repo.id,
        number: 1,
        title: 'A PR waiting on you',
        authorId: alice,
        state: 'open',
        isDraft: false,
        openedAt: new Date(Date.now() - 2 * DAY),
        updatedAt: new Date(Date.now() - DAY),
      })
      .returning()
      .execute();
    await db.insert(reviewRequests).values({ prId: pr.id, userId: viewer }).execute();
    // And one PR nobody asked you about — only the survey lists it.
    const [pr2] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_mmts_2',
        accountId: 1,
        repoId: repo.id,
        number: 2,
        title: 'A PR nobody asked you about',
        authorId: bob,
        state: 'open',
        isDraft: false,
        openedAt: new Date(Date.now() - 2 * DAY),
        updatedAt: new Date(Date.now() - DAY),
      })
      .returning()
      .execute();
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: pr2.id,
        type: 'pr_opened',
        occurredAt: new Date(Date.now() - 2 * DAY),
        dedupeKey: 'pr_opened:PR_mmts_2',
      })
      .execute();
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: pr.id,
        type: 'pr_opened',
        occurredAt: new Date(Date.now() - 2 * DAY),
        dedupeKey: 'pr_opened:PR_mmts_1',
      })
      .execute();
    const q = await import('../../db/queries.js');
    await q.ensureDefaultWorkspace(1);
    await q.ensureRepoMemberships(1);
    workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  });

  it('drops the cached roll-up counts, so no line counts the survey just switched off', async () => {
    const brief = await import('../../db/daily-brief.js');
    await put({ settings: { showNewPrs: false } });
    brief.clearDailyBriefCache();
    // Warm the five-minute cache with the one review request.
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(1);
    // The survey on adds bob's untouched PR…
    expect((await put({ settings: { showNewPrs: true } })).statusCode).toBe(200);
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(2);
    // …and off takes it away again.
    expect((await put({ settings: { showNewPrs: false } })).statusCode).toBe(200);
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(1);
    brief.clearDailyBriefCache();
  });
});
