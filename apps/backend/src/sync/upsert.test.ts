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
