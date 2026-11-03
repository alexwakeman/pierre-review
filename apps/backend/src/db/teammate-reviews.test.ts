// TEAMMATES' POSTED REVIEWS (docs/CLAUDE-REVIEW.md § Teammates' reviews). Throwaway sqlite; the real
// persistPr (which runs the import after its commit), no GitHub.
//
// What this pins:
//   1. A teammate's posted Limn review (summary marker WITH metadata) becomes one read-only
//      `kind = 'teammate'` run: summary without the marker, verdict, head, provider/model/effort, and
//      its findings rebuilt from the teammate's finding comments (severity from the lead, path/line,
//      text without lead or marker). A reply on the thread is not a finding.
//   2. A legacy summary (no metadata) imports with null run fields and the inferred head.
//   3. Re-running the import (a second walk) writes nothing new: same ids, same counts.
//   4. The reader's OWN posted review is never imported.
//   5. A replies-pass outcome (`k=replies`) is never imported.
//   6. Own-runs readers leave the teammate rows out: the auto-review daily cap count, the latest
//      review, the history; the follow-up anchor (`latestFullReviewAtOrBefore`) can name one.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { limnReviewMarker } from '@pierre-review/shared';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-teammate-reviews-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('../sync/upsert.js');
let teammate: typeof import('./teammate-reviews.js');
let importer: typeof import('./teammate-reviews-import.js');
let queries: typeof import('./queries.js');
let repoId = 0;
let workspaceId = 0;

const MARK = '<!-- pierre:claude-review-finding v=1 -->';
const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' }; // the reader
const ROBIN = { login: 'robin-dev', id: 'U_robin', __typename: 'User' }; // the teammate
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' }; // the PR author
const HEAD = 'b'.repeat(40);
const OLD = 'c'.repeat(40);

function comment(id: string, author: any, body: string, at: string): any {
  return { id, fullDatabaseId: id.replace(/\D/g, '') || null, body, createdAt: at, diffHunk: null, author };
}

function thread(id: string, comments: any[], over: Record<string, unknown> = {}): any {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    isCollapsed: false,
    path: 'src/x.ts',
    line: 12,
    resolvedBy: null,
    comments: { nodes: comments },
    ...over,
  };
}

function review(id: string, author: any, body: string, at: string, state = 'COMMENTED'): any {
  return { id, fullDatabaseId: id.replace(/\D/g, ''), state, body, submittedAt: at, author };
}

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_tm_${n}`,
    number: n,
    title: 'Parser fix',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-10-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-10-02T00:00:00Z',
    url: `https://github.com/acme/tm/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'fix',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function prIdOf(n: number): Promise<number> {
  const { eq } = await import('drizzle-orm');
  return (await db.select({ id: schema.pullRequests.id }).from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, `PR_tm_${n}`)).execute())[0].id;
}

async function teammateRows(prId: number): Promise<any[]> {
  const { and, eq } = await import('drizzle-orm');
  return db
    .select()
    .from(schema.claudeReviews)
    .where(and(eq(schema.claudeReviews.prId, prId), eq(schema.claudeReviews.kind, 'teammate')))
    .execute();
}

async function findingRows(reviewId: number): Promise<any[]> {
  const { eq } = await import('drizzle-orm');
  return db.select().from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.reviewId, reviewId)).execute();
}

const ROBIN_SUMMARY = `Two things to fix before this lands.\n\n_Posted automatically by Limn’s Claude review._\n\n${limnReviewMarker('aa11', {
  headSha: HEAD,
  run: 'auto',
  pair: false,
  runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
  verdict: 'REQUEST_CHANGES',
  limnVersion: '0.1.174',
})}`;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('../sync/upsert.js');
  teammate = await import('./teammate-reviews.js');
  importer = await import('./teammate-reviews-import.js');
  queries = await import('./queries.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).where(eq(schema.accounts.id, 1)).execute();
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'tm', githubNodeId: 'R_tm_1' })
    .returning()
    .execute();
  repoId = r.id;
  workspaceId = await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe("teammates' posted reviews", () => {
  it("imports a teammate's posted review with its findings, read-only", async () => {
    await persist(
      gqlPr(1, {
        reviews: { nodes: [review('RV_501', ROBIN, ROBIN_SUMMARY, '2026-10-02T10:00:00Z', 'CHANGES_REQUESTED')] },
        reviewThreads: {
          nodes: [
            thread('T_1', [
              comment('C_101', ROBIN, `**Warning**\n\nThis can throw on an empty list.\n\n${MARK}`, '2026-10-02T10:00:00Z'),
              comment('C_102', CAROL, 'Good catch.', '2026-10-02T11:00:00Z'),
              comment('C_103', ROBIN, `Thanks.\n\n${MARK}`, '2026-10-02T12:00:00Z'),
            ]),
          ],
        },
        comments: {
          nodes: [comment('IC_301', ROBIN, `**Blocker** · \`src/y.ts:4\`\n\nThe lock is never released.\n\n${MARK}`, '2026-10-02T10:00:05Z')],
        },
      }),
    );
    const prId = await prIdOf(1);
    const rows = await teammateRows(prId);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r).toMatchObject({
      status: 'succeeded',
      trigger: 'manual',
      headSha: HEAD,
      provider: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
      verdict: 'REQUEST_CHANGES',
      summary: 'Two things to fix before this lands.\n\n_Posted automatically by Limn’s Claude review._',
      postedReviewId: null,
      costUsd: null,
      sourceReviewNodeId: 'RV_501',
    });
    expect(r.teammate).toMatchObject({ run: 'auto', pair: false, limnVersion: '0.1.174', headInferred: false, githubReviewId: '501' });

    const f = (await findingRows(r.id)).sort((a, b) => a.id - b.id);
    expect(f.map((x) => [x.postedCommentKind, x.severity, x.path, x.line, x.body])).toEqual([
      ['inline', 'warning', 'src/x.ts', 12, 'This can throw on an empty list.'],
      ['pr_comment', 'blocker', 'src/y.ts', 4, 'The lock is never released.'],
    ]);
    expect(f.every((x) => x.included === false && x.postedAt != null)).toBe(true);

    const listed = await teammate.listTeammateReviews(db, 1, prId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      poster: { login: 'robin-dev' },
      run: 'auto',
      runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }],
      githubUrl: 'https://github.com/acme/tm/pull/1#pullrequestreview-501',
    });
    expect(listed[0]!.findings[0]).toMatchObject({
      severity: 'warning',
      kind: 'inline',
      githubUrl: 'https://github.com/acme/tm/pull/1#discussion_r101',
    });
    expect(listed[0]!.findings[0]!.threadId).toEqual(expect.any(Number));
    expect(listed[0]!.findings[1]).toMatchObject({ kind: 'pr_comment', githubUrl: 'https://github.com/acme/tm/pull/1#issuecomment-301' });
  });

  it('is idempotent: a second walk writes the same rows', async () => {
    const prId = await prIdOf(1);
    const before = await teammateRows(prId);
    const beforeF = await findingRows(before[0].id);
    const again = await importer.importTeammateReviews(1, prId);
    expect(again).toEqual({ reviews: 1, findings: 2, removedFindings: 0 });
    const after = await teammateRows(prId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect((await findingRows(after[0].id)).map((x) => x.id).sort()).toEqual(beforeF.map((x) => x.id).sort());
  });

  it('imports a legacy summary (no metadata) with null run fields and the inferred head', async () => {
    await persist(
      gqlPr(2, {
        reviews: { nodes: [review('RV_502', ROBIN, 'Old style summary.\n\n<!-- pierre:claude-review v=1 -->', '2026-10-03T10:00:00Z')] },
      }),
    );
    const prId = await prIdOf(2);
    await db.insert(schema.commits).values([
      { sha: OLD, prId, committedAt: new Date('2026-10-03T09:00:00Z') },
      { sha: HEAD, prId, committedAt: new Date('2026-10-03T11:00:00Z') },
    ]).execute();
    await importer.importTeammateReviews(1, prId);
    const [r] = await teammateRows(prId);
    expect(r).toMatchObject({ summary: 'Old style summary.', headSha: OLD, model: '', provider: null, effort: null, verdict: 'COMMENT' });
    expect(r.teammate).toMatchObject({ run: null, pair: false, runs: [], limnVersion: null, headInferred: true });
  });

  it("never imports the reader's own post, nor a replies-pass outcome", async () => {
    const own = `Mine.\n\n${limnReviewMarker('bb22', { headSha: HEAD, run: 'manual', runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: null }] })}`;
    const replies = `Replies look fine.\n\n${limnReviewMarker('cc33', { headSha: HEAD, run: 'replies' })}`;
    await persist(
      gqlPr(3, {
        reviews: {
          nodes: [review('RV_503', ALICE, own, '2026-10-04T10:00:00Z'), review('RV_504', ROBIN, replies, '2026-10-04T11:00:00Z', 'APPROVED')],
        },
        reviewThreads: { nodes: [thread('T_3', [comment('C_301', ALICE, `**Nit**\n\nRename.\n\n${MARK}`, '2026-10-04T10:00:00Z')])] },
      }),
    );
    expect(await teammateRows(await prIdOf(3))).toHaveLength(0);
  });

  it("keeps teammate rows out of the reader's own runs, and the anchor can name one", async () => {
    const prId = await prIdOf(1);
    const [tm] = await teammateRows(prId);
    // Even stamped 'auto', a teammate row is never counted toward the reader's daily cap.
    const { eq } = await import('drizzle-orm');
    await db.update(schema.claudeReviews).set({ trigger: 'auto', createdAt: new Date() }).where(eq(schema.claudeReviews.id, tm.id)).execute();
    const [own] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: OLD, status: 'succeeded', model: 'claude-opus-5-5', trigger: 'auto', createdAt: new Date(), finishedAt: new Date('2026-10-01T12:00:00Z') })
      .returning()
      .execute();
    const dayStartMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const cands = await queries.getAutoReviewCandidates(1, workspaceId, { openedSinceMs: 0, dayStartMs, limit: 0 });
    expect(cands?.autoToday).toBe(1);

    const persistMod = await import('../review/claude-review/persist.js');
    const ctx = { db, schema } as any;
    expect((await persistMod.getLatestClaudeReview(ctx, prId, 1))?.id).toBe(own.id);
    expect((await persistMod.listClaudeReviewHistory(ctx, prId, 1)).map((h) => h.id)).toEqual([own.id]);
    // Read-only: no draft write, no post context.
    expect(await persistMod.updateReviewDraft(ctx, tm.id, { userBody: 'x' })).toBe(false);
    expect(await persistMod.getReviewPostContext(ctx, tm.id, 1)).toBeNull();

    // The follow-up anchor: own or teammate's, the latest at or before the head.
    await db.insert(schema.commits).values([
      { sha: OLD, prId, committedAt: new Date('2026-10-01T09:00:00Z') },
      { sha: HEAD, prId, committedAt: new Date('2026-10-02T09:00:00Z') },
    ]).execute();
    expect(await teammate.latestFullReviewAtOrBefore(1, prId, HEAD, db)).toMatchObject({ reviewId: tm.id, origin: 'teammate', headSha: HEAD });
    expect(await teammate.latestFullReviewAtOrBefore(1, prId, OLD, db)).toMatchObject({ reviewId: own.id, origin: 'own' });
  });
});
