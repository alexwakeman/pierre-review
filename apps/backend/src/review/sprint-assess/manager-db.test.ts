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
  summary: 'Nearly ready: the basket is kept in memory only.',
  plan: [
    { repo: 'acme/web', path: 'src/basket.ts', change: 'Keep the basket in local storage.' },
    { repo: 'acme/web', path: 'src/invented.ts', change: 'A step whose path does not exist: kept without it.' },
  ],
  // Format 6: anything of the retired kind is ignored.
  findings: [{ issue: 'unclear_done', rule: 'vague_term', text: 'ignored' }],
  revisedCriteria: ['ignored'],
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
      // An open tracker link and a finished one: the prompt hands in the OPEN one only, as fenced data.
      blockedByJson: [
        { key: 'ENG-8', title: 'Payments API', status: 'To Do', category: 'new', relation: 'is blocked by', url: null },
        { key: 'ENG-6', title: 'Old spike', status: 'Done', category: 'done', relation: 'depends on', url: null },
      ],
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
const start = async (mode: 'plan' | 'verify' = 'plan') => {
  const ticket = (await store.readSprintTicket(1, ws, IDENT))!;
  expect(mgr.claimSprintAssessSlot(1, IDENT)).toBe(true);
  const rec = await mgr.startSprintAssessment(ctx(), { accountId: 1, workspaceId: ws, ident: IDENT, ticket, criteria: ['Basket survives a reload'], repos: repos(), mode });
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
      expect(a.prompt).not.toContain('BEGIN KNOWN');
      expect(a.prompt).toMatch(
        /---BEGIN REFERENCES \S+---\n- ENG-8 · Payments API · status To Do · blocked_by\n- ENG-6 · Old spike · status Done \(done\) · blocked_by\n---END REFERENCES/,
      );
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
    expect(row.bodyJson!.plan.map((i: any) => i.path)).toEqual(['src/basket.ts', null]);
    expect(row.bodyJson).not.toHaveProperty('findings');
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

  it('the MODE: stored, picks the prompt + tool shape, bounds what the validator keeps; a stage change makes it stale', async () => {
    const seen: string[] = [];
    mgr.setSprintAssessRunnerForTests(async (a) => {
      seen.push(a.mode);
      expect(a.systemPrompt).toContain(a.mode === 'plan' ? 'Expect NO code for it' : 'should already be on the default branch');
      expect(a.prompt).toMatch(a.mode === 'plan' ? /^Plan ticket ENG-1/ : /^Verify ticket ENG-1/);
      return result({
        submitted: {
          ...goodSubmit,
          plan: [{ repo: 'acme/web', path: 'src/basket.ts', change: 'Persist the basket.' }],
          criterionChecks: [{ n: 1, status: 'partly', evidence: 'Kept in memory only.', repo: 'acme/web', path: 'src/basket.ts', tests: 'src/nope.test.ts' }],
          coverage: 'No tests cover criterion 1.',
        },
      });
    });
    // The ticket has no status → Not started → plan.
    const plan = await start('plan');
    expect(plan.mode).toBe('plan');
    expect(plan.bodyJson!.mode).toBe('plan');
    expect(plan.bodyJson!.plan).toEqual([{ repo: 'acme/web', path: 'src/basket.ts', newPath: null, change: 'Persist the basket.' }]);
    expect(plan.bodyJson!.criterionChecks).toEqual([]);
    expect(store.sprintAssessmentRecordOf(plan)).toMatchObject({ mode: 'plan', outdated: false });
    expect(await mgr.sprintAssessmentCurrency(1, plan)).toBe('current');
    // The ticket moves to Done: the plan is stale (the check to run now verifies).
    await db.update(schema.sprintTickets).set({ statusName: 'Done', statusCategory: 'done' }).where(eq(schema.sprintTickets.ident, IDENT)).execute();
    expect(await mgr.sprintAssessmentCurrency(1, plan)).toBe('stale');
    const verify = await start('verify');
    expect(verify.mode).toBe('verify');
    expect(verify.bodyJson!.plan).toEqual([]);
    expect(verify.bodyJson!.criterionChecks).toEqual([
      { n: 1, status: 'partly', evidence: 'Kept in memory only.', ref: { repo: 'acme/web', path: 'src/basket.ts' }, tests: null },
    ]);
    expect(verify.bodyJson!.coverage).toBe('No tests cover criterion 1.');
    expect(await mgr.sprintAssessmentCurrency(1, verify)).toBe('current');
    expect(seen).toEqual(['plan', 'verify']);
    await db.update(schema.sprintTickets).set({ statusName: null, statusCategory: null }).where(eq(schema.sprintTickets.ident, IDENT)).execute();
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
    mgr.setSprintAssessRunnerForTests(async () => result({ submitted: { summary: '', findings: [], revisedCriteria: [] } }));
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
    const rec = await mgr.startSprintAssessment(ctx(), { accountId: 1, workspaceId: ws, ident: IDENT, ticket, criteria: ['x'], repos: repos(), mode: 'plan' });
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

// THE REFERENCE LIBRARY (docs/REFERENCE-DOCS.md § Use in reviews): with the workspace's switch ON and
// a built document, the check is handed the library folder and the block, and only references that
// CHECK OUT are stored; OFF, the run is exactly as before and stores none.
describe('sprint assessment and the reference library', () => {
  const SECTION = 'basket-rules/sections/01-basket.md';
  let docsRoot = '';
  let docsStore: typeof import('../../reference-docs/store.js');

  beforeAll(async () => {
    docsRoot = mkdtempSync(join(tmpdir(), 'sprint-assess-docs-'));
    const paths = await import('../../reference-docs/paths.js');
    paths.setDocsRootForTest(docsRoot);
    docsStore = await import('../../reference-docs/store.js');
    const { renderSection } = await import('../../reference-docs/render.js');
    const { writeIndex } = await import('../../reference-docs/library.js');
    const doc = await docsStore.insertDocRow({
      accountId: 1, workspaceId: ws, slug: 'basket-rules', title: 'Basket rules', sourceKind: 'markdown',
      sourceName: 'basket.md', sourceUrl: null, byteSize: 10, pageCount: null,
    });
    await docsStore.saveDocBuilt(1, doc.id, {
      title: 'Basket rules', summary: 's', topics: ['basket'],
      sections: [{ path: SECTION, title: 'Basket', summary: '', depth: 1, trail: [], headings: [], words: 10 }],
    }, {});
    const lib = paths.libraryDir(1, ws);
    mkdirSync(join(lib, 'basket-rules', 'sections'), { recursive: true });
    writeFileSync(join(lib, 'basket-rules', 'CONTENTS.md'), '# Basket rules\n');
    writeFileSync(
      join(lib, SECTION),
      renderSection({ docTitle: 'Basket rules', index: 0, total: 1, section: { title: 'Basket', trail: [], body: 'A basket is kept for thirty days on the device.' }, prevFile: null, nextFile: null }),
    );
    await writeIndex(1, ws);
  });

  afterAll(async () => {
    (await import('../../reference-docs/paths.js')).setDocsRootForTest(null);
    rmSync(docsRoot, { recursive: true, force: true });
  });

  const submitted = {
    ...goodSubmit,
    docReferences: [
      { link: SECTION, quote: 'kept for thirty days on the device', verdict: 'supports', note: 'Local storage keeps it.' },
      { link: SECTION, quote: 'kept for ninety days on the server', verdict: 'contradicts', note: 'Not in the text.' },
      { link: '../../../etc/hosts', quote: 'kept for thirty days on the device', verdict: 'context', note: 'Outside.' },
    ],
  };

  it('OFF: no folder, the plain prompt, and no references stored', async () => {
    await docsStore.writeDocsInReview(1, ws, false);
    let args: any = null;
    mgr.setSprintAssessRunnerForTests(async (a) => {
      args = a;
      return result({ submitted });
    });
    const row = await start('plan');
    expect(args.docsDir).toBeUndefined();
    expect(args.systemPrompt).not.toContain('reference library');
    expect(row.bodyJson).not.toHaveProperty('references');
  });

  it('ON: the folder + block are handed over, and only the references that check out are stored', async () => {
    await docsStore.writeDocsInReview(1, ws, true);
    let args: any = null;
    mgr.setSprintAssessRunnerForTests(async (a) => {
      args = a;
      return result({ submitted });
    });
    const row = await start('plan');
    expect(row.status).toBe('succeeded');
    expect(args.docsDir).toBe(join(docsRoot, '1', String(ws), 'library'));
    expect(args.systemPrompt).toContain('# Checking the story against the library');
    expect(row.bodyJson!.references).toEqual([
      expect.objectContaining({ path: SECTION, verdict: 'supports', quote: 'kept for thirty days on the device', docTitle: 'Basket rules' }),
    ]);
    expect(store.sprintAssessmentRecordOf(row).body?.references).toHaveLength(1);
    await docsStore.writeDocsInReview(1, ws, false);
  });
});
