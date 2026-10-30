// `getPrImpactLevel` — the auto-approve impact gate's server read of a PR's blast-radius LEVEL.
// What is pinned: it folds the PR's stored signals through the SHARED `blastRadius()` +
// `resolveBlastConfig()` with the ACCOUNT's stored config (so the Settings dial moves the gate the
// way it moves the chip), an unmeasured PR is null (never "low"), and another account's PR is null.
//
//   pnpm --filter @pierre-review/backend exec vitest run src/db/blast-radius-query.test.ts
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { StoredPrFile } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-blast-radius-query.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let closeDb: (() => void) | undefined;
let client: typeof import('./client.js');
let q: typeof import('./blast-radius-query.js');
let repoId = 0;
let seq = 0;

async function makePr(files: StoredPrFile[] | null, accountId = 1): Promise<number> {
  seq += 1;
  const add = (files ?? []).reduce((n, f) => n + f.additions, 0);
  const [p] = await client.db
    .insert(client.schema.pullRequests)
    .values({
      githubNodeId: `PR_blast_${seq}`,
      accountId,
      repoId,
      number: seq,
      title: `pr ${seq}`,
      state: 'open',
      isDraft: false,
      headSha: 'HEAD',
      openedAt: new Date(),
      updatedAt: new Date(),
      files,
      additions: add,
      deletions: 0,
      changedFiles: files?.length ?? 0,
    } as any)
    .returning()
    .execute();
  return p!.id;
}

const code = (n: number, loc: number): StoredPrFile[] =>
  Array.from({ length: n }, (_, i) => ({ path: `src/m${i}.ts`, additions: loc, deletions: 0 }));

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  await client.db
    .insert(client.schema.accounts)
    .values({ id: 2, githubUserId: 'U_blast_other', githubLogin: 'other', isLocal: false })
    .execute();
  const [r] = await client.db
    .insert(client.schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_blast_api' })
    .returning()
    .execute();
  repoId = r!.id;
  q = await import('./blast-radius-query.js');
});

afterAll(() => {
  closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

const setConfig = (config: unknown) =>
  client.db
    .update(client.schema.accounts)
    .set({ blastRadiusConfig: config as any })
    .where(eq(client.schema.accounts.id, 1))
    .execute();

describe('getPrImpactLevel', () => {
  it('reads the level through the shared resolver, and follows the account dial', async () => {
    const small = await makePr(code(1, 20));
    const twelve = await makePr(code(12, 30));
    const migration = await makePr([{ path: 'db/migrations/0001_init.sql', additions: 3, deletions: 0 }]);
    await setConfig(null);
    expect(await q.getPrImpactLevel(1, small)).toBe('low');
    expect(await q.getPrImpactLevel(1, twelve)).toBe('medium');
    expect(await q.getPrImpactLevel(1, migration)).toBe('high');
    // Cautious: 12 code files clears its 10-file high bar — the gate moves with the chip.
    await setConfig({ sensitivity: 'cautious', surfacesOff: [] });
    expect(await q.getPrImpactLevel(1, twelve)).toBe('high');
    await setConfig(null);
  });

  it('is null for an unmeasured PR (never low) and for another account’s PR', async () => {
    const unmeasured = await makePr(null);
    expect(await q.getPrImpactLevel(1, unmeasured)).toBeNull();
    const mine = await makePr(code(1, 20));
    expect(await q.getPrImpactLevel(2, mine)).toBeNull();
    expect(await q.getPrImpactLevel(1, 999_999)).toBeNull();
  });
});
