// getBotAnalytics — "time to addressed" spans reply | resolve | addressing commit, on a
// THROWAWAY sqlite DB.
//
// The median-to-address column must light up for bots whose threads are handled WITHOUT a human
// reply — i.e. resolved on GitHub, or silently fixed by a later commit (the deepsource pattern).
// Seed one bot with two addressed-but-never-replied threads:
//  • Thread A: likely_addressed, an addressing commit touched its file 3 days after it opened →
//    time-to-addressed = 3d (proves the commit path).
//  • Thread B: resolved 1 day after it opened (resolvedAt) → time-to-addressed = 1d (proves resolve).
// median(1d, 3d) = 2d, and non-null → both mechanisms contribute.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-addressed-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, commits, commitFiles } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_ad', inboxWatch: true })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_ad',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'addressed fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
      updatedAt: new Date(now - DAY),
    })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'deepsource-io', githubNodeId: 'U_ad', isBot: true })
    .returning()
    .execute();

  // Thread A: likely_addressed, opened 10d ago on src/a.ts. No reply, no resolve.
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'AD_A',
      prId: pr.id,
      path: 'src/a.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'likely_addressed',
      originalCommenterId: bot.id,
      createdAt: new Date(now - 10 * DAY),
    })
    .execute();
  // The addressing commit: touches src/a.ts 3 days after the thread opened (7d ago).
  await db
    .insert(commits)
    .values({ sha: 'sha_a', prId: pr.id, committedAt: new Date(now - 7 * DAY) })
    .execute();
  await db.insert(commitFiles).values({ sha: 'sha_a', paths: ['src/a.ts'] }).execute();

  // Thread B: resolved 1 day after it opened (opened 6d ago, resolvedAt 5d ago).
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'AD_B',
      prId: pr.id,
      path: 'src/b.ts',
      line: 1,
      isResolved: true,
      isOutdated: false,
      derivedState: 'resolved',
      originalCommenterId: bot.id,
      createdAt: new Date(now - 6 * DAY),
      resolvedAt: new Date(now - 5 * DAY),
    })
    .execute();
});

afterAll(() => closeDb?.());

describe('getBotAnalytics time-to-addressed (reply | resolve | commit)', () => {
  it('counts a commit-addressed thread AND a resolved thread — neither had a human reply', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14');
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'deepsource')!;
    // median(3d commit-addressed, 1d resolved) = 2d — both mechanisms contributed a sample.
    expect(v.medianAddressedMs).toBe(2 * DAY);
  });
});
