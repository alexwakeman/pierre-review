// getBenchmarkContributions — WHAT LEAVES THE TENANT, on a THROWAWAY sqlite DB.
//
// THE CONTRACT THIS FILE EXISTS FOR, and it is the highest-stakes one in the query layer: rows
// from this getter are contributed to a CROSS-ORG benchmark. They leave the account, land in a
// dataset shared with other tenants, and CANNOT BE RECALLED. So the question "which vendor kinds
// are comparable across orgs?" has to be answered by an ALLOW-list, and it has to be answered
// here rather than by a set constant that nothing proves is consulted.
//
// ⚠ WHY THIS FILE EXISTS AT ALL, stated plainly because it is a lesson about testing rather than
// about benchmarks. A unit test already pinned the CONTENTS of `BENCHMARKABLE_VENDOR_KINDS`
// against its shared twin — and when the predicate was mutated back to the old deny-list
// (`k !== 'in_house' && k !== 'pierre' && k !== 'vendor'`), that test still passed. It was
// checking that a list said the right thing, not that anything read it. Every assertion below
// goes through `getBenchmarkContributions` itself for that reason.
//
// The two rows that matter are the two the deny-list gets wrong:
//   • a QUALITY GATE a user has marked `role: 'review'` — it clears the role gate, so the kind
//     filter is the only thing left between SonarQube's volume and a shared review-bot cohort;
//   • a DEPENDENCY bot with a real brand kind — branded, automated, and not a reviewer.
// Under a deny-list both are contributed, because both kinds are "not in_house, not pierre, not
// vendor". Under the allow-list neither is, and a genuine CodeRabbit still is.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-benchmark-kinds-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
const id: Record<string, number> = {};

const DAY = 86_400_000;
// Second-aligned: sqlite stores `mode: 'timestamp'` as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
const FROM = new Date(now - 30 * DAY);
const TO = new Date(now + DAY);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const { runMigrations } = await import('./run-migrations.js');
  await runMigrations();
  q = await import('./queries.js');

  const { repos, users, pullRequests, reviewThreads, reviewComments, workspaces, workspaceRepos, workspaceReviewers } =
    schema;

  const ws = (
    await db
      .insert(workspaces)
      .values({ accountId: 1, name: 'Bench', isDefault: false })
      .returning()
      .execute()
  )[0].id;
  const repoId = (
    await db
      .insert(repos)
      .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_bk' })
      .returning()
      .execute()
  )[0].id;
  await db.insert(workspaceRepos).values({ accountId: 1, workspaceId: ws, repoId }).execute();

  const mkUser = async (key: string, login: string) => {
    id[key] = (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_bk_${key}`, isBot: true })
        .returning()
        .execute()
    )[0].id;
  };
  await mkUser('rabbit', 'coderabbitai');
  await mkUser('sonar', 'sonarqubecloud');
  await mkUser('dependabot', 'dependabot[bot]');
  await mkUser('inhouse', 'acme-ci');

  // ⚠ EVERY ROW IS `role: 'review'`, INCLUDING THE ONES THAT ARE NOT REVIEWERS.
  //
  // That is the point. The role gate (`automatedReviewerUserIdsForAccount(…, 'review')`) is the
  // FIRST defence and would quietly hide this bug: with SonarQube roled `quality_check` it never
  // reaches the kind filter at all, and a deny-list would look perfectly correct. A user marking
  // a quality gate "review bot" is an ordinary thing to do — the row is `source: 'manual'` here
  // because that is how it happens in the product — and at that point the kind filter is the only
  // thing standing between a linter and a shared review-bot cohort.
  const rv = (over: Record<string, unknown>) => ({
    accountId: 1,
    workspaceId: ws,
    automated: true,
    role: 'review',
    confidence: 'high',
    source: 'manual',
    identitySource: 'manual',
    ...over,
  });
  await db
    .insert(workspaceReviewers)
    .values([
      rv({ authorUserId: id.rabbit, kind: 'coderabbit' }),
      rv({ authorUserId: id.sonar, kind: 'sonarqube' }),
      rv({ authorUserId: id.dependabot, kind: 'dependabot' }),
      rv({ authorUserId: id.inhouse, kind: 'in_house' }),
    ])
    .execute();

  // One PR, and one thread per actor so each has something to contribute.
  const prId = (
    await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_bk',
        accountId: 1,
        repoId,
        number: 1,
        title: 'fixture',
        state: 'merged',
        isDraft: false,
        openedAt: new Date(now - 10 * DAY),
        updatedAt: new Date(now - 9 * DAY),
        mergedAt: new Date(now - 9 * DAY),
      })
      .returning()
      .execute()
  )[0].id;

  for (const key of ['rabbit', 'sonar', 'dependabot', 'inhouse']) {
    const thread = (
      await db
        .insert(reviewThreads)
        .values({
          githubNodeId: `T_bk_${key}`,
          prId,
          path: 'src/a.ts',
          line: 1,
          isResolved: false,
          isOutdated: false,
          derivedState: 'untouched',
          originalCommenterId: id[key],
          createdAt: new Date(now - 5 * DAY),
        })
        .returning()
        .execute()
    )[0].id;
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_bk_${key}`,
        threadId: thread,
        prId,
        authorId: id[key],
        body: 'finding',
        createdAt: new Date(now - 5 * DAY),
      })
      .execute();
  }
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getBenchmarkContributions — the cross-org allow-list', () => {
  const kinds = async (): Promise<string[]> =>
    (await q.getBenchmarkContributions(1, FROM, TO))
      .map((r: any) => r.vendorKind)
      .sort();

  it('contributes a genuine AI-review vendor', async () => {
    // Without this the whole suite could pass by contributing nothing at all — which is the other
    // way a filter goes wrong, and it would silently empty the shared dataset.
    expect(await kinds()).toContain('coderabbit');
  });

  it('does NOT contribute a quality gate, even when a human marked it a review bot', async () => {
    // THE MUTATION THIS FILE EXISTS TO CATCH. Under the old deny-list `sonarqube` is "not
    // in_house, not pierre, not vendor" and is contributed — shipping a linter's thread and
    // comment counts into a cohort other tenants read as AI-review performance.
    expect(await kinds()).not.toContain('sonarqube');
  });

  it('does NOT contribute a dependency bot', async () => {
    expect(await kinds()).not.toContain('dependabot');
  });

  it('still excludes the unbranded kinds', async () => {
    // The original three exclusions, which the allow-list has to keep honouring: they are not
    // comparable across orgs and `in_house` is arguably identifying.
    const seen = await kinds();
    for (const k of ['in_house', 'pierre', 'vendor']) expect(seen).not.toContain(k);
  });

  it('contributes ONLY review-vendor kinds, whatever else is in the account', async () => {
    // The general statement rather than a list of specific exclusions: anything that reaches the
    // shared dataset must be a member of the review-bot cohort. A kind added to
    // `AutomatedReviewerKind` in future is excluded by DEFAULT under this rule.
    const { REVIEW_BOT_KINDS } = await import('@pierre-review/shared');
    for (const k of await kinds()) expect(REVIEW_BOT_KINDS.has(k), k).toBe(true);
  });
});
