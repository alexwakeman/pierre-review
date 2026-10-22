// GET /api/stories — Reports → "Stories", on a THROWAWAY sqlite DB with a real Fastify instance.
// The fold itself is pinned in db/stories.test.ts; this pins the ROUTE:
//   1. The resolved workspace and the reporting window are echoed; another tenant's id resolves to
//      the caller's Default.
//   2. A workspace with no reading tracker answers `trackerOn: false` with no stories.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(tmpdir(), 'pierre-stories-route-test.sqlite');
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void> | void) | undefined;
let rw: any;
let ownWs = 0;
let foreignWs = 0;

const DAY = 86_400_000;
const NOW = Date.now();
const FROM = NOW - 10 * DAY;
const TO = NOW - 2 * DAY;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  rw = await import('../../db/reporting-window.js');
  const db: any = client.db;
  const schema: any = client.schema;
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_str_b', githubLogin: 'str-b', isLocal: false })
    .execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);
  // The workspace CHOSE no tracker.
  await db.insert(schema.workspaceTrackers).values({ accountId: 1, workspaceId: ownWs, provider: 'none' }).execute();

  const { insightsRoutes } = await import('./insights.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(insightsRoutes);
  await app.ready();
});

afterAll(async () => {
  rw?.registerReportingWindowResolver(null);
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/stories', () => {
  it('echoes the resolved workspace and the reporting window; no tracker → trackerOn false', async () => {
    rw.registerReportingWindowResolver(async () => ({ fromMs: FROM, toMs: TO, mode: 'sprint' }));
    const res = await app.inject({ method: 'GET', url: `/api/stories?workspace=${foreignWs}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.workspaceId).toBe(ownWs);
    expect(body.window).toMatchObject({ mode: 'sprint', from: new Date(FROM).toISOString(), to: new Date(TO).toISOString() });
    expect(body).toMatchObject({ trackerOn: false, stories: [], shortfall: [], unchecked: [], truncated: false });
    expect(typeof body.workingDayHours).toBe('number');
  });
});
