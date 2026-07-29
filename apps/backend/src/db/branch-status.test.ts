// getBranchStatus on a THROWAWAY sqlite DB.
//
// The three things worth pinning down, because each has a silent failure mode:
//  1. ACCOUNT ISOLATION. `branch_commits.accountId` is denormalized, so the commit read is a
//     single indexed predicate that does NOT join back through `repos`. That is exactly the
//     shape where a missing predicate leaks: seed two accounts with a commit each and prove
//     the foreign one never appears — including when the caller NAMES the foreign repo id.
//  2. A repo with no branch sync still gets a row, with nulls + 'unknown', so the strip's row
//     count matches the repo list rather than silently shortening.
//  3. The author join: a commit whose `authorUserId` resolves carries the login (and prefers
//     the synced avatar); one that doesn't falls back to the raw git name with a null login.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchStatusResponse } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-branch-status-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let getBranchStatus: (
  accountId: number,
  repoIds: number[] | null,
) => Promise<BranchStatusResponse>;

const at = (isoDay: string): Date => new Date(`2026-07-${isoDay}T12:00:00Z`);

let acctMine = 0;
let ownRepo = 0;
let unsyncedRepo = 0;
let foreignRepo = 0;
let knownUserId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ getBranchStatus } = await import('./branch-queries.js'));
  await runMigrations();

  const { accounts, repos, users, branchCommits } = schema;
  // Account 1 is created by the migrations' local-account seed in some paths and not others,
  // so upsert both accounts by their unique github user id rather than assuming ids.
  const mkAccount = async (login: string): Promise<number> => {
    const existing = await db.select().from(accounts).execute();
    const found = existing.find((a: any) => a.githubLogin === login);
    if (found) return found.id;
    const [row] = await db
      .insert(accounts)
      .values({ githubUserId: `U_${login}`, githubLogin: login })
      .returning()
      .execute();
    return row.id;
  };
  const a1 = await mkAccount('mine');
  const a2 = await mkAccount('theirs');
  acctMine = a1;

  const mkRepo = async (accountId: number, tag: string, branch: string | null) => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name: tag,
        githubNodeId: `R_${tag}`,
        defaultBranchName: branch,
        defaultBranchHeadSha: branch ? `head_${tag}` : null,
        defaultBranchCiStatus: branch ? 'failure' : null,
        defaultBranchUpdatedAt: branch ? at('20') : null,
      })
      .returning()
      .execute();
    return r.id;
  };
  ownRepo = await mkRepo(a1, 'own', 'main');
  unsyncedRepo = await mkRepo(a1, 'fresh', null);
  foreignRepo = await mkRepo(a2, 'theirs', 'trunk');

  const [u] = await db
    .insert(users)
    .values({
      githubLogin: 'octocat',
      githubNodeId: 'U_octocat',
      avatarUrl: 'https://avatars.example/synced.png',
    })
    .returning()
    .execute();
  knownUserId = u.id;

  await db
    .insert(branchCommits)
    .values([
      {
        accountId: a1,
        repoId: ownRepo,
        sha: 'aaa1',
        messageHeadline: 'older commit',
        authorUserId: null,
        authorName: 'Detached Dev',
        authorAvatarUrl: null,
        committedAt: at('18'),
        ciStatus: 'success',
      },
      {
        accountId: a1,
        repoId: ownRepo,
        sha: 'bbb2',
        messageHeadline: 'newest commit',
        authorUserId: knownUserId,
        authorName: 'Octo Cat',
        authorAvatarUrl: 'https://avatars.example/stale.png',
        committedAt: at('19'),
        ciStatus: null,
      },
      {
        accountId: a2,
        repoId: foreignRepo,
        sha: 'ccc3',
        messageHeadline: 'other tenant',
        authorName: 'Someone Else',
        committedAt: at('19'),
        ciStatus: 'success',
      },
      // The row that makes the isolation assertion NON-VACUOUS. Scoping by repoId alone would
      // already hide `ccc3` (that repo isn't in account 1's list), so the accountId predicate
      // on `branch_commits` would pass a test that only seeded that. This row is stamped to the
      // OTHER account while pointing at account 1's repo — the precise shape a denormalized
      // owner column exists to catch — so dropping `eq(branchCommits.accountId, …)` from the
      // query surfaces it and fails the test.
      {
        accountId: a2,
        repoId: ownRepo,
        sha: 'ddd4',
        messageHeadline: 'mis-stamped row',
        authorName: 'Not Yours',
        committedAt: at('21'),
        ciStatus: 'success',
      },
    ])
    .execute();
});

afterAll(() => closeDb?.());

describe('getBranchStatus', () => {
  it('returns a row per owned repo, newest commit first, with the head snapshot', async () => {
    const { repos: rows } = await getBranchStatus(acctMine, null);
    const own = rows.find((r) => r.repoId === ownRepo);
    expect(own).toBeDefined();
    expect(own!.branchName).toBe('main');
    expect(own!.headSha).toBe('head_own');
    expect(own!.ciStatus).toBe('failure');
    expect(own!.commits.map((c) => c.sha)).toEqual(['bbb2', 'aaa1']);
    // lastCommitAt is the newest COMMIT's timestamp, not our observation time.
    expect(own!.lastCommitAt).toBe(at('19').toISOString());
  });

  it('surfaces a never-branch-synced repo as a null row rather than omitting it', async () => {
    const { repos: rows } = await getBranchStatus(acctMine, null);
    const fresh = rows.find((r) => r.repoId === unsyncedRepo);
    expect(fresh).toBeDefined();
    expect(fresh!.branchName).toBeNull();
    expect(fresh!.headSha).toBeNull();
    expect(fresh!.ciStatus).toBe('unknown');
    expect(fresh!.lastCommitAt).toBeNull();
    expect(fresh!.commits).toEqual([]);
  });

  it('maps a known author to their login + synced avatar, and falls back otherwise', async () => {
    const { repos: rows } = await getBranchStatus(acctMine, [ownRepo]);
    const [known, unknown] = rows[0]!.commits;
    expect(known!.authorLogin).toBe('octocat');
    // The users row's avatar wins over the one frozen onto the commit at fetch time.
    expect(known!.authorAvatarUrl).toBe('https://avatars.example/synced.png');
    // A null ci_status column reads as 'unknown' on the wire (the type is non-nullable).
    expect(known!.ciStatus).toBe('unknown');
    expect(unknown!.authorLogin).toBeNull();
    expect(unknown!.authorName).toBe('Detached Dev');
  });

  it('never returns another account’s repo or commits, even when named explicitly', async () => {
    const all = await getBranchStatus(acctMine, null);
    expect(all.repos.some((r) => r.repoId === foreignRepo)).toBe(false);
    const shas = all.repos.flatMap((r) => r.commits).map((c) => c.sha);
    expect(shas).not.toContain('ccc3');
    // The mis-stamped row on OUR repo: only the accountId predicate keeps this out.
    expect(shas).not.toContain('ddd4');

    // The IDOR shape: caller asks for the OTHER tenant's repo id by number.
    const named = await getBranchStatus(acctMine, [foreignRepo]);
    expect(named.repos).toEqual([]);
  });
});
