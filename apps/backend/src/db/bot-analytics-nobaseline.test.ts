// getBotAnalytics — the fixed 36h overdue-gate BOUNDARY, on a THROWAWAY sqlite DB.
//
// A not-addressed (untouched) thread is treated as overdue only once it's older than the fixed 36h
// grace window (OVERDUE_GRACE_MS) — so a young backlog isn't instantly branded overdue. Here the
// bot has never drawn a reply (medianResponseMs is null), which doesn't change the gate at all.
//
// Seed (account 1, one repo/PR, window rolling_14): one bot, ZERO replies anywhere, three
// untouched threads straddling the 36h boundary → only the two older than 36h are overdue.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-nobaseline-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const HOUR = 60 * 60 * 1000;
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

  const { repos, pullRequests, users, reviewThreads } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_nb', inboxWatch: true })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_nb',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'no-baseline fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 10 * 24 * HOUR),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_nb', isBot: true })
    .returning()
    .execute();

  // Three untouched threads, NO comments anywhere → zero reply samples (null median), 36h gate.
  // 40h + 50h old are past 36h (overdue); 10h old is inside the grace (not overdue).
  for (const [i, ageHours] of [40, 50, 10].entries()) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `NB_T${i}`,
        prId: pr.id,
        path: `src/n${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: bot.id,
        createdAt: new Date(now - ageHours * HOUR),
      })
      .execute();
  }
});

afterAll(() => closeDb?.());

describe('getBotAnalytics fixed 36h overdue gate boundary', () => {
  it('only threads older than 36h are overdue (even with no reply history)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14');
    expect(resp.totals.overdueGraceMs).toBe(36 * HOUR); // the fixed gate
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit')!;
    expect(v.untouched).toBe(3); // all three not addressed
    expect(v.overdueUntouched).toBe(2); // the 40h + 50h ones; the 10h one is inside the 36h grace
    expect(v.medianAddressedMs).toBeNull(); // never addressed — doesn't affect the gate
  });
});
