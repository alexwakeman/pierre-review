// PENDING → "AI REVIEWS", THE NEWEST AI REVIEW PER PR (db/ai-reviews-seen.ts), on a THROWAWAY sqlite
// DB (the pending-mute.test.ts pattern).
//
// WHAT THIS PINS:
//   1. WHAT IS AN AI REVIEW: the reader's own finished full review and a teammate's imported one —
//      never a failed run, a router skip, a replies pass or a pair's second half (a pair is ONE row,
//      with both halves' findings and the pair's one verdict). Praise and merged-away repeats are not
//      findings.
//   2. ONE ROW PER PR, its newest review, newest first. LOOKING NEVER REMOVES A ROW: the stamp only
//      counts what is newer (`countNewAiReviews`, the tab's `newTotal`) and never moves back.
//   3. THE BOARD: live only, the "AI reviews" tab's one list, counted in its own
//      `kindTotals.ai_review`, unscored, and never in the non-live (Slack) board.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load), and
// every import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ai-reviews-seen-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let seen: typeof import('./ai-reviews-seen.js');
let tabs: typeof import('./pending-tabs.js');
let q: any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;

const ids: Record<string, number> = {};
let repoId = 0;
let workspaceId = 0;
let teammateId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  seen = await import('./ai-reviews-seen.js');
  tabs = await import('./pending-tabs.js');
  q = await import('./queries.js');
  const { eq } = await import('drizzle-orm');
  await db.update(schema.accounts).set({ githubLogin: 'viewer-ai' }).where(eq(schema.accounts.id, 1)).execute();

  const [viewer] = await db.insert(schema.users).values({ githubLogin: 'viewer-ai', githubNodeId: 'U_viewer_ai', isBot: false }).returning().execute();
  const [mate] = await db.insert(schema.users).values({ githubLogin: 'mate-ai', githubNodeId: 'U_mate_ai', isBot: false, displayName: 'Mate' }).returning().execute();
  teammateId = mate.id;
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'ai', githubNodeId: 'R_ai', viewerPermission: 'WRITE', defaultBranch: 'main', createdAt: new Date(now - 30 * DAY) })
    .returning()
    .execute();
  repoId = repo.id;
  let n = 1;
  const pr = async (key: string, state: 'open' | 'merged' = 'open'): Promise<number> => {
    const [row] = await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: `PR_ai_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        authorId: viewer.id,
        state,
        isDraft: false,
        headSha: `head_${key}`,
        openedAt: new Date(now - 5 * DAY),
        updatedAt: new Date(now - DAY),
      })
      .returning()
      .execute();
    ids[`pr:${key}`] = row.id;
    return row.id;
  };
  const run = async (key: string, prId: number, values: Record<string, unknown>): Promise<number> => {
    const [row] = await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId, headSha: `head_${key}`, status: 'succeeded', model: 'claude-opus-5-5', createdAt: new Date(now - 2 * DAY), ...values })
      .returning()
      .execute();
    ids[key] = row.id;
    return row.id;
  };
  const finding = async (reviewId: number, severity: string, extra: Record<string, unknown> = {}): Promise<void> => {
    await db.insert(schema.claudeReviewFindings).values({ reviewId, path: 'a.ts', line: 1, severity, title: 't', body: 'b', ...extra }).execute();
  };

  const a = await pr('a');
  const b = await pr('b', 'merged');
  const c = await pr('c');

  // Own, finished 2h ago: 2 findings that count (praise and a merged-away repeat do not).
  const own = await run('own', a, { finishedAt: new Date(now - 2 * HOUR), verdict: 'REQUEST_CHANGES', trigger: 'auto' });
  await finding(own, 'blocker');
  await finding(own, 'nit');
  await finding(own, 'praise');
  const keep = (await db.select().from(schema.claudeReviewFindings).execute())[0];
  await finding(own, 'warning', { mergedInto: keep.id });
  // Not reviews: a failed run, a router skip, a replies pass.
  await run('failed', a, { status: 'failed', finishedAt: new Date(now - HOUR) });
  await run('skip', a, { reviewMode: 'skip', finishedAt: new Date(now - HOUR) });
  await run('replies', a, { kind: 'replies', finishedAt: new Date(now - HOUR) });
  // Ten days old, on the same PR as `own`: only the PR's NEWEST review is listed.
  await run('old', a, { finishedAt: new Date(now - 10 * DAY) });
  // A pair on a MERGED PR — one review, both halves' findings, the pair's verdict.
  const first = await run('pairFirst', b, { finishedAt: new Date(now - 4 * HOUR), verdict: 'COMMENT', pairRole: 'first' });
  await db.update(schema.claudeReviews).set({ pairId: first, pairConsolidation: { verdict: 'APPROVE' } }).where(eq(schema.claudeReviews.id, first)).execute();
  const second = await run('pairSecond', b, { finishedAt: new Date(now - 3 * HOUR), pairId: first, pairRole: 'second' });
  await finding(first, 'warning');
  await finding(second, 'question');
  // A teammate's Limn posted a review 30 minutes ago.
  const tm = await run('teammate', c, {
    kind: 'teammate',
    sourceUserId: teammateId,
    sourceReviewNodeId: 'PRR_mate',
    postedAt: new Date(now - HOUR / 2),
    verdict: 'COMMENT',
  });
  await finding(tm, 'nit');

  workspaceId = (await q.resolveWorkspaceScope(1, undefined)).workspaceId;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('AI reviews: the newest AI review per PR', () => {
  it('lists own reviews, pairs once and teammates’ reviews, one per PR, newest first', async () => {
    const { cards, userIds } = await seen.buildAiReviewCards(1, [repoId]);
    expect(cards.map((c) => c.reviewId)).toEqual([ids.teammate, ids.own, ids.pairFirst]);
    const [tm, own, pair] = cards;
    expect(tm).toMatchObject({ ranByUserId: teammateId, auto: false, verdict: 'COMMENT', findingCount: 1 });
    expect(own).toMatchObject({ ranByUserId: null, auto: true, verdict: 'REQUEST_CHANGES', findingCount: 2 });
    // The pair: listed on its first half, at the later half's finish, with the pair's one verdict.
    expect(pair).toMatchObject({ ranByUserId: null, verdict: 'APPROVE', findingCount: 2, at: new Date(now - 3 * HOUR).toISOString() });
    expect(userIds).toEqual([teammateId]);
  });

  it('moves the stamp only forward; the list never shrinks, only the new count does', async () => {
    expect(await seen.getAiReviewsSeenAt(1, workspaceId)).toBeNull();
    const at = await seen.markAiReviewsSeen(1, workspaceId, new Date(now - 2 * HOUR), now);
    expect(at?.getTime()).toBe(now - 2 * HOUR);
    // Older `through` (a second browser tab with a stale list) — no move back.
    const again = await seen.markAiReviewsSeen(1, workspaceId, new Date(now - 5 * HOUR), now);
    expect(again?.getTime()).toBe(now - 2 * HOUR);
    const { cards } = await seen.buildAiReviewCards(1, [repoId]);
    expect(cards.map((c) => c.reviewId)).toEqual([ids.teammate, ids.own, ids.pairFirst]);
    expect(seen.countNewAiReviews(cards, again)).toBe(1);
    expect(seen.countNewAiReviews(cards, null)).toBe(3);
    // Another account's workspace id is not written.
    expect(await seen.markAiReviewsSeen(2, workspaceId, null, now)).toBeNull();
  });

  it('is the "AI reviews" tab on the live board, counted on its own, unscored — and never off it', async () => {
    await db.update(schema.workspaces).set({ aiReviewsSeenAt: null }).execute();
    const board = await tabs.buildPendingBoard(1, workspaceId, { live: true, now });
    const claude = board.tabs!.find((t) => t.key === 'claude')!;
    expect(claude.kindTotals.ai_review).toBe(3);
    expect(claude.newTotal).toBe(3);
    expect(board.aiReviewsSeenAt).toBeNull();
    const listed = claude.cardIds.map((id) => board.cards.find((c) => c.id === id)!);
    expect(listed.every((c) => c.kind === 'ai_review')).toBe(true);
    expect(listed.map((c) => (c as any).reviewId)).toEqual([ids.teammate, ids.own, ids.pairFirst]);
    // After a look the rows stay; only the badge drops.
    await seen.markAiReviewsSeen(1, workspaceId, new Date(now - HOUR / 2), now);
    const after = await tabs.buildPendingBoard(1, workspaceId, { live: true, now });
    const claudeAfter = after.tabs!.find((t) => t.key === 'claude')!;
    expect(claudeAfter.cardIds).toEqual(claude.cardIds);
    expect(claudeAfter.newTotal).toBe(0);
    for (const c of listed) if (c.kind === 'ai_review') expect(board.scores?.[c.id]).toBeUndefined();
    // The teammate rides `users[]`.
    expect(board.users.some((u) => u.id === teammateId)).toBe(true);
    // No other tab holds one.
    for (const t of board.tabs!) if (t.key !== 'claude') expect(t.kindTotals.ai_review).toBeUndefined();
    // The Slack snapshot (not live) never builds them.
    const team = await tabs.buildPendingBoard(1, workspaceId, { now });
    expect(team.cards.some((c) => c.kind === 'ai_review')).toBe(false);
    expect(team.aiReviewsSeenAt).toBeUndefined();
  });
});
