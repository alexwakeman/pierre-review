// Retention-sweep test on a THROWAWAY sqlite DB. Seeds an OLD PR (updatedAt beyond the
// window) and a RECENT PR, each with the FK-trickiest children (a review thread + a
// comment that FK BOTH the thread and the PR, plus an event), then asserts pruneOldData
// deletes the old PR's whole subtree (no FK violation) and leaves the recent one intact.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection + read env
// at module load), so every host module is pulled in via dynamic import inside beforeAll.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-retention-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let pruneOldData: (log: any, retentionDays?: number) => Promise<number>;
let eq: any;

const DAY = 24 * 60 * 60 * 1000;
const log = { info() {}, warn() {}, error() {} } as any;

async function seedPr(tag: string, updatedAt: Date): Promise<number> {
  const { accounts, repos, pullRequests, events, reviewThreads, reviewComments } = schema;
  // account 1 exists (migration 0008); one repo per PR keeps the seed simple.
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: `o_${tag}`, name: `r_${tag}`, githubNodeId: `R_${tag}` })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: `pr ${tag}`,
      state: 'open',
      isDraft: false,
      openedAt: updatedAt,
      updatedAt,
    })
    .returning()
    .execute();
  await db
    .insert(events)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr.id,
      type: 'pr_opened',
      occurredAt: updatedAt,
      dedupeKey: `pr_opened:${tag}`,
    })
    .execute();
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: `RT_${tag}`,
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      createdAt: updatedAt,
    })
    .returning()
    .execute();
  await db
    .insert(reviewComments)
    .values({
      githubNodeId: `RC_${tag}`,
      threadId: thread.id,
      prId: pr.id,
      createdAt: updatedAt,
    })
    .execute();
  return pr.id;
}

async function countFor(prId: number): Promise<{
  prs: number;
  events: number;
  threads: number;
  comments: number;
}> {
  const { pullRequests, events, reviewThreads, reviewComments } = schema;
  const c = async (t: any, col: any) =>
    (await db.select().from(t).where(eq(col, prId)).execute()).length;
  return {
    prs: await c(pullRequests, pullRequests.id),
    events: await c(events, events.prId),
    threads: await c(reviewThreads, reviewThreads.prId),
    comments: await c(reviewComments, reviewComments.prId),
  };
}

let oldPrId = 0;
let recentPrId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ pruneOldData } = await import('./retention.js'));
  ({ eq } = await import('drizzle-orm'));
  await runMigrations();
  const now = Date.now();
  oldPrId = await seedPr('old', new Date(now - 200 * DAY)); // beyond a 180d window
  recentPrId = await seedPr('recent', new Date(now - 10 * DAY)); // well inside
});

afterAll(() => closeDb?.());

describe('pruneOldData', () => {
  it('prunes the old PR + its whole subtree, keeps the recent one', async () => {
    const before = { old: await countFor(oldPrId), recent: await countFor(recentPrId) };
    expect(before.old).toEqual({ prs: 1, events: 1, threads: 1, comments: 1 });

    const pruned = await pruneOldData(log, 180);
    expect(pruned).toBe(1);

    // Old PR + every child gone (FK-safe; no throw).
    expect(await countFor(oldPrId)).toEqual({ prs: 0, events: 0, threads: 0, comments: 0 });
    // Recent PR fully intact.
    expect(await countFor(recentPrId)).toEqual({
      prs: 1,
      events: 1,
      threads: 1,
      comments: 1,
    });
  });

  it('is a no-op when retention is disabled (0)', async () => {
    expect(await pruneOldData(log, 0)).toBe(0);
    expect((await countFor(recentPrId)).prs).toBe(1);
  });
});
