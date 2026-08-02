// getBotAnalytics dormant-row emission, on a THROWAWAY sqlite DB. Seeds one bot reviewer
// (coderabbitai) whose only thread is 40 days old (inside the 12-week trend span, outside
// every rolling window) plus a body-only submitted review 20 days ago, then asserts the
// three time semantics reconcile: rolling_30 sees the review → a NON-dormant row with
// zeroed thread/comment counts; rolling_14 sees nothing in-window → a DORMANT row that
// still carries the trend + lastActiveAt (instead of vanishing from the table).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-dormant-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
// BotScope { workspaceId, repoIds } — `workspaceId` decides who counts as a bot, `repoIds`
// narrows the measured data. Resolved through the production resolver in beforeAll.
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS, so a millisecond-bearing
// date wouldn't round-trip and the lastActiveAt equality below would fail.
const now = Math.floor(Date.now() / 1000) * 1000;
const reviewAt = new Date(now - 20 * DAY); // in rolling_30, out of rolling_14
const threadAt = new Date(now - 40 * DAY); // in the 84-day trend span, out of every window

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviews } = schema;

  // account 1 exists (migration 0008). One repo + one PR.
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_bd' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_bd',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'dormant fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 45 * DAY),
      updatedAt: new Date(now - 20 * DAY),
    })
    .returning()
    .execute();

  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_bd', isBot: true })
    .returning()
    .execute();

  // The bot's only thread: 40 days old — trend-span activity, zero window activity.
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'BD_T1',
      prId: pr.id,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: bot.id,
      createdAt: threadAt,
    })
    .execute();

  // A body-only submitted review (no inline threads) 20 days ago — window activity for
  // rolling_30 only; must NOT enter the thread/comment volume math.
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'BD_RV1',
      prId: pr.id,
      authorId: bot.id,
      state: 'commented',
      submittedAt: reviewAt,
    })
    .execute();

  // A second bot whose ONLY footprint is that same-age body-only review — zero threads
  // anywhere in the trend span. Its row must survive on the review alone (the original
  // fixture's thread masked this: the trend-survival leg was threads-only).
  const [reviewsOnlyBot] = await db
    .insert(users)
    .values({ githubLogin: 'greptile-apps', githubNodeId: 'U_bd2', isBot: true })
    .returning()
    .execute();
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'BD_RV2',
      prId: pr.id,
      authorId: reviewsOnlyBot.id,
      state: 'commented',
      submittedAt: reviewAt,
    })
    .execute();

  // ⚠ Resolve the scope through `resolveWorkspaceScope`, never by hand-building
  // `{workspaceId, repoIds}` — that call runs `ensureRepoMemberships`, which is what puts a repo
  // inserted straight into `repos` into the account's Default workspace. Hand-build it and the
  // seeded repo belongs to no workspace, `getBotAnalytics` short-circuits on the empty scope, and
  // "vendors is empty" would look like a dormancy bug rather than a missing membership.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('getBotAnalytics dormant emission', () => {
  it('rolling_14: zero window activity → a dormant row riding the trend, not a dropped one', async () => {
    expect(scope.repoIds).toHaveLength(1); // the emptiness below must be dormancy, not an empty scope
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    expect(resp.vendors).toHaveLength(2);
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit')!;
    expect(v.dormant).toBe(true);
    expect(v.threads).toBe(0);
    expect(v.comments).toBe(0);
    // lastActiveAt = the newest trend-span activity (the review beats the older thread).
    expect(v.lastActiveAt).toBe(reviewAt.toISOString());
    // The 12-week trend still carries the 40-day-old thread.
    expect(v.trend.reduce((s: number, p: { threads: number }) => s + p.threads, 0)).toBe(1);
    // Dormant rows contribute nothing to the window totals.
    expect(resp.totals.threads).toBe(0);
  });

  it('rolling_14: a reviews-ONLY bot (zero threads ever) survives as dormant on the review alone', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'greptile')!;
    expect(v).toBeDefined();
    expect(v.dormant).toBe(true);
    expect(v.threads).toBe(0);
    expect(v.trend.reduce((s: number, p: { threads: number }) => s + p.threads, 0)).toBe(0);
    expect(v.lastActiveAt).toBe(reviewAt.toISOString());
  });

  it('rolling_30: a body-only review is window activity → non-dormant, volume math unchanged', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_30', scope);
    expect(resp.vendors).toHaveLength(2);
    for (const v of resp.vendors) {
      expect(v.dormant).toBe(false);
      // Reviews gate emission/dormancy only — thread/comment volume stays zero.
      expect(v.threads).toBe(0);
      expect(v.comments).toBe(0);
      expect(v.lastActiveAt).toBe(reviewAt.toISOString());
    }
  });
});
