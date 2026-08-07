// upsertRepo's `description` write follows the three-state partial-response policy
// (sync/branch-status.ts is the reference): `undefined` ⇒ the selection was never received
// (the lightweight add-repo path, a tolerant partial that lost the key) ⇒ the stored value
// is PRESERVED; `null` ⇒ GitHub positively said the repo has no description ⇒ cleared; a
// string overwrites. An unconditional write would NULL a good description on every add-path
// call; a write-only-if-non-null would leave a deleted GitHub description alive forever.
// Throwaway sqlite.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-upsert-repo-description-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsertRepo: (
  owner: string,
  name: string,
  githubNodeId: string,
  defaultBranch: string | null | undefined,
  accountId: number,
  viewerPermission?: string | null,
  description?: string | null,
) => Promise<number>;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ upsertRepo } = await import('./upsert.js'));
  await runMigrations();
  // upsertRepo writes the workspace-membership row, which hangs off a real account.
  // A migration may already have seeded account 1 — tolerate it.
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_test', githubLogin: 'tester', isLocal: true })
    .onConflictDoNothing()
    .execute();
});

afterAll(() => closeDb?.());

async function descriptionOf(repoId: number): Promise<string | null> {
  const { eq } = await import('drizzle-orm');
  const row = (
    await db.select().from(schema.repos).where(eq(schema.repos.id, repoId)).execute()
  )[0];
  return row?.description ?? null;
}

describe('upsertRepo description follows the three-state partial-response policy', () => {
  it('writes a received string, on insert and on update', async () => {
    const id = await upsertRepo('o', 'r', 'R_desc', 'main', 1, 'ADMIN', 'A test repo');
    expect(await descriptionOf(id)).toBe('A test repo');
    const again = await upsertRepo('o', 'r', 'R_desc', 'main', 1, 'ADMIN', 'Now different');
    expect(again).toBe(id);
    expect(await descriptionOf(id)).toBe('Now different');
  });

  it('preserves the stored description when the key was absent (undefined)', async () => {
    const id = await upsertRepo('o', 'r2', 'R_keep', 'main', 1, 'ADMIN', 'Keep me');
    // The add-repo path / a tolerant partial: no description argument at all.
    await upsertRepo('o', 'r2', 'R_keep', null, 1);
    expect(await descriptionOf(id)).toBe('Keep me');
  });

  it('clears the stored description on a positive null from GitHub', async () => {
    const id = await upsertRepo('o', 'r3', 'R_clear', 'main', 1, 'ADMIN', 'Soon gone');
    await upsertRepo('o', 'r3', 'R_clear', 'main', 1, 'ADMIN', null);
    expect(await descriptionOf(id)).toBe(null);
  });

  it('inserts null when a brand-new repo arrives without the selection', async () => {
    const id = await upsertRepo('o', 'r4', 'R_new', null, 1);
    expect(await descriptionOf(id)).toBe(null);
  });
});
