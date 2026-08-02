// Cross-WORKSPACE comparison (`GET /api/workspace-metrics/compare` → getWorkspaceComparison) on a
// THROWAWAY sqlite DB.
//
// WHAT CHANGED FROM ITS PREDECESSOR, and why most of the old file is gone rather than ported:
// `getWorkspaceComparisonRows` takes NO SCOPE AT ALL. The team-era module parsed a `TeamScope`
// wire string and narrowed the matrix to the selected teams, which is what made the surface vanish
// the moment fewer than two teams were selected. Every "scope resolution across every wire form"
// case in the old suite therefore has no subject any more — there is no parser left to pin. What
// survives is the half that was always the real risk:
//
//  1. THE ROSTER IS THE WHOLE ROSTER — Default included, in listWorkspaces order (default first,
//     then by name). A repo in no workspace at all must still be counted, because the membership
//     repair moves it into Default; under the old model it was simply invisible.
//  2. accountId SCOPING, in BOTH directions. There is no id parameter to attack, so the only way
//     this leaks is through the metrics themselves — hence account 2 owns its OWN workspace, its
//     OWN repo and its OWN merged PRs, and the assertion is on the NUMBERS, not just the rows. An
//     empty foil would make every isolation assertion here pass for the wrong reason.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-workspace-comparison-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let getWorkspaceComparison: (accountId: number) => Promise<any>;
let getWorkspaceComparisonRows: (accountId: number) => Promise<any[]>;

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

// Account 1's two NON-default workspaces + its auto-created Default; account 2's one, the foil.
let wsAlpha = 0;
let wsBeta = 0;
let wsForeign = 0;
let defaultOne = 0;
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
  const mod = await import('./workspace-comparison.js');
  getWorkspaceComparison = mod.getWorkspaceComparison;
  getWorkspaceComparisonRows = mod.getWorkspaceComparisonRows;
  await runMigrations();

  await seedAccount(1, 'owner-one');
  await seedAccount(2, 'owner-two');

  // The script inserts its accounts AFTER migrating, so they carry no Default workspace. Create
  // it explicitly — the row ordering assertion below is about Default being first, and it cannot
  // be about a row that does not exist.
  defaultOne = await q.ensureDefaultWorkspace(1);
  await q.ensureDefaultWorkspace(2);

  // Account 1: "Alpha" (1 repo, 2 merges) + "Beta" (2 repos, 1 merge). Names chosen so the
  // default-first-then-name order is Default, Alpha, Beta — the column order the matrix renders.
  const alphaRepo = await seedRepo(1, 'alpha-svc');
  const betaRepo1 = await seedRepo(1, 'beta-svc');
  const betaRepo2 = await seedRepo(1, 'beta-web');
  // A repo assigned to nothing. Under the old model it belonged to no team and was
  // invisible to the matrix; now the membership repair homes it into Default, and Default's
  // repoCount is what proves the repair ran.
  await seedRepo(1, 'unassigned-svc');
  wsAlpha = (await q.createWorkspace(1, 'Alpha')).id;
  wsBeta = (await q.createWorkspace(1, 'Beta')).id;
  await q.assignReposToWorkspace(wsAlpha, 1, [alphaRepo]);
  await q.assignReposToWorkspace(wsBeta, 1, [betaRepo1, betaRepo2]);
  await seedMergedPr(1, alphaRepo);
  await seedMergedPr(1, alphaRepo);
  await seedMergedPr(1, betaRepo1);

  // Account 2: its own workspace + repo + merged PRs. NOT a bare empty account — an empty foil
  // makes the cross-account assertions pass for the wrong reason.
  const foreignRepo = await seedRepo(2, 'foreign-svc');
  wsForeign = (await q.createWorkspace(2, 'Alpha')).id; // same NAME as account 1's, on purpose
  await q.assignReposToWorkspace(wsForeign, 2, [foreignRepo]);
  await seedMergedPr(2, foreignRepo);
  await seedMergedPr(2, foreignRepo);
  await seedMergedPr(2, foreignRepo);
});

afterAll(() => closeDb?.());

describe('getWorkspaceComparisonRows — the whole roster, no scope', () => {
  it('returns every workspace the account owns, Default first then by name', async () => {
    const rows = await getWorkspaceComparisonRows(1);
    expect(rows.map((r) => r.workspaceName)).toEqual(['Default', 'Alpha', 'Beta']);
    expect(rows[0]!.isDefault).toBe(true);
    expect(rows[0]!.workspaceId).toBe(defaultOne);
  });

  it('rows carry the workspace repo count and metrics for THAT workspace only', async () => {
    const rows = await getWorkspaceComparisonRows(1);
    const alpha = rows.find((r) => r.workspaceId === wsAlpha)!;
    const beta = rows.find((r) => r.workspaceId === wsBeta)!;
    expect(alpha.repoCount).toBe(1);
    expect(beta.repoCount).toBe(2);
    expect(alpha.metrics.merges.value).toBe(2);
    expect(beta.metrics.merges.value).toBe(1);
  });

  it('the repo assigned to nothing is homed into Default rather than vanishing', async () => {
    const rows = await getWorkspaceComparisonRows(1);
    const def = rows.find((r) => r.isDefault)!;
    expect(def.repoCount).toBe(1);
  });
});

describe('getWorkspaceComparisonRows — accountId scoping (IDOR)', () => {
  it("each account sees only its OWN workspaces, in both directions", async () => {
    const a1 = await getWorkspaceComparisonRows(1);
    const a2 = await getWorkspaceComparisonRows(2);
    expect(a1.map((r) => r.workspaceId)).toContain(wsAlpha);
    expect(a1.map((r) => r.workspaceId)).not.toContain(wsForeign);
    expect(a2.map((r) => r.workspaceId)).toContain(wsForeign);
    expect(a2.map((r) => r.workspaceId)).not.toContain(wsAlpha);
    expect(a2.map((r) => r.workspaceId)).not.toContain(wsBeta);
  });

  it("account 2's metrics never include account 1's PRs (the NUMBERS are scoped, not just the rows)", async () => {
    // 3 merges seeded on account 2's own repo, 3 on account 1's. A leak would show 6.
    const a2 = await getWorkspaceComparisonRows(2);
    const foreign = a2.find((r) => r.workspaceId === wsForeign)!;
    expect(foreign.metrics.merges.value).toBe(3);
  });
});

describe('getWorkspaceComparison — response envelope', () => {
  it('is always enabled from core and reports the trailing-14d window it computed over', async () => {
    const res = await getWorkspaceComparison(1);
    expect(res.enabled).toBe(true);
    expect(res.workspaces).toHaveLength(3);
    const span = Date.parse(res.sprint.to) - Date.parse(res.sprint.from);
    expect(Math.round(span / DAY)).toBe(14);
  });
});
