// THE CROSS-CHECK: `$ per acted-on thread` MUST BE THE SAME NUMBER ON BOTH TABS.
//
// ⚠ WHY THIS FILE EXISTS, AND IT IS THE SECOND TIME. `apps/backend/src/db/bot-analytics-cost.test.ts`
// records the first: the Bots ROI table divided a MONTHLY price by a RAW in-window count, and the
// defect went unnoticed through 1136 green backend tests until somebody read the figure beside the
// Benchmark rollup's own $/acted-on for the same bot at the same price — US$2.23 against US$21.24.
// The ROI tab was moved onto a chosen window. The Benchmark rollup was NOT: it went on dividing by
// `spanDays`, the stretch between the reviewer's earliest and latest comment on the walked slice —
// a window nobody chose, an order statistic one old comment could set, and a number no component
// ever rendered. On the real erxes/CodeRabbit card that was 237 days, and the two adjacent tabs
// printed US$3.2 and US$23.94 for one reviewer at one price.
//
// ⚠ NOTHING PINNED THE AGREEMENT, WHICH IS WHY IT COULD BREAK TWICE. Each tab's own suite was green
// against its own arithmetic; no test in either repository ever put the two numbers side by side.
// This file does exactly that, over ONE database, with ONE fixture, and it is the assertion that
// forces `COST_WINDOW_DAYS === DAYS_PER_MONTH` (see the first test).
//
// It lives in the PRO suite because it needs both halves: `getBotAnalytics` from the host and the
// placement route from the plugin. It runs with the backend suite; on its own:
//   pnpm --filter @pierre-review/backend exec vitest run src/platform/test/benchmark-roi-agreement
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's config/client, which open the
// connection at module load. `bot-analytics-cost.test.ts`'s rule, verbatim.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotBenchmarkPlacementResponse } from '@pierre-review/shared';
import {
  COST_WINDOW_DAYS,
  COST_WINDOW_MIN_ACTED,
  DAYS_PER_MONTH,
} from '../bots/benchmark/cost.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-benchmark-roi-agreement.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const DAY = 86_400_000;
const ACCOUNT = 1;
/** Second-aligned: sqlite stores `mode: 'timestamp'` as epoch SECONDS. */
const now = Math.floor(Date.now() / 1000) * 1000;

const MONTHLY_USD = 60;
/**
 * ⚠ COMFORTABLY ABOVE `COST_WINDOW_MIN_ACTED`, and the assertion below says so out loud. A fixture
 * under the floor would make the Benchmark side refuse `window_underpopulated` while every
 * agreement assertion here read as though it had compared two figures.
 */
const ACTED_THREADS = 12;
/**
 * ⚠ TEN DAYS OLD, WHICH IS THE ONE AGE THAT PUTS BOTH TABS ON ONE POPULATION. The Benchmark counts
 * a thread by its SETTLE POINT (creation + the corpus's 72-hour settle window); the ROI table counts
 * it by its CREATION. At ten days old the settle point is seven days ago and the creation is ten,
 * and both fall inside a trailing month — so the two folds see the same twelve threads and any
 * difference in the answer is a difference in ARITHMETIC, which is what this file is about.
 */
const THREAD_AGE_DAYS = 10;

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let scope: any;
let app: any;
let botId = 0;
let repoId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('../../db/queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments } = schema;

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: ACCOUNT,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_agree',
      // ⚠ OLDER THAN BOTH WINDOWS. Under the cost window the per-thread money refuses
      // `repo_window_incomplete`; under the fortnight the placement itself refuses.
      createdAt: new Date(now - 400 * DAY),
    })
    .returning()
    .execute();
  repoId = repo.id;

  const [human] = await db
    .insert(users)
    .values({ githubLogin: 'alice', githubNodeId: 'U_alice' })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({
      githubLogin: 'coderabbitai',
      githubNodeId: 'U_agree_bot',
      isBot: true,
      githubType: 'Bot',
    })
    .returning()
    .execute();
  botId = bot.id;

  // ⚠ A HUMAN-AUTHORED PULL REQUEST, MERGED INSIDE THE FORTNIGHT. Both are load-bearing: the
  // corpus's outcome population excludes machine-authored pull requests, and `walkBudgetFor(0)` is
  // ZERO — a repository that merged nothing in fourteen days has the benchmark read no pull
  // requests at all and report the reviewer as silent.
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_agree',
      accountId: ACCOUNT,
      repoId,
      number: 1,
      title: 'agreement fixture',
      authorId: human.id,
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
      mergedAt: new Date(now - 2 * DAY),
      updatedAt: new Date(now - 2 * DAY),
    })
    .returning()
    .execute();

  const createdAt = new Date(now - THREAD_AGE_DAYS * DAY);
  for (let n = 1; n <= ACTED_THREADS; n += 1) {
    // ⚠ RESOLVED ON BOTH SIDES OF THE VOCABULARY GAP, deliberately. The two folds do NOT share a
    // definition of "acted on" — the ROI table folds the `likely_addressed` commit heuristic into
    // its numerator and divides by every in-window thread, while `acted_on_rate` divides by the
    // SETTLED ones (docs/PLATFORM.md is explicit that these are different columns
    // that must never be reconciled). A RESOLVED thread is acted-on under BOTH, which is what lets
    // this fixture isolate the ARITHMETIC. It is not a claim that the two counts agree in general.
    const [thread] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_agree_${n}`,
        prId: pr.id,
        path: `src/f${n}.ts`,
        line: n,
        isResolved: true,
        isOutdated: false,
        derivedState: 'resolved',
        originalCommenterId: botId,
        createdAt,
      })
      .returning()
      .execute();
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_agree_${n}`,
        threadId: thread.id,
        prId: pr.id,
        authorId: botId,
        body: 'x'.repeat(40),
        createdAt,
      })
      .execute();
  }

  // Through the production resolver, so the membership rows are the ones the app would have.
  scope = await q.resolveWorkspaceScope(ACCOUNT, null);

  await db
    .insert(schema.workspaceReviewers)
    .values({
      accountId: ACCOUNT,
      workspaceId: scope.workspaceId,
      authorUserId: botId,
      automated: true,
      role: 'review',
      confidence: 'high',
      source: 'auto',
      kind: 'coderabbit',
    })
    .execute();
  // ⚠ THE PRICE GOES THROUGH ITS ONE PRODUCTION WRITER — a narrowed UPDATE that writes nothing
  // unless the judgement row already exists, which is why it comes second.
  await q.setReviewerCost(ACCOUNT, botId, scope.workspaceId, MONTHLY_USD, 'flat');

  const { registerBotBenchmarkPlacementRoutes } = await import(
    '../bots/benchmark/placement-routes.js'
  );
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerBotBenchmarkPlacementRoutes(app, {
    accountIdOf: () => ACCOUNT,
    db,
    schema,
    queries: { defaultWorkspaceId: async () => scope.workspaceId },
    log: { warn: () => {}, info: () => {}, error: () => {} },
  } as any);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  closeDb?.();
});

/** The Bots ROI table's figure, over EXACTLY the Benchmark's own cost window. */
async function roiVendor(windowDays = COST_WINDOW_DAYS): Promise<any> {
  const resp = await q.getBotAnalytics(
    ACCOUNT,
    // ⚠ EXPLICIT BOUNDS, not the `rolling_30` enum. The enum resolves to a round 30 days, and this
    // file's whole point is that the window on both sides of the comparison must be the SAME one —
    // so the Benchmark's constant is handed to the ROI fold rather than approximated by a chip.
    { kind: 'rolling_30', fromMs: now - windowDays * DAY, toMs: now },
    scope,
  );
  const v = resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit');
  if (v == null) throw new Error('no coderabbit row in the ROI response');
  return v;
}

/** The Benchmark rollup's figure, off the real route. */
async function benchmarkCard(): Promise<any> {
  const res = await app.inject({
    method: 'GET',
    url: '/api/pro/bot-benchmark/placement',
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as BotBenchmarkPlacementResponse;
  const card = (body.rollup ?? []).find((r) => r.key === 'coderabbit');
  if (card == null) throw new Error('no coderabbit rollup card');
  return card;
}

describe('$ per acted-on thread agrees across the Bots ROI table and the Benchmark rollup', () => {
  it('the fixture is above the money floor and both folds see the same twelve threads', async () => {
    // ⚠ THE GUARD THAT KEEPS EVERY ASSERTION BELOW FROM BEING VACUOUS. If either side counted a
    // different number of threads, the agreement further down would be a coincidence of two wrong
    // numbers — or, worse, a comparison of two refusals.
    expect(ACTED_THREADS).toBeGreaterThanOrEqual(COST_WINDOW_MIN_ACTED);
    const roi = await roiVendor();
    const card = await benchmarkCard();
    expect(roi.actedOn).toBe(ACTED_THREADS);
    expect(roi.costMonthlyUsd).toBe(MONTHLY_USD);
    if (card.cost?.yours.status !== 'value') {
      throw new Error(`benchmark refused: ${JSON.stringify(card.cost?.yours)}`);
    }
    expect(card.cost.yours.actedThreads).toBe(ACTED_THREADS);
    expect(card.cost.monthlyUsd).toBe(MONTHLY_USD);
    expect(card.cost.costWindowDays).toBe(COST_WINDOW_DAYS);
  });

  it('LANDS ON THE SAME FIGURE — the assertion this whole file exists for', async () => {
    const roi = await roiVendor();
    const card = await benchmarkCard();
    if (card.cost?.yours.status !== 'value') throw new Error('unreachable');

    // ⚠ EXACT, NOT `toBeCloseTo`. Both sides are one IEEE-754 division of a price by a count over
    // the SAME window, so two correct implementations agree bit for bit; a tolerance here would
    // quietly absorb precisely the 1.45 % the next test explains.
    expect(card.cost.yours.perActedOnUsd).toBe(roi.costPerActedOnUsd);
    expect(card.cost.yours.perActedOnUsd).toBe(MONTHLY_USD / ACTED_THREADS); // 60 ÷ 12 = 5.00

    // ⚠ THE TWO FIGURES THE DEFECT PRODUCED, NAMED. The Benchmark divided by
    // `acted × DAYS_PER_MONTH ÷ spanDays`, where `spanDays` was the reviewer's own comment stretch:
    // every comment here landed in one instant, so `resolveSpan` refused and the card said
    // `span_unobserved` — and on the real erxes card, where the stretch was 237 days, it printed
    // US$23.94 against this tab's US$3.2.
    expect(card.cost.yours.status).not.toBe('refused');
    expect(card.cost.yours.perActedOnUsd).not.toBe(23.942874);
  });

  it('AND THE AGREEMENT IS STRUCTURAL — it holds only at a window of exactly one month', async () => {
    // ⚠ THIS IS THE TEST THAT FORCES THE CONSTANT. The ROI table computes
    // `monthlyUsd ÷ ((acted × DAYS_PER_MONTH) ÷ windowDays)`; the Benchmark computes
    // `monthlyUsd ÷ acted`. Those two expressions are equal at exactly ONE window length —
    // `windowDays === DAYS_PER_MONTH` — and they differ by the ratio everywhere else. At a round
    // 30 days that is 1.45 %: small enough to read as a rounding difference on screen, large enough
    // to be a wrong price, and permanent.
    expect(COST_WINDOW_DAYS).toBe(DAYS_PER_MONTH);

    const card = await benchmarkCard();
    if (card.cost?.yours.status !== 'value') throw new Error('unreachable');
    // The SAME twelve threads read by the ROI fold over a 30-day window instead of a 30.44-day one:
    // the counts are identical (nothing settled in the 0.44 days between the two windows' edges)
    // and the figures are NOT.
    const thirty = await roiVendor(30);
    expect(thirty.actedOn).toBe(ACTED_THREADS);
    expect(thirty.costPerActedOnUsd).not.toBe(card.cost.yours.perActedOnUsd);
    expect(thirty.costPerActedOnUsd! / card.cost.yours.perActedOnUsd).toBeCloseTo(
      30 / DAYS_PER_MONTH,
      9,
    );

    // MUTATION-TESTED, and it is the mutation this file was written for. `COST_WINDOW_DAYS` set to
    // a round `30`: 2 of 4 RED — this test on the constant, and "LANDS ON THE SAME FIGURE" with the
    // Benchmark's US$5.00 against the ROI table's US$4.9277 (the 1.45 %, in money). The other two
    // survive, correctly: the fixture guard and the reader-recomputes check are about the card's own
    // internal consistency, which a shorter window does not break. Restored.
  });

  it('the reader can recompute the figure from the two numbers the card prints', async () => {
    // ⚠ THE PROPERTY THE OLD CARD LACKED, AND THE REASON THE DEFECT SURVIVED. It printed
    // "US$783.00 a month", "255 of 544 threads acted on" and "US$23.94", and no arithmetic over
    // those three is consistent — the missing 237-day divisor appeared nowhere on screen.
    const card = await benchmarkCard();
    if (card.cost?.yours.status !== 'value') throw new Error('unreachable');
    expect(card.cost.monthlyUsd! / card.cost.yours.actedThreads).toBe(
      card.cost.yours.perActedOnUsd,
    );
    // …and the served sentence carries BOTH of those numbers, in the spelling the rows use.
    expect(card.cost.basisNote).toContain('US$60.00 a month');
    expect(card.cost.basisNote).toContain('12 comments your team used in the last 30 days');
  });
});
