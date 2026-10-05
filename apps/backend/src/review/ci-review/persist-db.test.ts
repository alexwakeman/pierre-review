// THE CI REVIEW over the REAL core client and migrations (sqlite 0082): persistence, the synced
// currency read, the sweeper, AI Fix's CI half and the delete path. What this pins:
//   1. A run round-trips with its items and counts; another account's id reads as null (→ 404).
//   2. ⚠ Currency comes from the SYNCED head + the newest `ci_status_events` row AT that head — no
//      GitHub call; a push or a changed failing set reads stale.
//   3. ⚠ The sweeper queues a red, human-opened PR AT ONCE (no settle, no CI hold), skips a bot's PR,
//      a failure observed before auto review was switched on, a PR whose run is held, and inputs a
//      run already took (a refusal included); its daily cap counts rows written when queued.
//   4. AI Fix's CI half is the latest succeeded run AT THE CURRENT HEAD, fixable items only.
//   5. Both delete paths' helper removes the runs and their items.
//
//   pnpm --filter @pierre-review/backend test ci-review/persist-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ci-review-persist-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

vi.mock('../claude-review/ai-ready.js', () => ({ agenticRunReady: () => true }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let runTransaction: any;
let persist: typeof import('./persist.js');
let currency: typeof import('./currency.js');
let sweep: typeof import('./sweep.js');
let routes: typeof import('./routes.js');
let ctx: AgentContext;
let ws = 0;
let repoId = 0;
let botUserId = 0;
let humanUserId = 0;
const pr: Record<string, number> = {};

const NOW = Date.now();
const T0 = NOW % 86_400_000 > 23 * 3_600_000 ? NOW - 3_600_000 : NOW;
const ENABLED_AT = T0 - 24 * 3_600_000;

async function addPr(tag: string, opts: { authorId: number; ciStatus: string; head?: string; draft?: boolean }): Promise<number> {
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_${tag}`,
      accountId: 1,
      repoId,
      number: Object.keys(pr).length + 1,
      title: tag,
      state: 'open',
      isDraft: opts.draft ?? false,
      authorId: opts.authorId,
      headSha: opts.head ?? `h_${tag}`,
      ciStatus: opts.ciStatus,
      openedAt: new Date(ENABLED_AT - 3_600_000),
      updatedAt: new Date(T0),
    })
    .returning()
    .execute();
  pr[tag] = p.id;
  return p.id;
}

async function event(tag: string, head: string, status: string, failing: string[], observedAt: number): Promise<void> {
  await db
    .insert(schema.ciStatusEvents)
    .values({ accountId: 1, repoId, prId: pr[tag]!, headSha: head, status, failingChecks: failing, observedAt: new Date(observedAt) })
    .execute();
}

const item = (over: Partial<import('./persist.js').CiItemWrite> = {}): import('./persist.js').CiItemWrite => ({
  ref: 'F1',
  checkName: 'test',
  jobId: 12_345_678_901,
  step: 'Run tests',
  url: 'https://github.com/acme/api/actions/runs/1/job/2',
  sent: true,
  carried: false,
  status: 'diagnosed',
  notCheckedReason: null,
  cause: 'A snapshot is out of date',
  explanation: 'e',
  category: 'test',
  fixableInPr: true,
  relatedFiles: [{ path: 'src/a.test.ts', line: 3 }],
  assessedAtHead: 'h',
  path: 'src/a.test.ts',
  line: 3,
  suggestion: 'Update the snapshot.',
  ...over,
});

/** A succeeded run of `tag` at `head` that judged `failing`. */
async function seedRun(tag: string, head: string, failing: string[], items = [item()]): Promise<number> {
  const id = await persist.insertQueuedCiReview(ctx, {
    accountId: 1,
    workspaceId: ws,
    prId: pr[tag]!,
    repoId,
    headSha: head,
    triggerKey: null,
    trigger: 'manual',
    model: 'm',
  });
  await persist.markCiReviewRunning(ctx, 1, id, { headSha: head, failingChecks: failing, ciState: { state: 'failing', checkCount: 3 } });
  await persist.saveCiReviewSuccess(ctx, 1, id, { summary: 'The snapshot test fails.', numTurns: 2, items });
  return id;
}

const queued: number[] = [];
let dailyCap = 20;
let held = new Set<number>();
const deps = (): import('./sweep.js').CiSweepDeps => ({
  roster: async () => [{ accountId: 1, workspaceId: ws, enabledAtMs: ENABLED_AT }],
  enqueue: async (c, a) => {
    const runId = await persist.insertQueuedCiReview(c, {
      accountId: a.accountId,
      workspaceId: a.workspaceId,
      prId: a.prId,
      repoId: a.repoId,
      headSha: a.headSha,
      triggerKey: a.triggerKey,
      trigger: a.trigger,
      model: 'm',
    });
    queued.push(a.prId);
    return { outcome: 'queued', runId };
  },
  laneRoom: () => 20,
  held: (_a, prId) => held.has(prId),
  automationUserIds: async () => new Set([botUserId]),
  dailyCap,
});

async function endQueuedRuns(): Promise<void> {
  const { eq } = await import('drizzle-orm');
  await db.update(schema.ciReviews).set({ status: 'cancelled' }).where(eq(schema.ciReviews.status, 'queued')).execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  runTransaction = client.runTransaction;
  await runMigrations();
  persist = await import('./persist.js');
  currency = await import('./currency.js');
  sweep = await import('./sweep.js');
  routes = await import('./routes.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction,
    recordAiUsage: async () => {},
    host: { isCloud: false },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  for (const id of [1, 2]) {
    await db.insert(schema.accounts).values({ id, githubUserId: `U_${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  }
  const [w] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Team', isDefault: false }).returning().execute();
  ws = w.id;
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId }).execute();
  const [h] = await db.insert(schema.users).values({ githubLogin: 'alice', githubNodeId: 'U_alice' }).returning().execute();
  humanUserId = h.id;
  const [b] = await db.insert(schema.users).values({ githubLogin: 'renovate[bot]', githubNodeId: 'U_bot', isBot: true }).returning().execute();
  botUserId = b.id;

  await addPr('red', { authorId: humanUserId, ciStatus: 'failure' });
  await event('red', 'h_red', 'failure', ['test', 'lint'], T0 - 60_000);
  await addPr('old', { authorId: humanUserId, ciStatus: 'failure' });
  await event('old', 'h_old', 'failure', ['test'], ENABLED_AT - 60_000);
  await addPr('bot', { authorId: botUserId, ciStatus: 'failure' });
  await event('bot', 'h_bot', 'failure', ['test'], T0 - 60_000);
  await addPr('draft', { authorId: humanUserId, ciStatus: 'failure', draft: true });
  await event('draft', 'h_draft', 'failure', ['test'], T0 - 60_000);
  await addPr('green', { authorId: humanUserId, ciStatus: 'success' });
  await event('green', 'h_green', 'success', [], T0 - 60_000);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistence', () => {
  it('a run round-trips with its items and counts; another account reads null', async () => {
    const id = await seedRun('green', 'h_green', ['test'], [item(), item({ ref: null, checkName: 'sonar', jobId: null, status: 'not_checked', notCheckedReason: 'no_log', cause: null, fixableInPr: null, path: null, line: null, suggestion: null })]);
    const run = await persist.getCiReviewById(ctx, 1, id);
    expect(run).toMatchObject({
      status: 'succeeded',
      failingChecks: ['test'],
      summary: 'The snapshot test fails.',
      ciState: { state: 'failing', checkCount: 3 },
      counts: { failing: 2, explained: 1, fixableInPr: 1, notChecked: 1 },
    });
    // A GitHub Actions job id past 2^31 survives the round trip.
    expect(run!.items[0]).toMatchObject({ jobId: 12_345_678_901, path: 'src/a.test.ts', suggestion: 'Update the snapshot.' });
    expect(run!.items[1]).toMatchObject({ status: 'not_checked', notCheckedReason: 'no_log', fixableInPr: null });
    expect(await persist.getCiReviewById(ctx, 2, id)).toBeNull();
    expect(await persist.getLatestCiReviewForPr(ctx, 2, pr.green!)).toBeNull();
  });
});

describe('the synced currency read', () => {
  it('reads the failing names at the CURRENT head only', async () => {
    const synced = await persist.readSyncedCi(ctx, 1, [pr.red!, pr.green!]);
    expect(synced.get(pr.red!)).toMatchObject({ headSha: 'h_red', failingChecks: ['lint', 'test'], passing: false });
    expect(synced.get(pr.red!)!.failingKey).toBe(currency.failingKey(['test', 'lint']));
    expect(synced.get(pr.green!)).toMatchObject({ failingKey: null, passing: true });
    expect((await persist.readSyncedCi(ctx, 2, [pr.red!])).size).toBe(0);
  });

  it('current for the same head + set, stale on a push; another account sees none', async () => {
    const id = await seedRun('red', 'h_red', ['lint', 'test']);
    let st = (await routes.ciStatesFor(ctx, 1, [pr.red!])).get(pr.red!)!;
    expect(st).toMatchObject({ status: 'current', latestRunId: id, counts: { explained: 1 } });
    expect((await routes.ciStatesFor(ctx, 2, [pr.red!])).get(pr.red!)).toMatchObject({ status: 'none', latestRunId: null });
    // Another check fails on the same head.
    await event('red', 'h_red', 'failure', ['test', 'lint', 'e2e'], T0 - 30_000);
    st = (await routes.ciStatesFor(ctx, 1, [pr.red!])).get(pr.red!)!;
    expect(st).toMatchObject({ status: 'stale', staleBecause: 'checks_changed' });
    // Back to the judged set for the rest of the file.
    await event('red', 'h_red', 'failure', ['lint', 'test'], T0 - 20_000);
  });
});

describe('the sweeper', () => {
  it('⚠ queues a red, human PR at once once its inputs move; skips bots, drafts, old failures and covered inputs', async () => {
    sweep._resetCiSweepForTest();
    queued.length = 0;
    // red is covered by its run; old was observed before the switch-on; bot and draft never qualify.
    let r = await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([]);
    expect(r.considered).not.toContain(pr.bot);
    expect(r.considered).not.toContain(pr.draft);
    // A push: due on the very next tick, nothing to wait for.
    const { eq } = await import('drizzle-orm');
    await db.update(schema.pullRequests).set({ headSha: 'h_red2' }).where(eq(schema.pullRequests.id, pr.red!)).execute();
    await event('red', 'h_red2', 'failure', ['test'], T0 - 10_000);
    r = await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([pr.red]);
    // Held (queued or running): never a second one.
    queued.length = 0;
    held = new Set([pr.red!]);
    await endQueuedRuns();
    const { and } = await import('drizzle-orm');
    await db.delete(schema.ciReviews).where(and(eq(schema.ciReviews.prId, pr.red!), eq(schema.ciReviews.headSha, 'h_red2'))).execute();
    await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([]);
    held = new Set();
  });

  it('a refusal on exactly these inputs is not retried; the daily cap counts automatic rows', async () => {
    queued.length = 0;
    const id = await persist.insertQueuedCiReview(ctx, {
      accountId: 1,
      workspaceId: ws,
      prId: pr.red!,
      repoId,
      headSha: 'h_red2',
      triggerKey: currency.failingKey(['test']),
      trigger: 'auto',
      model: 'm',
    });
    await persist.markCiReviewRefused(ctx, 1, id, { reason: 'no_logs', headSha: 'h_red2', failingChecks: ['test'] });
    await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([]);
    const st = (await routes.ciStatesFor(ctx, 1, [pr.red!])).get(pr.red!)!;
    expect(st).toMatchObject({ status: 'stale', staleBecause: 'pushed', refused: 'no_logs' });
    // A new failing set: due — unless the workspace's automatic runs for today are spent.
    await event('red', 'h_red2', 'failure', ['test', 'build'], T0 - 5_000);
    const used = await persist.countAutoCiReviewsSince(ctx, 1, ws, 0);
    dailyCap = used;
    await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([]);
    dailyCap = 20;
    await sweep.runCiReviewSweep(ctx, T0, deps());
    expect(queued).toEqual([pr.red]);
    expect(await persist.countAutoCiReviewsSince(ctx, 2, ws, 0)).toBe(0);
    await endQueuedRuns();
  });
});

describe("AI Fix's CI half and the delete path", () => {
  it('fixable items come only from the latest succeeded run at the CURRENT head', async () => {
    // red's head is h_red2 now; its only success is at h_red.
    expect(await persist.getFixableCiItemsForPr(ctx, 1, pr.red!)).toEqual([]);
    await seedRun('red', 'h_red2', ['build', 'test'], [item(), item({ checkName: 'build', fixableInPr: false })]);
    const items = await persist.getFixableCiItemsForPr(ctx, 1, pr.red!);
    expect(items.map((i) => i.checkName)).toEqual(['test']);
    expect(await persist.getFixableCiItemsForPr(ctx, 2, pr.red!)).toEqual([]);
  });

  it('pruneCiReviewsForPrs removes the runs and their items', async () => {
    const { pruneCiReviewsForPrs } = await import('../../db/ci-review-prune.js');
    await runTransaction(async (tx: any) => pruneCiReviewsForPrs(tx, [pr.red!]));
    const { eq } = await import('drizzle-orm');
    expect(await db.select().from(schema.ciReviews).where(eq(schema.ciReviews.prId, pr.red!)).execute()).toEqual([]);
    const items = await db.select().from(schema.ciReviewItems).execute();
    const runs = await db.select().from(schema.ciReviews).execute();
    expect(items.every((i: { ciReviewId: number }) => runs.some((r: { id: number }) => r.id === i.ciReviewId))).toBe(true);
  });
});
