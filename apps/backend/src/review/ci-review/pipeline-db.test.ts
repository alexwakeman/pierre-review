// THE CI REVIEW PIPELINE (manager.ts `runPipeline`) over the REAL core client and migrations, with
// GitHub (`ctx.ci`), the checkout and the agent faked. What this pins:
//   1. A run reads the head's checks live, shows Claude only the failing Actions jobs' excerpts, and
//      stores one item per failing check (the third-party one 'no_log').
//   2. ⚠ A refusal runs NO model: every failing check outside GitHub Actions → 'no_logs'.
//   3. An AUTOMATIC run at the same head carries what is already explained and, with nothing new to
//      read, saves with no model at all.
//   4. ⚠ The signed log URL never reaches the stored run: only the check's details page is kept.
//
//   pnpm --filter @pierre-review/backend test ci-review/pipeline-db
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckRun } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

const DB_PATH = '/tmp/pierre-ci-review-pipeline-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const agentCalls: Array<{ prompt: string; worktrees: readonly string[] }> = [];
vi.mock('./agent.js', () => ({
  runCiReviewAgent: async (a: { prompt: string; worktrees: readonly string[] }) => {
    agentCalls.push({ prompt: a.prompt, worktrees: a.worktrees });
    return {
      submitted: true,
      aborted: false,
      payload: {
        summary: 'The snapshot test fails.',
        failures: [
          { ref: 'F1', cause: 'Snapshot out of date', explanation: 'e', category: 'test', fixableInPr: true, confidence: 88, path: 'src/a.test.ts', line: 4, suggestion: 'Update it.' },
        ],
      },
      costUsd: 0.4,
      inputTokens: 10,
      outputTokens: 5,
      numTurns: 3,
    };
  },
}));
vi.mock('../ticket-review/prepare.js', () => ({
  fetchMemberDiffs: async (ms: Array<{ prId: number }>) =>
    new Map(ms.map((m) => [m.prId, { diff: 'diff --git a/src/a.ts b/src/a.ts\n+x', changedFiles: ['src/a.ts'] }])),
  prepareMemberWorktrees: async (ms: Array<{ prId: number }>) => ({
    byPr: new Map(ms.map((m) => [m.prId, { path: '/tmp/wt/fake' }])),
    cleanup: async () => {},
  }),
}));
vi.mock('../clone-manager.js', () => ({ cleanupCloneCache: () => {} }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let persist: typeof import('./persist.js');
let manager: typeof import('./manager.js');
let ctx: AgentContext;
let ws = 0;
let repoId = 0;
let prId = 0;
const HEAD = 'c'.repeat(40);
const SIGNED = 'https://pipelines.actions.githubusercontent.com/signed?sig=SECRET';

let checks: CheckRun[] = [];
const logReads: number[] = [];
const check = (name: string, state: CheckRun['state'], jobId: number | null): CheckRun => ({
  name,
  state,
  url: jobId != null ? `https://github.com/acme/api/actions/runs/1/job/${jobId}` : `https://sonar.example/${name}`,
  runId: jobId != null ? 1 : null,
  jobId,
});

async function waitDone(runId: number): Promise<import('./persist.js').CiReviewRow> {
  for (let i = 0; i < 200; i += 1) {
    const r = await persist.getCiReviewRow(ctx, 1, runId);
    if (r && r.status !== 'queued' && r.status !== 'running') return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('run did not finish');
}

async function start(trigger: 'manual' | 'auto', queued: { headSha?: string; triggerKey?: string | null } = {}): Promise<number> {
  const r = await manager.startCiReview(ctx, {
    accountId: 1,
    workspaceId: ws,
    prId,
    repoId,
    headSha: queued.headSha ?? HEAD,
    triggerKey: queued.triggerKey ?? null,
    trigger,
  });
  if (r.outcome !== 'queued') throw new Error(`not queued: ${r.outcome}`);
  return r.runId;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  persist = await import('./persist.js');
  manager = await import('./manager.js');
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    host: { isCloud: false },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ci: {
      readCommitChecks: async () => ({ ok: true, rollupState: 'FAILURE', checks }),
      readJobLog: async (_a: number, a: { jobId: number }) => {
        logReads.push(a.jobId);
        return { available: true, text: `Error: snapshot mismatch\n(see ${SIGNED.length} chars)`, totalLines: 2, returnedLines: 2, startByte: 0 };
      },
      readFailedStep: async () => 'Run tests',
    },
  } as any as AgentContext;
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_1', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [w] = await db.insert(schema.workspaces).values({ accountId: 1, name: 'Team', isDefault: false }).returning().execute();
  ws = w.id;
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId }).execute();
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: 'PR_1',
      accountId: 1,
      repoId,
      number: 1,
      title: 'Add things',
      state: 'open',
      headSha: HEAD,
      ciStatus: 'failure',
      openedAt: new Date(),
      updatedAt: new Date(),
    })
    .returning()
    .execute();
  prId = p.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  agentCalls.length = 0;
  logReads.length = 0;
});

describe('the CI review pipeline', () => {
  it('⚠ refuses with no model when no failing check has an Actions log', async () => {
    checks = [check('sonar', 'failure', null), check('ok', 'success', 1)];
    const row = await waitDone(await start('manual'));
    expect(row).toMatchObject({ status: 'failed', refused: 'no_logs', failingChecks: ['sonar'] });
    expect(agentCalls).toHaveLength(0);
    expect(logReads).toHaveLength(0);
  });

  it('explains each failing check once; the third-party one is no_log; no log URL is stored', async () => {
    checks = [check('test', 'failure', 2), check('sonar', 'failure', null), check('ok', 'success', 1)];
    const id = await start('manual');
    const row = await waitDone(id);
    expect(row.status).toBe('succeeded');
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]!.worktrees).toEqual(['/tmp/wt/fake']);
    expect(agentCalls[0]!.prompt).toContain('Check: test');
    expect(agentCalls[0]!.prompt).not.toContain('Check: sonar');
    const run = (await persist.getCiReviewById(ctx, 1, id))!;
    expect(run.failingChecks).toEqual(['sonar', 'test']);
    expect(run.items.map((i) => [i.checkName, i.status, i.notCheckedReason])).toEqual([
      ['test', 'diagnosed', null],
      ['sonar', 'not_checked', 'no_log'],
    ]);
    expect(run.items[0]).toMatchObject({ path: 'src/a.test.ts', line: 4, suggestion: 'Update it.', fixableInPr: true, confidence: 88 });
    expect(run.items[1]!.confidence).toBeNull();
    expect(run.counts).toEqual({ failing: 2, explained: 1, fixableInPr: 1, notChecked: 1 });
    expect(JSON.stringify(run)).not.toContain('githubusercontent');
  });

  it('an automatic run at the same head carries what is explained; nothing new ⇒ no model', async () => {
    const id = await start('auto');
    const row = await waitDone(id);
    expect(row.status).toBe('succeeded');
    expect(agentCalls).toHaveLength(0);
    expect(logReads).toHaveLength(0);
    const run = (await persist.getCiReviewById(ctx, 1, id))!;
    expect(run.items[0]).toMatchObject({ checkName: 'test', carried: true, path: 'src/a.test.ts', suggestion: 'Update it.', confidence: 88 });
    expect(run.summary).toBe('The snapshot test fails.');
  });

  it('a click carries nothing: a fresh look', async () => {
    const row = await waitDone(await start('manual'));
    expect(row.status).toBe('succeeded');
    expect(agentCalls).toHaveLength(1);
    expect(logReads).toEqual([2]);
  });

  it('⚠ queued at one head, run at a newer one: the old trigger key is dropped', async () => {
    const { eq } = await import('drizzle-orm');
    const { failingKey } = await import('./currency.js');
    const { ciReviewDue } = await import('./currency.js');
    const NEXT = 'd'.repeat(40);
    const K = failingKey(['test']);
    // Queued for HEAD with HEAD's synced set {test}; the head moves before the run starts, and
    // the new head's `test` is still running and only `lint` has failed when the run reads it.
    await db.update(schema.pullRequests).set({ headSha: NEXT }).where(eq(schema.pullRequests.id, prId)).execute();
    checks = [check('test', 'pending', 2), check('lint', 'failure', 3)];
    const id = await start('auto', { headSha: HEAD, triggerKey: K });
    const row = await waitDone(id);
    expect(row).toMatchObject({ status: 'succeeded', headSha: NEXT, failingChecks: ['lint'], triggerKey: null });
    // `test` then fails on the new head too: the same synced key, and a run is due again.
    const later = new Date((Math.floor(Date.now() / 1000) + 5) * 1000);
    await db
      .insert(schema.ciStatusEvents)
      .values({ accountId: 1, repoId, prId, headSha: NEXT, status: 'failure', failingChecks: ['test'], observedAt: later })
      .execute();
    const synced = (await persist.readSyncedCi(ctx, 1, [prId])).get(prId)!;
    expect(synced.failingKey).toBe(K);
    const inputs = (await persist.getCiStateInputs(ctx, 1, [prId])).get(prId);
    expect(ciReviewDue(inputs, synced)).toBe(true);
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
  });

  it('⚠ a no_failures refusal (a check re-running) waits for the sync to see the failure again', async () => {
    const { ciReviewDue, deriveCiReviewState, failingKey } = await import('./currency.js');
    const AT = 'e'.repeat(40);
    const { eq } = await import('drizzle-orm');
    await db.update(schema.pullRequests).set({ headSha: AT }).where(eq(schema.pullRequests.id, prId)).execute();
    const nowS = Math.floor(Date.now() / 1000);
    // The sync saw `test` failing at AT; someone pressed Re-run, so the live read sees it pending.
    await db
      .insert(schema.ciStatusEvents)
      .values({ accountId: 1, repoId, prId, headSha: AT, status: 'failure', failingChecks: ['test'], observedAt: new Date((nowS - 60) * 1000) })
      .execute();
    checks = [check('test', 'pending', 2)];
    const row = await waitDone(await start('auto', { headSha: AT, triggerKey: failingKey(['test']) }));
    expect(row).toMatchObject({ refused: 'no_failures', triggerKey: null });
    let synced = (await persist.readSyncedCi(ctx, 1, [prId])).get(prId)!;
    let inputs = (await persist.getCiStateInputs(ctx, 1, [prId])).get(prId);
    // The sync has not seen anything since the refusal: not due (no re-queue every tick).
    expect(ciReviewDue(inputs, synced)).toBe(false);
    // The re-run fails again under the same name: due, and "nothing is failing" is withdrawn.
    await db
      .insert(schema.ciStatusEvents)
      .values({ accountId: 1, repoId, prId, headSha: AT, status: 'failure', failingChecks: ['test'], observedAt: new Date((nowS + 60) * 1000) })
      .execute();
    synced = (await persist.readSyncedCi(ctx, 1, [prId])).get(prId)!;
    inputs = (await persist.getCiStateInputs(ctx, 1, [prId])).get(prId);
    expect(ciReviewDue(inputs, synced)).toBe(true);
    expect(deriveCiReviewState(prId, inputs, synced).refused).toBeNull();
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
  });

  it('⚠ the daily cap counts runs, never refusals that ran no model', async () => {
    const before = await persist.countAutoCiReviewsSince(ctx, 1, ws, 0);
    checks = [check('sonar', 'failure', null)];
    const row = await waitDone(await start('auto'));
    expect(row.refused).toBe('no_logs');
    expect(await persist.countAutoCiReviewsSince(ctx, 1, ws, 0)).toBe(before);
  });
});
