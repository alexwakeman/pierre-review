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

  it('the one review (team-view.ts): the newer teammate review leads; resolved or addressed findings drop', async () => {
    const { loadTeamReviewView } = await import('../review/claude-review/team-view.js');
    const persistMod = await import('../review/claude-review/persist.js');
    const { eq } = await import('drizzle-orm');
    const ctx = { db, schema } as any;
    const prId = await prIdOf(1);
    const reviews = await teammate.listTeammateReviews(db, 1, prId);
    const [inline, prLevel] = reviews[0]!.findings;
    const view = async () =>
      loadTeamReviewView(db, 1, prId, await persistMod.getLatestClaudeReview(ctx, prId, 1), reviews, null);
    // The reader's own run finished before Robin posted: Robin's review leads, both findings list.
    expect(await view()).toMatchObject({ lead: 'teammate', teammateReviewId: reviews[0]!.reviewId });
    expect((await view()).findings.map((f) => f.id)).toEqual([inline!.id, prLevel!.id]);
    // Resolved on GitHub: the inline one drops.
    await db.update(schema.reviewThreads).set({ isResolved: true }).where(eq(schema.reviewThreads.id, inline!.threadId)).execute();
    expect((await view()).findings.map((f) => f.id)).toEqual([prLevel!.id]);
    // A later own review judged the PR-level one addressed: it drops, and that review leads.
    await db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1,
        prId,
        headSha: HEAD,
        status: 'succeeded',
        model: 'claude-opus-5-5',
        createdAt: new Date('2026-10-05T10:00:00Z'),
        finishedAt: new Date('2026-10-05T10:05:00Z'),
        followUp: { items: [{ priorFindingId: prLevel!.id, status: 'addressed' }] },
      })
      .execute();
    expect(await view()).toMatchObject({ lead: 'own', teammateReviewId: null, findings: [] });
  });

  it('the review count: own succeeded full reviews (a pair once, no skip, no replies pass) plus teammates', async () => {
    const { loadTeamReviewView } = await import('../review/claude-review/team-view.js');
    await persist(gqlPr(9));
    const prId = await prIdOf(9);
    const row = (over: Record<string, unknown>) => ({
      accountId: 1,
      prId,
      headSha: HEAD,
      status: 'succeeded',
      model: 'claude-opus-5-5',
      createdAt: new Date('2026-10-05T10:00:00Z'),
      finishedAt: new Date('2026-10-05T10:05:00Z'),
      ...over,
    });
    const [first] = await db.insert(schema.claudeReviews).values(row({})).returning().execute();
    await db.insert(schema.claudeReviews).values(row({ pairRole: 'first', pairId: first.id + 100 })).execute();
    await db.insert(schema.claudeReviews).values(row({ pairRole: 'second', pairId: first.id + 100 })).execute();
    await db.insert(schema.claudeReviews).values(row({ kind: 'replies' })).execute();
    await db.insert(schema.claudeReviews).values(row({ reviewMode: 'skip' })).execute();
    await db.insert(schema.claudeReviews).values(row({ status: 'failed' })).execute();
    // One plain run + one pair = 2; the replies pass, the skip and the failed run do not count.
    const noTeam = await loadTeamReviewView(db, 1, prId, null, [], null);
    expect(noTeam.reviewCount).toEqual({ total: 2, byTeammate: [] });
    const poster = { userId: 77, login: 'robin-dev', displayName: 'Robin Dunn', avatarUrl: null };
    const tm = (reviewId: number) => ({
      reviewId,
      poster,
      headSha: HEAD,
      headInferred: false,
      postedAt: '2026-10-04T10:00:00Z',
      githubUrl: null,
      summary: '',
      verdict: null,
      run: null,
      pair: false,
      runs: [],
      limnVersion: null,
      findings: [],
    });
    const withTeam = await loadTeamReviewView(db, 1, prId, null, [tm(901), tm(902)], null);
    expect(withTeam.reviewCount).toEqual({ total: 4, byTeammate: [{ poster, count: 2 }] });
  });
});

// STANDING VERDICTS + JUDGEMENTS THAT TRAVEL WITH A POST + A TEAMMATE'S STANDING BLOCK (203001-shaped).
describe('standing verdicts and posted judgements (real DB)', () => {
  const NOV3 = '2026-11-03T10:00:00Z';
  const NOV4 = '2026-11-04T10:00:00Z';
  const aliceSummary = `Changes needed.\n\n${limnReviewMarker('ee55', { headSha: HEAD, run: 'auto', pair: true, runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: null }, { provider: 'codex', model: 'gpt-6.1', effort: null }], verdict: 'REQUEST_CHANGES' })}`;
  const robinSummary = `Looks close.\n\n${limnReviewMarker('ff66', { headSha: HEAD, run: 'auto', runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: null }], verdict: 'COMMENT', judged: [{ commentId: '611', outcome: 'addressed' }] })}`;

  async function seed203001(n: number, extraReviews: any[] = []): Promise<{ prId: number; ownId: number }> {
    await persist(
      gqlPr(n, {
        reviews: {
          nodes: [
            review(`RV_${n}601`, ALICE, aliceSummary, NOV3, 'CHANGES_REQUESTED'),
            review(`RV_${n}602`, ROBIN, robinSummary, NOV4, 'COMMENTED'),
            ...extraReviews,
          ],
        },
        reviewThreads: {
          nodes: [
            thread(`T_${n}a`, [comment(`C_611`, ALICE, `**Blocker** · Codex\n\nNull deref.\n\n${MARK}`, NOV3)], { path: 'src/a.ts', line: 5 }),
            thread(`T_${n}b`, [comment(`C_${n}621`, ROBIN, `**Nit**\n\nRename this.\n\n${MARK}`, NOV4)], { path: 'src/r.ts', line: 9 }),
          ],
        },
      }),
    );
    const prId = await prIdOf(n);
    const halves = await db
      .insert(schema.claudeReviews)
      .values(
        ['first', 'second'].map((role, i) => ({
          accountId: 1,
          prId,
          headSha: HEAD,
          status: 'succeeded',
          model: i === 0 ? 'claude-opus-5-5' : 'gpt-6.1',
          provider: i === 0 ? 'claude' : 'codex',
          verdict: 'REQUEST_CHANGES',
          trigger: 'auto',
          pairRole: role,
          createdAt: new Date(NOV3),
          finishedAt: new Date(NOV3),
          autoPost: { status: 'posted', githubReviewId: `${n}601`, verdict: { submitted: 'REQUEST_CHANGES' } },
        })),
      )
      .returning()
      .execute();
    const { inArray } = await import('drizzle-orm');
    await db.update(schema.claudeReviews).set({ pairId: halves[0].id }).where(inArray(schema.claudeReviews.id, halves.map((h: any) => h.id))).execute();
    await db
      .insert(schema.claudeReviewFindings)
      .values({
        reviewId: halves[1].id,
        path: 'src/a.ts',
        line: 5,
        severity: 'blocker',
        title: 'Null deref',
        body: 'Null deref.',
        included: true,
        postedAt: new Date(NOV3),
        githubCommentId: '611',
        postedCommentKind: 'inline',
      })
      .execute();
    return { prId, ownId: halves[1].id };
  }

  it("imports the judgements a teammate's post carried, and the reader's finding reads as addressed by them", async () => {
    const { prId } = await seed203001(20);
    const [tm] = await teammateRows(prId);
    expect(tm.teammate.judged).toEqual([{ commentId: '611', outcome: 'addressed' }]);
    const reviews = await teammate.listTeammateReviews(db, 1, prId);
    expect(reviews[0]!.judged).toEqual([{ commentId: '611', outcome: 'addressed' }]);
    expect(reviews[0]!.findings[0]).toMatchObject({ providers: ['claude'], githubCommentId: '20621' });

    const { loadTeamReviewView } = await import('../review/claude-review/team-view.js');
    const persistMod = await import('../review/claude-review/persist.js');
    const ctx = { db, schema } as any;
    const latest = await persistMod.getLatestClaudeReview(ctx, prId, 1);
    const view = await loadTeamReviewView(db, 1, prId, latest, reviews, null);
    const mine = view.allFindings!.find((p) => p.author.you)!;
    expect(mine).toMatchObject({ providers: ['codex'], posted: true, state: { kind: 'addressed', by: { you: false, poster: { login: 'robin-dev' } } } });
    expect(view.allFindings!.find((p) => !p.author.you)).toMatchObject({ origin: 'teammate', state: { kind: 'open' } });

    // STANDING: the reader's Request changes (3 Nov) still blocks; Robin (4 Nov) reviewed last.
    expect(view.standings?.blocking).toMatchObject({ you: true, verdict: 'REQUEST_CHANGES' });
    expect(view.standings?.latest).toMatchObject({ you: false, verdict: 'COMMENT', poster: { login: 'robin-dev' } });

    // The states batch says the same.
    const [state] = await persistMod.getLatestReviewStates(ctx, [prId], 1);
    expect(state!.teammateLead?.login).toBe('robin-dev');
    expect(state!.standing?.blocking).toMatchObject({ you: true });
    expect(state!.standing?.latest).toMatchObject({ poster: { login: 'robin-dev' } });

    // Resolved on GitHub wins over any judgement.
    const { eq } = await import('drizzle-orm');
    await db.update(schema.reviewThreads).set({ isResolved: true }).where(eq(schema.reviewThreads.id, mine.threadId)).execute();
    const after = await loadTeamReviewView(db, 1, prId, latest, reviews, null);
    expect(after.allFindings!.find((p) => p.author.you)!.state).toEqual({ kind: 'resolved_on_github' });
  });

  it('a post carries the judgements of posted Limn findings: the follow-up by comment id, a thread judgement by its root', async () => {
    const { prId } = await seed203001(24);
    const { loadJudgedForPost } = await import('../review/claude-review/post-meta.js');
    const { and, eq } = await import('drizzle-orm');
    const ownFinding = (
      await db.select({ id: schema.claudeReviewFindings.id }).from(schema.claudeReviewFindings).where(eq(schema.claudeReviewFindings.githubCommentId, '611')).execute()
    ).at(-1)!;
    const robinThread = (
      await db.select({ id: schema.reviewThreads.id }).from(schema.reviewThreads).where(and(eq(schema.reviewThreads.prId, prId), eq(schema.reviewThreads.path, 'src/r.ts'))).execute()
    )[0]!;
    const ctx = { db, schema, log: { warn() {} } } as any;
    const judged = await loadJudgedForPost(ctx, 1, prId, [
      {
        followUp: { items: [{ priorFindingId: ownFinding.id, status: 'not_addressed' }, { priorFindingId: 999999, status: 'addressed' }] },
        threadAssessments: [{ threadId: robinThread.id, addressed: 'addressed' }],
      },
      { followUp: { items: [{ priorFindingId: ownFinding.id, status: 'addressed' }] } },
    ]);
    expect(judged).toEqual([
      { commentId: '611', outcome: 'addressed' },
      { commentId: '24621', outcome: 'addressed' },
    ]);
  });

  it('a dismissal on GitHub lifts the standing block', async () => {
    const { prId } = await seed203001(21);
    const persistMod = await import('../review/claude-review/persist.js');
    const ctx = { db, schema } as any;
    const { eq } = await import('drizzle-orm');
    await db.update(schema.reviews).set({ state: 'dismissed' }).where(eq(schema.reviews.githubNodeId, 'RV_21601')).execute();
    const [state] = await persistMod.getLatestReviewStates(ctx, [prId], 1);
    expect(state!.standing?.blocking).toBeNull();
    expect(state!.standing?.reviewers[0]).toMatchObject({ you: true, inForce: null, dismissed: true });
  });

  it("a non-author teammate's standing Request changes joins the reader's follow-up until lifted", async () => {
    const robinBlock = `Fix first.\n\n${limnReviewMarker('gg77', { headSha: HEAD, run: 'auto', runs: [{ provider: 'codex', model: 'gpt-6.1', effort: null }], verdict: 'REQUEST_CHANGES' })}`;
    await persist(
      gqlPr(22, {
        reviews: { nodes: [review('RV_22701', ROBIN, robinBlock, NOV3, 'CHANGES_REQUESTED')] },
        reviewThreads: {
          nodes: [thread('T_22a', [comment('C_22711', ROBIN, `**Blocker** · Codex\n\nRace on close.\n\n${MARK}`, NOV3)], { path: 'src/c.ts', line: 7 })],
        },
      }),
    );
    const prId = await prIdOf(22);
    const { loadStandingBlockAnchors } = await import('../review/claude-review/teammate-anchor.js');
    const ctx = { db, schema, log: { warn() {} } } as any;
    const blocks = await loadStandingBlockAnchors(ctx, prId, 1);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ teammate: { login: 'robin-dev' }, headSha: HEAD });
    expect(blocks[0]!.findings.map((f) => f.title)).toEqual(['Race on close.']);
    // The reader's run settled it: not sent again.
    const [tmFinding] = await findingRows((await teammateRows(prId))[0].id);
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', followUp: { items: [{ priorFindingId: tmFinding.id, status: 'addressed' }] } })
      .execute();
    expect(await loadStandingBlockAnchors(ctx, prId, 1)).toEqual([]);
  });

  it("PR 221269: a teammate's replies-pass Approve is in force though only their Comment was imported", async () => {
    // robin's Limn commented at 13:04 (imported as a teammate review), then its replies pass APPROVED
    // at 14:04. A replies pass is never imported, so the standing reads the approval from the synced
    // review row, its commit from the marker.
    const comment1 = `Not approved: a nit is open.\n\n${limnReviewMarker('jj10', { headSha: HEAD, run: 'auto', runs: [{ provider: 'claude', model: 'claude-opus-5-5', effort: null }], verdict: 'COMMENT' })}`;
    const approve = `Replies checked: the remaining points are settled.\n\n${limnReviewMarker('kk11', { headSha: HEAD, run: 'replies', verdict: 'APPROVE' })}`;
    await persist(
      gqlPr(25, {
        reviews: {
          nodes: [
            review('RV_25801', ROBIN, comment1, '2026-11-09T13:04:51Z', 'COMMENTED'),
            review('RV_25802', ROBIN, approve, '2026-11-09T14:04:21Z', 'APPROVED'),
          ],
        },
      }),
    );
    const prId = await prIdOf(25);
    expect((await teammateRows(prId)).map((r) => r.verdict)).toEqual(['COMMENT']);
    const persistMod = await import('../review/claude-review/persist.js');
    const [state] = await persistMod.getLatestReviewStates({ db, schema } as any, [prId], 1);
    const robin = state!.standing!.reviewers.find((r) => !r.you)!;
    expect(robin.latest).toMatchObject({ verdict: 'COMMENT' });
    expect(robin.inForce).toMatchObject({ verdict: 'APPROVE', reviewId: null, at: '2026-11-09T14:04:21.000Z', headSha: HEAD });
    expect(robin.withdrawn ?? null).toBeNull();
    // Dismissed on GitHub: no longer in force; the withdrawal names the verdict and its commit.
    const { eq } = await import('drizzle-orm');
    await db.update(schema.reviews).set({ state: 'dismissed' }).where(eq(schema.reviews.githubNodeId, 'RV_25802')).execute();
    const [after] = await persistMod.getLatestReviewStates({ db, schema } as any, [prId], 1);
    const robinAfter = after!.standing!.reviewers.find((r) => !r.you)!;
    expect(robinAfter.inForce).toBeNull();
    expect(robinAfter.withdrawn).toMatchObject({ verdict: 'APPROVE', headSha: HEAD });
  });

  it("a teammate's own later Approve lifts their block (no follow-up on it)", async () => {
    const block = `Fix first.\n\n${limnReviewMarker('hh88', { headSha: HEAD, run: 'auto', verdict: 'REQUEST_CHANGES' })}`;
    const ok = `All good.\n\n${limnReviewMarker('ii99', { headSha: HEAD, run: 'auto', verdict: 'APPROVE' })}`;
    await persist(
      gqlPr(23, {
        reviews: { nodes: [review('RV_23701', ROBIN, block, NOV3, 'CHANGES_REQUESTED'), review('RV_23702', ROBIN, ok, NOV4, 'APPROVED')] },
        reviewThreads: {
          nodes: [thread('T_23a', [comment('C_23711', ROBIN, `**Blocker**\n\nRace.\n\n${MARK}`, NOV3)], { path: 'src/c.ts', line: 7 })],
        },
      }),
    );
    const { loadStandingBlockAnchors } = await import('../review/claude-review/teammate-anchor.js');
    expect(await loadStandingBlockAnchors({ db, schema, log: { warn() {} } } as any, await prIdOf(23), 1)).toEqual([]);
  });
  it("an author's own Limn review at the head is owed a teammate's verdict (the candidate read)", async () => {
    const { eq } = await import('drizzle-orm');
    const ownPr = `Looks good to me.\n\n${limnReviewMarker('ov31', { headSha: HEAD, run: 'auto', verdict: 'COMMENT', ownPrVerdict: 'APPROVE' })}`;
    await persist(
      gqlPr(31, {
        reviews: { nodes: [review('RV_31001', CAROL, ownPr, '2026-11-10T08:00:00Z')] },
        comments: { nodes: [comment('IC_31002', ALICE, 'Taking a look.', '2026-11-10T08:05:00Z')] },
      }),
    );
    const prId = await prIdOf(31);
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
    expect((await teammateRows(prId))[0].teammate).toMatchObject({ ownPrVerdict: 'APPROVE' });
    const floor = Date.parse('2026-11-01T00:00:00Z');
    const read = () => queries.getAutoReviewCandidates(1, workspaceId, { openedSinceMs: floor, dayStartMs: floor, limit: 20 });
    const first = await read();
    expect(first?.verdictNeeded).toContainEqual(
      expect.objectContaining({ prId, headSha: HEAD, reason: 'author_review', authorVerdict: 'APPROVE' }),
    );
    expect(first?.prIds).not.toContain(prId);

    // Robin's Limn review at the head is the verdict: nothing owed any more.
    const robin = `Approved.\n\n${limnReviewMarker('ov32', { headSha: HEAD, run: 'auto', verdict: 'APPROVE' })}`;
    await persist(
      gqlPr(31, {
        reviews: {
          nodes: [review('RV_31001', CAROL, ownPr, '2026-11-10T08:00:00Z'), review('RV_31003', ROBIN, robin, '2026-11-10T09:00:00Z', 'APPROVED')],
        },
        comments: { nodes: [comment('IC_31002', ALICE, 'Taking a look.', '2026-11-10T08:05:00Z')] },
      }),
    );
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
    expect((await read())?.verdictNeeded.map((v) => v.prId)).not.toContain(prId);
  });

  it("the author's side: waiting for a teammate's Limn only with evidence one runs auto reviews", async () => {
    const { eq } = await import('drizzle-orm');
    const { teammateVerdictWaits } = await import('./teammate-verdict-wait.js');
    const { getAccountUserId } = await import('../auth/account.js');
    // ALICE (the reader) opened PR 32 and her Limn's review is posted at the head.
    await persist(gqlPr(32, { author: ALICE }));
    const prId = await prIdOf(32);
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: HEAD, status: 'succeeded', model: 'claude-opus-5-5', postedAt: new Date('2026-11-10T08:00:00Z') })
      .execute();
    const me = await getAccountUserId(1);
    expect(me).not.toBeNull();
    const at = Date.parse('2026-11-10T09:00:00Z');
    // Robin's auto reviews on other PRs of the workspace (2026-10-02) are older than two weeks: silent.
    expect((await teammateVerdictWaits(db, 1, me, [prId], Date.parse('2026-11-30T00:00:00Z'))).size).toBe(0);
    // Within two weeks of them: the wait shows.
    expect((await teammateVerdictWaits(db, 1, me, [prId], Date.parse('2026-10-10T00:00:00Z'))).get(prId)).toEqual({
      headSha: HEAD,
      since: '2026-11-10T08:00:00.000Z',
    });
    // A teammate's Limn review at the head ends it.
    const robin = `Fine.\n\n${limnReviewMarker('ov33', { headSha: HEAD, run: 'auto', verdict: 'APPROVE' })}`;
    await persist(gqlPr(32, { author: ALICE, reviews: { nodes: [review('RV_32001', ROBIN, robin, '2026-11-10T08:30:00Z', 'APPROVED')] } }));
    await db.update(schema.pullRequests).set({ headSha: HEAD }).where(eq(schema.pullRequests.id, prId)).execute();
    expect((await teammateVerdictWaits(db, 1, me, [prId], at)).size).toBe(0);
  });
});
