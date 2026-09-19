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
//  3. OVERRIDES ONLY, and the echo is WHAT WAS STORED: a sent default is not stored, `null` resets.
//  4. EVERY SWITCH IS DECLARED IN THE BODY SCHEMA. Fastify's ajv strips an undeclared key without a
//     word (the contact-form honeypot defect), so a switch missing from the schema would save as
//     nothing and report success.
//  5. EACH MEANING ERROR 400s WITH THE VALIDATOR'S OWN SENTENCE — the one the form shows.
//  6. A SAVE REACHES THE DAILY BRIEF AT ONCE. Its roll-up counts sit in a five-minute cache; without
//     the route dropping them, "Elsewhere" lines keep counting a type the reader just switched off.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DO_NEXT_PRESETS,
  MY_TURN_SHOW_DEFAULTS,
  MY_TURN_TOGGLES,
  type MyTurnToggle,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-me-my-turn-settings-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

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
  it('start null — "the reader has never chosen", not a stored default', async () => {
    expect((await me()).myTurnSettings).toBeNull();
    expect(await stored()).toBeNull();
  });

  it('store overrides only, echo what was stored, and reach /api/me at once', async () => {
    const res = await put({
      settings: {
        // One real change, beside three values that ARE the defaults.
        show: { watched_repo_pr: true, mention: true },
        trunkScope: 'off',
        weights: DO_NEXT_PRESETS.balanced,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', myTurnSettings: { show: { watched_repo_pr: true } } });
    expect(await stored()).toEqual({ show: { watched_repo_pr: true } });
    // ⚠ THROUGH THE LOCAL ACCOUNT CACHE — the real request hook, not a per-request row read.
    expect((await me()).myTurnSettings).toEqual({ show: { watched_repo_pr: true } });
  });

  it('treat null as a RESET back to the defaults', async () => {
    await put({ settings: { trunkScope: 'all' } });
    const res = await put({ settings: null });
    expect(res.json().myTurnSettings).toBeNull();
    expect(await stored()).toBeNull();
    expect((await me()).myTurnSettings).toBeNull();
  });

  it('store a settings object that equals the defaults as NULL', async () => {
    await put({ settings: { trunkScope: 'maintained' } });
    const res = await put({ settings: { show: { mention: true }, trunkScope: 'off' } });
    expect(res.json().myTurnSettings).toBeNull();
    expect(await stored()).toBeNull();
  });

  it('accept EVERY switch — each is declared in the body schema, so none is silently dropped', async () => {
    const flipped = Object.fromEntries(
      MY_TURN_TOGGLES.map((k: MyTurnToggle) => [k, !MY_TURN_SHOW_DEFAULTS[k]]),
    );
    const res = await put({ settings: { show: flipped } });
    expect(res.statusCode).toBe(200);
    expect(res.json().myTurnSettings.show).toEqual(flipped);
    expect(Object.keys((await stored() as { show: object }).show)).toHaveLength(MY_TURN_TOGGLES.length);
    await put({ settings: null });
  });

  it('never lets an undeclared switch reach the database', async () => {
    const res = await put({ settings: { show: { watched_repo_pr: true, not_a_type: true } } });
    expect(res.statusCode).toBe(200);
    expect(await stored()).toEqual({ show: { watched_repo_pr: true } });
    await put({ settings: null });
  });

  it.each<[string, unknown, string]>([
    ['an unknown scope', { trunkScope: 'everywhere' }, 'Red default branch must be Off, Repos you maintain or Every repo.'],
    ['an unknown type in the order', { order: ['mention', 'nope'] }, '“nope” is not a My Turn card type.'],
    ['a repeated type in the order', { order: ['mention', 'mention'] }, 'Each card type can appear in the order once.'],
    ['a missing weight', { weights: { proximity: 50, stall: 50 } }, 'Set all three weights.'],
    [
      'a weight off the 10% steps',
      { weights: { proximity: 55, stall: 25, relevance: 20 } },
      'Each weight must be 0 to 100%, in steps of 10.',
    ],
    [
      'weights that do not add up',
      { weights: { proximity: 50, stall: 30, relevance: 10 } },
      'The three weights must add up to 100%.',
    ],
  ])('400s %s with the validator\'s sentence, and stores nothing', async (_name, settings, sentence) => {
    await put({ settings: { show: { watched_repo_pr: true } } });
    const res = await put({ settings });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'InvalidMyTurnSettings', message: sentence });
    // The earlier save stands.
    expect(await stored()).toEqual({ show: { watched_repo_pr: true } });
    await put({ settings: null });
  });

  it.each<[unknown, string]>([
    [{}, 'a missing settings key'],
    [{ settings: { show: { mention: 'yes' } } }, 'a switch that is not a boolean'],
    [{ settings: { weights: { proximity: 'half', stall: 30, relevance: 20 } } }, 'a weight that is not a number'],
    // (A bare string for `order` is NOT here: Fastify's ajv runs with `coerceTypes: 'array'` and
    // reads it as a one-item list, which the validator then judges like any other.)
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

  it('drops the cached roll-up counts, so no line counts a type just switched off', async () => {
    const brief = await import('../../db/daily-brief.js');
    await put({ settings: null });
    brief.clearDailyBriefCache();
    // Warm the five-minute cache with the one review request.
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(1);
    expect((await put({ settings: { show: { review_request: false } } })).statusCode).toBe(200);
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(0);
    // And back: a reset is a save like any other.
    expect((await put({ settings: null })).statusCode).toBe(200);
    expect((await brief.getDailyBriefCounts(1, workspaceId)).myTurn).toBe(1);
    brief.clearDailyBriefCache();
  });
});
