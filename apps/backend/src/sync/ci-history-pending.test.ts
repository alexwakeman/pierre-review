// The persisted "CI-history backfill still owed" stamp (migration 0156), on a THROWAWAY sqlite DB:
// the column exists after migrations, and mark / read / list / clear touch only the named repo.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ci-history-pending-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let pending: typeof import('./ci-history-pending.js');
const repoIds: number[] = [];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  pending = await import('./ci-history-pending.js');
  const db: any = client.db;
  const { repos, syncState } = client.schema as any;
  for (const n of ['a', 'b']) {
    const [repo] = await db
      .insert(repos)
      .values({ accountId: 1, owner: 'o', name: n, githubNodeId: `R_cihp_${n}` })
      .returning()
      .execute();
    repoIds.push(repo.id);
    await db.insert(syncState).values({ repoId: repo.id, lastFullSyncAt: new Date() }).execute();
  }
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ci-history pending stamp', () => {
  it('marks, reads, lists and clears one repo at a time', async () => {
    const [a, b] = repoIds as [number, number];
    expect(await pending.isCiHistoryPending(a)).toBe(false);
    expect(await pending.listCiHistoryPendingRepoIds()).toEqual([]);

    await pending.markCiHistoryPending(a);
    expect(await pending.isCiHistoryPending(a)).toBe(true);
    expect(await pending.isCiHistoryPending(b)).toBe(false);
    expect(await pending.listCiHistoryPendingRepoIds()).toEqual([a]);

    await pending.clearCiHistoryPending(a);
    expect(await pending.isCiHistoryPending(a)).toBe(false);
    expect(await pending.listCiHistoryPendingRepoIds()).toEqual([]);
  });
});
