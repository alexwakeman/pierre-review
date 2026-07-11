// Phase 2 "review-bot signal-to-noise" compute, on a THROWAWAY sqlite DB. Seeds one watched
// repo + open PR with a mix of review-BOT threads (by a coderabbitai user) plus a human thread,
// then asserts (a) getActivity's per-repo botThreads/botThreadsActedOn, and (b) getTeamInsights'
// deterministic bot_signal card — proving the classifier segments bot vs human and the acted-on
// heuristic (resolved|likely_addressed) is counted correctly.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotSignalCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-bot-signal-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let prId = 0;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const now = Date.now();
  const { repos, pullRequests, events, users, reviewThreads } = schema;

  // account 1 exists (migration 0008). One watched repo + one open PR.
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_bs', inboxWatch: true })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_bs',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'bot-signal fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 3 * DAY),
      updatedAt: new Date(now - 1 * DAY),
    })
    .returning()
    .execute();
  prId = pr.id;
  // A recent event so getTeamInsights' non-stale open-PR path is happy.
  await db
    .insert(events)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr.id,
      type: 'pr_opened',
      occurredAt: new Date(now - 3 * DAY),
      dedupeKey: 'pr_opened:PR_bs',
    })
    .execute();

  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cr', isBot: true })
    .returning()
    .execute();
  const [human] = await db
    .insert(users)
    .values({ githubLogin: 'morgan-diaz', githubNodeId: 'U_mo', isBot: false })
    .returning()
    .execute();

  // 5 BOT threads: 2 acted-on (resolved + likely_addressed), 2 untouched, 1 replied_unresolved.
  // Plus 1 HUMAN untouched thread that must NOT be counted as bot.
  const threads = [
    { node: 'BS_1', state: 'untouched', opener: bot.id, ageDays: 2 },
    { node: 'BS_2', state: 'untouched', opener: bot.id, ageDays: 5 }, // the oldest untouched
    { node: 'BS_3', state: 'replied_unresolved', opener: bot.id, ageDays: 2 },
    { node: 'BS_4', state: 'likely_addressed', opener: bot.id, ageDays: 2 },
    { node: 'BS_5', state: 'resolved', opener: bot.id, ageDays: 2, resolved: true },
    { node: 'BS_H', state: 'untouched', opener: human.id, ageDays: 2 }, // human — excluded
  ];
  for (const t of threads) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: t.node,
        prId: pr.id,
        path: 'src/x.ts',
        line: 1,
        isResolved: t.resolved ?? false,
        isOutdated: false,
        derivedState: t.state,
        originalCommenterId: t.opener,
        createdAt: new Date(now - t.ageDays * DAY),
      })
      .execute();
  }
});

afterAll(() => closeDb?.());

describe('review-bot signal-to-noise (Phase 2)', () => {
  it('getActivity segments bot threads + counts acted-on over open PRs', async () => {
    const activity = await q.getActivity(1, null);
    const repo = activity.repos[0];
    expect(repo).toBeDefined();
    // 5 bot threads (the human thread is excluded); acted-on = resolved + likely_addressed = 2.
    expect(repo.stats.botThreads).toBe(5);
    expect(repo.stats.botThreadsActedOn).toBe(2);
  });

  it('getTeamInsights emits a deterministic bot_signal card', async () => {
    const insights = await q.getTeamInsights(1);
    const card = insights.cards.find((c: { kind: string }) => c.kind === 'bot_signal') as
      | BotSignalCard
      | undefined;
    expect(card).toBeDefined();
    if (!card) return;
    expect(card.totalThreads).toBe(5);
    expect(card.totalActedOn).toBe(2);
    expect(card.totalUntouched).toBe(2);
    expect(card.actedOnPct).toBe(40); // 2/5
    expect(card.oldestUntouchedDays).toBeGreaterThanOrEqual(4); // ~5d, allowing for call-time drift
    expect(card.vendors).toHaveLength(1);
    expect(card.vendors[0]!.kind).toBe('coderabbit');
    expect(card.vendors[0]!.threads).toBe(5);
    expect(card.vendors[0]!.untouched).toBe(2);
  });
});

describe('getResolvableBotThreads (Phase 3 bulk-resolve eligibility)', () => {
  it('null (default) returns every likely_addressed unresolved bot thread', async () => {
    const r = await q.getResolvableBotThreads(prId, 1);
    expect(r).toHaveLength(1); // only BS_4 (bot-originated, likely_addressed, unresolved)
  });

  it('an EXPLICIT empty selection resolves NOTHING (not resolve-all)', async () => {
    const r = await q.getResolvableBotThreads(prId, 1, []);
    expect(r).toHaveLength(0);
  });

  it('narrows to exactly the reviewed ids, dropping ineligible/unknown ones', async () => {
    const [only] = await q.getResolvableBotThreads(prId, 1);
    expect(await q.getResolvableBotThreads(prId, 1, [only.id])).toEqual([only]);
    expect(await q.getResolvableBotThreads(prId, 1, [999_999])).toHaveLength(0);
  });
});
