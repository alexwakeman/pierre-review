// The blast-radius CO-CHANGE index, end to end on a THROWAWAY sqlite DB (the
// large-pr-threshold.test.ts pattern): env is set BEFORE importing config/client, the real
// migrations run, and the real builder + real reader are exercised against real rows.
//
// It proves the migration is registered (an unregistered file SILENTLY SKIPS and every query
// 500s on a missing relation) and, more importantly, the four quality rules — each of which was
// arrived at by measuring a real corpus, and each of which is invisible to a type-checker:
//
//   1. tests excluded            3. a repo below the coverage floor gets NO row
//   2. huge pull requests skipped   4. the bar is max(p90, absolute floor)
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-file-coupling-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let mod: typeof import('./file-coupling.js');

const ACCOUNT = 1;
let nextRepo = 100;
let nextPr = 1000;

/** Seed one repo and a list of merged pull requests, each given as its file paths. */
async function seedRepo(prs: string[][]): Promise<number> {
  const repoId = nextRepo++;
  await db
    .insert(schema.repos)
    .values({
      id: repoId,
      githubNodeId: `R_${repoId}`,
      accountId: ACCOUNT,
      owner: 'acme',
      name: `r${repoId}`,
      defaultBranch: 'main',
      createdAt: new Date(),
    })
    .execute();
  for (const paths of prs) {
    const id = nextPr++;
    await db
      .insert(schema.pullRequests)
      .values({
        id,
        githubNodeId: `PR_${id}`,
        accountId: ACCOUNT,
        repoId,
        number: id,
        title: 't',
        state: 'merged',
        openedAt: new Date(),
        updatedAt: new Date(),
        additions: paths.length * 10,
        deletions: paths.length * 2,
        changedFiles: paths.length,
        files: paths.map((p) => ({ path: p, additions: 10, deletions: 2 })),
      })
      .execute();
  }
  return repoId;
}

/** N pull requests that each touch `core` plus a unique satellite — so `core` accumulates
 *  degree N while every satellite has degree 1. The minimal shape of a hub. */
function hubShape(core: string, n: number, prefix = 'src/leaf'): string[][] {
  return Array.from({ length: n }, (_, i) => [core, `${prefix}${i}.ts`]);
}

/** Enough pull requests of `hubShape` to clear BOTH gates at once — the coverage floor (a count
 *  of contributing PRs) and the degree bar (how many other files the core has met). They are
 *  different quantities and it is easy to satisfy one while failing the other, which is exactly
 *  what the first draft of this file did. */
function enoughPrs(extra = 25): number {
  return Math.max(mod.HUB_MIN_PRS, mod.HUB_MIN_DEGREE) + extra;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mod = await import('./file-coupling.js');
}, 60_000);

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('rebuildRepoCoupling — the coverage floor (rule 3)', () => {
  it('writes NO row for a repo below the floor, however coupled it looks', async () => {
    // ⚠ A REFUSAL, not an empty index. Measured: only 7 of 22 real repositories clear this.
    const repoId = await seedRepo(hubShape('src/core.ts', mod.HUB_MIN_PRS - 1));
    expect(await mod.rebuildRepoCoupling(ACCOUNT, repoId)).toBeNull();
    expect((await mod.loadRepoCoupling(ACCOUNT, [repoId])).get(repoId)).toBeUndefined();
  });

  it('DELETES a stale row when a repo drops below the floor', async () => {
    // A row saying "these are the hubs" that no longer holds is worse than no row: the arm would
    // keep firing on evidence that has been withdrawn.
    const repoId = await seedRepo(hubShape('src/core.ts', mod.HUB_MIN_PRS + 20));
    expect(await mod.rebuildRepoCoupling(ACCOUNT, repoId)).not.toBeNull();
    await db.delete(schema.pullRequests).where(eq(schema.pullRequests.repoId, repoId)).execute();
    expect(await mod.rebuildRepoCoupling(ACCOUNT, repoId)).toBeNull();
    expect((await mod.loadRepoCoupling(ACCOUNT, [repoId])).get(repoId)).toBeUndefined();
  });
});

describe('rebuildRepoCoupling — the bar (rule 4)', () => {
  it('publishes NO hubs when nothing clears the absolute floor', async () => {
    // ⚠ THE RULE THAT TOOK LONGEST TO GET RIGHT. A p90 alone is exceeded by a tenth of paths BY
    // CONSTRUCTION, so this repo — where every file has degree 1 — would publish "hubs" under a
    // p90-only bar. Measured on real data: a config repo produced 77 of them, which were eight
    // per-environment copies of one service's .env file.
    const prs = Array.from({ length: mod.HUB_MIN_PRS + 10 }, (_, i) => [
      `src/a${i}.ts`,
      `src/b${i}.ts`,
    ]);
    const repoId = await seedRepo(prs);
    expect(await mod.rebuildRepoCoupling(ACCOUNT, repoId)).toBeNull();
  });

  it('publishes a hub that clears both halves, and reports the bar it cleared', async () => {
    const degree = enoughPrs();
    const repoId = await seedRepo(hubShape('src/core.ts', degree));
    const built = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    expect(built).not.toBeNull();
    expect(built!.hubs.get('src/core.ts')).toBe(degree);
    expect(built!.hubBar).toBeGreaterThanOrEqual(mod.HUB_MIN_DEGREE);
    // Only the hub is stored — the satellites are below the bar and simply absent.
    expect(built!.hubs.size).toBe(1);
  });
});

describe('rebuildRepoCoupling — what counts (rules 1 and 2)', () => {
  it('EXCLUDES test files from the index', async () => {
    // A test co-changes with its subject by construction — that is what a test IS, not evidence
    // of reach. Measured: one real repo's top "hubs" were four *.test.js files above their own
    // controllers.
    const n = enoughPrs();
    const prs = Array.from({ length: n }, (_, i) => [
      'src/core.ts',
      'src/core.test.ts',
      `src/leaf${i}.ts`,
    ]);
    const repoId = await seedRepo(prs);
    const built = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    expect(built!.hubs.has('src/core.ts')).toBe(true);
    expect(built!.hubs.has('src/core.test.ts')).toBe(false);
  });

  it('EXCLUDES non-code files from the index', async () => {
    const n = enoughPrs();
    const prs = Array.from({ length: n }, (_, i) => [
      'src/core.ts',
      'README.md',
      'package-lock.json',
      `src/leaf${i}.ts`,
    ]);
    const repoId = await seedRepo(prs);
    const built = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    expect(built!.hubs.has('README.md')).toBe(false);
    expect(built!.hubs.has('package-lock.json')).toBe(false);
  });

  it('ignores a pull request over the per-PR file cap entirely', async () => {
    // A 100-file pull request creates a 100-way clique in one stroke. That says the author did a
    // big refactor, not that the files are coupled — and without the cap ONE such PR can lift a
    // hundred unrelated paths over the bar.
    const wide = Array.from({ length: mod.HUB_PR_FILE_CAP + 1 }, (_, i) => `src/wide${i}.ts`);
    const prs = [
      ...Array.from({ length: mod.HUB_MIN_PRS + 5 }, (_, i) => ['src/keep.ts', `src/l${i}.ts`]),
      ...Array.from({ length: 40 }, () => wide),
    ];
    const repoId = await seedRepo(prs);
    const built = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    // 40 cliques of 26 files would have made every one of them a hub. None of them is.
    for (const p of wide) expect(built!.hubs.has(p)).toBe(false);
    // And the contributing count excludes them, so the floor is measured on real evidence.
    expect(built!.prCount).toBe(mod.HUB_MIN_PRS + 5);
  });

  it('is idempotent — rebuilding twice writes the same row, not a second one', async () => {
    const repoId = await seedRepo(hubShape('src/core.ts', enoughPrs(30)));
    const a = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    const b = await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    expect(b).toEqual(a);
    const loaded = await mod.loadRepoCoupling(ACCOUNT, [repoId]);
    expect(loaded.size).toBe(1);
  });
});

describe('hubReadingFor', () => {
  it('returns null when the repo has NO index — never a zero', async () => {
    // ⚠ The whole reason `hubDegree` is nullable. Most repos have no index at all, and a 0 here
    // would read on screen as "measured, not a hub".
    expect(mod.hubReadingFor([{ path: 'src/core.ts', additions: 1, deletions: 1 }], undefined))
      .toBeNull();
  });

  it('returns null when the pull request touches no hub', async () => {
    const repoId = await seedRepo(hubShape('src/core.ts', enoughPrs(30)));
    const coupling = (await mod.loadRepoCoupling(ACCOUNT, [repoId])).get(repoId);
    expect(
      mod.hubReadingFor([{ path: 'src/unrelated.ts', additions: 1, deletions: 1 }], coupling),
    ).toBeNull();
  });

  it('picks the HIGHEST-degree hub and names it', async () => {
    const big = enoughPrs(60);
    const small = enoughPrs(0);
    const prs = [
      ...hubShape('src/big.ts', big, 'src/x'),
      ...hubShape('src/small.ts', small, 'src/y'),
    ];
    const repoId = await seedRepo(prs);
    await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    const coupling = (await mod.loadRepoCoupling(ACCOUNT, [repoId])).get(repoId);
    const reading = mod.hubReadingFor(
      [
        { path: 'src/small.ts', additions: 1, deletions: 1 },
        { path: 'src/big.ts', additions: 1, deletions: 1 },
      ],
      coupling,
    );
    expect(reading?.path).toBe('src/big.ts');
    expect(reading?.degree).toBeGreaterThan(small);
    // The bar travels with the number so the comparison on screen is auditable.
    expect(reading?.bar).toBe(coupling!.hubBar);
  });
});

describe('loadRepoCoupling — tenancy', () => {
  it('never returns another account\'s row', async () => {
    const repoId = await seedRepo(hubShape('src/core.ts', enoughPrs(30)));
    await mod.rebuildRepoCoupling(ACCOUNT, repoId);
    expect((await mod.loadRepoCoupling(ACCOUNT, [repoId])).size).toBe(1);
    // A different account asking for the same repo id gets nothing — the predicate is on
    // account_id, not just repo_id.
    expect((await mod.loadRepoCoupling(999, [repoId])).size).toBe(0);
  });
});
