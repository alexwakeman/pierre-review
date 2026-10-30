// THE SETTLE SWEEP (sync/settle-sweep.ts). Throwaway sqlite; the GitHub GraphQL client, the token,
// the single-PR sync, the Limn-free CI recompute and the trunk-moved recheck are stubbed. The
// comparison with stored rows, the cadence (adaptive.ts) and the rate budget are real.
//
// What this pins:
//   1. Only PRs that DIFFER from their stored row are re-synced (head, CI, unresolved threads,
//      draft, review decision), at most `syncSettleMaxPrSyncs` per sweep — the rest next sweep.
//   2. A PR GitHub lists that the DB lacks, or one NEWER than stored, marks the repo DIRTY for a
//      walk (no per-PR sync), unless it is older than the walk's own window.
//   3. Nothing is inferred from what GitHub did NOT say: a missing head commit, a thread list
//      longer than one page, a nulled repo. A stored open PR absent from a COMPLETE open list is
//      re-read by number (the one positive statement absence makes).
//   4. Limn's own `limn/…` lines are not CI: a head carrying one is judged on the Limn-free
//      recompute, and only when the raw state could hide a change.
//   5. No mergeability in the sweep (the 502 rule): the trunk moving schedules the existing ≤25
//      merge-state recheck instead; every request asks ≤10 repos.
//   6. Rate limits are pre-empted quietly: a limited account is not asked and not stamped; a
//      limit discovered mid-sweep notes the budget and stops; nothing throws.
//   7. Loop-proof: one re-sync per distinct GitHub answer.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-settle-sweep-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/** The stubbed GraphQL client: every request is recorded and answered by `respond`. */
const requests: Array<{ query: string; vars: Record<string, unknown> }> = [];
let respond: (vars: Record<string, unknown>) => unknown = () => ({});
const client = vi.fn(async (query: string, vars: Record<string, unknown>) => {
  requests.push({ query, vars });
  return respond(vars);
});
vi.mock('../github/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGraphqlClientFor: () => client,
}));
const getAccessToken = vi.fn(async () => 'tok');
vi.mock('../auth/account.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAccessToken,
}));
const syncOnePr = vi.fn(async () => true);
vi.mock('./sync-one-pr.js', () => ({ syncOnePr }));
const scheduleTrunkMovedRecheck = vi.fn();
const runUnsettledPrBackstop = vi.fn(async () => {});
vi.mock('./unsettled-prs.js', () => ({ scheduleTrunkMovedRecheck, runUnsettledPrBackstop }));
const fetchRollupsWithoutLimn = vi.fn(
  async (_c: unknown, _o: string, _n: string, shas: readonly string[]) => ({
    bySha: new Map<string, string | null>(shas.map((s) => [s, 'SUCCESS'])),
    cost: 1,
  }),
);
vi.mock('./limn-ci.js', () => ({ fetchRollupsWithoutLimn }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let sweep: typeof import('./settle-sweep.js');
let adaptive: typeof import('./adaptive.js');
let budget: typeof import('../github/rate-budget.js');
let seq = 0;

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const LAST_WALK = NOW - 10 * 60_000; // the walk window starts 20 min before this
const OLD = new Date(NOW - 2 * 60 * 60_000); // well before the walk window

interface PrSpec {
  number: number;
  updatedAt?: string;
  head?: string | null; // null = no head commit node received
  ci?: string | null;
  limn?: boolean;
  threads?: boolean[]; // isResolved per thread
  threadTotal?: number;
  isDraft?: boolean;
  reviewDecision?: string | null;
}

function prNode(p: PrSpec): Record<string, unknown> {
  const threads = p.threads ?? [];
  return {
    number: p.number,
    id: `PR_${p.number}`,
    updatedAt: p.updatedAt ?? OLD.toISOString(),
    isDraft: p.isDraft ?? false,
    reviewDecision: p.reviewDecision === undefined ? null : p.reviewDecision,
    commits: {
      nodes:
        p.head === null
          ? null
          : [
              {
                commit: {
                  oid: p.head ?? `sha${p.number}`,
                  statusCheckRollup: p.ci === null ? null : { state: p.ci ?? 'SUCCESS' },
                  status: p.limn ? { contexts: [{ context: 'limn/review-claude' }] } : null,
                },
              },
            ],
    },
    reviewThreads: {
      totalCount: p.threadTotal ?? threads.length,
      nodes: threads.map((isResolved) => ({ isResolved })),
    },
  };
}

function repoNode(prs: PrSpec[], opts: { trunk?: string; hasNextPage?: boolean } = {}): unknown {
  return {
    defaultBranchRef: { target: { oid: opts.trunk ?? 'trunk1' } },
    pullRequests: {
      pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.hasNextPage ? 'c1' : null },
      nodes: prs.map(prNode),
    },
  };
}

/** Answer every aliased repo by its name from `byName`. */
function answerRepos(byName: Record<string, unknown>): void {
  respond = (vars) => {
    const out: Record<string, unknown> = {
      rateLimit: { cost: 1, remaining: 4000, resetAt: new Date(NOW + 3_600_000).toISOString() },
    };
    for (let i = 0; `n${i}` in vars; i += 1) out[`r${i}`] = byName[vars[`n${i}`] as string] ?? null;
    return out;
  };
}

async function seedRepo(name: string, accountId = 1): Promise<number> {
  seq += 1;
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId, owner: 'acme', name, githubNodeId: `R_s_${seq}` })
    .returning()
    .execute();
  await db
    .insert(schema.syncState)
    .values({ repoId: r.id, lastIncrementalSyncAt: new Date(LAST_WALK) })
    .execute();
  return r.id;
}

async function seedPr(
  repoId: number,
  p: { number: number; state?: string; head?: string | null; ci?: string; isDraft?: boolean; reviewDecision?: string | null; updatedAt?: Date; unresolved?: number; resolved?: number },
  accountId = 1,
): Promise<number> {
  seq += 1;
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRS_${seq}`,
      accountId,
      repoId,
      number: p.number,
      title: `pr ${p.number}`,
      state: p.state ?? 'open',
      isDraft: p.isDraft ?? false,
      headSha: p.head === undefined ? `sha${p.number}` : p.head,
      ciStatus: p.ci ?? 'success',
      reviewDecision: p.reviewDecision ?? null,
      openedAt: OLD,
      updatedAt: p.updatedAt ?? OLD,
    })
    .returning()
    .execute();
  const threads = [
    ...Array.from({ length: p.unresolved ?? 0 }, () => false),
    ...Array.from({ length: p.resolved ?? 0 }, () => true),
  ];
  for (const isResolved of threads) {
    seq += 1;
    await db
      .insert(schema.reviewThreads)
      .values({
        githubNodeId: `RT_${seq}`,
        prId: row.id,
        path: 'a.ts',
        isResolved,
        derivedState: isResolved ? 'resolved' : 'untouched',
        createdAt: OLD,
      })
      .execute();
  }
  return row.id;
}

const run = () => sweep.runSettleSweep({ log, now: NOW });
const syncedNumbers = () => syncOnePr.mock.calls.map((c) => (c as unknown as [number, number])[1]).sort((a, b) => a - b);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const c = await import('../db/client.js');
  db = c.db;
  schema = c.schema;
  closeDb = c.closeDb;
  await runMigrations();
  sweep = await import('./settle-sweep.js');
  adaptive = await import('./adaptive.js');
  budget = await import('../github/rate-budget.js');
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(async () => {
  // A clean slate per test: only this test's repos exist.
  for (const t of ['reviewThreads', 'pullRequests', 'syncState', 'workspaceRepos', 'repos']) {
    await db.delete(schema[t]).execute();
  }
  requests.length = 0;
  client.mockClear();
  syncOnePr.mockClear();
  syncOnePr.mockImplementation(async () => true);
  scheduleTrunkMovedRecheck.mockClear();
  runUnsettledPrBackstop.mockClear();
  fetchRollupsWithoutLimn.mockClear();
  getAccessToken.mockClear();
  log.warn.mockClear();
  sweep.__resetSettleSweep();
  adaptive.__resetAdaptiveState();
  budget.__resetRateBudget();
});

describe('only PRs that differ are re-synced', () => {
  it('head, CI, threads, draft and review decision each count; an agreeing PR costs nothing', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1 }); // agrees
    await seedPr(repoId, { number: 2 }); // head moved
    await seedPr(repoId, { number: 3, ci: 'pending' }); // CI finished
    await seedPr(repoId, { number: 4, unresolved: 1 }); // thread resolved on github.com
    await seedPr(repoId, { number: 5 }); // marked draft
    await seedPr(repoId, { number: 6 }); // approved
    await seedPr(repoId, { number: 7, unresolved: 1, resolved: 1 }); // agrees, with threads
    answerRepos({
      web: repoNode([
        { number: 1 },
        { number: 2, head: 'newsha' },
        { number: 3, ci: 'SUCCESS' },
        { number: 4, threads: [true] },
        { number: 5, isDraft: true },
        { number: 6, reviewDecision: 'APPROVED' },
        { number: 7, threads: [false, true] },
      ]),
    });
    const r = await run();
    expect(syncedNumbers()).toEqual([2, 3, 4, 5, 6]);
    expect(r).toMatchObject({ repos: 1, compared: 7, prSyncs: 5, deferred: 0, walksMarked: 0, paused: false });
    // One request, and it never asks GitHub to compute mergeability (the 502 rule).
    expect(requests).toHaveLength(1);
    expect(requests[0]!.query).not.toMatch(/mergeable|mergeStateStatus/);
  });

  it('caps the re-syncs per sweep; the rest go on the next sweep', async () => {
    const repoId = await seedRepo('web');
    const specs: PrSpec[] = [];
    for (let n = 1; n <= 25; n += 1) {
      await seedPr(repoId, { number: n, ci: 'pending' });
      specs.push({ number: n, ci: 'SUCCESS' });
    }
    answerRepos({ web: repoNode(specs) });
    const first = await run();
    expect(first).toMatchObject({ prSyncs: 20, deferred: 5 });
    // Next sweep (5 min later). The 20 re-synced ones were remembered; the 5 deferred go now.
    // (The stub sync does not write, so the 20 still differ — and are NOT paid for twice.)
    syncOnePr.mockClear();
    const second = await sweep.runSettleSweep({ log, now: NOW + 5 * 60_000 });
    expect(second.prSyncs).toBe(5);
    expect(syncedNumbers()).toEqual([21, 22, 23, 24, 25]);
  });

  it('pays once per distinct GitHub answer (loop-proof), and again when the answer moves', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' });
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS' }]) });
    await run();
    expect(syncOnePr).toHaveBeenCalledTimes(1);
    await sweep.runSettleSweep({ log, now: NOW + 5 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(1); // the same answer: not re-paid
    answerRepos({ web: repoNode([{ number: 1, ci: 'FAILURE' }]) });
    await sweep.runSettleSweep({ log, now: NOW + 10 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(2);
  });
});

describe('a re-sync that did not land is retried, boundedly', () => {
  it('a failed or stood-down syncOnePr is retried next sweep, up to three times per answer', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'failure' });
    // CI re-ran green on the same head: updatedAt-silent, so nothing but the sweep will see it.
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS' }]) });
    syncOnePr.mockImplementation(async () => false); // a 502 / a stand-down
    await run();
    await sweep.runSettleSweep({ log, now: NOW + 5 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(2); // NOT remembered as done
    await sweep.runSettleSweep({ log, now: NOW + 10 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(3);
    // Three failures on the same answer: given up until GitHub says something new.
    await sweep.runSettleSweep({ log, now: NOW + 15 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(3);
    answerRepos({ web: repoNode([{ number: 1, ci: 'FAILURE', head: 'sha1' }]) });
    await sweep.runSettleSweep({ log, now: NOW + 20 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(3); // FAILURE agrees with the stored failure
    answerRepos({ web: repoNode([{ number: 1, ci: 'PENDING' }]) });
    await sweep.runSettleSweep({ log, now: NOW + 25 * 60_000 });
    expect(syncOnePr).toHaveBeenCalledTimes(4); // a new answer: tried again
  });

  it('a failure then a success is remembered once landed', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' });
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS' }]) });
    syncOnePr.mockImplementationOnce(async () => false);
    await run();
    await sweep.runSettleSweep({ log, now: NOW + 5 * 60_000 }); // lands
    await sweep.runSettleSweep({ log, now: NOW + 10 * 60_000 }); // remembered: not re-paid
    expect(syncOnePr).toHaveBeenCalledTimes(2);
  });
});

describe('the unsettled-PR backstop rides the sweep', () => {
  it('runs for every repo GitHub answered for, after the re-syncs; not for an unread repo', async () => {
    const a = await seedRepo('web');
    const b = await seedRepo('api');
    await seedRepo('gone');
    await seedPr(a, { number: 1, ci: 'pending' });
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS' }]), api: repoNode([]) });
    let syncedBeforeBackstop = false;
    runUnsettledPrBackstop.mockImplementationOnce(async () => {
      syncedBeforeBackstop = syncOnePr.mock.calls.length === 1;
    });
    await run();
    const ids = runUnsettledPrBackstop.mock.calls
      .map((c) => (c as unknown as [{ repoId: number }])[0].repoId)
      .sort((x, y) => x - y);
    expect(ids).toEqual([a, b].sort((x, y) => x - y));
    expect(syncedBeforeBackstop).toBe(true);
  });

  it('not while the account is limited', async () => {
    await seedRepo('web');
    budget.noteLimited(1, new Date(Date.now() + 60 * 60_000));
    await run();
    expect(runUnsettledPrBackstop).not.toHaveBeenCalled();
  });
});

describe('activity the walk will pick up', () => {
  it('a PR newer than stored, or one the DB lacks, marks the repo dirty instead of a sync', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, head: 'old' });
    answerRepos({
      web: repoNode([
        { number: 1, head: 'new', updatedAt: new Date(NOW - 60_000).toISOString() },
        { number: 2, updatedAt: new Date(NOW - 30_000).toISOString() },
      ]),
    });
    const r = await run();
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(r.walksMarked).toBe(1);
    expect(adaptive.isDirty(repoId)).toBe(true);
  });

  it('…but one OLDER than the walk window is synced by number (the walk would never reach it)', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, updatedAt: new Date(OLD.getTime() - 60_000) });
    answerRepos({
      web: repoNode([
        { number: 1, updatedAt: OLD.toISOString() },
        { number: 2, updatedAt: OLD.toISOString() },
      ]),
    });
    await run();
    expect(syncedNumbers()).toEqual([1, 2]);
    expect(adaptive.isDirty(repoId)).toBe(false);
  });
});

describe('nothing is inferred from what GitHub did not say', () => {
  it('no head commit, or a thread list past one page, compares as equal', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' });
    await seedPr(repoId, { number: 2, unresolved: 3 });
    answerRepos({
      web: repoNode([
        { number: 1, head: null },
        { number: 2, threads: [true], threadTotal: 150 },
      ]),
    });
    await run();
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  it('a stored open PR missing from a COMPLETE list is re-read by number; from a partial list, not', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1 });
    await seedPr(repoId, { number: 9 }); // closed on GitHub without a walk noticing
    answerRepos({ web: repoNode([{ number: 1 }]) });
    await run();
    expect(syncedNumbers()).toEqual([9]);

    // The same, but GitHub says there is another page we did not read (cap of 4 pages hit).
    syncOnePr.mockClear();
    sweep.__resetSettleSweep();
    let page = 0;
    respond = (vars) => {
      page += 1;
      const out: Record<string, unknown> = { rateLimit: { cost: 1, remaining: 4000 } };
      for (let i = 0; `n${i}` in vars; i += 1) out[`r${i}`] = repoNode([{ number: 1 }], { hasNextPage: true });
      return out;
    };
    await sweep.runSettleSweep({ log, now: NOW + 15 * 60_000 });
    expect(page).toBe(4); // followed pages, bounded
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  it('a repo GitHub returns null for is skipped, not judged empty', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1 });
    answerRepos({}); // r0: null
    const r = await run();
    expect(r.repos).toBe(0);
    expect(syncOnePr).not.toHaveBeenCalled();
  });
});

describe("Limn's own status lines are not CI", () => {
  it('a raw PENDING held up by a limn/ line is judged on the Limn-free recompute', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' }); // stored before CI finished
    await seedPr(repoId, { number: 2, ci: 'success' }); // already right
    answerRepos({
      web: repoNode([
        { number: 1, ci: 'PENDING', limn: true },
        { number: 2, ci: 'PENDING', limn: true },
      ]),
    });
    await run(); // the recompute stub says SUCCESS for both heads
    expect(fetchRollupsWithoutLimn).toHaveBeenCalledTimes(1);
    expect(syncedNumbers()).toEqual([1]);
  });

  it('a raw SUCCESS with a limn/ line over a stored success costs no recompute', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'success' });
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS', limn: true }]) });
    await run();
    expect(fetchRollupsWithoutLimn).not.toHaveBeenCalled();
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  // A walk persisted a fresh head before any check registered (stored `unknown`); CI then ran and
  // passed, and Limn's own line went green too. The raw SUCCESS cannot say which — recompute.
  it('a raw SUCCESS with a limn/ line over a stored unknown is recomputed, not assumed equal', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'unknown' }); // CI registered and passed since
    await seedPr(repoId, { number: 2, ci: 'unknown' }); // only Limn's line: still "no CI"
    fetchRollupsWithoutLimn.mockImplementationOnce(async () => ({
      bySha: new Map<string, string | null>([
        ['sha1', 'SUCCESS'],
        ['sha2', null],
      ]),
      cost: 1,
    }));
    answerRepos({
      web: repoNode([
        { number: 1, ci: 'SUCCESS', limn: true },
        { number: 2, ci: 'SUCCESS', limn: true },
      ]),
    });
    await run();
    expect(fetchRollupsWithoutLimn).toHaveBeenCalledTimes(1);
    expect(syncedNumbers()).toEqual([1]);
  });

  it('…and with the recompute unavailable, the stored unknown is left unjudged', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'unknown' });
    fetchRollupsWithoutLimn.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    answerRepos({ web: repoNode([{ number: 1, ci: 'SUCCESS', limn: true }]) });
    await run();
    expect(syncOnePr).not.toHaveBeenCalled();
  });

  it('a failed recompute leaves that CI unjudged rather than guessing', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' });
    fetchRollupsWithoutLimn.mockRejectedValueOnce(new Error('502 Bad Gateway'));
    answerRepos({ web: repoNode([{ number: 1, ci: 'PENDING', limn: true }]) });
    await run();
    expect(syncOnePr).not.toHaveBeenCalled();
  });
});

describe('merge state: never asked here; the trunk moving schedules the ≤25 recheck', () => {
  it('first sight and every move schedule it; a still trunk does not', async () => {
    const repoId = await seedRepo('web');
    answerRepos({ web: repoNode([], { trunk: 'A' }) });
    await run();
    expect(scheduleTrunkMovedRecheck).toHaveBeenCalledWith(1, repoId, log);
    scheduleTrunkMovedRecheck.mockClear();
    await sweep.runSettleSweep({ log, now: NOW + 15 * 60_000 });
    expect(scheduleTrunkMovedRecheck).not.toHaveBeenCalled();
    answerRepos({ web: repoNode([], { trunk: 'B' }) });
    await sweep.runSettleSweep({ log, now: NOW + 30 * 60_000 });
    expect(scheduleTrunkMovedRecheck).toHaveBeenCalledTimes(1);
  });

  it('aliases at most 10 repos per request', async () => {
    const byName: Record<string, unknown> = {};
    for (let i = 0; i < 23; i += 1) {
      await seedRepo(`r${i}`);
      byName[`r${i}`] = repoNode([]);
    }
    answerRepos(byName);
    const r = await run();
    expect(r.repos).toBe(23);
    expect(requests.map((q) => Object.keys(q.vars).filter((k) => k.startsWith('n')).length)).toEqual([10, 10, 3]);
  });
});

describe('cadence and rate limits', () => {
  it('reads a repo only when its settle interval is due', async () => {
    await seedRepo('web');
    answerRepos({ web: repoNode([]) });
    await run();
    expect(requests).toHaveLength(1);
    await sweep.runSettleSweep({ log, now: NOW + 60_000 });
    expect(requests).toHaveLength(1); // not due yet
  });

  it('a limited account is not asked and not stamped — read as soon as the window lifts', async () => {
    const repoId = await seedRepo('web');
    budget.noteLimited(1, new Date(Date.now() + 60 * 60_000));
    const r = await run();
    expect(r.paused).toBe(true);
    expect(requests).toHaveLength(0);
    expect(adaptive.isSettleDue(repoId, NOW + 1)).toBe(true);
  });

  it('a limit discovered by the read notes the budget, stops quietly, and never throws', async () => {
    const repoId = await seedRepo('web');
    await seedPr(repoId, { number: 1, ci: 'pending' });
    respond = () => {
      throw Object.assign(new Error('API rate limit exceeded'), { status: 429 });
    };
    const r = await run();
    expect(r.paused).toBe(true);
    expect(budget.isLimited(1)).toBe(true);
    expect(syncOnePr).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled(); // a pause, not an error
  });

  it('any other failure is a warn line, and the repo is stamped (not re-asked every tick)', async () => {
    const repoId = await seedRepo('web');
    respond = () => {
      throw Object.assign(new Error('Bad credentials'), { status: 401 });
    };
    const r = await run();
    expect(r.paused).toBe(false);
    expect(log.warn).toHaveBeenCalled();
    expect(adaptive.isSettleDue(repoId, NOW + 60_000)).toBe(false);
    expect(adaptive.lastCheckedAtFor(repoId)).toBeNull(); // stamped, but not "checked"
  });

  it('one sweep at a time', async () => {
    await seedRepo('web');
    let release!: () => void;
    respond = () =>
      new Promise((resolve) => {
        release = () => resolve({ rateLimit: { cost: 1, remaining: 4000 }, r0: repoNode([]) });
      });
    const first = run();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect((await run()).skipped).toBe(true);
    release();
    expect((await first).skipped).toBe(false);
  });
});

describe('account scoping', () => {
  it("another account's rows are never read as this repo's stored state", async () => {
    const repoId = await seedRepo('web');
    // A row for the same repo id under ANOTHER account (structurally impossible in practice; the
    // read must still not see it).
    await seedPr(repoId, { number: 1, ci: 'pending' }, 2);
    const stored = await sweep.getSettleStoredPrs(1, repoId, [1]);
    expect(stored).toEqual([]);
  });
});
