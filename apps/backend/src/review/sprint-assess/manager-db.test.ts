import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The sprint assessment's runs (review/sprint-assess/manager.ts) on a SCRATCH SQLite with a FAKE
// runner and a FAKE checkout — never a real model call, never a real clone, never apps/backend/data.
// Pins: the synchronous slot, the phases, path verification on the stored body, spend recorded,
// failure codes, compare-and-set cancel, the boot sweep, and currency flipping on a ticket text edit
// and on a default-branch head move.

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-assess-manager-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let mgr: typeof import('./manager.js');
let store: typeof import('../../db/sprint-store.js');
let eq: any;
let ws = 0;
let repoId = 0;
let checkoutRoot = '';
const IDENT = 'jira:https://acme.atlassian.net#ENG-1';
const recordAiUsage = vi.fn(async () => {});
let authOk = true;
const ctx = () =>
  ({
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage,
    llm: { detectAuth: () => ({ status: authOk ? 'ok' : 'none' }) },
  }) as any;

let checkoutOk = true;
const fakeCheckout = async (repos: any[]) => ({
  checkouts: repos.map((r) =>
    checkoutOk
      ? { ...r, path: checkoutRoot, repoCloneDir: checkoutRoot, sha: 'checkout-sha', error: null }
      : { ...r, path: null, repoCloneDir: null, sha: null, error: 'clone failed' },
  ),
  cleanup: async () => {},
});

const goodSubmit = {
  criteria: [
    {
      n: 1,
      testableAgainstCode: true,
      existing: 'partial',
      note: 'Kept in memory.',
      landsIn: [
        { repo: 'acme/web', path: 'src/basket.ts', symbol: 'saveBasket' },
        { repo: 'acme/web', path: 'src/invented.ts' },
      ],
    },
  ],
  gaps: { unnamedDependencies: [], unstatedBehaviourChanges: [], dataOrMigrationImpact: ['A new table'], edgeCases: [] },
  suggestion: { rewrittenCriteria: [], addedCriteria: [], split: null, questionsForOwner: ['How long?'], summary: 'Nearly ready.' },
};
const result = (o: Record<string, unknown> = {}) => ({
  submitted: goodSubmit,
  costUsd: 0.4,
  inputTokens: 1000,
  outputTokens: 200,
  numTurns: 12,
  aborted: false,
  runtimeMissing: false,
  subtype: 'success',
  ...o,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  checkoutRoot = mkdtempSync(join(tmpdir(), 'sprint-assess-checkout-'));
  mkdirSync(join(checkoutRoot, 'src'), { recursive: true });
  writeFileSync(join(checkoutRoot, 'src', 'basket.ts'), 'export {}');
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  eq = (await import('drizzle-orm')).eq;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sam_a', githubLogin: 'sam-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sam_b', githubLogin: 'sam-b', isLocal: false }).execute();
  ws = await q.ensureDefaultWorkspace(1);
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, githubNodeId: 'R_sam_web', owner: 'acme', name: 'web', defaultBranchName: 'main', defaultBranchHeadSha: 'sha-1' })
    .returning({ id: schema.repos.id })
    .execute();
  repoId = r.id;
  await q.assignReposToWorkspace(ws, 1, [repoId]);
  await db
    .insert(schema.sprintTickets)
    .values({
      accountId: 1,
      workspaceId: ws,
      ident: IDENT,
      provider: 'jira',
      apiRoot: 'https://acme.atlassian.net',
      issueKey: 'ENG-1',
      title: 'Save basket',
      description: 'As a shopper…',
      acceptanceCriteria: '- Basket survives a reload',
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      fetchedAt: new Date(),
      nextCheckAt: new Date(),
    })
    .execute();
  await db
    .insert(schema.sprintTicketRepos)
    .values({ accountId: 1, workspaceId: ws, ident: IDENT, repoId, via: 'manual', acceptedAt: new Date() })
    .execute();
  store = await import('../../db/sprint-store.js');
  mgr = await import('./manager.js');
  mgr.setSprintAssessCheckoutForTests(fakeCheckout as any);
});

afterAll(async () => {
  mgr?.setSprintAssessRunnerForTests(null);
  mgr?.setSprintAssessCheckoutForTests(null);
  await closeDb?.();
  rmSync(checkoutRoot, { recursive: true, force: true });
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  authOk = true;
  checkoutOk = true;
  recordAiUsage.mockClear();
});

const repos = () => [{ repoId, fullName: 'acme/web', owner: 'acme', name: 'web', defaultBranch: 'main', syncedSha: 'sha-1' }];
const start = async () => {
  const ticket = (await store.readSprintTicket(1, ws, IDENT))!;
  expect(mgr.claimSprintAssessSlot(1, IDENT)).toBe(true);
  const rec = await mgr.startSprintAssessment(ctx(), { accountId: 1, workspaceId: ws, ident: IDENT, ticket, criteria: ['Basket survives a reload'], repos: repos() });
  await mgr.sprintAssessRunPromise(rec.id);
  return (await mgr.loadSprintAssessment(1, rec.id))!;
};

describe('sprint assessment manager', () => {
  it('the slot is synchronous and per (account, ticket)', () => {
    expect(mgr.claimSprintAssessSlot(1, 'jira:x#A-1')).toBe(true);
    expect(mgr.claimSprintAssessSlot(1, 'jira:x#A-1')).toBe(false);
    expect(mgr.claimSprintAssessSlot(2, 'jira:x#A-1')).toBe(true);
    mgr.releaseSprintAssessSlot(1, 'jira:x#A-1');
    mgr.releaseSprintAssessSlot(2, 'jira:x#A-1');
    expect(mgr.claimSprintAssessSlot(1, 'jira:x#A-1')).toBe(true);
    mgr.releaseSprintAssessSlot(1, 'jira:x#A-1');
  });

  it('runs through the phases, verifies paths, records spend and releases the slot', async () => {
    const phases: string[] = [];
    mgr.setSprintAssessRunnerForTests(async (a) => {
      const [row] = await db.select().from(schema.sprintAssessments).where(eq(schema.sprintAssessments.status, 'running')).execute();
      phases.push(row.phase);
      expect(a.model).toBe('claude-sonnet-5');
      expect(a.worktrees).toEqual([checkoutRoot]);
      expect(a.prompt).toContain('Basket survives a reload');
      a.onSubmit?.();
      await new Promise((r) => setTimeout(r, 20));
      const [after] = await db.select().from(schema.sprintAssessments).where(eq(schema.sprintAssessments.id, row.id)).execute();
      phases.push(after.phase);
      return result();
    });
    const row = await start();
    expect(phases).toEqual(['reading', 'writing']);
    expect(row.status).toBe('succeeded');
    expect(row.phase).toBeNull();
    expect(row.bodyJson!.criteria[0]!.landsIn).toEqual([{ repo: 'acme/web', path: 'src/basket.ts', symbol: 'saveBasket' }]);
    expect(row.droppedJson).toEqual({ paths: 1, items: 0 });
    expect(row.reposJson).toEqual([{ repoId, fullName: 'acme/web', sha: 'checkout-sha' }]);
    expect(recordAiUsage).toHaveBeenCalledWith(expect.objectContaining({ accountId: 1, feature: 'sprint_assess', model: 'claude-sonnet-5', costUsd: 0.4 }));
    // The slot was released by the run's end.
    expect(mgr.claimSprintAssessSlot(1, IDENT)).toBe(true);
    mgr.releaseSprintAssessSlot(1, IDENT);
    expect(await mgr.sprintAssessmentCurrency(1, row)).toBe('current');
  });

  it('currency goes stale on a ticket text edit and on a default-branch head move', async () => {
    mgr.setSprintAssessRunnerForTests(async () => result());
    const row = await start();
    expect(await mgr.sprintAssessmentCurrency(1, row)).toBe('current');
    await db.update(schema.repos).set({ defaultBranchHeadSha: 'sha-2' }).where(eq(schema.repos.id, repoId)).execute();
    expect(await mgr.sprintAssessmentCurrency(1, row)).toBe('stale');
    await db.update(schema.repos).set({ defaultBranchHeadSha: 'sha-1' }).where(eq(schema.repos.id, repoId)).execute();
    expect(await mgr.sprintAssessmentCurrency(1, row)).toBe('current');
    await db.update(schema.sprintTickets).set({ acceptanceCriteria: '- Basket survives a reload\n- New' }).where(eq(schema.sprintTickets.ident, IDENT)).execute();
    expect(await mgr.sprintAssessmentCurrency(1, row)).toBe('stale');
    await db.update(schema.sprintTickets).set({ acceptanceCriteria: '- Basket survives a reload' }).where(eq(schema.sprintTickets.ident, IDENT)).execute();
  });

  it('failure codes: no checkout, auth, max turns, no submit, invalid', async () => {
    mgr.setSprintAssessRunnerForTests(async () => result());
    checkoutOk = false;
    expect((await start()).error).toBe('no_checkout');
    checkoutOk = true;
    authOk = false;
    expect((await start()).error).toBe('auth');
    authOk = true;
    mgr.setSprintAssessRunnerForTests(async () => result({ submitted: null, subtype: 'error_max_turns', failureReason: 'stopped' }));
    expect((await start()).error).toBe('max_turns');
    mgr.setSprintAssessRunnerForTests(async () => result({ submitted: null, subtype: 'success', failureReason: 'no call' }));
    expect((await start()).error).toBe('no_assessment');
    mgr.setSprintAssessRunnerForTests(async () => result({ submitted: { criteria: [], suggestion: { summary: '' } } }));
    const invalid = await start();
    expect(invalid.error).toBe('invalid_assessment');
    expect(await mgr.sprintAssessmentCurrency(1, invalid)).toBeNull();
  });

  it('cancel aborts the run, wins over a late finish, and is tenant-scoped', async () => {
    let release: () => void = () => {};
    let seenAbort = false;
    mgr.setSprintAssessRunnerForTests(async (a) => {
      await new Promise<void>((r) => {
        release = r;
      });
      seenAbort = a.abortController.signal.aborted;
      return result(); // a late "success" — must not overwrite the cancel
    });
    const ticket = (await store.readSprintTicket(1, ws, IDENT))!;
    expect(mgr.claimSprintAssessSlot(1, IDENT)).toBe(true);
    const rec = await mgr.startSprintAssessment(ctx(), { accountId: 1, workspaceId: ws, ident: IDENT, ticket, criteria: ['x'], repos: repos() });
    for (let i = 0; i < 50 && (await mgr.loadSprintAssessment(1, rec.id))!.phase !== 'reading'; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(await mgr.cancelSprintAssessment(2, rec.id)).toBeNull();
    const cancelled = (await mgr.cancelSprintAssessment(1, rec.id))!;
    expect(cancelled.status).toBe('cancelled');
    release();
    await mgr.sprintAssessRunPromise(rec.id);
    expect(seenAbort).toBe(true);
    expect((await mgr.loadSprintAssessment(1, rec.id))!.status).toBe('cancelled');
    expect(await mgr.loadSprintAssessment(2, rec.id)).toBeNull();
  });

  it('the boot sweep marks orphaned runs interrupted', async () => {
    const [orphan] = await db
      .insert(schema.sprintAssessments)
      .values({ accountId: 1, workspaceId: ws, ident: IDENT, model: 'claude-sonnet-5', status: 'running', phase: 'reading', fingerprint: 'f', textHash: 'h', reposJson: [] })
      .returning()
      .execute();
    expect(await mgr.reconcileSprintAssessmentsOnStartup()).toBeGreaterThanOrEqual(1);
    const row = (await mgr.loadSprintAssessment(1, orphan.id))!;
    expect(row).toMatchObject({ status: 'failed', error: 'interrupted', phase: null });
  });
});
