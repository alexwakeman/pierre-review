// Findings-density trend of getBotBehaviourAnalytics, on a THROWAWAY sqlite DB. Seeds one review
// bot (coderabbitai) that touches three PRs of KNOWN diff size in KNOWN trend weeks and opens a
// KNOWN number of review threads on each, then locks the per-week findingsPerPr / findingsPerKloc /
// prsInWeek math — the "is PR quality improving?" signal that replaces the TTFR headline chart.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-behaviour-density-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
// BotScope { workspaceId, repoIds } — `workspaceId` decides who counts as a bot, `repoIds`
// narrows the measured data. Resolved through the production resolver in beforeAll.
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS, so a millisecond-bearing date
// wouldn't round-trip. Day offsets keep each PR's first-touch well inside a week (never on a 7-day
// boundary), so the bucket index is stable regardless of the tiny test→call clock drift.
const now = Math.floor(Date.now() / 1000) * 1000;

// Two PRs first-touched ~5/4 days ago → trend week 11 (the last week); one ~30 days ago → week 7.
// week index = floor((84 − offsetDays) / 7): 5→11, 4→11, 30→7.
async function seedPr(
  bot: { id: number },
  n: number,
  touchDaysAgo: number,
  additions: number,
  deletions: number,
  threadCount: number,
): Promise<void> {
  const { repos, pullRequests, reviews, reviewThreads } = schema;
  // One repo per PR keeps node ids trivially unique. All three land in the account's Default
  // workspace (every repo belongs to exactly one), so the resolved scope covers all of them.
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: `r${n}`, githubNodeId: `R_d${n}` })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_d${n}`,
      accountId: 1,
      repoId: repo.id,
      number: n,
      title: `density fixture ${n}`,
      state: 'open',
      isDraft: false,
      additions,
      deletions,
      openedAt: new Date(now - (touchDaysAgo + 1) * DAY),
      updatedAt: new Date(now - touchDaysAgo * DAY),
    })
    .returning()
    .execute();
  // The bot's touch (a submitted review) → makes the PR "involved" + sets its first-touch week.
  await db
    .insert(reviews)
    .values({
      githubNodeId: `RV_d${n}`,
      prId: pr.id,
      authorId: bot.id,
      state: 'commented',
      submittedAt: new Date(now - touchDaysAgo * DAY),
    })
    .execute();
  // The findings: threadCount review threads the bot OPENED on this PR (the density numerator).
  for (let i = 0; i < threadCount; i++)
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_d${n}_${i}`,
        prId: pr.id,
        path: `src/f${i}.ts`,
        line: i + 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: bot.id,
        createdAt: new Date(now - touchDaysAgo * DAY),
      })
      .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { users } = schema;
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_density', isBot: true })
    .returning()
    .execute();

  // Week 11: PR A (100 LoC, 2 threads) + PR B (400 LoC, 4 threads).
  await seedPr(bot, 1, 5, 100, 0, 2);
  await seedPr(bot, 2, 4, 300, 100, 4);
  // Week 7: PR C — reviewed but ZERO findings (a real 0, not a gap), 100 LoC.
  await seedPr(bot, 3, 30, 50, 50, 0);

  // ⚠ Resolve the scope through `resolveWorkspaceScope`, never by hand-building
  // `{workspaceId, repoIds}` — that call runs `ensureRepoMemberships`, which is what puts repos
  // inserted straight into `repos` into the account's Default workspace. Hand-build it (or list
  // only some of the three repos) and the density averages below silently change denominator.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('getBotBehaviourAnalytics — findings density trend', () => {
  it('averages threads-per-PR and threads-per-KLoC over the PRs first touched that week', async () => {
    // All THREE seeded repos must be in scope or every denominator below is wrong — a missing
    // membership would quietly drop a PR and still produce plausible-looking numbers.
    expect(scope.repoIds).toHaveLength(3);
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const bot = resp.bots.find((b: { login: string | null }) => b.login === 'coderabbitai');
    expect(bot).toBeDefined();

    // Week 11: 2 PRs, 6 threads, 500 LoC → 3 findings/PR, 6/0.5 = 12 findings/KLoC.
    const w11 = bot.trend[11];
    expect(w11.prsInWeek).toBe(2);
    expect(w11.findingsPerPr).toBe(3);
    expect(w11.findingsPerKloc).toBe(12);

    // Week 7: 1 PR reviewed, 0 threads, 100 LoC → a genuine 0 density (bot found nothing).
    const w7 = bot.trend[7];
    expect(w7.prsInWeek).toBe(1);
    expect(w7.findingsPerPr).toBe(0);
    expect(w7.findingsPerKloc).toBe(0);
  });

  it('reports null density (not 0) for a week with no reviewed PRs', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const bot = resp.bots.find((b: { login: string | null }) => b.login === 'coderabbitai');
    const w0 = bot.trend[0]; // ~12 weeks ago — no fixtures
    expect(w0.prsInWeek).toBe(0);
    expect(w0.findingsPerPr).toBeNull();
    expect(w0.findingsPerKloc).toBeNull();
  });

  it('does not flag a density anomaly while the baseline is still building (<4 active weeks)', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const bot = resp.bots.find((b: { login: string | null }) => b.login === 'coderabbitai');
    expect(bot.trend.every((p: { densityAnomaly: boolean }) => p.densityAnomaly === false)).toBe(true);
    expect(bot.anomalies.every((a: { metric: string }) => a.metric !== 'density')).toBe(true);
  });
});
