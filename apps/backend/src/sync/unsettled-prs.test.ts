// THE UNSETTLED-PR BACKSTOP and the TRUNK-MOVED RECHECK (sync/unsettled-prs.ts). Throwaway sqlite;
// the GitHub liveness read and the token are stubbed, the selection and the write-back
// (`applyPrLiveness`, guards included) are real.
//
// What this pins:
//   1. BOUNDED AT 25 — the merge-state pass's measured batch (50 502s the gateway) — most recently
//      updated first, and only open, non-draft PRs whose merge state is unknown/NULL.
//   2. It WRITES KNOWN OVER UNKNOWN, raises the SPA change signal when a card can move, and — the
//      existing liveness guard, unchanged — never lets an observed UNKNOWN demote a known value.
//   3. It is FREE when there is nothing to re-read: no token, no GitHub call.
//   4. Account-scoped: another tenant's repo id selects nothing.
//   5. Stale CI `pending` → at most 5 settle nudges per walk, never the same PR twice in 20 min.
//   6. After a merge lands: two re-reads (~30s, ~90s), forward cards first.
//   7. A PR still unsettled after two reads — UNKNOWN, merge fields ABSENT, or not answered at
//      all — cools down, EXCLUDED IN THE QUERY; a FAILED read backs the repo's backstop off.
//   8. It never advances `updatedAt` (real activity is the walk's to persist).
//
// DATABASE_URL is set BEFORE importing config/client, and every value import is dynamic inside
// beforeAll (see db/pr-liveness.test.ts for why).
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-unsettled-prs-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/** What the stubbed GitHub answers for each node id asked: observation fields, or omitted. */
let answer: (nodeId: string) => Record<string, unknown> | null = () => ({
  mergeable: 'mergeable',
  mergeStateStatus: 'clean',
});
/** Set to make the next liveness read THROW (a gateway 502). */
let throwRead = false;
const fetchPrLivenessForNodes = vi.fn(
  async (_token: string, ids: string[], _opts: { withMergeState: boolean }) => {
    if (throwRead) throw new Error('502 Bad Gateway');
    return ids.flatMap((nodeId) => {
      const a = answer(nodeId);
      if (!a) return [];
      return [
        {
          nodeId,
          state: 'open' as const,
          isDraft: false,
          updatedAt: null,
          mergedAt: null,
          closedAt: null,
          reviewDecision: null,
          ...a,
        },
      ];
    });
  },
);
vi.mock('../github/pr-liveness.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPrLivenessForNodes,
}));
const getAccessToken = vi.fn(async () => 'tok');
vi.mock('../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken,
}));
const schedulePrSettle = vi.fn();
vi.mock('./pr-settle.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  schedulePrSettle,
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let mod: typeof import('./unsettled-prs.js');
let signal: typeof import('./pr-change-signal.js');
let repoId = 0;
let seq = 0;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const T0 = Date.UTC(2026, 8, 1);

async function seedPr(over: Record<string, unknown> = {}): Promise<{ id: number; node: string }> {
  seq += 1;
  const node = `PR_u_${seq}`;
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: node,
      accountId: 1,
      repoId,
      number: seq,
      title: `pr ${seq}`,
      state: 'open',
      isDraft: false,
      mergeable: 'unknown',
      mergeStateStatus: 'unknown',
      openedAt: new Date(T0),
      // Later seq = more recently updated.
      updatedAt: new Date(T0 + seq * 60_000),
      ...over,
    })
    .returning()
    .execute();
  return { id: row.id, node };
}

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (
    await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, id)).execute()
  )[0];
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mod = await import('./unsettled-prs.js');
  signal = await import('./pr-change-signal.js');
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  // A FRESH repo per test, so every selection sees only this test's rows.
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: `u${seq}`, githubNodeId: `R_u_${seq}` })
    .returning()
    .execute();
  repoId = r.id;
  fetchPrLivenessForNodes.mockClear();
  getAccessToken.mockClear();
  schedulePrSettle.mockClear();
  answer = () => ({ mergeable: 'mergeable', mergeStateStatus: 'clean' });
  throwRead = false;
  mod.__resetUnsettledPrs();
  signal.__resetPrChangeSignal();
});

afterEach(() => {
  vi.useRealTimers();
  mod.__resetUnsettledPrs();
});

describe('recheckRepoMergeStates — the unsettled backstop', () => {
  it('is bounded at 25, most recently updated first, and writes known over unknown', async () => {
    const seeded = [];
    for (let i = 0; i < 30; i++) seeded.push(await seedPr());
    const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(1);
    const asked = fetchPrLivenessForNodes.mock.calls[0]![1];
    expect(asked).toHaveLength(25);
    // The 25 most recently updated — the last 25 seeded.
    expect(new Set(asked)).toEqual(new Set(seeded.slice(5).map((s) => s.node)));
    expect(fetchPrLivenessForNodes.mock.calls[0]![2].withMergeState).toBe(true);
    expect(r).toMatchObject({ checked: 25, changed: 25, stillUnknown: 0, paused: false });
    const written = await rowOf(seeded[29]!.id);
    expect(written.mergeable).toBe('mergeable');
    expect(written.mergeStateStatus).toBe('clean');
    // A card can move → the SPA hears about it.
    expect(signal.lastPrChangeAt(1, repoId)).not.toBeNull();
    // The next pass reaches the 5 it could not.
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(fetchPrLivenessForNodes.mock.calls[1]![1]).toHaveLength(5);
  });

  it('asks nothing — no token, no GitHub call — when nothing is unsettled', async () => {
    await seedPr({ mergeable: 'mergeable', mergeStateStatus: 'clean' });
    await seedPr({ isDraft: true }); // drafts are 'unknown' forever by design
    await seedPr({ state: 'merged' });
    const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(r.checked).toBe(0);
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchPrLivenessForNodes).not.toHaveBeenCalled();
    expect(signal.lastPrChangeAt(1, repoId)).toBeNull();
  });

  it('counts a still-computing answer so the caller can ask once more', async () => {
    const p = await seedPr({ mergeable: null, mergeStateStatus: null });
    answer = () => ({ mergeable: 'unknown', mergeStateStatus: 'unknown' });
    const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(r.stillUnknown).toBe(1);
    // NULL ("never observed") → 'unknown' is still a positive statement from GitHub, so it is
    // written — the existing liveness rule, unchanged.
    expect(r.changed).toBe(1);
    const row = await rowOf(p.id);
    expect(row.mergeable).toBe('unknown');
  });

  it('leaves a PR GitHub answered UNKNOWN for twice running alone for a while', async () => {
    const stuck = await seedPr();
    const fine = await seedPr();
    answer = () => ({ mergeable: 'unknown', mergeStateStatus: 'unknown' });
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
    // Both answered unknown twice → both cool down; a third pass asks GitHub nothing.
    const third = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(third.checked).toBe(0);
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
    // A NEW unsettled PR is still asked about — the cooldown is per PR, not per repo.
    const fresh = await seedPr();
    answer = () => ({ mergeable: 'mergeable', mergeStateStatus: 'clean' });
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(fetchPrLivenessForNodes.mock.calls[2]![1]).toEqual([fresh.node]);
    // The trunk-moved recheck ignores the cooldown: a moved base is a new question.
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'open' });
    expect(new Set(fetchPrLivenessForNodes.mock.calls[3]![1])).toEqual(
      new Set([stuck.node, fine.node, fresh.node]),
    );
  });

  it('a PR answered WITHOUT the merge fields, or not answered at all, cools down too', async () => {
    const absent = await seedPr();
    const unanswered = await seedPr();
    // The token cannot read the merge fields for one; GitHub refuses the other node entirely.
    answer = (node) => (node === unanswered.node ? null : {});
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
    const third = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(third.checked).toBe(0);
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
    // Neither is a literal UNKNOWN, so neither earns the quick second read.
    expect((await rowOf(absent.id)).mergeable).toBe('unknown');
  });

  it('excludes cooling PRs IN THE QUERY, so they cannot crowd out the rest', async () => {
    const a = await seedPr();
    const b = await seedPr();
    const targets = await mod.getRepoMergeStateTargets(1, repoId, 'unsettled', [b.id]);
    expect(targets.map((t) => t.prId)).toEqual([a.id]);
    // The trunk-moved recheck never excludes.
    expect(await mod.getRepoMergeStateTargets(1, repoId, 'open', [b.id])).toHaveLength(2);
  });

  it('a FAILED read backs the repo off for the backstop, not for the trunk-moved recheck', async () => {
    await seedPr();
    throwRead = true;
    const failed = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(failed.checked).toBe(0);
    expect(log.error).not.toHaveBeenCalled();
    throwRead = false;
    const next = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(next.skipped).toBe(true);
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(1);
    // A merge landing is a new question; the recheck still asks.
    await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'open' });
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
  });

  it('never advances updatedAt — that activity is the walk’s to persist', async () => {
    const p = await seedPr();
    const before = (await rowOf(p.id)).updatedAt.getTime();
    answer = () => ({
      mergeable: 'mergeable',
      mergeStateStatus: 'clean',
      updatedAt: new Date(before + 3_600_000).toISOString(),
    });
    const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
    expect(r.changed).toBe(1);
    const row = await rowOf(p.id);
    expect(row.mergeStateStatus).toBe('clean');
    expect(row.updatedAt.getTime()).toBe(before);
  });

  it('is account-scoped: another tenant naming this repo selects nothing', async () => {
    await seedPr();
    expect(await mod.getRepoMergeStateTargets(2, repoId, 'unsettled')).toEqual([]);
    expect(await mod.getRepoMergeStateTargets(2, repoId, 'open')).toEqual([]);
    expect(await mod.getRepoMergeStateTargets(1, repoId, 'unsettled')).toHaveLength(1);
  });

  it('pauses on a limited token — nothing asked, never an error', async () => {
    await seedPr();
    const budget = await import('../github/rate-budget.js');
    budget.noteLimited(1, new Date(Date.now() + 60_000));
    try {
      const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'unsettled' });
      expect(r.paused).toBe(true);
      expect(fetchPrLivenessForNodes).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      budget.__resetRateBudget();
    }
  });
});

describe('the trunk-moved recheck', () => {
  it('ranks forward cards first and never lets an observed UNKNOWN demote a known state', async () => {
    const clean = await seedPr({ mergeable: 'mergeable', mergeStateStatus: 'clean', updatedAt: new Date(T0) });
    for (let i = 0; i < 30; i++) {
      await seedPr({ mergeable: 'mergeable', mergeStateStatus: 'blocked' });
    }
    // GitHub is recomputing everything against the new trunk.
    answer = () => ({ mergeable: 'unknown', mergeStateStatus: 'unknown' });
    const r = await mod.recheckRepoMergeStates({ accountId: 1, repoId, log, mode: 'open' });
    const asked = fetchPrLivenessForNodes.mock.calls[0]![1];
    expect(asked).toHaveLength(25);
    // The OLDEST PR is asked because it renders a Merge button (forward) — ranking, not recency.
    expect(asked[0]).toBe(clean.node);
    expect(r.changed).toBe(0);
    expect((await rowOf(clean.id)).mergeStateStatus).toBe('clean');
    expect(r.stillUnknown).toBe(25);
  });

  it('noteMergeLanded raises the signal now and re-reads at ~30s and ~90s', async () => {
    const merged = await seedPr({ state: 'merged', mergeable: 'mergeable', mergeStateStatus: 'clean' });
    const other = await seedPr({ mergeable: 'mergeable', mergeStateStatus: 'clean' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    answer = () => ({ mergeable: 'mergeable', mergeStateStatus: 'behind' });
    mod.noteMergeLanded(1, merged.id, log);
    await mod.__unsettledPrsDrain();
    expect(signal.lastPrChangeAt(1, repoId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchPrLivenessForNodes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await mod.__unsettledPrsDrain();
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(1);
    expect((await rowOf(other.id)).mergeStateStatus).toBe('behind');
    await vi.advanceTimersByTimeAsync(60_000);
    await mod.__unsettledPrsDrain();
    expect(fetchPrLivenessForNodes).toHaveBeenCalledTimes(2);
  });
});

describe('nudgeStaleCiPending', () => {
  it('nudges at most 5 stale-pending PRs per walk, and never the same PR twice in 20 min', async () => {
    const now = Date.now();
    const stale = [];
    for (let i = 0; i < 7; i++) {
      const p = await seedPr({ ciStatus: 'pending', headSha: `h${i}` });
      await db
        .insert(schema.ciStatusEvents)
        .values({
          accountId: 1,
          repoId,
          prId: p.id,
          headSha: `h${i}`,
          status: 'pending',
          failingChecks: [],
          observedAt: new Date(now - 60 * 60_000),
        })
        .execute();
      stale.push(p);
    }
    // Fresh pending (observed 2 min ago) — CI is simply running; leave it alone.
    const fresh = await seedPr({ ciStatus: 'pending', headSha: 'hf' });
    await db
      .insert(schema.ciStatusEvents)
      .values({
        accountId: 1,
        repoId,
        prId: fresh.id,
        headSha: 'hf',
        status: 'pending',
        failingChecks: [],
        observedAt: new Date(now - 2 * 60_000),
      })
      .execute();

    expect(await mod.nudgeStaleCiPending(1, repoId, log, now)).toBe(5);
    expect(schedulePrSettle).toHaveBeenCalledTimes(5);
    const nudged = new Set(schedulePrSettle.mock.calls.map((c) => c[1]));
    expect(nudged.has(fresh.id)).toBe(false);
    // Same walk again a minute later: only the 2 not yet nudged.
    expect(await mod.nudgeStaleCiPending(1, repoId, log, now + 60_000)).toBe(2);
    // And nothing at all inside the cooldown after that.
    expect(await mod.nudgeStaleCiPending(1, repoId, log, now + 120_000)).toBe(0);
    // Another tenant: nothing.
    expect(await mod.nudgeStaleCiPending(2, repoId, log, now + 60 * 60_000)).toBe(0);
  });
});
