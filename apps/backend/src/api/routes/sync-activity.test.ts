// GET /api/sync-activity on a THROWAWAY sqlite DB (the billing.test.ts pattern): env is set
// BEFORE importing config/client, and the real route + real query layer run — only
// sync-manager's in-memory progress snapshot is stubbed (the maps are private, and the walks
// they track would need live GitHub).
//
// The contract under test is what the global loading bar rests on: full-mode walks (running
// AND queued-for-full) come back in `backfills` with the joined fullName +
// percent/prsProcessed/paused passthrough; a ROUTINE incremental walk appears in NEITHER array
// (the bar must not flicker on the 5-minute cron); the ONE incremental that is reported is a
// COLD-RETURN CATCH-UP, in its own `catchups` array, and only when its `sinceMs` is more than
// 24h old; and the repos join IS the tenancy isolation — the progress map is process-wide
// across tenants in cloud, so a foreign repoId in it must not leak.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SyncProgress } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-sync-activity-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// Mutable snapshot the mocked accessor serves; vi.hoisted so the (hoisted) factory sees it.
const progress = vi.hoisted(() => ({
  rows: [] as Array<{ repoId: number; progress: SyncProgress }>,
}));
// Spread the real module so the many sync-manager exports repos.ts also imports still
// resolve — only the snapshot accessor is stubbed.
vi.mock('../../sync/sync-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listActiveSyncProgress: () => progress.rows,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let ownRepoId = 0;
let ownSecondRepoId = 0;
let foreignRepoId = 0;

async function get(): Promise<any> {
  return app.inject({ method: 'GET', url: '/api/sync-activity' });
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();

  const seedRepo = async (accountId: number, owner: string, name: string): Promise<number> =>
    (
      await db
        .insert(schema.repos)
        .values({ accountId, owner, name, githubNodeId: `R_${owner}_${name}` })
        .returning({ id: schema.repos.id })
        .execute()
    )[0].id;

  // Account 1 is the migration-seeded local account — what accountIdOf resolves to in local
  // mode, so the route needs no request decoration. Account 2 exists so the isolation check
  // below isn't vacuous.
  ownRepoId = await seedRepo(1, 'acme', 'api');
  ownSecondRepoId = await seedRepo(1, 'acme', 'web');
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'gh_2', githubLogin: 'neighbour' })
    .execute();
  foreignRepoId = await seedRepo(2, 'other', 'api');

  const { repoRoutes } = await import('./repos.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  await app.register(repoRoutes);
  await app.ready();
  // Generous: this hook runs the real migrations and loads the whole route tree, which is a
  // few seconds on a cold transform — past vitest's 10s hook default.
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/sync-activity', () => {
  it('answers empty when nothing heavy is running', async () => {
    progress.rows = [];
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.backfills).toEqual([]);
    expect(body.catchups).toEqual([]);
    expect(new Date(body.generatedAt).getTime()).not.toBeNaN();
  });

  it('returns full-mode walks with the joined fullName; incrementals are EXCLUDED', async () => {
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: { percent: 0.4, prsProcessed: 12, pages: 3, mode: 'full' },
      },
      {
        repoId: ownSecondRepoId,
        progress: { percent: 0.9, prsProcessed: 5, pages: 1, mode: 'incremental' },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([
      { repoId: ownRepoId, fullName: 'acme/api', percent: 0.4, prsProcessed: 12 },
    ]);
  });

  it('includes a repo QUEUED for a full walk (paused passthrough); a queued incremental stays out', async () => {
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: {
          percent: 0,
          prsProcessed: 0,
          pages: 0,
          mode: 'full',
          paused: { reason: 'queued' },
        },
      },
      // Queued, but its seeded mode is 'incremental' — not heavy work, must not appear.
      {
        repoId: ownSecondRepoId,
        progress: {
          percent: 0,
          prsProcessed: 0,
          pages: 0,
          mode: 'incremental',
          paused: { reason: 'queued' },
        },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([
      {
        repoId: ownRepoId,
        fullName: 'acme/api',
        percent: 0,
        prsProcessed: 0,
        paused: { reason: 'queued' },
      },
    ]);
  });

  it('suppresses a zero-progress retry of an ERRORED repo, but not its queued re-sync or real progress', async () => {
    // A permanently failing first backfill (SAML wall, revoked token) is retried by every
    // scheduler tick — those rows must not flash the ambient bar forever. But an explicit
    // user-queued re-sync, or a retry that IS walking (percent > 0), still shows.
    await db
      .insert(schema.syncState)
      .values({ repoId: ownRepoId, lastSyncStatus: 'error', lastSyncError: 'boom' })
      .execute();
    const attempt = (p: SyncProgress) => ({ repoId: ownRepoId, progress: p });
    try {
      progress.rows = [
        attempt({ percent: 0, prsProcessed: 0, pages: 0, mode: 'full' }),
      ];
      expect((await get()).json().backfills).toEqual([]);

      progress.rows = [
        attempt({
          percent: 0,
          prsProcessed: 0,
          pages: 0,
          mode: 'full',
          paused: { reason: 'queued' },
        }),
      ];
      expect((await get()).json().backfills).toHaveLength(1);

      progress.rows = [
        attempt({ percent: 0.2, prsProcessed: 4, pages: 1, mode: 'full' }),
      ];
      expect((await get()).json().backfills).toHaveLength(1);
    } finally {
      await db
        .delete(schema.syncState)
        .where(eq(schema.syncState.repoId, ownRepoId))
        .execute();
    }
  });

  it("drops another tenant's repo and an unknown repoId — the join is the isolation", async () => {
    progress.rows = [
      {
        repoId: foreignRepoId,
        progress: { percent: 0.5, prsProcessed: 9, pages: 2, mode: 'full' },
      },
      // Deleted mid-walk: an id the SELECT can't resolve simply drops out, never a 404/500.
      {
        repoId: 999_999,
        progress: { percent: 0.5, prsProcessed: 9, pages: 2, mode: 'full' },
      },
      {
        repoId: ownRepoId,
        progress: { percent: 0.7, prsProcessed: 30, pages: 6, mode: 'full' },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([
      { repoId: ownRepoId, fullName: 'acme/api', percent: 0.7, prsProcessed: 30 },
    ]);
  });

  // ── the catch-up half ───────────────────────────────────────────────────────────────────
  //
  // `catchups` is the ONE incremental walk the bar reports, and the whole feature rests on the
  // threshold separating it from a routine tick. That margin is three orders of magnitude, not
  // a tuned number: a HEALTHY repo's `since` never exceeds ~50 minutes (cold activity bucket
  // 15 min + the 30-min forced re-walk floor + the 20-min overlap), and a cold return is days.
  // These pin both ends of it.
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('an incremental walk BEHIND BY DAYS lands in `catchups`, carrying its cutoff — never in `backfills`', async () => {
    const eighteenDaysAgo = Date.now() - 18 * DAY_MS;
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: {
          percent: 0.3,
          prsProcessed: 40,
          pages: 2,
          mode: 'incremental',
          sinceMs: eighteenDaysAgo,
        },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([]);
    expect(body.catchups).toEqual([
      {
        repoId: ownRepoId,
        fullName: 'acme/api',
        percent: 0.3,
        prsProcessed: 40,
        sinceMs: eighteenDaysAgo,
      },
    ]);
    // ⚠ The wire carries a TIMESTAMP, not a pre-computed "18 days": the SPA renders the span at
    // read time, so a response sitting in cache cannot go on claiming yesterday's number.
    expect(typeof body.catchups[0].sinceMs).toBe('number');
  });

  it('a ROUTINE tick appears in NEITHER array — the bar must not flicker on the cron', async () => {
    // ~50 minutes: the widest a healthy repo's cutoff can be. The bar must stay silent.
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: {
          percent: 0.5,
          prsProcessed: 3,
          pages: 1,
          mode: 'incremental',
          sinceMs: Date.now() - 50 * 60_000,
        },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([]);
    expect(body.catchups).toEqual([]);
  });

  it('an ABSENT `sinceMs` is "not recorded", never "old" — it cannot invent a catch-up', async () => {
    // An older server, or a progress row seeded before the field existed. Silence is not
    // evidence of staleness, and reading it as one would report a permanent catch-up.
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: { percent: 0.5, prsProcessed: 3, pages: 1, mode: 'incremental' },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([]);
    expect(body.catchups).toEqual([]);
  });

  it('suppresses a zero-progress CATCH-UP retry of an ERRORED repo — the suppression is mode-blind', async () => {
    // ⚠ The sharper half of the errored-retry rule. `lastIncrementalSyncAt` is stamped only on
    // a SUCCESSFUL walk, so a repo that fails every attempt ages its own cutoff forever: left
    // unsuppressed it reports "18 days behind", then 19, on a repo nothing can fetch.
    await db
      .insert(schema.syncState)
      .values({ repoId: ownRepoId, lastSyncStatus: 'error', lastSyncError: 'boom' })
      .execute();
    const walk = (extra: Record<string, unknown>) => ({
      repoId: ownRepoId,
      progress: {
        percent: 0,
        prsProcessed: 0,
        pages: 0,
        mode: 'incremental' as const,
        sinceMs: Date.now() - 18 * DAY_MS,
        ...extra,
      },
    });
    try {
      progress.rows = [walk({})];
      expect((await get()).json().catchups).toEqual([]);

      // An explicit user-queued re-sync still shows — somebody asked for this one.
      progress.rows = [walk({ paused: { reason: 'queued' } })];
      expect((await get()).json().catchups).toHaveLength(1);

      // And a retry that IS making progress is real work, not a flapping retry.
      progress.rows = [walk({ percent: 0.2, prsProcessed: 4 })];
      expect((await get()).json().catchups).toHaveLength(1);
    } finally {
      await db
        .delete(schema.syncState)
        .where(eq(schema.syncState.repoId, ownRepoId))
        .execute();
    }
  });

  it("drops ANOTHER TENANT's catch-up — the join is the isolation on this array too", async () => {
    // The progress map is process-wide across tenants in cloud, so the accountId predicate is
    // what keeps a neighbour's repo name off this account's loading bar.
    progress.rows = [
      {
        repoId: foreignRepoId,
        progress: {
          percent: 0.5,
          prsProcessed: 9,
          pages: 2,
          mode: 'incremental',
          sinceMs: Date.now() - 18 * DAY_MS,
        },
      },
    ];
    const body = (await get()).json();
    expect(body.catchups).toEqual([]);
    expect(body.backfills).toEqual([]);
  });

  it('reports a backfill and a catch-up SIDE BY SIDE, each in its own array', async () => {
    const since = Date.now() - 9 * DAY_MS;
    progress.rows = [
      {
        repoId: ownRepoId,
        progress: { percent: 0.4, prsProcessed: 12, pages: 3, mode: 'full' },
      },
      {
        repoId: ownSecondRepoId,
        progress: {
          percent: 0.6,
          prsProcessed: 30,
          pages: 2,
          mode: 'incremental',
          sinceMs: since,
        },
      },
    ];
    const body = (await get()).json();
    expect(body.backfills).toEqual([
      { repoId: ownRepoId, fullName: 'acme/api', percent: 0.4, prsProcessed: 12 },
    ]);
    expect(body.catchups).toEqual([
      {
        repoId: ownSecondRepoId,
        fullName: 'acme/web',
        percent: 0.6,
        prsProcessed: 30,
        sinceMs: since,
      },
    ]);
  });
});
