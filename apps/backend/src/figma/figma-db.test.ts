// FIGMA'S SETTING over the REAL core client (a scratch SQLite) and a FAKE Figma: the token is write-only (never
// echoed), sealed at rest, scoped to the account's own workspace (404 otherwise), and "Test token" makes ONE call.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { JiraTransport } from '../tracker/jira/fetch.js';

const DB_PATH = `${process.env.DATABASE_URL ?? `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-figma`}.figma-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let app: FastifyInstance;
let wsA = 0;
let wsB = 0;
const TOKEN = 'figd_secret_token_value';
const seen: Array<{ path: string; token: string | undefined }> = [];
const transport: JiraTransport = async (url, headers) => {
  seen.push({ path: url.pathname, token: headers['x-figma-token'] });
  return headers['x-figma-token'] === TOKEN
    ? { status: 200, contentType: 'application/json', body: JSON.stringify({ handle: 'Ada' }) }
    : { status: 403, contentType: 'application/json', body: '{}' };
};

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../db/queries.js');
  for (const id of [1, 2]) await db.insert(schema.accounts).values({ id, githubUserId: `U${id}`, githubLogin: `me${id}`, isLocal: id === 1 }).onConflictDoNothing().execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  const Fastify = (await import('fastify')).default;
  const { registerFigmaRoutes } = await import('./routes.js');
  app = Fastify({ logger: false });
  registerFigmaRoutes(app, { db, schema, accountIdOf: () => 1, log: { info() {}, warn() {}, error() {} } as any, transport });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

describe('the Figma setting', () => {
  it('none at first; Test token says to save one, and calls nobody', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsA}/figma` })).json()).toEqual({ workspaceId: wsA, hasToken: false, tokenUnreadable: false });
    expect((await app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/figma/check` })).json()).toMatchObject({ ok: false, message: 'Save a token first.' });
    expect(seen).toEqual([]);
  });
  it('a saved token is never echoed, and is not stored as typed when sealing is available', async () => {
    const r = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/figma`, payload: { token: TOKEN } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(TOKEN);
    expect(r.json()).toEqual({ workspaceId: wsA, hasToken: true, tokenUnreadable: false });
    const [row] = await db.select().from(schema.workspaceFigma).execute();
    expect(row.authToken).toMatch(/^(sealed:v1:|plain:)/);
  });
  it('Test token: ONE call to Figma with the saved token', async () => {
    seen.length = 0;
    const r = (await app.inject({ method: 'POST', url: `/api/workspaces/${wsA}/figma/check` })).json();
    expect(r).toEqual({ workspaceId: wsA, ok: true, message: 'The token works, as Ada.' });
    expect(seen).toEqual([{ path: '/v1/me', token: TOKEN }]);
  });
  it('another account’s workspace is a 404, and an empty or double patch is refused', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/workspaces/${wsB}/figma` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsB}/figma`, payload: { token: 'x' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/figma`, payload: { token: 'x', clearToken: true } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/figma`, payload: {} })).statusCode).toBe(400);
  });
  it('remove', async () => {
    const r = await app.inject({ method: 'PUT', url: `/api/workspaces/${wsA}/figma`, payload: { clearToken: true } });
    expect(r.json()).toMatchObject({ hasToken: false });
  });
});
