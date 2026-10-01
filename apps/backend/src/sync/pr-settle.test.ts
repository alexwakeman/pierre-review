// THE POST-WRITE SETTLE LADDER (sync/pr-settle.ts) and its inline front half,
// settlePrAfterWrite (sync/resync-after-write.ts). Throwaway sqlite; the GitHub fetch
// (`syncOnePr`), the rate-budget gate and the hydration cache are stubbed — the settle decision
// reads REAL rows through the real account-scoped facts select.
//
// What this pins:
//   1. The ladder STOPS the moment the row says what the write implied — and not a read later.
//   2. ⚠ A STALE CONFLICTING/DIRTY FOR THE NEW HEAD KEEPS IT GOING when the writer said
//      `notConflicting`. That verdict is KNOWN, so "both merge columns known" alone would stop on
//      it at step one — the exact false settle that left a resolved PR's "Conflicts" card up.
//   3. A rate-limited account PAUSES the ladder (re-arms, no read) — never an error.
//   4. Every entry is RELEASED on every exit path: settled, exhausted, a throw inside a step, a PR
//      that is not the account's — and the map never outgrows its bound.
//   5. A second write COALESCES: one entry, merged expectations, the ladder restarted.
//   6. settlePrAfterWrite: `visible` = the head expectation met; unmet → handed to the ladder.
//   7. `mergeStateNot` (approve) and `ciNot` (CI rerun) keep a no-head ladder reading past a
//      stale KNOWN value — without them it stops at its first read.
//   8. The inline wait is bounded from the START of the call: a slow resync eats into it, and a
//      slow re-read is raced against what is left.
//
// DATABASE_URL is set BEFORE importing config/client, and every value import is dynamic inside
// beforeAll (see db/pr-liveness.test.ts for why).
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-pr-settle-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/** What the stubbed GitHub read writes into the PR row on each call — a queue, last one sticks. */
let githubAnswers: Array<Record<string, unknown> | 'throw'> = [];
let prIdUnderTest = 0;
/** Real-time latency of each stubbed GitHub read (only for the inline-deadline test). */
let syncDelayMs = 0;
const syncOnePr = vi.fn(async (..._a: unknown[]) => {
  if (syncDelayMs > 0) await new Promise((r) => setTimeout(r, syncDelayMs));
  const next = githubAnswers.length > 1 ? githubAnswers.shift()! : githubAnswers[0];
  if (next === 'throw') throw new Error('boom');
  if (next) {
    const { eq } = await import('drizzle-orm');
    await db
      .update(schema.pullRequests)
      .set(next)
      .where(eq(schema.pullRequests.id, prIdUnderTest))
      .execute();
  }
  return true;
});
vi.mock('./sync-one-pr.js', () => ({ syncOnePr }));

let limited = false;
vi.mock('../github/rate-budget.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isLimited: () => limited,
}));
vi.mock('./hydrate-detail.js', () => ({ invalidatePrHydration: vi.fn() }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let settle: typeof import('./pr-settle.js');
let rsw: typeof import('./resync-after-write.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

async function resetRow(set: Record<string, unknown>): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db
    .update(schema.pullRequests)
    .set({ state: 'open', isDraft: false, ...set })
    .where(eq(schema.pullRequests.id, prIdUnderTest))
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  settle = await import('./pr-settle.js');
  rsw = await import('./resync-after-write.js');
  rsw.__setSettleInlineTiming({ delaysMs: [1, 1, 1], budgetMs: 500 });
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'settle', githubNodeId: 'R_settle' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_settle',
      accountId: 1,
      repoId: repo.id,
      number: 7,
      title: 'settle fixture',
      state: 'open',
      isDraft: false,
      headSha: 'old',
      mergeable: 'conflicting',
      mergeStateStatus: 'dirty',
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prIdUnderTest = pr.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  syncOnePr.mockClear();
  log.info.mockClear();
  log.warn.mockClear();
  log.error.mockClear();
  limited = false;
  syncDelayMs = 0;
  githubAnswers = [];
  settle.__resetPrSettle();
  await resetRow({
    headSha: 'old',
    mergeable: 'conflicting',
    mergeStateStatus: 'dirty',
    ciStatus: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  settle.__resetPrSettle();
});

/** Advance fake time and let every awaited DB round trip inside the step drain. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  // The step awaits real sqlite round trips after its timer fires (facts, sync, facts) — wait for
  // every step that started to FINISH (and arm its successor) before asserting.
  await settle.__prSettleDrain();
}

const CLEAN = { mergeable: 'mergeable', mergeStateStatus: 'clean' };

describe('schedulePrSettle — the ladder', () => {
  it('stops the moment the row has settled, and not a read later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ headSha: 'new', ...CLEAN }];
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new' });
    expect(settle.__prSettleState().size).toBe(1);
    await advance(4_999);
    expect(syncOnePr).not.toHaveBeenCalled();
    await advance(1);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
    await advance(200_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
  });

  it('⚠ keeps going on a STALE conflict for the new head when notConflicting is expected', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // GitHub attached the push but still reports the old verdict — twice — then recomputes.
    githubAnswers = [
      { headSha: 'new', mergeable: 'conflicting', mergeStateStatus: 'dirty' },
      { headSha: 'new', mergeable: 'conflicting', mergeStateStatus: 'dirty' },
      { headSha: 'new', ...CLEAN },
    ];
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new', notConflicting: true });
    await advance(5_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(1);
    await advance(10_000); // t = 15s
    expect(syncOnePr).toHaveBeenCalledTimes(2);
    expect(settle.__prSettleState().size).toBe(1);
    await advance(30_000); // t = 45s
    expect(syncOnePr).toHaveBeenCalledTimes(3);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('without notConflicting the same stale verdict counts as settled (why the flag exists)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ headSha: 'new', mergeable: 'conflicting', mergeStateStatus: 'dirty' }];
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new' });
    await advance(5_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('an unknown merge state keeps it going; the ladder is 4 reads, then released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ headSha: 'new', mergeable: 'unknown', mergeStateStatus: 'unknown' }];
    settle.schedulePrSettle(1, prIdUnderTest, log);
    // Step by step: each step's DB round trips run on real event-loop turns, so the next timer is
    // armed only after the previous step finished.
    for (const gap of [5_000, 10_000, 30_000, 75_000]) await advance(gap);
    expect(syncOnePr).toHaveBeenCalledTimes(4);
    expect(settle.__prSettleState().size).toBe(0);
    await advance(600_000);
    expect(syncOnePr).toHaveBeenCalledTimes(4);
  });

  it('PAUSES while the account is rate-limited — no read, no error — and resumes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ headSha: 'new', ...CLEAN }];
    limited = true;
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new' });
    await advance(5_000);
    await advance(60_000);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(settle.__prSettleState().size).toBe(1);
    expect(log.error).not.toHaveBeenCalled();
    limited = false;
    await advance(60_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('releases its entry when the facts LOOKUP throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // An id the driver refuses to bind: the very first DB read of the step throws.
    const unbindable = { toString: () => '424242' } as unknown as number;
    settle.schedulePrSettle(1, unbindable, log);
    expect(settle.__prSettleState().size).toBe(1);
    await advance(5_000);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(settle.__prSettleState().size).toBe(0);
    expect(log.warn).toHaveBeenCalled();
  });

  it('releases its entry when a step throws', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = ['throw'];
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new' });
    await advance(5_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('releases its entry, reading nothing from GitHub, for a PR that is not the account’s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    settle.schedulePrSettle(2, prIdUnderTest, log, { headSha: 'new' });
    await advance(5_000);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('releases on a PR that already left the open set', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await resetRow({ state: 'merged' });
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'new' });
    await advance(5_000);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('COALESCES a second write: one entry, merged expectations, the ladder restarted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ headSha: 'b', ...CLEAN }];
    settle.schedulePrSettle(1, prIdUnderTest, log, { headNot: 'old' });
    await advance(4_000);
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'b', notConflicting: true });
    // A plain re-read (an approval, a rerun) keeps what the writes before it said.
    settle.schedulePrSettle(1, prIdUnderTest, log);
    expect(settle.__prSettleState().size).toBe(1);
    expect(settle.__prSettleState().get(1, prIdUnderTest)).toEqual({
      step: 0,
      expect: { headSha: 'b', notConflicting: true },
    });
    await advance(4_000); // 8s after the first call, 4s after the restart
    expect(syncOnePr).not.toHaveBeenCalled();
    await advance(1_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('mergeStateNot (approve): a stale BLOCKED keeps it going; the flip to clean stops it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [
      { mergeable: 'mergeable', mergeStateStatus: 'blocked' },
      { mergeable: 'mergeable', mergeStateStatus: 'clean' },
    ];
    settle.schedulePrSettle(1, prIdUnderTest, log, { mergeStateNot: 'blocked' });
    await advance(5_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(1);
    await advance(10_000);
    expect(syncOnePr).toHaveBeenCalledTimes(2);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('without an expectation the same stale BLOCKED stops it at the first read (why it exists)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [{ mergeable: 'mergeable', mergeStateStatus: 'blocked' }];
    settle.schedulePrSettle(1, prIdUnderTest, log);
    await advance(5_000);
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('ciNot (CI rerun): a stale FAILURE keeps it going until the red moves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    githubAnswers = [
      { ...CLEAN, ciStatus: 'failure' },
      { ...CLEAN, ciStatus: 'failure' },
      { ...CLEAN, ciStatus: 'pending' },
    ];
    settle.schedulePrSettle(1, prIdUnderTest, log, { ciNot: 'failure' });
    await advance(5_000);
    await advance(10_000);
    expect(settle.__prSettleState().size).toBe(1);
    await advance(30_000);
    expect(syncOnePr).toHaveBeenCalledTimes(3);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('coalescing keeps mergeStateNot / ciNot unless a newer write restates them', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    settle.schedulePrSettle(1, prIdUnderTest, log, { mergeStateNot: 'blocked' });
    settle.schedulePrSettle(1, prIdUnderTest, log, { ciNot: 'failure' });
    settle.schedulePrSettle(1, prIdUnderTest, log, { headSha: 'x' });
    expect(settle.__prSettleState().get(1, prIdUnderTest)?.expect).toEqual({
      headSha: 'x',
      mergeStateNot: 'blocked',
      ciNot: 'failure',
    });
    settle.schedulePrSettle(1, prIdUnderTest, log, { ciNot: 'error' });
    expect(settle.__prSettleState().get(1, prIdUnderTest)?.expect.ciNot).toBe('error');
  });

  it('is bounded: the oldest ladder is evicted, never an unbounded map', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (let i = 1; i <= 501; i++) settle.schedulePrSettle(1, 100_000 + i, log);
    expect(settle.__prSettleState().size).toBe(500);
    expect(settle.__prSettleState().get(1, 100_001)).toBeNull();
    expect(settle.__prSettleState().get(1, 100_501)).not.toBeNull();
  });
});

describe('settlePrAfterWrite — resync, verify, hand off', () => {
  it('visible once the pushed head is stored; nothing left for the ladder', async () => {
    githubAnswers = [{ headSha: 'new', ...CLEAN }];
    const res = await rsw.settlePrAfterWrite({
      accountId: 1,
      prId: prIdUnderTest,
      log,
      expect: { headSha: 'new', notConflicting: true },
    });
    expect(res).toEqual({ visible: true });
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(0);
  });

  it('a head GitHub has not attached yet: bounded inline re-reads, then visible:false + a ladder', async () => {
    githubAnswers = [{ mergeable: 'conflicting', mergeStateStatus: 'dirty' }];
    const res = await rsw.settlePrAfterWrite({
      accountId: 1,
      prId: prIdUnderTest,
      log,
      expect: { headSha: 'new', notConflicting: true },
    });
    expect(res).toEqual({ visible: false });
    expect(syncOnePr.mock.calls.length).toBeGreaterThan(1);
    expect(syncOnePr.mock.calls.length).toBeLessThanOrEqual(4);
    expect(settle.__prSettleState().get(1, prIdUnderTest)?.expect).toEqual({
      headSha: 'new',
      notConflicting: true,
    });
  });

  it('headNot (a native update-branch): met on the inline re-read that sees the head move', async () => {
    githubAnswers = [
      { headSha: 'old', ...CLEAN },
      { headSha: 'merged-in', mergeable: 'unknown', mergeStateStatus: 'unknown' },
    ];
    const res = await rsw.settlePrAfterWrite({
      accountId: 1,
      prId: prIdUnderTest,
      log,
      expect: { headNot: 'old' },
    });
    expect(res).toEqual({ visible: true });
    // Head met, but GitHub is still computing the new head's merge state → the ladder reads it.
    expect(settle.__prSettleState().size).toBe(1);
  });

  it('no expectation keeps the old meaning (a resync ran) and hands off an unknown verdict', async () => {
    githubAnswers = [{ mergeable: 'unknown', mergeStateStatus: 'unknown' }];
    const res = await rsw.settlePrAfterWrite({ accountId: 1, prId: prIdUnderTest, log });
    expect(res).toEqual({ visible: true });
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    expect(settle.__prSettleState().size).toBe(1);
  });

  it('the inline wait is bounded from the START: a slow resync eats the budget, a slow re-read is raced', async () => {
    // Every GitHub read takes 200ms; the budget is 300ms. The resync alone spends 200 of it, so
    // at most ONE re-read can start, and it is abandoned when the budget runs out. Before the fix
    // the deadline started after the resync and each re-read ran to completion: ~800ms here.
    rsw.__setSettleInlineTiming({ delaysMs: [1, 1, 1], budgetMs: 300 });
    syncDelayMs = 200;
    githubAnswers = [{ mergeable: 'conflicting', mergeStateStatus: 'dirty' }];
    try {
      const t0 = Date.now();
      const res = await rsw.settlePrAfterWrite({
        accountId: 1,
        prId: prIdUnderTest,
        log,
        expect: { headSha: 'new' },
      });
      const elapsed = Date.now() - t0;
      expect(res).toEqual({ visible: false });
      expect(elapsed).toBeLessThan(550);
      expect(syncOnePr.mock.calls.length).toBeLessThanOrEqual(2);
      expect(settle.__prSettleState().get(1, prIdUnderTest)?.expect).toEqual({ headSha: 'new' });
    } finally {
      // Let the abandoned background read finish before the next test resets the row.
      await new Promise((r) => setTimeout(r, 250));
      rsw.__setSettleInlineTiming({ delaysMs: [1, 1, 1], budgetMs: 500 });
    }
  });

  it('never throws, and schedules nothing for a PR that is not the account’s', async () => {
    const res = await rsw.settlePrAfterWrite({
      accountId: 2,
      prId: prIdUnderTest,
      log,
      expect: { headSha: 'new' },
    });
    expect(res).toEqual({ visible: false });
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(settle.__prSettleState().size).toBe(0);
  });
});
