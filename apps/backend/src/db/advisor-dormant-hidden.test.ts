// The Bot Tuning Advisor HIDES DORMANT REVIEWERS, on a THROWAWAY sqlite DB.
//
// Seeds two review bots in one workspace:
//  • LIVE (coderabbitai) — an untouched thread 5 days old, plus an ML label on its origin comment.
//  • DORMANT (greptile-apps) — NO thread, NO review comment, NO submitted review anywhere in the
//    30-day dormancy window; its only in-window footprint is an ML label on a PR-LEVEL comment,
//    which is exactly the state that used to emit an advisor row (`mlLabelled > 0`) for a reviewer
//    the Bots ROI table already calls dormant. PR-level comments are deliberately NOT dormancy
//    evidence — `getBotAnalytics` does not count them either, and the two must agree.
//
// The point of the assertions below is the DIRECTION of the filter: the live bot keeps every cell
// it had, and the dormant one leaves nothing behind — no row, no cell, no zero.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-advisor-dormant-hidden-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let dormancy: any;
let scope: any;
let liveBotId = 0;
let dormantBotId = 0;

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const recent = new Date(now - 5 * DAY); // inside rolling_30 AND the dormancy window

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  dormancy = await import('./bot-dormancy.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, mlCommentLabels } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_adh' })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_adh',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'advisor dormancy fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 10 * DAY),
      updatedAt: recent,
    })
    .returning()
    .execute();

  const [live] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_adh1', isBot: true })
    .returning()
    .execute();
  const [dormant] = await db
    .insert(users)
    .values({ githubLogin: 'greptile-apps', githubNodeId: 'U_adh2', isBot: true })
    .returning()
    .execute();
  liveBotId = live.id;
  dormantBotId = dormant.id;

  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'ADH_T1',
      prId: pr.id,
      path: 'src/x.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'untouched',
      originalCommenterId: live.id,
      createdAt: recent,
    })
    .returning()
    .execute();
  const [originComment] = await db
    .insert(reviewComments)
    .values({
      githubNodeId: 'ADH_C1',
      prId: pr.id,
      threadId: thread.id,
      authorId: live.id,
      body: 'this allocation is unbounded',
      path: 'src/x.ts',
      createdAt: recent,
    })
    .returning()
    .execute();

  const label = (over: Record<string, unknown>) => ({
    accountId: 1,
    repoId: repo.id,
    prId: pr.id,
    authorUserId: live.id,
    severity: 'major',
    severityOrd: 2,
    severityProb: 0.9,
    categories: ['correctness'],
    categoryProbs: { correctness: 0.9 },
    isSummary: false,
    backend: 'modernbert-onnx',
    modelVersion: 'test',
    bodyHash: 'h',
    targetCreatedAt: recent,
    ...over,
  });
  await db
    .insert(mlCommentLabels)
    .values(label({ targetKind: 'review_comment', targetId: originComment.id }))
    .execute();
  // The dormant bot's ONLY in-window footprint: a labelled PR-LEVEL comment. No thread, no review
  // comment, no submitted review — so it is dormant, and before this gate it still emitted a row.
  await db
    .insert(mlCommentLabels)
    .values(
      label({
        authorUserId: dormant.id,
        targetKind: 'pr_comment',
        targetId: 4242,
        categories: ['maintainability'],
        categoryProbs: { maintainability: 0.8 },
      }),
    )
    .execute();

  // Through the production resolver — see bot-analytics-dormant.test.ts on why hand-building a
  // scope makes a missing membership look like a dormancy bug.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('bot dormancy (core predicate)', () => {
  it('names the silent reviewer and only the silent reviewer', async () => {
    expect(scope.repoIds).toHaveLength(1);
    const ids = await dormancy.dormantBotUserIds(1, scope.workspaceId, [liveBotId, dormantBotId]);
    expect(ids).toEqual([dormantBotId]);
  });

  it('is a subset of the candidates it was handed — it never widens', async () => {
    expect(await dormancy.dormantBotUserIds(1, scope.workspaceId, [liveBotId])).toEqual([]);
    expect(await dormancy.dormantBotUserIds(1, scope.workspaceId, [])).toEqual([]);
  });

  it('a workspace with no repos yields no dormant ids — silence unobserved is not a judgement', async () => {
    const [empty] = await db
      .insert(schema.workspaces)
      .values({ accountId: 1, name: 'Empty', isDefault: false })
      .returning()
      .execute();
    expect(await dormancy.dormantBotUserIds(1, empty.id, [liveBotId, dormantBotId])).toEqual([]);
  });
});

describe('getAdvisorFindings hides dormant reviewers', () => {
  it('emits the live bot and drops the dormant one entirely', async () => {
    const payload = await q.getAdvisorFindings(1, 'rolling_30', scope);
    expect(payload.bots.map((b: { botUserId: number }) => b.botUserId)).toEqual([liveBotId]);
    // Not a zeroed row, not an empty cell list — absent.
    for (const cells of [payload.categoryCells, payload.pathCells, payload.overlapCells])
      expect(cells.some((c: { botUserId: number }) => c.botUserId === dormantBotId)).toBe(false);
    // The live bot kept its evidence: the filter removed a reviewer, not a fold.
    const liveRow = payload.bots[0];
    expect(liveRow.threads).toBe(1);
    expect(liveRow.mlLabelled).toBe(1);
    expect(liveRow.mlFindings).toBe(1);
    // Coverage is stated over the EMITTED corpus: 1 of 1 labels on screen carries a path.
    expect(payload.pathCoveragePct).toBe(100);
  });
});
