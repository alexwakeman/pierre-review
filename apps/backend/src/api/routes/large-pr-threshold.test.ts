// The LARGE-PR FLAG's threshold, end to end on a THROWAWAY sqlite DB (the
// sync-activity.test.ts / billing.test.ts pattern): env is set BEFORE importing config/client,
// the real migrations run, and the real route + real query layer are exercised.
//
// Three things are under test, and the first is the one nothing else in the suite would catch:
//
//  1. THE MIGRATION IS REGISTERED. `runMigrations()` reads `migrations/meta/_journal.json`, and
//     an unregistered file SILENTLY SKIPS — the boot looks perfect and the first query 500s on a
//     missing column. Reading and writing the column here is what proves 0057 actually ran.
//     (Its pg twin, 0044, is registered in the OTHER journal and is verified only by the hand
//     replay in docs/MIGRATIONS.md — the suite is SQLite-only and cannot see it.)
//  2. `/api/me` echoes the RESOLVED number plus the is-default flag, top-level.
//  3. The write route accepts a positive integer, accepts `null` as a RESET, and rejects
//     nonsense — 0, negatives, fractions, strings, a missing key.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-large-pr-threshold-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void>) | undefined;

const me = async (): Promise<any> => (await app.inject({ method: 'GET', url: '/api/me' })).json();

const put = async (body: unknown): Promise<any> =>
  app.inject({ method: 'POST', url: '/api/me/large-pr-threshold', payload: body });

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  closeDb = client.closeDb;
  await runMigrations();

  const { getAccountById } = await import('../../auth/account.js');
  const { meRoutes } = await import('./me.js');
  const { default: Fastify } = await import('fastify');
  app = Fastify({ logger: false });
  // Stand in for registerAccountContext: load the REAL migration-seeded account row (id 1) so
  // the /api/me echo reads stored state rather than the synthesized local fallback — the
  // fallback's threshold is hard-coded null and would make the round-trip assertion vacuous.
  app.addHook('onRequest', async (req: any) => {
    req.account = await getAccountById(1);
  });
  await app.register(meRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the large-PR threshold setting', () => {
  it('starts at the product default, flagged as a default rather than a choice', async () => {
    const body = await me();
    expect(body.largePrCodeLocThreshold).toBe(1500);
    expect(body.largePrCodeLocThresholdIsDefault).toBe(true);
    // FREE FEATURE: the flag must be top-level, never inside `pro` — that object is zeroed for
    // free cloud accounts, i.e. exactly this feature's audience.
    expect(body.pro?.largePrCodeLocThreshold).toBeUndefined();
  });

  it('stores a positive integer and echoes it back on /api/me', async () => {
    const res = await put({ threshold: 400 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      largePrCodeLocThreshold: 400,
      largePrCodeLocThresholdIsDefault: false,
    });
    const body = await me();
    expect(body.largePrCodeLocThreshold).toBe(400);
    expect(body.largePrCodeLocThresholdIsDefault).toBe(false);
  });

  it('treats null as a RESET to the default, not as a stored 1500', async () => {
    await put({ threshold: 900 });
    const res = await put({ threshold: null });
    expect(res.statusCode).toBe(200);
    expect(res.json().largePrCodeLocThresholdIsDefault).toBe(true);
    const body = await me();
    expect(body.largePrCodeLocThreshold).toBe(1500);
    // The COLUMN must be null, not 1500 — otherwise a later change to the product default
    // would silently miss every account that had once used this control.
    const { db, schema } = await import('../../db/client.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ t: schema.accounts.largePrCodeLocThreshold })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, 1))
      .execute();
    expect(rows[0]?.t).toBeNull();
  });

  it('rejects nonsense rather than storing it', async () => {
    await put({ threshold: 750 }); // a known-good value to prove nothing below overwrites it
    for (const bad of [0, -1, 12.5, 1_000_001, 'lots', [], {}, [1500]]) {
      const res = await put({ threshold: bad });
      expect(res.statusCode, `threshold=${JSON.stringify(bad)}`).toBe(400);
    }
    // A missing key is not "leave it alone" — the field is required, so "clear it" and
    // "don't touch it" can never be the same request.
    expect((await put({})).statusCode).toBe(400);
    // Nothing above changed the stored value.
    expect((await me()).largePrCodeLocThreshold).toBe(750);
    // An unknown key is STRIPPED, not rejected — Fastify's ajv runs `removeAdditional` with
    // `additionalProperties: false`, app-wide (POST /api/me/benchmark-consent beside this one is
    // spelled identically). Pinned because the setting is per-ACCOUNT: a client that thought it
    // was scoping the write to a workspace gets an account-wide write, silently. There is no
    // second grain to scope to, which is the point — but the behaviour should be on the record.
    const res = await put({ threshold: 100, workspaceId: 3 });
    expect(res.statusCode).toBe(200);
    expect((await me()).largePrCodeLocThreshold).toBe(100);
  });

  // Fastify's ajv runs with `coerceTypes` on across this whole backend, so a NUMERIC STRING is
  // coerced before validation and lands as a real integer. Pinned rather than "fixed": the
  // coercion is app-wide behaviour, the coerced value is still checked against `integer` +
  // `minimum` + `maximum`, and a stored 1500 is exactly what "1500" meant. What must NOT happen
  // is the string reaching the column — that is what this asserts.
  it('coerces a numeric string the way every other route in this app does', async () => {
    const res = await put({ threshold: '1200' });
    expect(res.statusCode).toBe(200);
    expect(res.json().largePrCodeLocThreshold).toBe(1200);
    const { db, schema } = await import('../../db/client.js');
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select({ t: schema.accounts.largePrCodeLocThreshold })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, 1))
      .execute();
    expect(rows[0]?.t).toBe(1200);
  });

  // Same coercion, the other useful direction: an EMPTY STRING becomes `null`, i.e. a reset.
  // That is what a cleared Settings input naturally sends, so it is pinned as behaviour rather
  // than left as an accident — a future `coerceTypes: false` would turn a "clear the field"
  // click into a 400 with nothing on screen explaining it.
  it('reads an empty string as a reset, which is what a cleared input sends', async () => {
    await put({ threshold: 300 });
    const res = await put({ threshold: '' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      largePrCodeLocThreshold: 1500,
      largePrCodeLocThresholdIsDefault: true,
    });
  });
});
