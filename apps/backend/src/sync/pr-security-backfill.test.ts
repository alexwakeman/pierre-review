// DEPENDENCY + SECURITY BACKFILL: which open PRs it asks GitHub about, and what it writes back.
// Throwaway sqlite; GitHub is mocked (the review-request-history.test.ts pattern).
//
// What this pins:
//   1. The worklist is this account's OPEN, UN-STAMPED PRs in this repo that could be dependency
//      automation — an automated author by any account-free signal, or a tool's marker under a
//      person's account. A person's PR with no marker is never fetched.
//   2. "NOT RECEIVED" WRITES NOTHING — a node with `bodyText` nulled keeps its stamp NULL and is
//      asked for again on a later walk.
//   3. A received node is classified through the same columns persistPr writes, stamped, and a
//      branch the walk never stored is filled in.
//   4. The budget contract: a known-limited token costs no call; a rate-limit error is reported
//      through `noteLimited` and stops the run.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const DB_PATH = '/tmp/pierre-pr-security-backfill-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

const gqlCalls: { ids: string[] }[] = [];
let gqlAnswer: (ids: string[]) => unknown = () => ({ nodes: [] });

vi.mock('../auth/account.js', async (orig) => ({
  ...(await orig<object>()),
  getAccessToken: async () => 'test-token',
}));
vi.mock('../github/client.js', async (orig) => ({
  ...(await orig<object>()),
  getGraphqlClientFor: () => ({}),
  graphqlTolerant: async (_c: unknown, _q: string, vars: { ids: string[] }) => {
    gqlCalls.push({ ids: vars.ids });
    return gqlAnswer(vars.ids);
  },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let backfill: typeof import('./backfill-pr-security.js');
let budget: typeof import('../github/rate-budget.js');
let repoId = 0;
let otherRepoId = 0;
let foreignRepoId = 0;
const U: Record<string, number> = {};
const H = 3_600_000;

async function mkUser(login: string, over: Record<string, unknown> = {}): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ githubLogin: login, isBot: false, ...over })
    .returning()
    .execute();
  return u.id;
}

async function mkPr(
  accountId: number,
  rid: number,
  n: number,
  authorId: number,
  over: Record<string, unknown> = {},
): Promise<number> {
  const now = Date.now();
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_sb_${accountId}_${n}`,
      accountId,
      repoId: rid,
      number: n,
      title: `pr ${n}`,
      authorId,
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 10 * 24 * H),
      updatedAt: new Date(now - n * H),
      headRefName: `feature/${n}`,
      ...over,
    })
    .returning()
    .execute();
  return pr.id;
}

async function rowOf(id: number): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.id, id)).execute())[0];
}

const FOOTER =
  'Bumps x from 1 to 2.\nYou can disable automated security fix PRs for this repo from the Security Alerts page.';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  backfill = await import('./backfill-pr-security.js');
  budget = await import('../github/rate-budget.js');
  await db
    .insert(schema.accounts)
    .values({ id: 2, githubUserId: 'U_sb_b', githubLogin: 'sb-b', isLocal: false })
    .execute();
  const mkRepo = async (accountId: number, name: string): Promise<number> =>
    (
      await db
        .insert(schema.repos)
        .values({ accountId, owner: 'acme', name, githubNodeId: `R_sb_${accountId}_${name}` })
        .returning()
        .execute()
    )[0].id;
  repoId = await mkRepo(1, 'sb');
  otherRepoId = await mkRepo(1, 'sb-other');
  foreignRepoId = await mkRepo(2, 'sb');
  U.human = await mkUser('alice');
  U.isBot = await mkUser('dependabot[bot]', { isBot: true });
  // GitHub-typed Bot the login heuristics miss (socket-security's real shape: is_bot = 0).
  U.typedBot = await mkUser('acme-release-app', { githubType: 'Bot' });
  // A vendor login with no bot flag and no type (the REST-style bare row).
  U.vendor = await mkUser('renovate');
  U.semgrep = await mkUser('semgrep-code-acme[bot]');
});

beforeEach(() => {
  gqlCalls.length = 0;
  gqlAnswer = () => ({ nodes: [] });
  budget.__resetRateBudget();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('prSecurityBackfillWorklist', () => {
  it('lists only this account\'s open, un-stamped, automation-or-marker PRs in this repo', async () => {
    const want = {
      isBot: await mkPr(1, repoId, 1, U.isBot!),
      typedBot: await mkPr(1, repoId, 2, U.typedBot!),
      vendor: await mkPr(1, repoId, 3, U.vendor!),
      semgrep: await mkPr(1, repoId, 4, U.semgrep!),
      snykUnderPerson: await mkPr(1, repoId, 5, U.human!, { headRefName: 'snyk-fix-476d1f32ddb0e743d31723f1becb1e0b' }),
      frogbotTitle: await mkPr(1, repoId, 6, U.human!, { title: '[🐸 Frogbot] Update version of x to 2' }),
    };
    const not = {
      person: await mkPr(1, repoId, 7, U.human!),
      closed: await mkPr(1, repoId, 8, U.isBot!, { state: 'closed', closedAt: new Date() }),
      stamped: await mkPr(1, repoId, 9, U.isBot!, { securityCheckedAt: new Date() }),
      otherRepo: await mkPr(1, otherRepoId, 10, U.isBot!),
      foreign: await mkPr(2, foreignRepoId, 11, U.isBot!),
      // A branch that merely CONTAINS a marker is not one.
      containsMarker: await mkPr(1, repoId, 12, U.human!, { headRefName: 'alice/renovate/cleanup' }),
    };
    const ids = (await backfill.prSecurityBackfillWorklist(1, repoId)).map((r) => r.id);
    for (const [name, id] of Object.entries(want)) expect(ids, name).toContain(id);
    for (const [name, id] of Object.entries(not)) expect(ids, name).not.toContain(id);
    // Most recently active first.
    expect(ids[0]).toBe(want.isBot);
    // The other tenant sees its own PR, and never this one's.
    expect((await backfill.prSecurityBackfillWorklist(2, foreignRepoId)).map((r) => r.id)).toEqual([not.foreign]);
    expect(await backfill.prSecurityBackfillWorklist(1, foreignRepoId)).toEqual([]);
  });
});

describe('backfillPrSecurity', () => {
  it('classifies and stamps what GitHub returned, fills a missing branch, and leaves the rest for later', async () => {
    const got = await mkPr(1, repoId, 20, U.isBot!, { headRefName: null });
    const nulled = await mkPr(1, repoId, 21, U.isBot!);
    const missing = await mkPr(1, repoId, 22, U.isBot!);
    gqlAnswer = (ids) => ({
      nodes: [
        ...ids
          .filter((id) => id === 'PR_sb_1_20')
          .map((id) => ({
            id,
            title: 'Bump x from 1 to 2',
            headRefName: 'dependabot/npm_and_yarn/x-2',
            bodyText: FOOTER,
            labels: { nodes: [{ name: 'dependencies' }] },
          })),
        // Returned, but its body selection nulled: not received.
        { id: 'PR_sb_1_21', title: 'Bump y', headRefName: 'dependabot/npm_and_yarn/y-2', bodyText: null, labels: null },
        // A node this worklist never asked for must not reach a write.
        { id: 'PR_sb_2_11', title: 'x', headRefName: 'dependabot/x', bodyText: FOOTER, labels: { nodes: [] } },
      ],
      rateLimit: { remaining: 4000, resetAt: new Date(Date.now() + H).toISOString(), cost: 1 },
    });
    const written = await backfill.backfillPrSecurity(1, repoId);
    const asked = gqlCalls.flatMap((c) => c.ids);
    expect(asked).toContain('PR_sb_1_20');
    expect(asked).not.toContain('PR_sb_2_11');
    expect(written).toBeGreaterThanOrEqual(1);

    const row = await rowOf(got);
    expect(row).toMatchObject({ dependencyVendor: 'dependabot', securityFix: 'proven', headRefName: 'dependabot/npm_and_yarn/x-2' });
    expect(row.securityCheckedAt).toBeInstanceOf(Date);
    expect((await rowOf(nulled)).securityCheckedAt).toBeNull();
    expect((await rowOf(missing)).securityCheckedAt).toBeNull();
    const foreign = (await backfill.prSecurityBackfillWorklist(2, foreignRepoId))[0]!;
    expect((await rowOf(foreign.id)).securityCheckedAt).toBeNull();

    // A second run does not ask for the stamped PR again, and does ask for the nulled one.
    gqlCalls.length = 0;
    gqlAnswer = () => ({ nodes: [] });
    await backfill.backfillPrSecurity(1, repoId);
    const again = gqlCalls.flatMap((c) => c.ids);
    expect(again).not.toContain('PR_sb_1_20');
    expect(again).toContain('PR_sb_1_21');
  });

  it('classifies with the stored branch when the response omits one', async () => {
    const id = await mkPr(1, repoId, 30, U.human!, { headRefName: 'snyk-fix-0123456789abcdef0123456789abcdef' });
    gqlAnswer = (ids) => ({
      nodes: ids
        .filter((x) => x === 'PR_sb_1_30')
        .map((x) => ({ id: x, title: 'Upgrade deps', headRefName: null, bodyText: 'Pinned.', labels: { nodes: [] } })),
    });
    await backfill.backfillPrSecurity(1, repoId);
    expect(await rowOf(id)).toMatchObject({
      headRefName: 'snyk-fix-0123456789abcdef0123456789abcdef',
      dependencyVendor: 'snyk',
      securityFix: 'proven',
    });
  });

  it('never overwrites a branch the walk stored — the walk owns that column', async () => {
    const id = await mkPr(1, repoId, 31, U.isBot!, { headRefName: 'dependabot/npm_and_yarn/z-2' });
    gqlAnswer = (ids) => ({
      nodes: ids
        .filter((x) => x === 'PR_sb_1_31')
        .map((x) => ({ id: x, title: 'Bump z', headRefName: 'dependabot/npm_and_yarn/z-3', bodyText: FOOTER, labels: { nodes: [] } })),
    });
    await backfill.backfillPrSecurity(1, repoId);
    expect(await rowOf(id)).toMatchObject({ headRefName: 'dependabot/npm_and_yarn/z-2', securityFix: 'proven' });
  });

  it('spends nothing when the token is already known to be limited', async () => {
    await mkPr(1, repoId, 40, U.isBot!);
    budget.noteLimited(1, new Date(Date.now() + H));
    expect(await backfill.backfillPrSecurity(1, repoId)).toBe(0);
    expect(gqlCalls).toEqual([]);
  });

  it('reports a rate limit and stops at the first limited batch', async () => {
    const { PR_SECURITY_NODE_BATCH } = backfill.__prSecurityBackfillTesting;
    // Enough un-stamped automation PRs for a second batch.
    for (let n = 100; n < 100 + PR_SECURITY_NODE_BATCH + 5; n += 1) await mkPr(1, otherRepoId, n, U.isBot!);
    gqlAnswer = () => {
      throw Object.assign(new Error('API rate limit exceeded'), { status: 403 });
    };
    expect(budget.isLimited(1)).toBe(false);
    expect(await backfill.backfillPrSecurity(1, otherRepoId)).toBe(0);
    expect(gqlCalls).toHaveLength(1);
    expect(budget.isLimited(1)).toBe(true);
  });

  it('lets a non-rate-limit failure throw — the caller logs it as non-fatal', async () => {
    const id = await mkPr(1, repoId, 50, U.isBot!);
    gqlAnswer = () => {
      throw new Error('boom');
    };
    await expect(backfill.backfillPrSecurity(1, repoId)).rejects.toThrow('boom');
    expect((await rowOf(id)).securityCheckedAt).toBeNull();
  });
});
