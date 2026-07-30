// getBranchStatus's DERIVED fields, on a throwaway sqlite DB: the head commit's failing-check
// summary and the commit → local-PR resolution. Kept separate from branch-status.test.ts (which
// owns the base shape + account isolation) because these two need their own richer seed.
//
// Both have a silent failure mode, and neither is visible in a passing typecheck:
//  1. THE HEAD SUMMARY IS MATCHED BY SHA, never by position. The commit list is ordered by
//     committer date and then CAPPED, and a backdated committer date (a rebase, or a cherry-pick
//     with --committer-date-is-author-date) can sort the head commit below others — so a
//     `commits[0]` shortcut would silently report the WRONG commit's failures, or none at all, on
//     a repo whose CI status says failure.
//  2. THE PR RESOLUTION IS KEYED BY (repoId, number) AND SCOPED BY accountId. A PR number is
//     unique only within a repo, so a number-keyed map would cross-link repo A's #12 onto repo B's
//     commit and open the wrong PR; and the `inArray × inArray` predicate deliberately
//     over-matches, so the accountId predicate is the only thing keeping another tenant's PR id
//     out. Both traps are seeded here, not merely commented on: deleting either predicate must
//     fail a specific assertion.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BranchCheckRun, BranchStatusResponse } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-branch-status-detail-test.sqlite';
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

const failing = (name: string): BranchCheckRun[] => [
  { name, state: 'failure', url: null, runId: null, jobId: null, workflowName: 'CI' },
];

let acctMine = 0;
let acctTheirs = 0;
let mainRepo = 0;
let otherRepo = 0;
let ownPrId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  ({ getBranchStatus } = await import('./branch-queries.js'));
  await runMigrations();

  const { accounts, repos, branchCommits, pullRequests } = schema;
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
  acctMine = await mkAccount('mine');
  acctTheirs = await mkAccount('theirs');

  const mkRepo = async (accountId: number, tag: string, headSha: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name: tag,
        githubNodeId: `R_${tag}`,
        defaultBranchName: 'main',
        defaultBranchHeadSha: headSha,
        defaultBranchCiStatus: 'failure',
        defaultBranchUpdatedAt: at('20'),
      })
      .returning()
      .execute();
    return r.id;
  };
  // The head commit is deliberately NOT the newest by committer date — see trap 1.
  mainRepo = await mkRepo(acctMine, 'main-repo', 'head_sha');
  otherRepo = await mkRepo(acctMine, 'other-repo', 'nothing_synced');

  const mkPr = async (accountId: number, repoId: number, number: number): Promise<number> => {
    const [p] = await db
      .insert(pullRequests)
      .values({
        accountId,
        repoId,
        githubNodeId: `PR_${accountId}_${repoId}_${number}`,
        number,
        title: `pr ${number}`,
        state: 'merged',
        openedAt: at('18'),
        updatedAt: at('19'),
      })
      .returning()
      .execute();
    return p.id;
  };
  ownPrId = await mkPr(acctMine, mainRepo, 12);
  // Trap: the SAME number, in a repo the caller also owns. Resolving by bare number would attach
  // this id to mainRepo's commit and open the wrong PR.
  await mkPr(acctMine, otherRepo, 34);
  // Trap: a foreign account's PR pointing at OUR repo. Dropping eq(accountId) surfaces it.
  await mkPr(acctTheirs, mainRepo, 56);

  await db
    .insert(branchCommits)
    .values([
      {
        accountId: acctMine,
        repoId: mainRepo,
        sha: 'head_sha',
        messageHeadline: 'the head, with a BACKDATED committer date',
        // Older than the two below, so any positional shortcut picks the wrong row.
        committedAt: at('15'),
        ciStatus: 'failure',
        failingChecks: failing('build'),
        prNumber: 12,
      },
      {
        accountId: acctMine,
        repoId: mainRepo,
        sha: 'newer_sha',
        messageHeadline: 'newer by date, NOT the head',
        committedAt: at('19'),
        ciStatus: 'failure',
        failingChecks: failing('lint'),
        // The cross-repo trap: this number only exists in `otherRepo`.
        prNumber: 34,
      },
      {
        accountId: acctMine,
        repoId: mainRepo,
        sha: 'foreign_pr_sha',
        messageHeadline: 'points at a foreign account’s PR number',
        committedAt: at('18'),
        ciStatus: 'success',
        prNumber: 56,
      },
      {
        accountId: acctMine,
        repoId: mainRepo,
        sha: 'direct_push_sha',
        messageHeadline: 'pushed straight to trunk',
        committedAt: at('17'),
        ciStatus: 'success',
        // failingChecks left NULL: the pre-migration / green state.
      },
    ])
    .execute();
});

afterAll(() => closeDb?.());

// Deliberately the UNSCOPED (cross-repo Feed) read, not `[mainRepo]`. The PR resolution's
// `inArray(repoId, ids) AND inArray(number, numbers)` predicate is a cross-product that legitimately
// OVER-matches, and it can only over-match when more than one repo is in scope — so narrowing to a
// single repo would make the cross-repo trap below vacuous, passing even with a bare-number map key.
const mainCommits = async () => {
  const { repos: rows } = await getBranchStatus(acctMine, null);
  const repo = rows.find((r) => r.repoId === mainRepo)!;
  const bySha = new Map(repo.commits.map((c) => [c.sha, c]));
  return { repo, bySha };
};

describe('getBranchStatus: head failing-check summary', () => {
  it('derives it from the commit whose SHA is the head, not from the newest row', async () => {
    const { repo } = await mainCommits();
    expect(repo.failingChecks.map((c) => c.name)).toEqual(['build']);
    // 'lint' belongs to the newer-by-date commit; surfacing it here would mean a positional match.
    expect(repo.failingChecks.map((c) => c.name)).not.toContain('lint');
  });

  it('carries each commit’s own failures, and [] (never null) for a green or pre-migration row', async () => {
    const { bySha } = await mainCommits();
    expect(bySha.get('newer_sha')!.failingChecks.map((c) => c.name)).toEqual(['lint']);
    expect(bySha.get('direct_push_sha')!.failingChecks).toEqual([]);
  });

  it('is empty for a repo whose head sha matches no stored commit', async () => {
    const { repos: rows } = await getBranchStatus(acctMine, [otherRepo]);
    expect(rows[0]!.failingChecks).toEqual([]);
  });
});

describe('getBranchStatus: commit → local PR resolution', () => {
  it('resolves a number in the SAME repo to its local id', async () => {
    const { bySha } = await mainCommits();
    expect(bySha.get('head_sha')).toMatchObject({ prNumber: 12, prId: ownPrId });
  });

  it('does NOT resolve a number that only exists in another repo, but keeps the number', async () => {
    const { bySha } = await mainCommits();
    // The number survives so the client can still link out to github.com; only the in-app id is
    // withheld. A bare-number map key would put otherRepo's PR id here.
    expect(bySha.get('newer_sha')).toMatchObject({ prNumber: 34, prId: null });
  });

  it('does NOT resolve another account’s PR, even in our own repo', async () => {
    const { bySha } = await mainCommits();
    expect(bySha.get('foreign_pr_sha')).toMatchObject({ prNumber: 56, prId: null });
  });

  it('reports a direct push as both-null', async () => {
    const { bySha } = await mainCommits();
    expect(bySha.get('direct_push_sha')).toMatchObject({ prNumber: null, prId: null });
  });
});
