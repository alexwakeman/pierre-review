// The optional `?fromMs=&toMs=` bounds pair on GET /api/bot-analytics and
// GET /api/bot-analytics/vendor/:key/comments (the People report's real-period refinement), on
// a THROWAWAY sqlite DB with a real Fastify instance (the billing.test.ts pattern).
//
// THE CONTRACT: the pair names a POPULATION, so — unlike `?workspace=`, which degrades — garbage
// 400s: only-together, `fromMs < toMs`, span ≤ 200 days, digits only (ajv). A valid pair is
// echoed back as the response's real window bounds; no pair keeps the enum behaviour untouched.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-triage-window-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void> | void) | undefined;

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 6, 1);
const TO = Date.UTC(2026, 6, 15);

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();

  const routes = await import('./bot-triage.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // Local mode: accountIdOf falls back to the local account (1); the routes' entitlement reads
  // guard on req.account themselves, so no auth plugin is needed for these paths.
  await app.register(routes.botTriageRoutes);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('GET /api/bot-analytics bounds validation', () => {
  it('400s on a lone fromMs or toMs (only valid together)', async () => {
    expect((await getJson(`/api/bot-analytics?fromMs=${FROM}`)).status).toBe(400);
    expect((await getJson(`/api/bot-analytics?toMs=${TO}`)).status).toBe(400);
  });

  it('400s on an inverted or empty range', async () => {
    expect((await getJson(`/api/bot-analytics?fromMs=${TO}&toMs=${FROM}`)).status).toBe(400);
    expect((await getJson(`/api/bot-analytics?fromMs=${FROM}&toMs=${FROM}`)).status).toBe(400);
  });

  it('400s past the 200-day span cap', async () => {
    const to = FROM + 200 * DAY + 1;
    expect((await getJson(`/api/bot-analytics?fromMs=${FROM}&toMs=${to}`)).status).toBe(400);
    // ...while exactly 200 days is fine.
    expect(
      (await getJson(`/api/bot-analytics?fromMs=${FROM}&toMs=${FROM + 200 * DAY}`)).status,
    ).toBe(200);
  });

  it('400s on non-digit bounds (ajv pattern, before the handler)', async () => {
    expect((await getJson(`/api/bot-analytics?fromMs=abc&toMs=${TO}`)).status).toBe(400);
    expect((await getJson(`/api/bot-analytics?fromMs=-5&toMs=${TO}`)).status).toBe(400);
  });

  it('echoes a valid pair as the response window; no pair keeps the enum behaviour', async () => {
    const bounded = await getJson(`/api/bot-analytics?fromMs=${FROM}&toMs=${TO}`);
    expect(bounded.status).toBe(200);
    expect(bounded.body.window).toMatchObject({
      kind: 'rolling_14',
      from: new Date(FROM).toISOString(),
      to: new Date(TO).toISOString(),
    });
    const plain = await getJson('/api/bot-analytics');
    expect(plain.status).toBe(200);
    expect(plain.body.window.kind).toBe('rolling_14');
    // Enum-resolved bounds end at "now", not at the fixture's 2026 period.
    expect(plain.body.window.to).not.toBe(new Date(TO).toISOString());
  });
});

describe('GET /api/bot-analytics/vendor/:key/comments bounds validation', () => {
  it('validates the pair exactly like the analytics route', async () => {
    expect(
      (await getJson(`/api/bot-analytics/vendor/u999/comments?fromMs=${FROM}`)).status,
    ).toBe(400);
    expect(
      (await getJson(`/api/bot-analytics/vendor/u999/comments?fromMs=${TO}&toMs=${FROM}`)).status,
    ).toBe(400);
  });

  it('echoes a valid pair on the comments window', async () => {
    const res = await getJson(
      `/api/bot-analytics/vendor/u999/comments?fromMs=${FROM}&toMs=${TO}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.window).toMatchObject({
      kind: 'rolling_14',
      from: new Date(FROM).toISOString(),
      to: new Date(TO).toISOString(),
    });
    // An unclassified key still answers the empty shape (no oracle), bounds or not.
    expect(res.body.comments).toEqual([]);
  });
});
