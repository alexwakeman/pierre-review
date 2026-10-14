import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPRINT_STORY_VERSION } from '@pierre-review/shared';

// The sprint STORY store (db/sprint-story.ts) on a SCRATCH SQLite — never apps/backend/data. Pins: one
// row per (account, workspace) replaced by each pass, currency by hash + version, the tenant scope of
// the read, and the STRUCTURAL tenancy (a cross-account (workspace, account) pair fails in the DB).

const DB_PATH = '/private/tmp/claude-501/pierre-sprint-story-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let store: typeof import('./sprint-story.js');
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
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_st_a', githubLogin: 'st-a', isLocal: true }).execute();
  if (!have.has(2)) await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_st_b', githubLogin: 'st-b', isLocal: false }).execute();
  wsA = await q.ensureDefaultWorkspace(1);
  wsB = await q.ensureDefaultWorkspace(2);
  store = await import('./sprint-story.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const v = (headline: string) => ({
  headline,
  focus: 'The sprint is about checkout.',
  storylines: [{ kind: 'chain' as const, title: 'Checkout', sentence: 'Checkout is under way.', idents: ['i1', 'i2'] }],
  costUsd: 0.001,
  inputTokens: 4000,
  outputTokens: 300,
});

describe('sprint story store', () => {
  it('stores ONE row per workspace, replaced by the next pass; current only on hash + version', async () => {
    await store.storeSprintStory(1, wsA, 'h1', v('First'));
    await store.storeSprintStory(1, wsA, 'h2', v('Second'));
    const rows = await db.select().from(schema.sprintStory).execute();
    expect(rows.filter((r: any) => r.accountId === 1)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inputHash: 'h2', storyVersion: SPRINT_STORY_VERSION });
    expect(await store.currentSprintStory(1, wsA, 'h1')).toBeNull();
    const cur = await store.currentSprintStory(1, wsA, 'h2');
    expect(cur?.headline).toBe('Second');
    expect(cur?.focus).toBe('The sprint is about checkout.');
    expect(cur?.storylines[0]?.idents).toEqual(['i1', 'i2']);
  });

  it('latestSprintStory: the last story whatever its input (display), currency only gates a re-run', async () => {
    await store.storeSprintStory(1, wsA, 'h3', v('Third'));
    expect(await store.currentSprintStory(1, wsA, 'h4')).toBeNull();
    expect((await store.latestSprintStory(1, wsA))?.headline).toBe('Third');
    expect(await store.latestSprintStory(2, wsA)).toBeNull();
    // ⚠ An OLDER version still shows (stale) — a version bump must never blank the strip.
    await db.update(schema.sprintStory).set({ storyVersion: SPRINT_STORY_VERSION - 1 }).execute();
    expect((await store.latestSprintStory(1, wsA))?.headline).toBe('Third');
    expect(await store.currentSprintStory(1, wsA, 'h3')).toBeNull();
  });

  it('reads are tenant-scoped; the composite FK refuses a cross-account pair', async () => {
    await store.storeSprintStory(2, wsB, 'hb', v('B'));
    expect(await store.storedSprintStory(1, wsB)).toBeNull();
    expect((await store.storedSprintStory(2, wsB))?.inputHash).toBe('hb');
    await expect(store.storeSprintStory(2, wsA, 'x', v('X'))).rejects.toThrow();
  });
});
