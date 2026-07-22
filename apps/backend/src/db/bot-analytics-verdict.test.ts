// getBotAnalytics — the response-time-gated "noisy" verdict, on a THROWAWAY sqlite DB.
//
// The point of the gate: an untouched thread only counts against a bot ("overdue", and only then
// feeding the noisy verdict) once its age exceeds a FIXED 36h grace window. So two bots with the
// SAME untouched count get OPPOSITE verdicts when one's backlog is young and the other's is aged.
//
// Seed (account 1, one repo/PR, window rolling_14):
//  • Two REPLIED bot threads (coderabbit), each answered by a human ~1 day after opening → they
//    give coderabbit a ~1d MEDIAN reply (the info-only column) and count as acted-on.
//  • coderabbit also has 10 UNTOUCHED threads opened 2h ago (inside the 36h grace) →
//    overdue = 0 → NOT noisy (verdict 'tune').
//  • greptile has 10 UNTOUCHED threads opened 5 days ago (past 36h), nothing else →
//    overdue = 10 → 'noisy'. Same untouched count as coderabbit's untouched, opposite verdict.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-verdict-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
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

  const { repos, pullRequests, users, reviewThreads, reviewComments } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_v', inboxWatch: true })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_v',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'verdict fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();

  const [coderabbit] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cr', isBot: true })
    .returning()
    .execute();
  const [greptile] = await db
    .insert(users)
    .values({ githubLogin: 'greptile-apps', githubNodeId: 'U_gr', isBot: true })
    .returning()
    .execute();
  const [alice] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_al', isBot: false })
    .returning()
    .execute();

  // Two REPLIED coderabbit threads — a human answers ~1 day after each opens. These are the
  // only response-time samples, so the account norm = 1 day. (No bot comment needed: the
  // thread's originalCommenterId already marks it a bot thread.)
  for (const [i, openedDaysAgo] of [12, 10].entries()) {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_R${i}`,
        prId: pr.id,
        path: `src/r${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'replied_unresolved',
        originalCommenterId: coderabbit.id,
        createdAt: new Date(now - openedDaysAgo * DAY),
      })
      .returning()
      .execute();
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `V_RC${i}`,
        threadId: t.id,
        prId: pr.id,
        authorId: alice.id,
        body: 'thanks, addressing',
        createdAt: new Date(now - (openedDaysAgo - 1) * DAY), // ~1 day after the thread opened
      })
      .execute();
  }

  // coderabbit: 10 UNTOUCHED threads opened 2h ago — younger than the 1-day norm → NOT overdue.
  for (let i = 0; i < 10; i++) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_CRU${i}`,
        prId: pr.id,
        path: `src/cr${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: coderabbit.id,
        createdAt: new Date(now - 2 * HOUR),
      })
      .execute();
  }

  // greptile: 10 UNTOUCHED threads opened 5 days ago — older than the 1-day norm → all overdue.
  for (let i = 0; i < 10; i++) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_GRU${i}`,
        prId: pr.id,
        path: `src/gr${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: greptile.id,
        createdAt: new Date(now - 5 * DAY),
      })
      .execute();
  }
});

afterAll(() => closeDb?.());

describe('getBotAnalytics response-time-gated verdict', () => {
  it('the overdue gate is a fixed 36h grace window', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14');
    expect(resp.totals.overdueGraceMs).toBe(36 * HOUR);
  });

  it('young untouched backlog is NOT overdue → the bot escapes "noisy" (verdict tune)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14');
    const cr = resp.vendors.find((v: { kind: string }) => v.kind === 'coderabbit')!;
    expect(cr.untouched).toBe(10); // 10 not-addressed threads…
    expect(cr.overdueUntouched).toBe(0); // …but all 2h old, inside the 36h grace → none overdue
    expect(cr.medianAddressedMs).toBe(DAY); // its own two replies → median time-to-addressed ~1 day (info-only)
    expect(cr.verdict).toBe('tune'); // low acted-on, but NOT noisy — the grace spared it
  });

  it('aged untouched backlog IS overdue → same untouched count, verdict "noisy"', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14');
    const gr = resp.vendors.find((v: { kind: string }) => v.kind === 'greptile')!;
    expect(gr.untouched).toBe(10); // identical not-addressed count to coderabbit…
    expect(gr.overdueUntouched).toBe(10); // …but all 5d old, past the 36h grace → all overdue
    expect(gr.medianAddressedMs).toBeNull(); // no thread of its was ever addressed (no reply/resolve/commit)
    expect(gr.verdict).toBe('noisy'); // high volume, zero acted-on, all overdue
  });
});
