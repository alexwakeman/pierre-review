// Cross-team comparison (`GET /api/team-metrics/compare` → getTeamComparison) on a THROWAWAY
// sqlite DB.
//
// Two things are locked here, and they are the two things that were actually broken:
//
//  1. SCOPE RESOLUTION across EVERY TeamScope wire form. The bug this feature fixes was a gate
//     that only recognised the All-Teams sentinel, so an explicit `teams:<a,b>` multi-select fell
//     through it. Each variant gets its own assertion rather than one round-trip, because the
//     variants are produced by a client-side canonicaliser (teamSetToScope) that collapses a
//     one-team selection to a bare number and a full selection to 'teams' — three different
//     strings for what a user experiences as "the same kind of selection".
//
//  2. accountId SCOPING. A team id belonging to another account must not be readable. The known
//     trap (see the contributor-popover work) is a VACUOUS check that passes only because the
//     other account owns nothing — so account 2 here has its OWN team, with its OWN repo and its
//     OWN merged PRs, and the assertions are that each account sees exactly its own row and
//     never the other's, in BOTH directions.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-team-comparison-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let getTeamComparison: (accountId: number, scope?: string) => Promise<any>;
let getTeamComparisonRows: (accountId: number, scope?: string) => Promise<any[]>;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Account 1's two teams (the multi-team case) + account 2's one team (the isolation foil).
let teamAlpha = 0;
let teamBeta = 0;
let teamForeign = 0;
let prSeq = 0;

async function seedAccount(accountId: number, login: string): Promise<void> {
  await db
    .insert(schema.accounts)
    .values({
      id: accountId,
      githubUserId: `NODE_${accountId}`,
      githubLogin: login,
      displayName: login,
      isLocal: accountId === 1,
      accessTokenEnc: accountId === 1 ? null : 'sealed',
    })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: login } })
    .execute();
}

async function seedRepo(accountId: number, name: string): Promise<number> {
  const [repo] = await db
    .insert(schema.repos)
    .values({
      accountId,
      owner: 'acme',
      name,
      githubNodeId: `R_${accountId}_${name}`,
      inboxWatch: true,
    })
    .returning()
    .execute();
  return repo.id;
}

/** A merged PR inside the trailing-14d sprint, so `metrics.merges.value` is non-zero. */
async function seedMergedPr(accountId: number, repoId: number): Promise<void> {
  const mergedAt = new Date(now - 2 * DAY);
  await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_cmp_${prSeq}`,
      accountId,
      repoId,
      number: ++prSeq,
      title: `comparison fixture ${prSeq}`,
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - 4 * DAY),
      mergedAt,
      updatedAt: mergedAt,
    })
    .execute();
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  const mod = await import('./team-comparison.js');
  getTeamComparison = mod.getTeamComparison;
  getTeamComparisonRows = mod.getTeamComparisonRows;
  await runMigrations();

  await seedAccount(1, 'owner-one');
  await seedAccount(2, 'owner-two');

  // Account 1: "Alpha" (1 repo, 2 merges) + "Beta" (2 repos, 1 merge). Names chosen so
  // listTeams' name-asc order is Alpha, Beta — the column order the matrix renders.
  const alphaRepo = await seedRepo(1, 'alpha-svc');
  const betaRepo1 = await seedRepo(1, 'beta-svc');
  const betaRepo2 = await seedRepo(1, 'beta-web');
  // A watched repo in NO team — it must never appear in a comparison row's repoCount.
  await seedRepo(1, 'unassigned-svc');
  teamAlpha = (await q.createTeam(1, 'Alpha')).id;
  teamBeta = (await q.createTeam(1, 'Beta')).id;
  await q.assignReposToTeam(teamAlpha, 1, [alphaRepo]);
  await q.assignReposToTeam(teamBeta, 1, [betaRepo1, betaRepo2]);
  await seedMergedPr(1, alphaRepo);
  await seedMergedPr(1, alphaRepo);
  await seedMergedPr(1, betaRepo1);

  // Account 2: its own team + repo + merged PRs. NOT a bare empty account — an empty foil makes
  // the cross-account assertions pass for the wrong reason.
  const foreignRepo = await seedRepo(2, 'foreign-svc');
  teamForeign = (await q.createTeam(2, 'Alpha')).id; // same NAME as account 1's, on purpose
  await q.assignReposToTeam(teamForeign, 2, [foreignRepo]);
  await seedMergedPr(2, foreignRepo);
  await seedMergedPr(2, foreignRepo);
  await seedMergedPr(2, foreignRepo);
});

afterAll(() => closeDb?.());

describe('getTeamComparisonRows — scope resolution across every TeamScope wire form', () => {
  it("'all' compares every team (the default for a bare URL hit)", async () => {
    const rows = await getTeamComparisonRows(1, 'all');
    expect(rows.map((r) => r.teamName)).toEqual(['Alpha', 'Beta']);
  });

  it('an ABSENT scope behaves like all', async () => {
    const rows = await getTeamComparisonRows(1, undefined);
    expect(rows.map((r) => r.teamName)).toEqual(['Alpha', 'Beta']);
  });

  it("'teams' (the All-Teams sentinel) compares every team", async () => {
    const rows = await getTeamComparisonRows(1, 'teams');
    expect(rows.map((r) => r.teamId).sort()).toEqual([teamAlpha, teamBeta].sort());
  });

  it("'none' (repos in no team) degrades to every team rather than an empty matrix", async () => {
    // 'none' selects UNASSIGNED REPOS, which have no team row of their own. A blank panel would
    // be a worse answer than the full comparison.
    const rows = await getTeamComparisonRows(1, 'none');
    expect(rows).toHaveLength(2);
  });

  it("a bare '<teamId>' (a ONE-team selection, as teamSetToScope canonicalises it) selects just that team", async () => {
    const rows = await getTeamComparisonRows(1, String(teamBeta));
    expect(rows.map((r) => r.teamName)).toEqual(['Beta']);
  });

  it("'teams:<ids>' selects exactly those teams — the explicit multi-select the old All-Teams-only gate dropped", async () => {
    const both = await getTeamComparisonRows(1, `teams:${teamAlpha},${teamBeta}`);
    expect(both.map((r) => r.teamName)).toEqual(['Alpha', 'Beta']);
    const one = await getTeamComparisonRows(1, `teams:${teamAlpha}`);
    expect(one.map((r) => r.teamName)).toEqual(['Alpha']);
  });

  it('a malformed / unknown scope selects nothing rather than falling back to everything', async () => {
    expect(await getTeamComparisonRows(1, 'not-a-scope')).toEqual([]);
    expect(await getTeamComparisonRows(1, '-1')).toEqual([]);
    expect(await getTeamComparisonRows(1, '999999')).toEqual([]);
  });

  it('rows carry the team repo count and real metrics for the repos in that team only', async () => {
    const rows = await getTeamComparisonRows(1, 'teams');
    const alpha = rows.find((r) => r.teamId === teamAlpha)!;
    const beta = rows.find((r) => r.teamId === teamBeta)!;
    // The unassigned repo is in neither team.
    expect(alpha.repoCount).toBe(1);
    expect(beta.repoCount).toBe(2);
    expect(alpha.metrics.merges.value).toBe(2);
    expect(beta.metrics.merges.value).toBe(1);
  });
});

describe('getTeamComparisonRows — accountId scoping (IDOR)', () => {
  it("account 2 asking for account 1's team by id gets NO row", async () => {
    expect(await getTeamComparisonRows(2, String(teamAlpha))).toEqual([]);
    expect(await getTeamComparisonRows(2, `teams:${teamAlpha},${teamBeta}`)).toEqual([]);
  });

  it("account 1 asking for account 2's team by id gets NO row (blocked in both directions)", async () => {
    expect(await getTeamComparisonRows(1, String(teamForeign))).toEqual([]);
    expect(await getTeamComparisonRows(1, `teams:${teamForeign}`)).toEqual([]);
  });

  it("an unscoped comparison returns only the caller's OWN teams", async () => {
    // Both accounts have a team NAMED 'Alpha'; the ids must not cross.
    const a1 = await getTeamComparisonRows(1, 'teams');
    const a2 = await getTeamComparisonRows(2, 'teams');
    expect(a1.map((r) => r.teamId).sort()).toEqual([teamAlpha, teamBeta].sort());
    expect(a2.map((r) => r.teamId)).toEqual([teamForeign]);
  });

  it("account 2's metrics never include account 1's PRs (the numbers are scoped, not just the rows)", async () => {
    const a2 = await getTeamComparisonRows(2, 'teams');
    // 3 merges seeded on account 2's own repo, 3 on account 1's. A leak would show 6.
    expect(a2[0]!.metrics.merges.value).toBe(3);
  });
});

describe('getTeamComparison — response envelope', () => {
  it('is always enabled from core and reports the trailing-14d window it computed over', async () => {
    const res = await getTeamComparison(1, 'teams');
    expect(res.enabled).toBe(true);
    expect(res.teams).toHaveLength(2);
    const span = Date.parse(res.sprint.to) - Date.parse(res.sprint.from);
    expect(Math.round(span / DAY)).toBe(14);
  });
});
