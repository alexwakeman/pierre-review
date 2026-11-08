// THE LIMN HISTORY BACKFILL (db/limn-history-backfill.ts). Throwaway sqlite; the real persistPr
// (flag OFF, as the history was stored), then the real backfill. No GitHub.
//
// What this pins:
//   1. The exact records seed the ledger: a posted review with NO marker, an unmarked finding comment,
//      a watcher merge, a Dependencies push sha, a "@dependabot rebase" request.
//   2. The wrapper rule by timing: an empty review beside a Limn comment moves; an empty review
//      beside the reader's own comment, or beside both, stays the reader's.
//   3. A second run seeds and moves nothing; the recorded flag makes the boot job a no-op.
//   4. A sync walk with the switch ON afterwards keeps every moved row where the backfill put it
//      (the ledger rows carry it), although the history has no review ids on its comments.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-limn-history-backfill-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let config: any;
let upsert: typeof import('../sync/upsert.js');
let backfill: typeof import('./limn-history-backfill.js');
let repoId = 0;

const ALICE = { login: 'alice-dev', id: 'U_alice', __typename: 'User' };
const CAROL = { login: 'carol-dev', id: 'U_carol', __typename: 'User' };
const FINDING = '**Warning**\n\nThis can throw.\n\n<!-- pierre:claude-review-finding v=1 -->';
const SHA_FIX = 'ddd3000000000000000000000000000000000001';
const SHA_MINE = 'eee3000000000000000000000000000000000002';

const at = (hms: string) => `2026-10-02T${hms}Z`;
const review = (id: string, dbId: string, body: string, state: string, hms: string, author: any = ALICE): any => ({
  id,
  fullDatabaseId: dbId,
  state,
  body,
  submittedAt: at(hms),
  author,
});
// History: no review id on a comment (the field did not exist when these rows were stored).
const rc = (id: string, dbId: string, body: string, hms: string, author: any = ALICE): any => ({
  id,
  fullDatabaseId: dbId,
  body,
  createdAt: at(hms),
  diffHunk: null,
  author,
  pullRequestReview: null,
});
const thread = (id: string, comments: any[]): any => ({
  id,
  isResolved: false,
  isOutdated: false,
  isCollapsed: false,
  path: 'src/x.ts',
  line: 3,
  resolvedBy: null,
  comments: { nodes: comments },
});
const commit = (oid: string, message: string): any => ({
  commit: {
    oid,
    committedDate: at('09:00:00'),
    message,
    messageHeadline: message,
    author: { user: { login: ALICE.login, id: ALICE.id } },
    committer: { user: { login: ALICE.login, id: ALICE.id } },
  },
});

function historyPr(): GqlPullRequest {
  return {
    id: 'PR_hb_30',
    number: 30,
    title: 'Bump x',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'MERGED',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: at('08:00:00'),
    mergedAt: at('18:00:00'),
    closedAt: at('18:00:00'),
    updatedAt: at('18:00:00'),
    url: 'https://github.com/acme/hb/pull/30',
    baseRefName: 'main',
    headRefName: 'bump',
    mergeable: null,
    mergeStateStatus: null,
    author: CAROL,
    mergedBy: ALICE,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: {
      nodes: [
        // Limn's posted summary WITHOUT a marker: only claude_reviews.posted_review_id knows it.
        review('RV_sum', '3001', 'Looks good to me.', 'APPROVED', '09:30:00'),
        // The wrapper around the marked finding at 10:00:00.
        review('RV_wrap', '3002', '', 'COMMENTED', '10:00:01'),
        // Alice's own empty review around her own typed comment.
        review('RV_mine', '3003', '', 'COMMENTED', '13:00:00'),
        // An empty review beside a Limn comment AND Alice's own: not a pure wrapper — stays hers.
        review('RV_mixed', '3004', '', 'COMMENTED', '15:00:00'),
        // The wrapper around an UNMARKED finding the ledger knows (claude_review_findings).
        review('RV_wrap2', '3005', '', 'COMMENTED', '16:00:01'),
        review('RV_carol', '3006', '', 'COMMENTED', '10:00:01', CAROL),
      ],
    } as any,
    reviewThreads: {
      nodes: [
        thread('T_1', [rc('C_1', '3011', FINDING, '10:00:00')]),
        thread('T_2', [rc('C_2', '3012', 'I typed this one myself.', '13:00:00')]),
        thread('T_3', [rc('C_3', '3013', FINDING, '15:00:00'), rc('C_3b', '3016', 'Agreed, fixing.', '15:00:01')]),
        thread('T_4', [rc('C_4', '3014', 'Plain words, no marker.', '16:00:00')]),
      ],
    } as any,
    comments: {
      nodes: [
        { id: 'PC_rebase', fullDatabaseId: '3021', body: '@dependabot rebase', createdAt: at('17:00:00'), author: ALICE },
        { id: 'PC_mine', fullDatabaseId: '3022', body: '@dependabot rebase', createdAt: at('11:00:00'), author: ALICE },
      ],
    } as any,
    commits: { nodes: [commit(SHA_FIX, 'Resolve conflicts'), commit(SHA_MINE, 'My own commit')] } as any,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}
async function q(table: string, where: Record<string, unknown>): Promise<any> {
  const { and, eq } = await import('drizzle-orm');
  const t = schema[table];
  return (
    await db
      .select()
      .from(t)
      .where(and(...Object.entries(where).map(([k, v]) => eq(t[k], v))))
      .execute()
  )[0];
}
async function userId(login: string): Promise<number> {
  return (await q('users', { githubLogin: login })).id;
}
const d = (hms: string) => new Date(at(hms));

async function seedRunRecords(prId: number): Promise<void> {
  const [cr] = await db
    .insert(schema.claudeReviews)
    .values({ accountId: 1, prId, headSha: 'h1', status: 'succeeded', model: 'm', trigger: 'auto', postedReviewId: '3001', postedAt: d('09:30:00') })
    .returning()
    .execute();
  await db
    .insert(schema.claudeReviewFindings)
    .values({ reviewId: cr.id, path: 'src/x.ts', severity: 'warning', title: 't', body: 'b', githubCommentId: '3014', postedCommentKind: 'inline', postedAuto: true, postedAt: d('16:00:00') })
    .execute();
  await db
    .insert(schema.autoMergeRequests)
    .values({ accountId: 1, prId, mergeMethod: 'squash', updateStrategy: 'merge', expectedHeadOid: SHA_FIX, state: 'merged', armedAt: d('08:30:00'), expiresAt: d('23:00:00'), armedByPolicy: true })
    .execute();
  await db
    .insert(schema.dependencyAutomationActions)
    .values([
      { accountId: 1, prId, headSha: 'h1', action: 'rebase_request', state: 'done', createdAt: d('17:00:30') },
      { accountId: 1, prId, headSha: 'h1', action: 'ai_resolve', state: 'done', resultSha: SHA_FIX, createdAt: d('17:30:00') },
      { accountId: 1, prId, headSha: 'h1', action: 'merge_landed', state: 'done', createdAt: d('18:00:00') },
    ])
    .execute();
}

async function expectMoved(): Promise<void> {
  const alice = await userId('alice-dev');
  const carol = await userId('carol-dev');
  const bot = await userId('limn:alice-dev');
  const limn = { authorId: bot, limnPostedByUserId: alice };
  const mine = { authorId: alice, limnPostedByUserId: null };
  expect(await q('reviews', { githubNodeId: 'RV_sum' })).toMatchObject(limn);
  expect(await q('reviews', { githubNodeId: 'RV_wrap' })).toMatchObject(limn);
  expect(await q('reviews', { githubNodeId: 'RV_wrap2' })).toMatchObject(limn);
  expect(await q('reviews', { githubNodeId: 'RV_mine' })).toMatchObject(mine);
  expect(await q('reviews', { githubNodeId: 'RV_mixed' })).toMatchObject(mine);
  expect(await q('reviews', { githubNodeId: 'RV_carol' })).toMatchObject({ authorId: carol, limnPostedByUserId: null });
  expect(await q('reviewComments', { githubNodeId: 'C_4' })).toMatchObject(limn);
  expect(await q('reviewComments', { githubNodeId: 'C_2' })).toMatchObject(mine);
  expect(await q('reviewComments', { githubNodeId: 'C_3b' })).toMatchObject(mine);
  expect(await q('prComments', { githubNodeId: 'PC_rebase' })).toMatchObject(limn);
  // Same body, hours from the action: the reader's own.
  expect(await q('prComments', { githubNodeId: 'PC_mine' })).toMatchObject(mine);
  expect(await q('commits', { sha: SHA_FIX })).toMatchObject({ authorId: bot, limnPushedByUserId: alice });
  expect(await q('commits', { sha: SHA_MINE })).toMatchObject({ authorId: alice, limnPushedByUserId: null });
  expect(await q('pullRequests', { githubNodeId: 'PR_hb_30' })).toMatchObject({ authorId: carol, mergedById: bot, limnMergedForUserId: alice });
  expect((await q('events', { dedupeKey: 'review_submitted:RV_sum' })).actorId).toBe(bot);
  expect((await q('events', { dedupeKey: 'pr_comment:PC_mine' })).actorId).toBe(alice);
  expect((await q('events', { dedupeKey: 'pr_comment:PC_rebase' })).actorId).toBe(bot);
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  config = (await import('../config.js')).config;
  config.limnAttributeAll = false;
  upsert = await import('../sync/upsert.js');
  backfill = await import('./limn-history-backfill.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'alice-dev' }).where(eq(schema.accounts.id, 1)).execute();
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'hb', githubNodeId: 'R_hb_1' }).returning().execute();
  repoId = r.id;
  const queries = await import('./queries.js');
  await queries.ensureDefaultWorkspace(1);
  await queries.ensureRepoMemberships(1);
  // The history: stored with the switch OFF.
  await persist(historyPr());
  await seedRunRecords((await q('pullRequests', { githubNodeId: 'PR_hb_30' })).id);
});

afterAll(() => {
  if (config) config.limnAttributeAll = false;
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the history backfill', () => {
  it('is a no-op at boot while the switch is off', async () => {
    const logs: string[] = [];
    backfill.kickLimnHistoryBackfill(1, { info: (_o, m) => logs.push(m ?? ''), warn: (_o, m) => logs.push(m ?? '') });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toEqual([]);
    expect(await backfill.limnHistoryBackfillDone(1)).toBe(false);
    expect(await q('reviews', { githubNodeId: 'RV_sum' })).toMatchObject({ authorId: await userId('alice-dev') });
  });

  it('seeds the ledger from the exact records, applies the wrapper rule, and moves the rows', async () => {
    config.limnAttributeAll = true;
    const r = await backfill.runLimnHistoryBackfill(1, { yieldMs: 0, batchSize: 1 });
    expect(r.status).toBe('done');
    expect(r.seeded).toMatchObject({ reviews: 1, findingComments: 1, merges: 1, pushes: 1, rebaseRequests: 1 });
    expect(r.wrappers).toBe(2);
    expect(r.moved.reviews).toBe(3);
    expect(r.moved.commits).toBe(1);
    expect(r.moved.prs).toBe(1);
    await expectMoved();
    expect(await backfill.limnHistoryBackfillDone(1)).toBe(true);
  });

  it('a second run seeds and moves nothing, and the recorded flag stops the boot job', async () => {
    const again = await backfill.runLimnHistoryBackfill(1, { yieldMs: 0, force: true, record: false });
    expect(again.status).toBe('done');
    expect(Object.values(again.seeded).every((n) => n === 0)).toBe(true);
    expect(again.wrappers).toBe(0);
    expect(again.moved).toEqual({ reviews: 0, comments: 0, threads: 0, commits: 0, prs: 0 });
    expect((await backfill.runLimnHistoryBackfill(1)).status).toBe('already_done');
  });

  it('a walk with the switch on keeps every moved row (the ledger carries it)', async () => {
    config.limnAttributeAll = true;
    await persist(historyPr());
    await expectMoved();
  });

  it('stops at its time limit without recording, and carries on later', async () => {
    const { eq } = await import('drizzle-orm');
    await db.delete(schema.instanceMeta).where(eq(schema.instanceMeta.key, backfill.limnHistoryFlagKey(1))).execute();
    const stopped = await backfill.runLimnHistoryBackfill(1, { yieldMs: 0, deadlineMs: -1 });
    expect(stopped.status).toBe('stopped');
    expect(await backfill.limnHistoryBackfillDone(1)).toBe(false);
    expect((await backfill.runLimnHistoryBackfill(1, { yieldMs: 0 })).status).toBe('done');
  });
});
