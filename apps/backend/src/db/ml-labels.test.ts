// The ML-label candidate query and the "pending" count, on a THROWAWAY sqlite DB.
//
// REGRESSION THIS FILE EXISTS FOR: an approval with no comment is a `reviews` row whose body is
// the EMPTY STRING, not NULL — there are 5.4k of them in this repo's own dev database. The first
// cut filtered candidates with `IS NOT NULL` and then dropped empty bodies in JavaScript, while
// the pending COUNT only did the `IS NOT NULL` half. The two therefore disagreed permanently:
// the worker skipped those rows on every tick while the Bots panel reported them as "still being
// processed", and coverage could never reach 100%. Both sides now share one `trim(x) <> ''`
// predicate. Seeding an empty-body review is what makes this fail against the old code.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-ml-labels-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let mlLabels: any;
let queries: any;

let scope: { workspaceId: number; repoIds: number[] };
let botId = 0;
let realReviewId = 0;
let emptyReviewId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  mlLabels = await import('./ml-labels.js');
  queries = await import('./queries.js');
  await runMigrations();

  const at = new Date();
  const { repos, pullRequests, users, reviews, reviewThreads } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'o', name: 'r', githubNodeId: 'R_ml' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_ml',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'pr',
      state: 'open',
      isDraft: false,
      openedAt: at,
      updatedAt: at,
    })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubNodeId: 'U_bot', githubLogin: 'somebot', isBot: true })
    .returning()
    .execute();
  botId = bot.id;

  // A thread so the actor has a FOOTPRINT — setWorkspaceReviewer refuses an actor without one,
  // and a review comment alone does not create one.
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_ml',
      prId: pr.id,
      path: 'a.ts',
      isResolved: false,
      derivedState: 'untouched',
      originalCommenterId: botId,
      createdAt: at,
    })
    .execute();

  // THE FIXTURE: one review with real text, one that is an approval with NO comment (empty
  // string, NOT null), and one that is whitespace only.
  const [real] = await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_real',
      prId: pr.id,
      authorId: botId,
      state: 'commented',
      body: 'This looks like a genuine finding worth classifying.',
      submittedAt: at,
    })
    .returning()
    .execute();
  realReviewId = real.id;
  const [empty] = await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_empty',
      prId: pr.id,
      authorId: botId,
      state: 'approved',
      body: '',
      submittedAt: at,
    })
    .returning()
    .execute();
  emptyReviewId = empty.id;
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_blank',
      prId: pr.id,
      authorId: botId,
      state: 'approved',
      body: '   \n  ',
      submittedAt: at,
    })
    .execute();

  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  scope = (await queries.workspaceScopeForRepo(1, repo.id))!;
  await queries.setWorkspaceReviewer(1, botId, {
    workspaceId: scope.workspaceId,
    automated: true,
  });
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ML label candidates vs the pending count', () => {
  it('excludes the empty-string approval, the 5.4k-row case', async () => {
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    expect(candidates.map((c: any) => c.targetId)).toContain(realReviewId);
    expect(candidates.map((c: any) => c.targetId)).not.toContain(emptyReviewId);
    // The whitespace-with-newlines row DOES survive, and that is deliberate: SQL's `trim()`
    // strips spaces only in both dialects, so excluding it would take a JS-side filter — and a
    // JS-side filter is exactly what made the two sides disagree. It is classified once and
    // then stops being pending, which is cheaper than a permanent discrepancy.
    expect(candidates).toHaveLength(2);
  });

  it('counts pending as EXACTLY what the worker will pick up (the empty-body trap)', async () => {
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    // THE INVARIANT. Against the old code this was 2 vs 3 (and against the code before that,
    // 1 vs 3): rows the worker would never offer were counted as work outstanding forever.
    expect(rollup.pending).toBe(candidates.length);
    expect(rollup.pending).toBe(2);
    expect(rollup.labelled).toBe(0);
  });

  // The account-wide backlog is what `GET /api/ml-status` reports so a sync surface can keep
  // showing the scoring phase instead of announcing "complete" when only the GitHub walk is
  // done. It walks every workspace itself, so the thing worth pinning is that it agrees with
  // the per-workspace answer rather than quietly reporting an empty backlog — a zero here would
  // make the indicator go dark with work still outstanding, which is the exact bug it fixes.
  it('reports the same outstanding work account-wide as the workspace rollup', async () => {
    const backlog = await mlLabels.getMlBacklogForAccount(1);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(backlog.pending).toBe(rollup.pending);
    expect(backlog.pending).toBe(2);
    expect(backlog.labelled).toBe(0);
  });

  it('drops to zero pending once every candidate is labelled', async () => {
    const prId = (await db.select().from(schema.pullRequests).execute())[0]!.id;
    const candidates = await mlLabels.listMlCandidates(1, scope, 100);
    await mlLabels.upsertMlLabels(
      candidates.map((c: any) => ({
        accountId: 1,
        repoId: scope.repoIds[0]!,
        prId,
        targetKind: c.targetKind,
        targetId: c.targetId,
        authorUserId: botId,
        severity: c.targetId === realReviewId ? 'major' : 'nit',
        severityOrd: c.targetId === realReviewId ? 2 : 0,
        severityProb: 0.8,
        categories: ['correctness_bug'],
        categoryProbs: { correctness_bug: 0.8 },
        isSummary: false,
        backend: 'test',
        modelVersion: 'test',
        bodyHash: 'h',
        targetCreatedAt: new Date(),
      })),
    );
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(rollup.pending).toBe(0);
    expect(rollup.labelled).toBe(2);
    expect(rollup.totals.bySeverity.major).toBe(1);
    expect(await mlLabels.listMlCandidates(1, scope, 100)).toEqual([]);
    // ...and the account-wide backlog drains with it, so the sync indicator can actually stop.
    expect(await mlLabels.getMlBacklogForAccount(1)).toEqual({ pending: 0, labelled: 2 });
  });

  it('upserts idempotently on (account, target_kind, target_id)', async () => {
    // The conflict target is the table's declared unique. A stale one type-checks perfectly and
    // only raises at runtime, only when a row is actually WRITTEN — so writing twice is the
    // only thing that exercises it.
    const row = {
      accountId: 1,
      repoId: scope.repoIds[0]!,
      prId: (await db.select().from(schema.pullRequests).execute())[0]!.id,
      targetKind: 'review' as const,
      targetId: realReviewId,
      authorUserId: botId,
      severity: 'nit' as const,
      severityOrd: 0,
      severityProb: 0.4,
      categories: ['nitpick'],
      categoryProbs: { nitpick: 0.4 },
      isSummary: false,
      backend: 'test2',
      modelVersion: 'test2',
      bodyHash: 'h2',
      targetCreatedAt: new Date(),
    };
    await mlLabels.upsertMlLabels([row]);
    const rollup = await mlLabels.getBotSeverityRollup(1, scope, true);
    expect(rollup.labelled).toBe(2); // the row was UPDATED, not duplicated
    expect(rollup.totals.bySeverity.major).toBe(0); // major → nit
    expect(rollup.totals.bySeverity.nit).toBe(2);
  });
});
