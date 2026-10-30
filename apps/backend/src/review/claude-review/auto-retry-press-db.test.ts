// A READER'S PRESS IGNORES MANUAL RUNS AT THE HEAD (2026-10-27), over the REAL core client and
// migrations, and the REAL candidate read wired into the sweeper (only the lane is mocked).
//
// THE LIVE BUG: PR 183039 at head 2411e5a7 had runs 583 (auto, failed: Codex usage limit), 588
// (manual, succeeded), 593 (manual, failed); PR 182932 at 58028d94 had 580 (auto, failed), 589
// (manual, succeeded), 594 (manual, failed). "Run auto reviews now" queued NOTHING: the candidate
// read treated the head as done once ANY run succeeded there, and a retry needed the failed auto run
// to be the LATEST row at the head.
//
// THE RULE (db/auto-retry-at-head.ts):
//   • a READER'S PRESS (the sweep button, and Retry with prId): the head is done only when an AUTO run
//     succeeded there; manual rows at the head are ignored. In flight still blocks; the daily cap holds.
//   • the AUTOMATIC tick is unchanged: a manual success at the head makes it final.
//   • the lane's start-time re-check (`isAutoRetryStillDue`) and the AI Review tab's Retry line
//     (`getFailedAutoAtHead`) read the same fold.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-review-auto-retry-press-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// The lane: record what the sweeper hands it.
const enqueued: Array<{ prId: number; opts?: { retryOfReviewId?: number | null; pressed?: boolean } }> = [];
vi.mock('./manager.js', () => ({
  AGENTIC_AI_ENABLED: true,
  dropAutoReviews: () => 0,
  autoLaneRoom: () => 20,
  autoPendingPrIds: () => new Set<number>(),
  enqueueAutoReview: (
    _ctx: unknown,
    _accountId: number,
    prId: number,
    _workspaceId?: number,
    _commentsAtMs?: number | null,
    opts?: { retryOfReviewId?: number | null; pressed?: boolean },
  ) => {
    enqueued.push({ prId, opts });
    return 'queued';
  },
}));
vi.mock('./ai-ready.js', () => ({ agenticRunReady: () => true }));
let roster: Array<{ accountId: number; workspaceId: number; enabledAtMs: number; dailyCap: number }> = [];
vi.mock('./auto-settings.js', () => ({ listAutoReviewWorkspaces: async () => roster }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let q: typeof import('../../db/queries.js');
let persist: typeof import('./persist.js');
let auto: typeof import('./auto.js');
let ctx: AgentContext;
let workspaceId = 0;

const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const FLOOR = now - 10 * 24 * HOUR;
const OPENED = FLOOR + HOUR;
const USAGE = 'Codex could not finish: You’ve hit your usage limit. Upgrade to Pro or try again at 11:59 PM.';

let repoId = 0;
let aliceId = 0;
let prNumber = 1;
const pr: Record<string, number> = {};
const runId: Record<string, number> = {};

async function seedPr(key: string, headSha: string): Promise<number> {
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_press_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: key,
      state: 'open',
      isDraft: false,
      authorId: aliceId,
      headSha,
      openedAt: new Date(OPENED),
      updatedAt: new Date(OPENED),
    })
    .returning()
    .execute();
  pr[key] = row.id;
  return row.id;
}

async function run(
  key: string,
  prId: number,
  headSha: string,
  status: string,
  trigger: 'auto' | 'manual',
  atMs: number,
): Promise<number> {
  const [row] = await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1,
      prId,
      headSha,
      status,
      model: 'gpt-5-codex',
      provider: 'codex',
      trigger,
      error: status === 'failed' ? USAGE : null,
      createdAt: new Date(atMs),
      finishedAt: status === 'running' || status === 'queued' ? null : new Date(atMs + 60_000),
    })
    .returning()
    .execute();
  runId[key] = row.id;
  return row.id;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('../../db/queries.js');
  persist = await import('./persist.js');
  auto = await import('./auto.js');

  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
  const [alice] = await db
    .insert(schema.users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice-dev', isBot: false })
    .returning()
    .execute();
  aliceId = alice.id;
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_press', createdAt: new Date(FLOOR - HOUR) })
    .returning()
    .execute();
  repoId = repo.id;

  const T = now - 6 * HOUR;
  // PR 183039's rows at head 2411e5a7: 583 auto failed → 588 manual succeeded → 593 manual failed.
  {
    const id = await seedPr('live183039', '2411e5a7');
    await run('583', id, '2411e5a7', 'failed', 'auto', T);
    await run('588', id, '2411e5a7', 'succeeded', 'manual', T + HOUR);
    await run('593', id, '2411e5a7', 'failed', 'manual', T + 2 * HOUR);
  }
  // PR 182932's rows at head 58028d94: 580 auto failed → 589 manual succeeded → 594 manual failed.
  {
    const id = await seedPr('live182932', '58028d94');
    await run('580', id, '58028d94', 'failed', 'auto', T);
    await run('589', id, '58028d94', 'succeeded', 'manual', T + HOUR);
    await run('594', id, '58028d94', 'failed', 'manual', T + 2 * HOUR);
  }
  // An AUTO success at the head, then a failed auto re-review there: that head is done, press or not.
  {
    const id = await seedPr('autoDone', 'head_auto-done');
    await run('autoDoneOk', id, 'head_auto-done', 'succeeded', 'auto', T);
    await run('autoDoneFail', id, 'head_auto-done', 'failed', 'auto', T + HOUR);
  }
  // The live sequence, then the author pushed: the head moved — the normal moved-head flow.
  {
    const id = await seedPr('moved', 'head_new');
    await run('movedAuto', id, 'head_old', 'failed', 'auto', T);
    await run('movedOk', id, 'head_old', 'succeeded', 'manual', T + HOUR);
    await run('movedManualFail', id, 'head_old', 'failed', 'manual', T + 2 * HOUR);
  }
  // A failed auto run with a MANUAL run still in flight at the head: nothing, press or not.
  {
    const id = await seedPr('flying', 'head_flying');
    await run('flyingAuto', id, 'head_flying', 'failed', 'auto', T);
    await run('flyingManual', id, 'head_flying', 'running', 'manual', T + HOUR);
  }

  workspaceId = (await q.resolveWorkspaceScope(1, null)).workspaceId;
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    log: { info: () => {}, warn: () => {}, error: () => {} },
    queries: { getAutoReviewCandidates: q.getAutoReviewCandidates },
  } as any as AgentContext;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const opts = () => ({ openedSinceMs: FLOOR, dayStartMs: now - 24 * HOUR, limit: 50 });

describe('getAutoReviewCandidates — a press ignores manual rows at the head', () => {
  it('the automatic read does not list the live PRs (a manual success at the head is final)', async () => {
    const res = (await q.getAutoReviewCandidates(1, workspaceId, opts()))!;
    const retried = res.retry.map((r) => r.prId);
    for (const k of ['live183039', 'live182932', 'autoDone', 'moved', 'flying'])
      expect([k, retried.includes(pr[k]!)]).toEqual([k, false]);
  });

  it('the sweep button (`pressed`) lists both live PRs, retrying the failed AUTO run', async () => {
    const res = (await q.getAutoReviewCandidates(1, workspaceId, { ...opts(), pressed: true }))!;
    const byPr = new Map(res.retry.map((r) => [r.prId, r]));
    expect(byPr.get(pr.live183039!)).toMatchObject({
      headSha: '2411e5a7',
      failedReviewId: runId['583'],
      attempts: 1,
      provider: 'codex',
      error: USAGE,
    });
    expect(byPr.get(pr.live182932!)).toMatchObject({ headSha: '58028d94', failedReviewId: runId['580'], attempts: 1 });
    // An AUTO success at the head is final; a moved head is not a retry; a run in flight blocks.
    for (const k of ['autoDone', 'moved', 'flying']) expect([k, byPr.has(pr[k]!)]).toEqual([k, false]);
  });

  it('Retry on one PR (`pressPrId`) lists that PR only', async () => {
    const res = (await q.getAutoReviewCandidates(1, workspaceId, { ...opts(), pressPrId: pr.live182932! }))!;
    expect(res.retry.map((r) => r.prId)).toEqual([pr.live182932]);
    const done = (await q.getAutoReviewCandidates(1, workspaceId, { ...opts(), pressPrId: pr.autoDone! }))!;
    expect(done.retry).toEqual([]);
  });

  it('a moved head follows the normal flow: offered as a moved head, press or not', async () => {
    for (const o of [opts(), { ...opts(), pressed: true }]) {
      const res = (await q.getAutoReviewCandidates(1, workspaceId, o))!;
      expect(res.reReview.find((r) => r.prId === pr.moved)).toMatchObject({ headSha: 'head_new', reason: 'head' });
      expect(res.retry.some((r) => r.prId === pr.moved)).toBe(false);
    }
  });
});

describe('runAutoReviewSweep over the real read — press queues, tick does not', () => {
  beforeEach(() => {
    enqueued.length = 0;
    roster = [{ accountId: 1, workspaceId, enabledAtMs: FLOOR, dailyCap: 20 }];
    auto._resetAutoReReviewForTest();
    auto._setAutoProviderForTest(() => 'codex');
  });

  it('"Run auto reviews now" queues a retry of BOTH live PRs', async () => {
    const r = await auto.runAutoReviewSweep(ctx, now, { accountId: 1, workspaceId });
    const retries = enqueued.filter((e) => e.opts?.retryOfReviewId != null);
    expect(retries).toEqual(
      expect.arrayContaining([
        { prId: pr.live183039, opts: { retryOfReviewId: runId['583'], pressed: true } },
        { prId: pr.live182932, opts: { retryOfReviewId: runId['580'], pressed: true } },
      ]),
    );
    expect(retries.map((e) => e.prId)).not.toContain(pr.autoDone);
    expect(r.retried).toBe(2);
  });

  it('Retry on one live PR queues it', async () => {
    const r = await auto.runAutoReviewSweep(ctx, now, { accountId: 1, workspaceId, prId: pr.live183039! });
    expect(enqueued).toEqual([{ prId: pr.live183039, opts: { retryOfReviewId: runId['583'], pressed: true } }]);
    expect(r).toMatchObject({ queued: 1, retried: 1 });
  });

  it('the automatic tick queues no retry of either live PR (background quota stays unspent)', async () => {
    // Long after the usage reset, so only the manual success holds them back.
    const r = await auto.runAutoReviewSweep(ctx, now + 48 * HOUR);
    expect(enqueued.some((e) => e.prId === pr.live183039 || e.prId === pr.live182932)).toBe(false);
    expect(r.retried ?? 0).toBe(0);
  });

  it('the daily cap still holds for a press', async () => {
    const { utcDayStartMs } = auto;
    const today = (await q.getAutoReviewCandidates(1, workspaceId, { ...opts(), dayStartMs: utcDayStartMs(now), limit: 0 }))!;
    // Room for exactly ONE more auto run today: the press queues one of the two and reports the cap.
    roster = [{ accountId: 1, workspaceId, enabledAtMs: FLOOR, dailyCap: today.autoToday + 1 }];
    const r = await auto.runAutoReviewSweep(ctx, now, { accountId: 1, workspaceId });
    expect(enqueued).toHaveLength(1);
    expect(r).toMatchObject({ queued: 1, capped: true });
  });
});

describe('isAutoRetryStillDue — the lane’s start-time re-check', () => {
  it('a press accepts the failed auto run though manual rows came after it; the tick does not', async () => {
    expect(await persist.isAutoRetryStillDue(ctx, pr.live183039!, 1, '2411e5a7', runId['583']!, true)).toBe(true);
    expect(await persist.isAutoRetryStillDue(ctx, pr.live182932!, 1, '58028d94', runId['580']!, true)).toBe(true);
    expect(await persist.isAutoRetryStillDue(ctx, pr.live183039!, 1, '2411e5a7', runId['583']!)).toBe(false);
    expect(await persist.isAutoRetryStillDue(ctx, pr.live182932!, 1, '58028d94', runId['580']!)).toBe(false);
  });

  it('an AUTO success at the head, a run in flight, a moved head or another tenant refuse a press', async () => {
    expect(await persist.isAutoRetryStillDue(ctx, pr.autoDone!, 1, 'head_auto-done', runId.autoDoneFail!, true)).toBe(false);
    expect(await persist.isAutoRetryStillDue(ctx, pr.flying!, 1, 'head_flying', runId.flyingAuto!, true)).toBe(false);
    expect(await persist.isAutoRetryStillDue(ctx, pr.moved!, 1, 'head_new', runId.movedAuto!, true)).toBe(false);
    expect(await persist.isAutoRetryStillDue(ctx, pr.live183039!, 2, '2411e5a7', runId['583']!, true)).toBe(false);
  });
});

describe('getFailedAutoAtHead — the AI Review tab’s Retry line', () => {
  it('names the failed auto run at the head for both live PRs, and nothing where a press would not act', async () => {
    expect(await persist.getFailedAutoAtHead(ctx, pr.live183039!, 1)).toEqual({ reviewId: runId['583'], error: USAGE });
    expect(await persist.getFailedAutoAtHead(ctx, pr.live182932!, 1)).toEqual({ reviewId: runId['580'], error: USAGE });
    for (const k of ['autoDone', 'moved', 'flying']) expect([k, await persist.getFailedAutoAtHead(ctx, pr[k]!, 1)]).toEqual([k, null]);
    expect(await persist.getFailedAutoAtHead(ctx, pr.live183039!, 2)).toBeNull();
  });
});
