// THE RELEASE SCAN'S PR AND TICKET STEPS (sync/release-scan.ts; docs/RELEASES.md § Automatic candidate,
// acceptance 39–40): range PR numbers with no stored row are synced through the single-PR path, oldest
// tag first, bounded per run and budget-aware; a PR GitHub does not give is remembered (it holds its
// tag) and asked again later; the PRs whose tickets are not read are queued for the tracker worker.
// A THROWAWAY sqlite DB; `syncOnePr` and the tracker are stubbed through `deps`.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-scan-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let client: any;
let m: typeof import('./release-scan.js');
let scan: typeof import('../releases/scan-state.js');
let repoId = 0;
const sha = (c: string) => c.padEnd(40, '0');
const day = (d: number) => new Date(Date.UTC(2026, 10, d, 12));

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  m = await import('./release-scan.js');
  scan = await import('../releases/scan-state.js');
  const { repos, repoTags, repoTagRanges } = client.schema;
  const [repo] = await client.db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_scan_api', defaultBranchName: 'main' })
    .returning()
    .execute();
  repoId = repo.id;
  const tag = (name: string, d: number) => ({ accountId: 1, repoId, name, sha: sha(name), committedAt: day(d), onDefaultBranch: true, firstSeenAt: day(d), lastSeenAt: day(d) });
  await client.db.insert(repoTags).values([tag('v1.0.0', 1), tag('v1.1.0', 3)]).execute();
  const range = (tagName: string, prNumbers: number[]) => ({
    accountId: 1,
    repoId,
    tagName,
    sha: sha(tagName),
    method: 'compare',
    prNumbers,
    commitCount: prNumbers.length,
    unmatchedCommits: 0,
    truncated: false,
    computedAt: day(9),
  });
  // Stored newest first on purpose: the fetch order is the TAG order, oldest first.
  await client.db.insert(repoTagRanges).values([range('v1.1.0', [5, 3]), range('v1.0.0', [2, 1])]).execute();
});

beforeEach(async () => {
  scan.__resetScanState();
  const { __resetRateBudget } = await import('../github/rate-budget.js');
  __resetRateBudget();
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const storePr = async (number: number) => {
  await client.db
    .insert(client.schema.pullRequests)
    .values({
      githubNodeId: `PR_scan_${number}`,
      accountId: 1,
      repoId,
      number,
      title: `change ${number}`,
      state: 'merged',
      isDraft: false,
      openedAt: day(1),
      updatedAt: day(1),
      mergedAt: day(1),
      baseRefName: 'main',
    })
    .execute();
};

describe('rangePrNumbersInOrder', () => {
  it('oldest tag first, each number once', () => {
    const tags = [
      { name: 'b', committedAt: day(3), taggedAt: null },
      { name: 'a', committedAt: day(1), taggedAt: null },
    ];
    expect(m.rangePrNumbersInOrder(tags, [{ tagName: 'b', prNumbers: [5, 1] }, { tagName: 'a', prNumbers: [2, 1] }])).toEqual([2, 1, 5]);
  });
});

describe('fetchMissingRangePrs', () => {
  it('acceptance 39/40: syncs the missing numbers oldest tag first; a PR GitHub does not give holds and is not asked again at once', async () => {
    await storePr(1);
    const asked: number[] = [];
    const res = await m.fetchMissingRangePrs({
      accountId: 1,
      repoId,
      owner: 'acme',
      name: 'api',
      deps: {
        syncPr: async (n) => {
          asked.push(n);
          if (n === 3) return false;
          await storePr(n);
          return true;
        },
      },
    });
    expect(asked.sort()).toEqual([2, 3, 5]);
    expect(res).toMatchObject({ fetched: 2, failed: 1, left: 0, total: 4, paused: false });
    expect(scan.unreadablePrNumbers(repoId)).toEqual([3]);
    // A second run asks nothing: #3 waits for its retry time.
    const again: number[] = [];
    const res2 = await m.fetchMissingRangePrs({ accountId: 1, repoId, owner: 'acme', name: 'api', deps: { syncPr: async (n) => (again.push(n), true) } });
    expect(again).toEqual([]);
    expect(res2).toMatchObject({ fetched: 0, left: 0 });
  });

  it('bounded per run; stops when the budget is low (paused, not unreadable)', async () => {
    const { repoTagRanges } = client.schema;
    const { eq } = await import('drizzle-orm');
    await client.db.update(repoTagRanges).set({ prNumbers: [10, 11, 12, 13] }).where(eq(repoTagRanges.tagName, 'v1.1.0')).execute();
    const capped = await m.fetchMissingRangePrs({
      accountId: 1, repoId, owner: 'acme', name: 'api', cap: 1,
      deps: { syncPr: async (n) => (await storePr(n), true) },
    });
    expect(capped).toMatchObject({ fetched: 1, left: 3 });
    const { noteBudget } = await import('../github/rate-budget.js');
    noteBudget(1, { remaining: 1, resetAt: new Date(Date.now() + 3_600_000) });
    const paused = await m.fetchMissingRangePrs({ accountId: 1, repoId, owner: 'acme', name: 'api', deps: { syncPr: async () => true } });
    expect(paused).toMatchObject({ fetched: 0, failed: 0, paused: true });
    expect(scan.unreadablePrNumbers(repoId)).toEqual([]);
  });
});

describe('queueRangeTickets', () => {
  it('queues the PRs whose tickets are not read yet; nothing owed queues nothing', async () => {
    const queued: number[][] = [];
    expect(
      await m.queueRangeTickets({ accountId: 1, repoId, deps: { owed: async () => ({ prIds: [4, 9], waiting: 2 }), queue: (ids) => queued.push(ids) } }),
    ).toEqual({ queued: 2, waiting: 2 });
    expect(queued).toEqual([[4, 9]]);
    expect(await m.queueRangeTickets({ accountId: 1, repoId, deps: { owed: async () => ({ prIds: [], waiting: 0 }), queue: (ids) => queued.push(ids) } })).toEqual({
      queued: 0,
      waiting: 0,
    });
    expect(queued).toHaveLength(1);
  });
});
