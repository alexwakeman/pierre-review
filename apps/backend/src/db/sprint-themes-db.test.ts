import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_THEME_VERSION } from '@pierre-review/shared';

// The sprint THEMES store (db/sprint-themes.ts) on a SCRATCH SQLite — never apps/backend/data. Pins: one
// row per (account, workspace) replaced by each pass, currency by hash + version, the tenant scope of
// the read, and the STRUCTURAL tenancy (a cross-account (workspace, account) pair fails in the DB).

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-themes-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let store: typeof import('./sprint-themes.js');
let wsA = 0;
let wsB = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  db = client.db;
  schema = client.schema;
  const q = await import('./queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_th_a', githubLogin: 'th-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_th_b', githubLogin: 'th-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  store = await import('./sprint-themes.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const v = (names: string[], idents: string[]) => ({
  themes: names.map((name) => ({ name, summary: name === 'Delta' ? 'Delta work: code changes to the API.' : null })),
  assignments: idents.map((ident, i) => ({ ident, theme: names[i % names.length]! })),
  costUsd: 0.002,
  inputTokens: 9000,
  outputTokens: 400,
});

describe('sprint themes store', () => {
  it('stores ONE row per workspace, replaced by the next pass; current only on hash + version', async () => {
    await store.storeSprintThemes(1, wsA, 'h1', v(['Alpha', 'Beta', 'Gamma'], ['i1', 'i2', 'i3', 'i4']));
    await store.storeSprintThemes(1, wsA, 'h2', v(['Delta', 'Echo', 'Fox'], ['i1', 'i2', 'i3']));
    const rows = await db.select().from(schema.sprintThemes).execute();
    expect(rows.filter((r: any) => r.accountId === 1)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputHash: 'h2', themeVersion: SPRINT_THEME_VERSION });
    expect(await store.currentSprintThemes(1, wsA, 'h1')).toBeNull();
    const cur = await store.currentSprintThemes(1, wsA, 'h2');
    expect(cur?.themes.map((t) => t.name)).toEqual(['Delta', 'Echo', 'Fox']);
    expect(cur?.byIdent.get('i3')).toBe('Fox');
    // The summary is stored and read back; a theme with none reads as null.
    expect(cur?.themes.find((t) => t.name === 'Delta')?.summary).toBe('Delta work: code changes to the API.');
    expect(cur?.themes.find((t) => t.name === 'Echo')?.summary).toBeNull();
  });

  it('reads are tenant-scoped; the composite FK refuses a cross-account pair', async () => {
    await store.storeSprintThemes(2, wsB, 'hb', v(['B1', 'B2', 'B3'], ['i1', 'i2', 'i3']));
    expect(await store.storedSprintThemes(1, wsB)).toBeNull();
    expect((await store.storedSprintThemes(2, wsB))?.inputHash).toBe('hb');
    expect((await store.storedSprintThemes(1, wsA))?.inputHash).toBe('h2');
    await expect(store.storeSprintThemes(2, wsA, 'x', v(['X', 'Y', 'Z'], ['i1']))).rejects.toThrow();
  });
});
