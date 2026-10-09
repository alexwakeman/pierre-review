// The contributor popover's counts (`getUserStats`) cover the trailing USER_STATS_WINDOW_DAYS
// (90) on a THROWAWAY sqlite DB. Each count reads its OWN clock: merged by mergedAt, closed by
// closedAt, open/draft NOT windowed (a now-state), reviews by submittedAt, comments by createdAt — half-open
// `[now - 90d, now)`.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_STATS_WINDOW_DAYS, type UserContributionStats } from '@pierre-review/shared';

// ⚠ Every runtime import reaching db/client.ts is DYNAMIC, after the env is set.
const DB_PATH = `/private/tmp/pierre-user-stats-${process.pid}-${Date.now()}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let stats: () => Promise<UserContributionStats>;

const NOW = Math.floor(Date.now() / 1000) * 1000;
const DAY = 86_400_000;
const daysAgo = (d: number): Date => new Date(NOW - d * DAY);
const INSIDE = 10;
const OUTSIDE = USER_STATS_WINDOW_DAYS + 5;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  const db: any = client.db;
  const schema: any = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  await runMigrations();
  const { accounts, repos, users, pullRequests, reviews, prComments } = schema;

  const [account] = await db
    .insert(accounts)
    .values({ githubUserId: 'U_us_viewer', githubLogin: 'us-viewer' })
    .returning()
    .execute();
  const [person] = await db
    .insert(users)
    .values({ githubLogin: 'us-alice', githubNodeId: 'U_us_alice' })
    .returning()
    .execute();
  const [repo] = await db
    .insert(repos)
    .values({ accountId: account.id, owner: 'acme', name: 'user-stats', githubNodeId: 'R_us' })
    .returning()
    .execute();

  let n = 0;
  const pr = async (v: Record<string, unknown>): Promise<number> => {
    n += 1;
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_us_${n}`,
        accountId: account.id,
        repoId: repo.id,
        number: n,
        title: `PR ${n}`,
        authorId: person.id,
        updatedAt: daysAgo(1),
        ...v,
      })
      .returning()
      .execute();
    return row.id;
  };
  // Merged inside / merged outside (opened long ago in both — the merge clock decides).
  const host = await pr({ state: 'merged', openedAt: daysAgo(200), mergedAt: daysAgo(INSIDE) });
  await pr({ state: 'merged', openedAt: daysAgo(200), mergedAt: daysAgo(OUTSIDE) });
  // Closed inside / outside.
  await pr({ state: 'closed', openedAt: daysAgo(200), closedAt: daysAgo(INSIDE) });
  await pr({ state: 'closed', openedAt: daysAgo(200), closedAt: daysAgo(OUTSIDE) });
  // Open is a NOW-state, not a window event: a year-old open PR still counts; one draft.
  await pr({ state: 'open', openedAt: daysAgo(INSIDE) });
  await pr({ state: 'open', openedAt: daysAgo(365) });
  await pr({ state: 'open', isDraft: true, openedAt: daysAgo(INSIDE) });

  for (const [i, d] of [INSIDE, OUTSIDE].entries()) {
    await db
      .insert(reviews)
      .values({ githubNodeId: `RV_us_${i}`, prId: host, authorId: person.id, state: 'approved', submittedAt: daysAgo(d) })
      .execute();
    await db
      .insert(prComments)
      .values({ githubNodeId: `IC_us_${i}`, prId: host, authorId: person.id, body: 'x', createdAt: daysAgo(d) })
      .execute();
  }

  stats = () => q.getUserStats(account.id, person.id, null, NOW);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getUserStats — last 90 days', () => {
  it('counts each kind by its own clock inside the window only', async () => {
    const s = await stats();
    expect(s.prsMerged).toBe(1);
    expect(s.prsClosed).toBe(1);
    expect(s.prsOpen).toBe(2);
    expect(s.prsDraft).toBe(1);
    expect(s.reviewsGiven).toBe(1);
    expect(s.comments).toBe(1);
  });
});
