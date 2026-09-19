// PUT /api/workspaces/:id/flow-settings — Chronology's working hours and wait budgets, on a
// THROWAWAY sqlite DB (the pending-mute.test.ts pattern).
//
// What this pins:
//   1. PUT REPLACES THE WHOLE OVERRIDE SET, and `{}` stores NULL — "Reset to defaults" is not a
//      special route, and a field left out goes back to its default rather than keeping an old
//      value nobody can see on the form.
//   2. The 400 carries the SAME sentence `validateFlowSettings` gives the Settings form, so the
//      reader never sees two wordings of one mistake.
//   3. Another account's workspace is a 404, like every other id-addressed workspace route.
//   4. The engine reads what was stored: `getFlowCourts` echoes the resolved settings.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and every value import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const DB_PATH = '/tmp/pierre-flow-settings-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
process.env.WORK_TIMEZONE = 'Europe/Paris';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: FastifyInstance;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let ownWs = 0;
let foreignWs = 0;

const put = async (id: number, body: unknown) => {
  const res = await app.inject({ method: 'PUT', url: `/api/workspaces/${id}/flow-settings`, payload: body as any });
  return { status: res.statusCode, body: res.json() as any };
};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('../../db/queries.js');

  await client.db
    .insert(client.schema.accounts)
    .values({ id: 2, githubUserId: 'U_flow_b', githubLogin: 'flow-b', isLocal: false })
    .execute();
  ownWs = await q.ensureDefaultWorkspace(1);
  foreignWs = await q.ensureDefaultWorkspace(2);

  const { workspaceRoutes } = await import('./workspaces.js');
  const { registerAccountContext } = await import('../plugins/auth.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  registerAccountContext(app);
  await app.register(workspaceRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('PUT /api/workspaces/:id/flow-settings', () => {
  it('stores only what was sent and echoes the workspace', async () => {
    const res = await put(ownWs, {
      timeZone: 'America/New_York',
      days: [5, 1, 2, 3, 4, 4],
      startMinute: 480,
      endMinute: 1020,
      budgets: { firstLook: { good: 2 }, land: {} },
    });
    expect(res.status).toBe(200);
    expect(res.body.workspace.flowSettings).toEqual({
      timeZone: 'America/New_York',
      days: [1, 2, 3, 4, 5],
      startMinute: 480,
      endMinute: 1020,
      budgets: { firstLook: { good: 2 } },
    });
  });

  it('resolves the rest from the defaults, and the engine reads the result', async () => {
    const { getResolvedFlowSettings } = await import('../../db/flow-settings.js');
    const r = await getResolvedFlowSettings(1, ownWs);
    expect(r.timeZone).toBe('America/New_York');
    expect(r.budgets.firstLook).toEqual({ good: 2, ok: 8 });
    expect(r.budgets.reply).toEqual({ good: 8, ok: 16 });
    expect(r.defaults).toEqual({ timeZone: false, hours: false, budgets: false });

    const { getFlowCourts } = await import('../../db/pr-intervals.js');
    const scope = await q.resolveWorkspaceScope(1, ownWs);
    const out = await getFlowCourts(1, scope, 30);
    expect(out.settings?.timeZone).toBe('America/New_York');
    expect(out.settings?.startMinute).toBe(480);
  });

  it('replaces rather than merges — a field left out goes back to its default', async () => {
    const res = await put(ownWs, { budgets: { lead: { good: 6, ok: 12 } } });
    expect(res.body.workspace.flowSettings).toEqual({ budgets: { lead: { good: 6, ok: 12 } } });
    const { getResolvedFlowSettings } = await import('../../db/flow-settings.js');
    const r = await getResolvedFlowSettings(1, ownWs);
    // No zone stored → the deployment default (WORK_TIMEZONE here), marked as a default.
    expect(r.timeZone).toBe('Europe/Paris');
    expect(r.defaults.timeZone).toBe(true);
  });

  it('stores NULL for an empty body — that is "Reset to defaults"', async () => {
    const res = await put(ownWs, {});
    expect(res.status).toBe(200);
    expect(res.body.workspace.flowSettings).toBeNull();
  });

  it('400s with the validator’s own sentence', async () => {
    const { validateFlowSettings } = await import('@pierre-review/shared');
    const bad = { startMinute: 1080, endMinute: 540 };
    const res = await put(ownWs, bad);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(validateFlowSettings(bad));
    expect(res.body.message).toBe('The working day must end after it starts.');

    const zone = await put(ownWs, { timeZone: 'Mars/Olympus_Mons' });
    expect(zone.status).toBe(400);
    expect(zone.body.message).toMatch(/not a time zone/);

    const loose = await put(ownWs, { budgets: { reply: { good: 10, ok: 4 } } });
    expect(loose.status).toBe(400);
    expect(loose.body.message).toBe('“Acceptable” cannot be tighter than “good”.');
  });

  it('404s on another account’s workspace and writes nothing there', async () => {
    const res = await put(foreignWs, { timeZone: 'Asia/Tokyo' });
    expect(res.status).toBe(404);
    const { getResolvedFlowSettings } = await import('../../db/flow-settings.js');
    expect((await getResolvedFlowSettings(2, foreignWs)).defaults.timeZone).toBe(true);
  });
});
