// db/merged-reach.ts — "Reach by repository" over the pull requests MERGED in the reporting window,
// on a THROWAWAY sqlite DB. Pinned:
//  • the window: `[from, min(end, now))` on merged_at, half-open; open and closed PRs never count;
//  • SIGNALS, NEVER A LEVEL: the row carries `blast` + `codeLoc` + `codeLocIsLowerBound` from the
//    same folds the open-PR rows use, and an unmeasured PR is `blast: null`, not "low";
//  • tenancy: a foreign repo id handed in the scope never surfaces, and `[]` is empty, not "all".
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-merged-reach-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let mr: any;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 1);
const SPRINT = { fromMs: NOW - 5 * DAY, toMs: NOW + 9 * DAY, mode: 'sprint' as const };

let mine = 0;
let other = 0;
let foreign = 0;
let seq = 0;
const ids: Record<string, number> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  mr = await import('./merged-reach.js');
  const { repos, pullRequests } = schema;

  const mkRepo = async (name: string, accountId = 1): Promise<number> =>
    (
      await db
        .insert(repos)
        .values({ accountId, owner: 'acme', name, githubNodeId: `R_mr_${name}` })
        .returning()
        .execute()
    )[0].id;
  mine = await mkRepo('mine');
  other = await mkRepo('other');
  foreign = await mkRepo('theirs', 2);

  const mkPr = async (
    key: string,
    repoId: number,
    state: 'open' | 'merged' | 'closed',
    mergedMs: number | null,
    files: { path: string; additions: number; deletions: number }[] | null,
    accountId = 1,
  ): Promise<void> => {
    seq += 1;
    const add = (files ?? []).reduce((n, f) => n + f.additions, 0);
    const del = (files ?? []).reduce((n, f) => n + f.deletions, 0);
    const row = (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_mr_${seq}`,
          accountId,
          repoId,
          number: seq,
          title: key,
          state,
          isDraft: false,
          openedAt: new Date(NOW - 20 * DAY),
          updatedAt: new Date(NOW - DAY),
          mergedAt: mergedMs == null ? null : new Date(mergedMs),
          additions: add,
          deletions: del,
          changedFiles: files?.length ?? 0,
          files,
        })
        .returning()
        .execute()
    )[0];
    ids[key] = row.id;
  };
  const MIGRATION = [{ path: 'db/migrations/0001_x.sql', additions: 10, deletions: 0 }];
  const SMALL = [{ path: 'src/a.ts', additions: 3, deletions: 1 }];

  await mkPr('atStart', mine, 'merged', SPRINT.fromMs, MIGRATION); // inclusive lower bound
  await mkPr('inside', other, 'merged', NOW - DAY, SMALL);
  await mkPr('unmeasured', mine, 'merged', NOW - 2 * DAY, null); // never stored its files
  await mkPr('beforeStart', mine, 'merged', SPRINT.fromMs - 1000, SMALL);
  await mkPr('atNow', mine, 'merged', NOW, SMALL); // the measured span ends at now, half-open
  await mkPr('stillOpen', mine, 'open', null, SMALL);
  await mkPr('foreign', foreign, 'merged', NOW - DAY, SMALL, 2);
});

afterAll(() => closeDb?.());

describe('getWorkspaceMergedReach', () => {
  it('lists the pull requests merged in [window start, now), and nothing open', async () => {
    const out = await mr.getWorkspaceMergedReach(1, { workspaceId: 1, repoIds: [mine, other] }, NOW, SPRINT);
    expect(out.prs.map((p: any) => p.id).sort()).toEqual(
      [ids.atStart, ids.inside, ids.unmeasured].sort(),
    );
    expect(out.from).toBe(new Date(SPRINT.fromMs).toISOString());
    expect(out.to).toBe(new Date(NOW).toISOString());
    expect(out.truncated).toBe(false);
  });

  it('carries SIGNALS, never a level — and an unmeasured PR is null, not low', async () => {
    const out = await mr.getWorkspaceMergedReach(1, { workspaceId: 1, repoIds: [mine, other] }, NOW, SPRINT);
    const byId = new Map(out.prs.map((p: any) => [p.id, p]));
    const migration: any = byId.get(ids.atStart);
    expect(migration.blast.surfaces).toContain('db_migration');
    expect(migration).not.toHaveProperty('level');
    expect(typeof migration.codeLocIsLowerBound).toBe('boolean');
    const unmeasured: any = byId.get(ids.unmeasured);
    expect(unmeasured.blast).toBeNull();
    expect(unmeasured.codeLoc).toBeNull();
  });

  it('never crosses an account boundary, and an empty scope is empty', async () => {
    const out = await mr.getWorkspaceMergedReach(1, { workspaceId: 1, repoIds: [mine, foreign] }, NOW, SPRINT);
    expect(out.prs.some((p: any) => p.id === ids.foreign)).toBe(false);
    expect(await mr.getWorkspaceMergedReach(2, { workspaceId: 1, repoIds: [mine] }, NOW, SPRINT)).toBeNull();
    expect(await mr.getWorkspaceMergedReach(1, { workspaceId: 1, repoIds: [] }, NOW, SPRINT)).toBeNull();
  });
});
