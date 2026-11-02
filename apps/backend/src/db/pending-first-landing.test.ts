// PENDING ON THE FIRST LANDING — on a THROWAWAY sqlite DB (the my-turn-ball.test.ts pattern).
//
//   • the first-onboarding mark: set by the reader's add while the account has no repos, or in the
//     same first-run batch; never by a later add, a stray flag, or a walk's upsert;
//   • My Turn's floor: a first-onboarding repo looks back FIRST_ONBOARDING_LOOKBACK_DAYS before its
//     add time, a later add does not;
//   • the board's first-landing fields: the summary window, the reader's own open PRs on an empty
//     board, and the one-time review suggestion with its dismissal and its "any review ran" rule.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIRST_ONBOARDING_LOOKBACK_DAYS, PENDING_SUMMARY_DAYS } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-pending-first-landing-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let eq: any;
let upsertRepo: any;
let buildPendingBoard: any;
let dismissReviewSuggestion: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-first';

let viewerId = 0;
let aliceId = 0;
let prNumber = 1;
let tagN = 0;
const marks = new Map<string, boolean>();
let wsTeam = 0;
let wsMine = 0;
let firstRepo = 0;
let mineReadyPr = 0;

async function insertRepo(name: string, firstOnboarding: boolean, addedAt: number): Promise<number> {
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name, githubNodeId: `R_fl_${name}`, createdAt: new Date(addedAt), firstOnboarding })
    .returning()
    .execute();
  return r.id;
}

async function insertPr(repoId: number, authorId: number, openedAt: number, extra: Record<string, unknown> = {}): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_fl_${prNumber}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `fixture ${prNumber}`,
      state: 'open',
      isDraft: false,
      authorId,
      openedAt: new Date(openedAt),
      updatedAt: new Date(openedAt),
      ...extra,
    })
    .returning()
    .execute();
  return pr.id;
}

/** S3d: a thread Alice opened, you commented in, and Alice answered — the reply at `replyAt`. */
async function replyThread(prId: number, path: string, replyAt: number): Promise<void> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `TH_fl_${path}`,
      prId,
      path,
      line: 1,
      isResolved: false,
      derivedState: 'replied_unresolved',
      originalCommenterId: aliceId,
      createdAt: new Date(replyAt - 2 * HOUR),
    })
    .returning()
    .execute();
  for (const [authorId, at] of [
    [aliceId, replyAt - 2 * HOUR],
    [viewerId, replyAt - HOUR],
    [aliceId, replyAt],
  ] as const) {
    await db
      .insert(schema.reviewComments)
      .values({ githubNodeId: `RC_fl_${tagN++}`, threadId: t.id, prId, authorId, body: 'c', excerpt: 'c', createdAt: new Date(at) })
      .execute();
  }
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  ({ eq } = await import('drizzle-orm'));
  ({ upsertRepo } = await import('../sync/upsert.js'));
  ({ buildPendingBoard } = await import('./pending-tabs.js'));
  ({ dismissReviewSuggestion } = await import('./pending-first-landing.js'));

  await db.update(schema.accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(schema.accounts.id, 1)).execute();
  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}` }).returning().execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-fl');

  // ── THE MARK, through the real add path, on an account with no repos yet ──
  const add = async (name: string, added?: { firstRun: boolean }): Promise<void> => {
    const id = await upsertRepo('acme', name, `R_add_${name}`, null, 1, undefined, undefined, added);
    const [row] = await db.select().from(schema.repos).where(eq(schema.repos.id, id)).execute();
    marks.set(name, row.firstOnboarding);
  };
  await add('first', { firstRun: false }); // the account had no repos
  await add('batch', { firstRun: true }); // same first-run batch
  await add('later', { firstRun: false }); // a later add
  await add('stray', { firstRun: true }); // a flag after a non-batch add
  await add('walked'); // a walk's upsert (no `added`)
  // A re-add of a marked repo without the flag keeps its mark (the conflict update never touches it).
  await add('first', { firstRun: false });

  // ── THE FLOOR: two workspaces so the board tests below see their own repos only ──
  wsTeam = (await q.createWorkspace(1, 'Team')).id;
  wsMine = (await q.createWorkspace(1, 'Mine')).id;
  firstRepo = await insertRepo('team-first', true, now - DAY);
  const laterRepo = await insertRepo('team-later', false, now - DAY);
  const mineRepo = await insertRepo('mine', false, now - 60 * DAY);
  await q.assignReposToWorkspace(wsTeam, 1, [firstRepo, laterRepo]);
  await q.assignReposToWorkspace(wsMine, 1, [mineRepo]);

  // Replies 3 days ago: inside the first-onboarding lookback, before the later repo's add time.
  await replyThread(await insertPr(firstRepo, aliceId, now - 12 * DAY), 'first-recent.ts', now - 3 * DAY);
  await replyThread(await insertPr(laterRepo, aliceId, now - 12 * DAY), 'later-recent.ts', now - 3 * DAY);
  // A reply older than the lookback (add time 1 day ago − 7 days = 8 days ago).
  await replyThread(await insertPr(firstRepo, aliceId, now - 12 * DAY), 'first-old.ts', now - 9 * DAY);

  // ── THE READER'S OWN PRS, in a workspace whose board is empty ──
  await insertPr(mineRepo, viewerId, now - 2 * HOUR, { isDraft: true, headSha: 'aaa', mergeStateStatus: 'unknown' });
  mineReadyPr = await insertPr(mineRepo, viewerId, now - HOUR, {
    headSha: 'bbb',
    mergeable: 'mergeable',
    mergeStateStatus: 'blocked',
    reviewDecision: 'review_required',
    ciStatus: 'success',
  });
  // Asked of Alice an hour ago: no "Needs a reviewer" card, and too young to be stalled.
  await db.insert(schema.reviewRequests).values({ prId: mineReadyPr, userId: aliceId }).execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the first-onboarding mark (upsertRepo)', () => {
  it('marks the add to an empty account and the rest of its first-run batch', () => {
    expect(marks.get('first')).toBe(true);
    expect(marks.get('batch')).toBe(true);
  });
  it('never marks a later add, a stray flag after one, or a walk', () => {
    expect(marks.get('later')).toBe(false);
    expect(marks.get('stray')).toBe(false);
    expect(marks.get('walked')).toBe(false);
  });
});

describe("My Turn's floor", () => {
  it(`looks back ${FIRST_ONBOARDING_LOOKBACK_DAYS} days for a first-onboarding repo only`, async () => {
    const scope = await q.resolveWorkspaceScope(1, wsTeam);
    const mt = await q.getMyTurn(1, scope);
    const paths = (mt.threadReplies as { path: string }[]).map((t) => t.path).sort();
    expect(paths).toEqual(['first-recent.ts']);
  });
});

describe("the board's first-landing fields", () => {
  it('opens the summary window while the first onboarding is recent', async () => {
    const board = await buildPendingBoard(1, wsTeam, { live: true, now });
    expect(board.summary).toBe(true);
    // The team board has cards, so it lists no own PRs.
    expect(board.tabs.some((t: { total: number }) => t.total > 0)).toBe(true);
    expect(board.ownOpenPrs).toBeUndefined();
  });

  it('closes the summary window after PENDING_SUMMARY_DAYS', async () => {
    const board = await buildPendingBoard(1, wsTeam, { live: true, now: now + PENDING_SUMMARY_DAYS * DAY });
    expect(board.summary).toBe(false);
  });

  it('lists the reader’s own open PRs with their synced merge facts when every tab is empty', async () => {
    const board = await buildPendingBoard(1, wsMine, { live: true, now });
    expect(board.tabs.every((t: { total: number }) => t.total === 0)).toBe(true);
    expect(board.ownOpenPrTotal).toBe(2);
    expect(board.ownOpenPrs.map((p: { prId: number }) => p.prId)[0]).toBe(mineReadyPr);
    const ready = board.ownOpenPrs[0];
    expect(ready).toMatchObject({
      mergeStateStatus: 'blocked',
      isDraft: false,
    });
    // What blocks it is PR detail's to derive: no review, CI or thread facts on this list.
    expect(ready).not.toHaveProperty('reviewDecision');
    expect(ready).not.toHaveProperty('unresolvedThreads');
    expect(board.ownOpenPrs[1].isDraft).toBe(true);
  });

  it('suggests a review of the newest open, non-draft own PR', async () => {
    const board = await buildPendingBoard(1, wsMine, { live: true, now });
    expect(board.reviewSuggestion).toMatchObject({ prId: mineReadyPr, repoFullName: 'acme/mine' });
    expect(board.reviewSuggestion.budgetUsd).toBeGreaterThan(0);
  });

  it('is not part of the Slack snapshot (live only)', async () => {
    const board = await buildPendingBoard(1, wsMine, { now });
    expect(board.summary).toBeUndefined();
    expect(board.reviewSuggestion).toBeUndefined();
  });

  it('never suggests again once dismissed', async () => {
    await dismissReviewSuggestion(1);
    const board = await buildPendingBoard(1, wsMine, { live: true, now });
    expect(board.reviewSuggestion).toBeNull();
    await db.update(schema.accounts).set({ reviewSuggestionDismissedAt: null }).where(eq(schema.accounts.id, 1)).execute();
  });

  it('never suggests once any AI review has run for the account', async () => {
    expect((await buildPendingBoard(1, wsMine, { live: true, now })).reviewSuggestion).not.toBeNull();
    // A review on ANOTHER PR, in another workspace, that failed: still "a review ran".
    const otherPr = await insertPr(firstRepo, aliceId, now - DAY, { headSha: 'ccc' });
    await db
      .insert(schema.claudeReviews)
      .values({ accountId: 1, prId: otherPr, headSha: 'ccc', status: 'failed', model: 'claude-sonnet-5' })
      .execute();
    expect((await buildPendingBoard(1, wsMine, { live: true, now })).reviewSuggestion).toBeNull();
  });
});

describe('pure rules', () => {
  // Imported inside the tests: a collection-time import would open the DB before beforeAll resets it.
  it('firstOnboardingFor', async () => {
    const up = await import('../sync/upsert.js');
    expect(up.firstOnboardingFor([], false)).toBe(true);
    expect(up.firstOnboardingFor([true, true], true)).toBe(true);
    expect(up.firstOnboardingFor([true, false], true)).toBe(false);
    expect(up.firstOnboardingFor([true], false)).toBe(false);
  });
  it('summaryWindowOpen', async () => {
    const fl = await import('./pending-first-landing.js');
    expect(fl.summaryWindowOpen(null, now)).toBe(false);
    expect(fl.summaryWindowOpen(new Date(now - DAY), now)).toBe(true);
    expect(fl.summaryWindowOpen(new Date(now - PENDING_SUMMARY_DAYS * DAY), now)).toBe(false);
  });
  it('reviewSuggestionAllowed', async () => {
    const fl = await import('./pending-first-landing.js');
    expect(fl.reviewSuggestionAllowed({ aiEnabled: true, dismissedAt: null, anyReviewRan: false })).toBe(true);
    expect(fl.reviewSuggestionAllowed({ aiEnabled: false, dismissedAt: null, anyReviewRan: false })).toBe(false);
    expect(fl.reviewSuggestionAllowed({ aiEnabled: true, dismissedAt: new Date(), anyReviewRan: false })).toBe(false);
    expect(fl.reviewSuggestionAllowed({ aiEnabled: true, dismissedAt: null, anyReviewRan: true })).toBe(false);
  });
});
