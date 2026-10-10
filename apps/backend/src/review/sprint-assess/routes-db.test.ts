// The sprint assessment's ROUTES (review/sprint-assess/routes.ts) on a THROWAWAY sqlite DB with a
// real Fastify instance, a FAKE runner and a FAKE checkout (never a real model call or clone).
// Pinned: 402 before any DB work on all three; 400 on shape; 404 no_ticket (incl. another tenant's
// ticket through a foreign workspace id); 422 no_repos; 202 start; 409 busy + runningId while a run
// is in flight; GET/cancel of another account's id → 404. (Cloud registers none of these — the
// integrator pins that in review/agentic.test.ts.)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-assess-routes-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let db: any;
let schema: any;
let mgr: typeof import('./manager.js');
let setCaps: ((c: any) => void) | undefined;
let emptyCaps: any;
let fullCaps: any;
let ws = 0;
let foreignWs = 0;
let checkout = '';
const ROOT = 'https://acme.atlassian.net';
const WITH_REPO = `jira:${ROOT}#ENG-1`;
const NO_REPO = `jira:${ROOT}#ENG-2`;
const FOREIGN = `jira:${ROOT}#ENG-9`;
let release: () => void = () => {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  checkout = mkdtempSync(join(tmpdir(), 'sprint-assess-route-'));
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sar_a', githubLogin: 'sar-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sar_b', githubLogin: 'sar-b', isLocal: false }).execute();
  ws = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  const [r] = await db.insert(schema.repos).values({ accountId: 1, githubNodeId: 'R_sar', owner: 'acme', name: 'web' }).returning({ id: schema.repos.id }).execute();
  await q.assignReposToWorkspace(ws, 1, [r.id]);
  const ticket = (accountId: number, workspaceId: number, ident: string) => ({
    accountId,
    workspaceId,
    ident,
    provider: 'jira',
    apiRoot: ROOT,
    issueKey: ident.split('#')[1],
    title: 'T',
    acceptanceCriteria: '- one',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    fetchedAt: new Date(),
    nextCheckAt: new Date(),
  });
  await db.insert(schema.sprintTickets).values([ticket(1, ws, WITH_REPO), ticket(1, ws, NO_REPO), ticket(2, foreignWs, FOREIGN)]).execute();
  await db.insert(schema.sprintTicketRepos).values({ accountId: 1, workspaceId: ws, ident: WITH_REPO, repoId: r.id, via: 'manual', acceptedAt: new Date() }).execute();

  const contract = await import('../../pro/contract.js');
  emptyCaps = contract.EMPTY_CAPABILITIES;
  fullCaps = { ...contract.EMPTY_CAPABILITIES, periodReports: true };
  contract.setProCapabilities(fullCaps);
  setCaps = contract.setProCapabilities;
  mgr = await import('./manager.js');
  mgr.setSprintAssessCheckoutForTests((async (repos: any[]) => ({
    checkouts: repos.map((x) => ({ ...x, path: checkout, repoCloneDir: checkout, sha: 's', error: null })),
    cleanup: async () => {},
  })) as any);
  mgr.setSprintAssessRunnerForTests(async () => {
    await new Promise<void>((res) => {
      release = res;
    });
    return { submitted: null, costUsd: null, inputTokens: 0, outputTokens: 0, numTurns: 1, aborted: false, runtimeMissing: false, subtype: 'success' };
  });
  const { registerSprintAssessRoutes } = await import('./routes.js');
  const { registerAccountContext, accountIdOf } = await import('../../api/plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  registerSprintAssessRoutes(app, {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    accountIdOf,
    recordAiUsage: async () => {},
    llm: { detectAuth: () => ({ status: 'ok' }) },
  } as any);
  await app.ready();
});

afterAll(async () => {
  mgr?.setSprintAssessRunnerForTests(null);
  mgr?.setSprintAssessCheckoutForTests(null);
  setCaps?.(emptyCaps);
  await app?.close();
  await closeDb?.();
  rmSync(checkout, { recursive: true, force: true });
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const assess = (payload: unknown) => app.inject({ method: 'POST', url: '/api/sprint-stories/assess', payload: payload as any });

describe('sprint assessment routes', () => {
  it('402s every route without periodReports, before any DB work', async () => {
    setCaps?.(emptyCaps);
    for (const r of [
      { method: 'POST' as const, url: '/api/sprint-stories/assess', payload: { workspaceId: ws, ident: WITH_REPO } },
      { method: 'GET' as const, url: '/api/sprint-stories/assessments/1' },
      { method: 'POST' as const, url: '/api/sprint-stories/assessments/1/cancel' },
    ]) {
      const res = await app.inject(r);
      expect(res.statusCode).toBe(402);
    }
    expect(await db.select().from(schema.sprintAssessments).execute()).toEqual([]);
    setCaps?.(fullCaps);
  });

  it('refuses bad shapes, unknown and foreign tickets, and tickets with no repo', async () => {
    expect((await assess({ workspaceId: ws })).statusCode).toBe(400);
    expect((await assess({ workspaceId: '1', ident: WITH_REPO })).statusCode).toBe(400);
    const foreign = await assess({ workspaceId: foreignWs, ident: FOREIGN });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe('no_ticket');
    const noRepo = await assess({ workspaceId: ws, ident: NO_REPO });
    expect(noRepo.statusCode).toBe(422);
    expect(noRepo.json()).toEqual({ error: 'no_repos', message: 'Choose at least one repo first.' });
    // Every refusal released the slot.
    expect(mgr.claimSprintAssessSlot(1, NO_REPO)).toBe(true);
    mgr.releaseSprintAssessSlot(1, NO_REPO);
  });

  it('starts one run per ticket; a second click is busy; another account cannot read or cancel it', async () => {
    const res = await assess({ workspaceId: ws, ident: WITH_REPO });
    expect(res.statusCode).toBe(202);
    const id = (res.json() as any).assessment.id as number;
    expect((res.json() as any).assessment).toMatchObject({ ident: WITH_REPO, model: 'claude-sonnet-5' });
    const busy = await assess({ workspaceId: ws, ident: WITH_REPO });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: 'busy', runningId: id });

    const got = await app.inject({ method: 'GET', url: `/api/sprint-stories/assessments/${id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as any).currency).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/sprint-stories/assessments/999999' })).statusCode).toBe(404);
    expect((await mgr.loadSprintAssessment(2, id))).toBeNull();

    const cancelled = await app.inject({ method: 'POST', url: `/api/sprint-stories/assessments/${id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as any).assessment.status).toBe('cancelled');
    release();
    await mgr.sprintAssessRunPromise(id);
    expect((await mgr.loadSprintAssessment(1, id))!.status).toBe('cancelled');
  });
});
