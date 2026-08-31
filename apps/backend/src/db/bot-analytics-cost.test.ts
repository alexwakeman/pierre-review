// `costPerActedOnUsd` — THE ROI TABLE'S ONE MONEY FIGURE, ON A THROWAWAY SQLITE DB.
//
// ⚠ WHY THIS FILE EXISTS. The figure shipped as `monthlyPrice ÷ actedOn`, where `actedOn` is
// counted over the SELECTED WINDOW — a month's numerator over a fortnight's denominator. It went
// unnoticed until Bots → Benchmark landed one tab away with its own $/acted-on and the two
// disagreed on screen: $2.23 here against $21.24 there, same reviewer, same $49/month, no way for
// a reader to reconcile them, and wrong in the direction that flatters the bot. The whole backend
// suite (1136 tests) passed through both the defect and its fix, because nothing pinned the
// arithmetic at all.
//
// The load-bearing assertion is the LAST one: the same acted-on count measured over two different
// windows must produce two different figures. Under the old arithmetic it could not — `60 ÷ 4` is
// `60 ÷ 4` whatever window the 4 was counted in — so that case fails against the defect and no
// amount of adjusting a single expected number would rescue it.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-cost-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let scope: any;
let botId = 0;

const DAY = 24 * 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
// Inside BOTH a 14-day and a 30-day trailing window, so one fixture serves both readings.
const recent = new Date(now - 5 * DAY);

const MONTHLY_USD = 60;
const ACTED_THREADS = 4;
/** 365.25 ÷ 12 — spelled out here rather than imported, so a change to the constant in
 *  `bot-window.ts` has to be made deliberately in two places instead of silently agreeing with
 *  itself. `benchmark-cost.test.ts` pins the plugin's copy of the same number. */
const DAYS_PER_MONTH = 30.44;

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
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_cost' })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cost', isBot: true })
    .returning()
    .execute();
  botId = bot.id;

  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_cost1',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'cost fixture',
      state: 'merged',
      isDraft: false,
      openedAt: new Date(recent.getTime() - 2 * DAY),
      updatedAt: recent,
      mergedAt: recent,
    })
    .returning()
    .execute();

  // Four RESOLVED bot threads — unambiguously acted on, so the denominator is not itself a
  // heuristic under test here.
  for (let n = 1; n <= ACTED_THREADS; n += 1) {
    const [thread] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `COST_T${n}`,
        prId: pr.id,
        path: 'src/x.ts',
        line: n,
        isResolved: true,
        isOutdated: false,
        derivedState: 'resolved',
        originalCommenterId: botId,
        createdAt: recent,
      })
      .returning()
      .execute();
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `COST_RC${n}`,
        threadId: thread.id,
        prId: pr.id,
        authorId: botId,
        body: `finding ${n}`,
        createdAt: recent,
      })
      .execute();
  }

  // Through the production resolver (ensureRepoMemberships) — see bot-analytics-dormant.test.ts.
  scope = await q.resolveWorkspaceScope(1, null);

  // ⚠ THE JUDGEMENT ROW FIRST, THEN THE PRICE. `setReviewerCost` is a narrowed UPDATE on
  // `(accountId, workspaceId, authorUserId)` — deliberately, so pricing can never restate a
  // reviewer's judgement or identity — and it writes nothing at all when no row exists yet. The
  // classification pass normally creates it; here the fixture does, so the price still goes
  // through its ONE production writer rather than being inserted alongside.
  await db
    .insert(schema.workspaceReviewers)
    .values({
      accountId: 1,
      workspaceId: scope.workspaceId,
      authorUserId: botId,
      automated: true,
      role: 'review',
      confidence: 'high',
      source: 'auto',
      kind: 'coderabbit',
    })
    .execute();
  await q.setReviewerCost(1, botId, scope.workspaceId, MONTHLY_USD, 'flat');
});

afterAll(() => closeDb?.());

const vendorOf = (resp: any) =>
  resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit')!;

describe('costPerActedOnUsd puts both ends of the fraction on one time base', () => {
  it('divides the monthly price by a MONTHLY acted-on rate, not by the raw window count', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const v = vendorOf(resp);
    expect(v.actedOn).toBe(ACTED_THREADS);
    expect(v.costMonthlyUsd).toBe(MONTHLY_USD);

    const actedPerMonth = (ACTED_THREADS * DAYS_PER_MONTH) / 14;
    expect(v.costPerActedOnUsd).toBeCloseTo(MONTHLY_USD / actedPerMonth, 9);
    expect(v.costPerActedOnUsd).toBeCloseTo(6.899, 3);
    // ⚠ THE OLD ANSWER, NAMED. `60 ÷ 4` — a month's price spread over a fortnight's work.
    expect(v.costPerActedOnUsd).not.toBeCloseTo(15, 3);
  });

  it('reconstructs the monthly price exactly from the figure and its own window', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const v = vendorOf(resp);
    // The identity a reader is entitled to: rate × price-per-unit === the price.
    const actedPerMonth = (v.actedOn * DAYS_PER_MONTH) / 14;
    expect(v.costPerActedOnUsd * actedPerMonth).toBeCloseTo(MONTHLY_USD, 9);
  });

  it('MOVES WITH THE WINDOW — the same four threads read over 30 days cost more per thread', async () => {
    // ⚠ THE MUTATION-RESISTANT ONE. Both windows contain exactly the same four threads, so the raw
    // count is identical; only the stretch they were observed over differs. The old arithmetic
    // returned $15.00 for BOTH and had no way not to. A reviewer that produced four acted-on
    // threads in a fortnight is converting at twice the monthly rate of one that took a month, and
    // is therefore half the price per thread — which is the whole point of the figure.
    const short = vendorOf(await q.getBotAnalytics(1, 'rolling_14', scope));
    const long = vendorOf(await q.getBotAnalytics(1, 'rolling_30', scope));
    expect(long.actedOn).toBe(short.actedOn);
    expect(long.costPerActedOnUsd).toBeGreaterThan(short.costPerActedOnUsd);
    expect(long.costPerActedOnUsd / short.costPerActedOnUsd).toBeCloseTo(30 / 14, 6);
  });

  it('is null, never Infinity or zero, when nothing was acted on or no price is set', async () => {
    // A window with no activity at all: the reviewer is dormant, the divisor is 0.
    const empty = vendorOf(
      await q.getBotAnalytics(1, { kind: 'sprint', fromMs: now - 300 * DAY, toMs: now - 280 * DAY }, scope),
    );
    if (empty != null) {
      expect(empty.actedOn).toBe(0);
      expect(empty.costPerActedOnUsd).toBeNull();
    }

    // ⚠ AND A CLEARED PRICE IS NOT A FREE ONE. `null` must not become 0 on the way out.
    await q.setReviewerCost(1, botId, scope.workspaceId, null);
    const unpriced = vendorOf(await q.getBotAnalytics(1, 'rolling_14', scope));
    expect(unpriced.costMonthlyUsd).toBeNull();
    expect(unpriced.costPerActedOnUsd).toBeNull();
    await q.setReviewerCost(1, botId, scope.workspaceId, MONTHLY_USD, 'flat');
  });
});
