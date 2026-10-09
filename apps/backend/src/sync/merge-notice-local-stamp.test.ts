// A merge made INSIDE Limn (merge button, auto-merge watcher, "Merge or arm all", the dependency
// policy) stamps `state='merged'` through `markPrMergedLocally` BEFORE any walk. The walk that
// follows reads `prev.state === 'merged'`, so without a recorded observation the Slack "Pull
// request merged" signal never fired for any of them. Pinned on a throwaway sqlite DB.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-merge-notice-local-stamp-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let notice: typeof import('./merge-notice.js');
let prId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('../db/queries.js');
  notice = await import('./merge-notice.js');
  await runMigrations();
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_stamp' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_stamp',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'deps: bump',
      state: 'open',
      isDraft: false,
      openedAt: new Date(Date.now() - 3_600_000),
      updatedAt: new Date(Date.now() - 60_000),
    })
    .returning()
    .execute();
  prId = pr.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('a merge stamped locally is a live merge observation', () => {
  beforeEach(() => notice.resetMergeNoticesForTest());

  it('stamped merged locally, then walked: announced once', async () => {
    await q.markPrMergedLocally(prId, 1, null);
    const args = { accountId: 1, prId, prevState: 'merged', mergedAt: new Date() };
    expect(notice.isLiveMergeObservation(args)).toBe(true);
    expect(notice.isLiveMergeObservation(args)).toBe(false);
  });

  it("another account's stamp on a PR it does not own records nothing", async () => {
    await q.markPrMergedLocally(prId, 2, null);
    expect(
      notice.isLiveMergeObservation({ accountId: 2, prId, prevState: 'merged', mergedAt: new Date() }),
    ).toBe(false);
  });
});
