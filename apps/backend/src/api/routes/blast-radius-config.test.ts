// The BLAST-RADIUS reading settings, end to end on a THROWAWAY sqlite DB — the sibling of
// large-pr-threshold.test.ts beside it, and the same three things are under test:
//
//  1. THE MIGRATION IS REGISTERED. `runMigrations()` reads `migrations/meta/_journal.json`, and
//     an unregistered file SILENTLY SKIPS — the boot looks perfect and the first query 500s on a
//     missing column. Reading and writing the column here is what proves 0062 actually ran.
//     (Its pg twin, 0049, lives in the OTHER journal and is verified only by the hand replay in
//     docs/MIGRATIONS.md — the suite is SQLite-only and cannot see it.)
//  2. `/api/me` echoes the RAW stored config, nulls and all — deliberately NOT a resolved one.
//     If this ever starts returning a resolved object, the SPA's `resolveBlastConfig` will be
//     resolving an already-resolved value and `isDefault` will read false for every account.
//  3. The write route stores a valid config, treats `null` as a RESET, and SANITISES rather than
//     trusting the body — an unknown surface is dropped, a bad override is dropped, and a bad
//     sensitivity clears the whole thing rather than storing half a setting.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-blast-radius-config-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let app: any;
let closeDb: (() => Promise<void>) | undefined;

const me = async (): Promise<any> => (await app.inject({ method: 'GET', url: '/api/me' })).json();

const put = async (body: unknown): Promise<any> =>
  app.inject({ method: 'PUT', url: '/api/me/blast-radius-config', payload: body });

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
  // Stand in for registerAccountContext: load the REAL migration-seeded account row (id 1), so
  // the echo reads stored state rather than the synthesized local fallback (whose config is
  // hard-coded null and would make every round-trip assertion vacuous).
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

describe('the blast-radius config setting', () => {
  it('starts null — "the user has never chosen", not a stored default', async () => {
    // ⚠ The two-state rule. A stored `{sensitivity:'balanced'}` here would freeze this account
    // against any future change to the product defaults.
    expect((await me()).blastRadius).toBeNull();
  });

  it('stores a config and echoes it back RAW on /api/me', async () => {
    const res = await put({ config: { sensitivity: 'cautious', surfacesOff: ['db_schema'] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().blastRadius).toEqual({
      sensitivity: 'cautious',
      surfacesOff: ['db_schema'],
    });
    // ⚠ RAW, not resolved: no `thresholds`, no `isDefault`. The SPA resolves.
    const body = await me();
    expect(body.blastRadius).toEqual({ sensitivity: 'cautious', surfacesOff: ['db_schema'] });
    expect(body.blastRadius.thresholds).toBeUndefined();
  });

  it('treats null as a RESET back to "no opinion"', async () => {
    await put({ config: { sensitivity: 'relaxed', surfacesOff: [] } });
    expect((await put({ config: null })).json().blastRadius).toBeNull();
    expect((await me()).blastRadius).toBeNull();
  });

  it('DROPS an unknown surface rather than rejecting the whole write', async () => {
    // An older backend reading a newer client's payload must degrade to ignoring one opt-out,
    // not to discarding the user's dial.
    const res = await put({
      config: { sensitivity: 'balanced', surfacesOff: ['db_migration', 'not_a_surface'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().blastRadius).toEqual({
      sensitivity: 'balanced',
      surfacesOff: ['db_migration'],
    });
  });

  it('echoes WHAT WAS STORED, never what was sent', async () => {
    // The sanitizer dropped a surface above; if the route echoed `req.body` instead, Settings
    // would render a choice the database does not hold.
    const sent = { sensitivity: 'balanced' as const, surfacesOff: ['auth', 'nonsense'] };
    const echoed = (await put({ config: sent })).json().blastRadius;
    expect(echoed.surfacesOff).toEqual(['auth']);
    expect((await me()).blastRadius).toEqual(echoed);
  });

  it('keeps a valid override and drops an invalid one', async () => {
    const res = await put({
      config: {
        sensitivity: 'balanced',
        surfacesOff: [],
        // 0 would bucket every pull request; the schema rejects it before the sanitizer sees it.
        overrides: { highDirs: 3 },
      },
    });
    expect(res.json().blastRadius.overrides).toEqual({ highDirs: 3 });
  });

  it('rejects a bad sensitivity outright rather than storing half a setting', async () => {
    const res = await put({ config: { sensitivity: 'aggressive', surfacesOff: [] } });
    expect(res.statusCode).toBe(400);
  });

  it.each<[unknown, string]>([
    [{}, 'a missing config key'],
    [{ config: { surfacesOff: [] } }, 'no sensitivity'],
    [{ config: { sensitivity: 'balanced', overrides: { highDirs: 0 } } }, 'a zero override'],
    [{ config: { sensitivity: 'balanced', overrides: { highDirs: 1.5 } } }, 'a fractional override'],
  ])('rejects %#: %s', async (body) => {
    expect((await put(body)).statusCode).toBe(400);
  });

  it('STRIPS an unknown property rather than rejecting — Fastify\'s removeAdditional', async () => {
    // Worth pinning because it is not what `additionalProperties: false` reads like on its own:
    // Fastify's ajv runs with `removeAdditional`, so an unknown key is dropped from the body
    // before the handler sees it. That is the behaviour we want (a newer client's extra field
    // must not 400 an older server), and the sanitizer builds a fresh object anyway, so nothing
    // unvalidated can reach the column by this path.
    const res = await put({ config: { sensitivity: 'balanced', surfacesOff: [], extra: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().blastRadius).toEqual({ sensitivity: 'balanced', surfacesOff: [] });
  });

  it('survives a round trip through the column type in both directions', async () => {
    // The column is JSON in sqlite and jsonb in pg; a value that comes back as a STRING here
    // would mean the drizzle `mode: 'json'` mapping is wrong, and every reader would be parsing
    // a string it thinks is an object.
    await put({ config: { sensitivity: 'cautious', surfacesOff: ['infra', 'auth'] } });
    const back = (await me()).blastRadius;
    expect(typeof back).toBe('object');
    expect(back.surfacesOff).toEqual(['infra', 'auth']);
  });
});
