// BOT COMMENT SCORING, OPT-IN PER REPO (migration 0201), THE REPO'S OVERVIEW, AND THE TOOL SWITCHES' STORAGE
// (migration 0200), on a THROWAWAY sqlite DB (the ai-reviews-seen.test.ts pattern).
//
// WHAT THIS PINS:
//   1. Every repo starts NOT scored (opt-in); the switch is stored per repo, account-scoped, and listed on
//      the Repo wire shape (`botScoring`). The overview counts the repo's synced PRs by state.
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

describe('bot comment scoring, opt-in per repo', () => {
  it('starts off for every repo', async () => {
    expect([...(await mod.botScoringEnabledRepoIds(1))]).toEqual([]);
    const listed = await q.listRepos(1);
    expect(listed.map((r) => r.botScoring)).toEqual([false, false]);
  });

  it('is on once switched, and only for that repo', async () => {
    expect(await mod.setRepoBotScoring(1, repoIds[0]!, true)).toBe(true);
    expect([...(await mod.botScoringEnabledRepoIds(1))]).toEqual([repoIds[0]]);
    const listed = await q.listRepos(1);
    expect(listed.find((r) => r.id === repoIds[0])?.botScoring).toBe(true);
    expect(listed.find((r) => r.id === repoIds[1])?.botScoring).toBe(false);
  });

  it('is switched off again', async () => {
    expect(await mod.setRepoBotScoring(1, repoIds[0]!, false)).toBe(true);
    expect([...(await mod.botScoringEnabledRepoIds(1))]).toEqual([]);
  });

  it('refuses a repo that is not this account’s', async () => {
    expect(await mod.setRepoBotScoring(2, repoIds[0]!, true)).toBe(false);
    expect(await mod.setRepoBotScoring(1, 999_999, true)).toBe(false);
    expect([...(await mod.botScoringEnabledRepoIds(1))]).toEqual([]);
  });

  it('scores only repos switched on, never an External one', () => {
    const ws = { repoIds: [1, 2, 3], externalRepoIds: [3] };
    expect(mod.scoreableRepoIds(ws, new Set())).toEqual([]);
    expect(mod.scoreableRepoIds(ws, new Set([2, 3]))).toEqual([2]);
  });
});

describe('the repo overview', () => {
  it('counts synced pull requests by state and their authors; null for a foreign repo', async () => {
    const { getRepoOverview } = await import('./repo-overview.js');
    const [u1] = await db.insert(schema.users).values({ githubNodeId: 'U_a', githubLogin: 'ana' }).returning().execute();
    const [u2] = await db.insert(schema.users).values({ githubNodeId: 'U_b', githubLogin: 'ben' }).returning().execute();
    const now = new Date();
    const pr = (n: number, state: string, authorId: number) => ({
      accountId: 1,
      repoId: repoIds[1]!,
      githubNodeId: `PR_${n}`,
      number: n,
      title: `PR ${n}`,
      state,
      authorId,
      openedAt: now,
      updatedAt: now,
    });
    await db.insert(schema.pullRequests).values([pr(1, 'open', u1.id), pr(2, 'merged', u1.id), pr(3, 'merged', u2.id), pr(4, 'closed', u2.id)]).execute();
    const o = await getRepoOverview(1, repoIds[1]!);
    expect(o?.prs).toEqual({ total: 4, open: 1, merged: 2, closed: 1 });
    expect(o?.authors).toBe(2);
    expect(o?.botScoring).toEqual({ enabled: false, labelled: 0, pending: 0 });
    expect(await getRepoOverview(2, repoIds[1]!)).toBeNull();
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
