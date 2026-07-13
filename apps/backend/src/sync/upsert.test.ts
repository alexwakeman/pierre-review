// §3e — the user resolver captures the GraphQL actor __typename into users.githubType
// (the bot-triage classifier's hard "GitHub reports this as a Bot" signal), and never
// overwrites a known type with null on a later {login,id}-only resolve. Throwaway sqlite.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-upsert-githubtype-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let createUserResolver: any;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ createUserResolver } = await import('./upsert.js'));
  await runMigrations();
});

afterAll(() => closeDb?.());

async function githubTypeOf(login: string): Promise<string | null> {
  const { eq } = await import('drizzle-orm');
  const row = (
    await db.select().from(schema.users).where(eq(schema.users.githubLogin, login)).execute()
  )[0];
  return row?.githubType ?? null;
}

async function userByLogin(login: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (
    await db.select().from(schema.users).where(eq(schema.users.githubLogin, login)).execute()
  )[0];
}

describe('createUserResolver captures githubType', () => {
  it("writes githubType from a Bot author's __typename", async () => {
    const resolver = createUserResolver();
    const id = await resolver.resolve(db, {
      login: 'branded-reviewer[bot]',
      id: 'U_bot',
      __typename: 'Bot',
    });
    expect(typeof id).toBe('number');
    expect(await githubTypeOf('branded-reviewer[bot]')).toBe('Bot');
  });

  it("writes githubType from a User author's __typename", async () => {
    const resolver = createUserResolver();
    await resolver.resolve(db, { login: 'a-human', id: 'U_h', __typename: 'User' });
    expect(await githubTypeOf('a-human')).toBe('User');
  });

  it('leaves githubType null when the actor carried no __typename', async () => {
    const resolver = createUserResolver();
    await resolver.resolve(db, { login: 'commit-only', id: 'U_c' });
    expect(await githubTypeOf('commit-only')).toBe(null);
  });

  it('never overwrites a known githubType with null on a later {login,id}-only resolve', async () => {
    // A fresh resolver each call → no in-run login cache, so the DB upsert path runs.
    await createUserResolver().resolve(db, { login: 'stable-bot', id: 'U_sb', __typename: 'Bot' });
    expect(await githubTypeOf('stable-bot')).toBe('Bot');
    // Re-resolve the SAME login without a __typename (mirrors a commit-author resolve).
    await createUserResolver().resolve(db, { login: 'stable-bot', id: 'U_sb' });
    expect(await githubTypeOf('stable-bot')).toBe('Bot');
  });
});

// Regression: a single account surfacing under two logins with the SAME node id must
// NOT hit "UNIQUE constraint failed: users.github_node_id". This is the real-world
// bot case — GitHub returns `dependabot[bot]` on the Bot-typed author field but bare
// `dependabot` on the commit-author field, both carrying one node id. The DB already
// holds a bare-`dependabot` row (null node, synced earlier) AND a `dependabot[bot]`
// row that owns the node id; resolving the bare login WITH the node id used to try to
// coalesce that already-taken node onto the bare row and blow up the whole PR upsert.
describe('createUserResolver resolves by node id to avoid a github_node_id collision', () => {
  it('reuses the node-id owner instead of stamping a taken node onto another login', async () => {
    const NODE = 'MDM6Qm90NDk2OTkzMzM='; // dependabot's real Bot node id
    // 1. The bare login exists first with NO node id (an early commit-author resolve).
    const bareId = await createUserResolver().resolve(db, { login: 'dependabot' });
    expect((await userByLogin('dependabot')).githubNodeId).toBe(null);
    // 2. The [bot] login is synced and takes ownership of the node id.
    const botId = await createUserResolver().resolve(db, {
      login: 'dependabot[bot]',
      id: NODE,
      __typename: 'Bot',
    });
    expect(botId).not.toBe(bareId);

    // 3. The bare login now arrives WITH the same node id (the crash trigger). It must
    //    resolve to the node-id owner — no throw, no second row, node left on the owner.
    const again = await createUserResolver().resolve(db, { login: 'dependabot', id: NODE });
    expect(again).toBe(botId);
    // The pre-existing bare row is untouched (its null node id was never stamped).
    expect((await userByLogin('dependabot')).githubNodeId).toBe(null);
    // The node id still belongs solely to the [bot] row.
    expect((await userByLogin('dependabot[bot]')).githubNodeId).toBe(NODE);
  });

  it('still creates a fresh row when the node id is brand-new', async () => {
    const id = await createUserResolver().resolve(db, {
      login: 'new-actor',
      id: 'U_new_actor',
      __typename: 'User',
    });
    expect(typeof id).toBe('number');
    expect((await userByLogin('new-actor')).githubNodeId).toBe('U_new_actor');
  });
});
