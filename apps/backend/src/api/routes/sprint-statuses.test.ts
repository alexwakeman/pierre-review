// Reports → This sprint — PUT /api/sprint-stories/statuses (api/routes/sprint-stories.ts) on a
// THROWAWAY sqlite DB with a real Fastify instance. Pinned: 402 without Reports (before any write);
// 400 bad_request on a malformed body (nothing written); 400 bad_workspace for an id that does not
// resolve to itself (another tenant's, unknown) — never written onto the caller's Default; 200 with the
// stored settings and the recomputed layout; "Reset to automatic" stores NULL.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-statuses-route-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let db: any;
let schema: any;
let setCaps: ((c: any) => void) | undefined;
let emptyCaps: any;
let fullCaps: any;
let ownWs = 0;
let foreignWs = 0;
const ROOT = 'https://acme.atlassian.net';
const NOW = new Date(Date.UTC(2026, 9, 10));

async function stored(workspaceId: number): Promise<unknown> {
  const { eq } = await import('drizzle-orm');
  const [r] = await db.select({ v: schema.workspaces.sprintStatuses }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).execute();
  return r?.v ?? null;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('../../db/queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_sts_a', githubLogin: 'sts-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_sts_b', githubLogin: 'sts-b', isLocal: false }).execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  await db
    .insert(schema.sprintReads)
    .values({
      accountId: 1,
      workspaceId: ownWs,
      provider: 'jira',
      apiRoot: ROOT,
      viewedAt: NOW,
      nextReadAt: NOW,
      statusOrderJson: {
        source: 'jira_board',
        readAt: NOW.toISOString(),
        statuses: [
          { id: '1', name: 'To Do', category: 'new' },
          { id: '3', name: 'In Development', category: 'indeterminate' },
          { id: '4', name: 'Ready for QA', category: 'indeterminate' },
          { id: '6', name: 'Done', category: 'done' },
        ],
      },
    })
    .execute();
  await db
    .insert(schema.sprintTickets)
    .values({
      accountId: 1,
      workspaceId: ownWs,
      ident: `jira:${ROOT}#ENG-1`,
      provider: 'jira',
      apiRoot: ROOT,
      issueKey: 'ENG-1',
      title: 'One',
      statusName: 'Ready for QA',
      statusCategory: 'indeterminate',
      inSprint: true,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      fetchedAt: NOW,
      nextCheckAt: NOW,
    })
    .execute();
  const contract = await import('../../pro/contract.js');
  emptyCaps = contract.EMPTY_CAPABILITIES;
  fullCaps = { ...contract.EMPTY_CAPABILITIES, periodReports: true };
  contract.setProCapabilities(fullCaps);
  setCaps = contract.setProCapabilities;
  const { sprintStoriesRoutes } = await import('./sprint-stories.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(sprintStoriesRoutes);
  await app.ready();
});

afterAll(async () => {
  setCaps?.(emptyCaps);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/sprint-stories/statuses', payload: payload as any });

const sections = (o: Record<string, unknown> = {}) => ({ sections: { not_started: [], in_progress: [], in_review: [], done: [], ...o } });

describe('PUT /api/sprint-stories/statuses', () => {
  it('402 without Reports, nothing written', async () => {
    setCaps?.(emptyCaps);
    const res = await put({ workspaceId: ownWs, settings: sections({ in_review: ['Ready for QA'] }) });
    setCaps?.(fullCaps);
    expect(res.statusCode).toBe(402);
    expect(await stored(ownWs)).toBeNull();
  });

  it('400 bad_request on a malformed body (the retired shape included)', async () => {
    for (const body of [
      {},
      { workspaceId: 'x', settings: { sections: null } },
      { workspaceId: ownWs },
      { workspaceId: ownWs, settings: { order: ['Ready for QA'], deliveredFrom: null } },
      { workspaceId: ownWs, settings: sections({ in_review: 'Ready' }) },
      { workspaceId: ownWs, settings: sections({ in_progress: ['A'], in_review: ['a'] }) },
    ]) {
      const res = await put(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_request');
    }
    expect(await stored(ownWs)).toBeNull();
  });

  it('400 bad_workspace for another tenant’s or an unknown id — never written onto the Default', async () => {
    for (const id of [foreignWs, 99_999]) {
      const res = await put({ workspaceId: id, settings: sections({ in_review: ['Ready for QA'] }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('bad_workspace');
    }
    expect(await stored(ownWs)).toBeNull();
    expect(await stored(foreignWs)).toBeNull();
  });

  it('200: stores the override and answers the recomputed layout; Reset stores NULL', async () => {
    const S = { not_started: [], in_progress: ['Ready for QA', 'In Development'], in_review: [], done: [] };
    const res = await put({ workspaceId: ownWs, settings: { sections: S } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.workspaceId).toBe(ownWs);
    expect(body.settings).toEqual({ sections: S });
    expect(body.statusLayout.orderSource).toBe('override');
    expect([body.statusLayout.codingBegins, body.statusLayout.codingEnds]).toEqual(['Ready for QA', null]);
    expect(body.statusLayout.order.map((o: any) => `${o.name}:${o.stage}`)).toEqual([
      'To Do:not_started',
      'Ready for QA:in_progress',
      'In Development:in_progress',
      'Done:done',
    ]);
    expect(await stored(ownWs)).toEqual({ sections: S });

    const reset = await put({ workspaceId: ownWs, settings: { sections: null } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().statusLayout.orderSource).toBe('jira_board');
    expect(await stored(ownWs)).toBeNull();
  });
});
