// A REPO LEFT OUT OF BOT COMMENT SCORING, AND THE TOOL SWITCHES' STORAGE (migration 0199), on a THROWAWAY
// sqlite DB (the ai-reviews-seen.test.ts pattern).
//
// WHAT THIS PINS:
//   1. Migration 0199 applies: every repo starts INCLUDED; the switch is stored per repo, account-scoped,
//      and listed on the Repo wire shape (`botScoringExcluded`).
//   2. The tool switches store ONE switch at a time, overrides only: `null` puts it back to its default
//      and an empty object is stored as NULL.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load), and every
// import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-repo-bot-scoring-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let mod: typeof import('./repo-bot-scoring.js');
let q: typeof import('./queries.js');
let account: typeof import('../auth/account.js');
const repoIds: number[] = [];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mod = await import('./repo-bot-scoring.js');
  q = await import('./queries.js');
  account = await import('../auth/account.js');
  for (const name of ['web', 'api']) {
    const [r] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_${name}` })
      .returning()
      .execute();
    repoIds.push(r.id);
  }
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('a repo left out of bot comment scoring', () => {
  it('starts included', async () => {
    expect([...(await mod.botScoringExcludedRepoIds(1))]).toEqual([]);
    const listed = await q.listRepos(1);
    expect(listed.map((r) => r.botScoringExcluded)).toEqual([false, false]);
  });

  it('is left out once switched, and only that repo', async () => {
    expect(await mod.setRepoBotScoringExcluded(1, repoIds[0]!, true)).toBe(true);
    expect([...(await mod.botScoringExcludedRepoIds(1))]).toEqual([repoIds[0]]);
    const listed = await q.listRepos(1);
    expect(listed.find((r) => r.id === repoIds[0])?.botScoringExcluded).toBe(true);
    expect(listed.find((r) => r.id === repoIds[1])?.botScoringExcluded).toBe(false);
  });

  it('is put back', async () => {
    expect(await mod.setRepoBotScoringExcluded(1, repoIds[0]!, false)).toBe(true);
    expect([...(await mod.botScoringExcludedRepoIds(1))]).toEqual([]);
  });

  it('refuses a repo that is not this account’s', async () => {
    expect(await mod.setRepoBotScoringExcluded(2, repoIds[0]!, true)).toBe(false);
    expect(await mod.setRepoBotScoringExcluded(1, 999_999, true)).toBe(false);
    expect([...(await mod.botScoringExcludedRepoIds(1))]).toEqual([]);
  });
});

describe('the tool switches, stored', () => {
  it('stores one switch at a time, overrides only', async () => {
    expect(await account.setToolSwitch(1, 'ai', false)).toEqual({ ai: false });
    expect(await account.setToolSwitch(1, 'botAnalysis', true)).toEqual({ ai: false, botAnalysis: true });
  });

  it('puts a switch back to its default with null, and stores nothing left as NULL', async () => {
    expect(await account.setToolSwitch(1, 'ai', null)).toEqual({ botAnalysis: true });
    expect(await account.setToolSwitch(1, 'botAnalysis', null)).toBeNull();
    const [row] = await db.select({ t: schema.accounts.toolSwitches }).from(schema.accounts).execute();
    expect(row.t).toBeNull();
  });
});
