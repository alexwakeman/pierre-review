// MY TURN DISMISSALS + ONE CARD PER PR, on a THROWAWAY sqlite DB (the pending-mute.test.ts pattern).
//
// WHAT THIS PINS — each is a way the retired "Done" button went wrong, or a way this one could:
//
//   1. ONE CARD PER PR IS THE BOARD'S RULE. With `onePerPr` a PR holding two jobs lists ONE — the
//      reader's highest type, and the reader's order decides — while the account-wide inbox the
//      notification watcher reads keeps both.
//   2. THE BOARD'S COUNTS MOVE WITH IT: `kindTotals.my_turn` and the cards agree.
//   3. A DISMISSAL HIDES A SUBJECT EVERYWHERE — the inbox, the board, the counts — and lists it.
//   4. IT IS NOT STICKY. Something that happens AFTER the dismissal shows again, and only that item.
//   5. IT DISCHARGES. A subject that leaves the plate on its own drops its row, so a later summons
//      arrives fresh instead of already dismissed — the failure that got 0060's table deleted.
//   6. IT IS TENANT-SCOPED: another account's subject is a 404 (null), and the composite FK refuses
//      a cross-account row in the database.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and EVERY import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MyTurnCardReason, MyTurnResponse } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-dismissals-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let dz: any;
let account: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-dismiss';
const OTHER_ACCOUNT = 2;

let viewerId = 0;
let aliceId = 0;
let repoId = 0;
/** Review requested of the viewer AND a reply in the viewer's thread — two jobs, one PR. */
let bothPr = 0;
let bothThreadId = 0;
/** Review requested only. */
let reqPr = 0;
let otherAccountPr = 0;
let scope: any;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  dz = await import('./my-turn-dismissals.js');
  account = await import('../auth/account.js');

  const { accounts, repos, pullRequests, reviewRequests, reviewThreads, reviewComments, users } =
    schema;
  const { eq } = await import('drizzle-orm');
  // Migration 0008 seeds account 1 with an EMPTY login, which makes getMyTurn short-circuit to an
  // all-empty response — every assertion below would then be vacuous.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();
  await db
    .insert(accounts)
    .values({ id: OTHER_ACCOUNT, githubUserId: 'U_other', githubLogin: 'other', isLocal: false })
    .execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dismiss');

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'dismiss',
      githubNodeId: 'R_dismiss',
      viewerPermission: 'WRITE',
      defaultBranch: 'main',
      createdAt: new Date(now - 30 * DAY),
    })
    .returning()
    .execute();
  repoId = repo.id;

  let n = 1;
  const insertPr = async (key: string, accountId = 1, rId = repoId): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_dismiss_${key}`,
        accountId,
        repoId: rId,
        number: n++,
        title: `${key} fixture`,
        authorId: aliceId,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 5 * DAY),
        updatedAt: new Date(now - 5 * DAY),
        firstReviewRequestedAt: new Date(now - 3 * DAY),
      })
      .returning()
      .execute();
    return pr.id;
  };

  bothPr = await insertPr('both');
  reqPr = await insertPr('req');
  await db
    .insert(reviewRequests)
    .values([
      { prId: bothPr, userId: viewerId },
      { prId: reqPr, userId: viewerId },
    ])
    .execute();

  // The viewer's thread on `bothPr`, answered by alice a day ago — a `thread` job.
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_dismiss_both',
      prId: bothPr,
      path: 'src/index.ts',
      isResolved: false,
      derivedState: 'replied_unresolved',
      originalCommenterId: viewerId,
      createdAt: new Date(now - 4 * DAY),
    })
    .returning()
    .execute();
  bothThreadId = thread.id;
  await db
    .insert(reviewComments)
    .values([
      {
        githubNodeId: 'RC_dismiss_1',
        prId: bothPr,
        threadId: bothThreadId,
        authorId: viewerId,
        body: 'why this?',
        createdAt: new Date(now - 4 * DAY),
      },
      {
        githubNodeId: 'RC_dismiss_2',
        prId: bothPr,
        threadId: bothThreadId,
        authorId: aliceId,
        body: 'because',
        createdAt: new Date(now - DAY),
      },
    ])
    .execute();

  // Another account's PR, for the tenancy checks.
  const [otherRepo] = await db
    .insert(repos)
    .values({ accountId: OTHER_ACCOUNT, owner: 'else', name: 'where', githubNodeId: 'R_else' })
    .returning()
    .execute();
  otherAccountPr = await insertPr('other', OTHER_ACCOUNT, otherRepo.id);

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const setOrder = async (order: MyTurnCardReason[] | undefined): Promise<void> => {
  await account.setMyTurnSettings(1, order == null ? null : { order });
};

/** Every PR the response names, per section — enough to see duplicates and absences. */
const prsIn = (res: MyTurnResponse): { review: number[]; thread: number[] } => ({
  review: res.awaitingReview.map((r) => r.prId),
  thread: res.threadsAwaiting.map((t) => t.prId),
});

/** The board's my_turn cards for one PR. */
async function boardCardsFor(prId: number): Promise<{ reasons: string[]; total: number }> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
  const mine = insights.cards.filter((c: any) => c.kind === 'my_turn' && c.prId === prId);
  return { reasons: mine.map((c: any) => c.reason), total: insights.kindTotals.my_turn ?? 0 };
}

describe('one card per PR', () => {
  it('the inbox keeps both jobs (the fixture is not vacuous)', async () => {
    const res = await q.getMyTurn(1);
    expect(prsIn(res).review).toEqual(expect.arrayContaining([bothPr, reqPr]));
    expect(prsIn(res).thread).toEqual([bothPr]);
  });

  it('the board lists ONE card for a PR with two jobs — the reader’s highest type', async () => {
    const both = await boardCardsFor(bothPr);
    // Default order: review_request before thread.
    expect(both.reasons).toEqual(['review_request']);
    // Two PRs on the plate, two cards: the count moved with the list.
    expect(both.total).toBe(2);
  });

  it('follows the READER’S order, not a fixed precedence', async () => {
    await setOrder(['thread', 'review_request']);
    try {
      expect((await boardCardsFor(bothPr)).reasons).toEqual(['thread']);
      const res = await q.getMyTurn(1, scope, { onePerPr: true });
      expect(prsIn(res).review).toEqual([reqPr]);
      expect(prsIn(res).thread).toEqual([bothPr]);
    } finally {
      await setOrder(undefined);
    }
  });
});

describe('dismissing a My Turn entry', () => {
  it('hides the subject everywhere and lists it', async () => {
    expect(await dz.dismissMyTurn(1, { kind: 'pr', id: reqPr })).not.toBeNull();
    const res = await q.getMyTurn(1);
    expect(prsIn(res).review).not.toContain(reqPr);
    expect(res.dismissed?.map((d: any) => d.target)).toEqual([{ kind: 'pr', id: reqPr }]);
    expect(res.dismissed?.[0]?.reason).toBe('review_request');
    expect(res.dismissed?.[0]?.title).toBe('req fixture');
    // …and off the board, count included.
    const board = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    expect(board.cards.some((c: any) => c.kind === 'my_turn' && c.prId === reqPr)).toBe(false);
    expect(board.kindTotals.my_turn).toBe(1);
    expect(board.myTurnDismissed?.map((d: any) => d.target.id)).toEqual([reqPr]);
  });

  it('brings it back on restore', async () => {
    expect(await dz.restoreMyTurn(1, { kind: 'pr', id: reqPr })).toBe(true);
    const res = await q.getMyTurn(1);
    expect(prsIn(res).review).toContain(reqPr);
    expect(res.dismissed).toEqual([]);
    // Nothing left to restore.
    expect(await dz.restoreMyTurn(1, { kind: 'pr', id: reqPr })).toBe(false);
  });

  it('lets a NEWER item through — and only that item', async () => {
    // Dismissed twelve hours ago: after alice's reply (a day ago) and the request (three days).
    await dz.dismissMyTurn(1, { kind: 'pr', id: bothPr }, now - 12 * HOUR);
    let res = await q.getMyTurn(1);
    expect(prsIn(res).review).not.toContain(bothPr);
    expect(prsIn(res).thread).not.toContain(bothPr);
    expect(res.dismissed?.map((d: any) => d.target.id)).toContain(bothPr);

    // alice replies again, AFTER the dismissal.
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: 'RC_dismiss_3',
        prId: bothPr,
        threadId: bothThreadId,
        authorId: aliceId,
        body: 'any thoughts?',
        createdAt: new Date(now - HOUR),
      })
      .execute();
    res = await q.getMyTurn(1);
    // The reply comes back as a reply; the review request the reader set down stays down.
    expect(prsIn(res).thread).toContain(bothPr);
    expect(prsIn(res).review).not.toContain(bothPr);
    // Back on the plate, so no longer listed as dismissed.
    expect(res.dismissed?.map((d: any) => d.target.id) ?? []).not.toContain(bothPr);
    // On the board it is the ONE card left for the PR.
    expect((await boardCardsFor(bothPr)).reasons).toEqual(['thread']);
    await dz.restoreMyTurn(1, { kind: 'pr', id: bothPr });
  });

  it('DISCHARGES when the subject leaves the plate, so the next summons starts fresh', async () => {
    const { reviewRequests, myTurnDismissals } = schema;
    const { and, eq } = await import('drizzle-orm');
    await dz.dismissMyTurn(1, { kind: 'pr', id: reqPr });
    // The viewer reviewed: GitHub removed the request, so nothing on the PR is theirs any more.
    await db
      .delete(reviewRequests)
      .where(and(eq(reviewRequests.prId, reqPr), eq(reviewRequests.userId, viewerId)))
      .execute();
    await q.getMyTurn(1);
    const rows = await db
      .select()
      .from(myTurnDismissals)
      .where(eq(myTurnDismissals.prId, reqPr))
      .execute();
    expect(rows).toEqual([]);
    // Re-requested later: it arrives on the plate, not already dismissed. (The request's clock is
    // the PR's first-request time, three days ago — a surviving row would have hidden it forever,
    // which is exactly what the retired table did.)
    await db.insert(reviewRequests).values({ prId: reqPr, userId: viewerId }).execute();
    expect(prsIn(await q.getMyTurn(1)).review).toContain(reqPr);
  });

  it('refuses another account’s subject, and the database refuses the pair too', async () => {
    expect(await dz.dismissMyTurn(1, { kind: 'pr', id: otherAccountPr })).toBeNull();
    expect(await dz.dismissMyTurn(OTHER_ACCOUNT, { kind: 'pr', id: reqPr })).toBeNull();
    expect(await dz.dismissMyTurn(1, { kind: 'repo', id: 999_999 })).toBeNull();
    expect(await dz.restoreMyTurn(OTHER_ACCOUNT, { kind: 'pr', id: reqPr })).toBe(false);
    // ⚠ STRUCTURAL: the composite FK rejects (account 1, another account's PR) even when a
    // handler forgets to check.
    await expect(
      db
        .insert(schema.myTurnDismissals)
        .values({ accountId: 1, prId: otherAccountPr, repoId: null, dismissedAt: new Date(now) })
        .execute(),
    ).rejects.toThrow();
  });
});

describe('the pure fold', () => {
  it('a red default branch is dismissed by repo and dated by its observation, not `since`', () => {
    const f = new dz.MyTurnDismissalFilter(
      [{ target: { kind: 'repo', id: 7 }, dismissedAtMs: now, repoId: 7, closed: false }],
      ['trunk_red'],
    );
    const desc = () => ({ repoFullName: 'a/b', prNumber: null, title: 'main', githubUrl: 'x' });
    // Observed before the dismissal → hidden; no observation at all → cannot prove it is newer.
    expect(f.keep({ kind: 'repo', id: 7 }, new Date(now - HOUR).toISOString(), 'trunk_red', desc)).toBe(false);
    expect(f.keep({ kind: 'repo', id: 7 }, null, 'trunk_red', desc)).toBe(false);
    expect(f.dismissed().map((d: any) => d.title)).toEqual(['main']);
    // A new red head, observed after it → shown.
    expect(f.keep({ kind: 'repo', id: 7 }, new Date(now + HOUR).toISOString(), 'trunk_red', desc)).toBe(true);
    expect(f.dismissed()).toEqual([]);
  });

  it('discharges only subjects the read could have seen, and every closed PR', () => {
    const f = new dz.MyTurnDismissalFilter(
      [
        { target: { kind: 'pr', id: 1 }, dismissedAtMs: now, repoId: 10, closed: false },
        { target: { kind: 'pr', id: 2 }, dismissedAtMs: now, repoId: 20, closed: false },
        { target: { kind: 'pr', id: 3 }, dismissedAtMs: now, repoId: 20, closed: true },
      ],
      [],
    );
    expect(f.dischargeable((r: number) => r === 10)).toEqual([
      { kind: 'pr', id: 1 },
      { kind: 'pr', id: 3 },
    ]);
  });

  it('breaks a same-type tie on the longer wait', () => {
    const t = (threadId: number, lastReplyAt: string) => ({ threadId, prId: 5, lastReplyAt }) as any;
    const empty = {
      awaitingReview: [], mentions: [], commentReplies: [], pushedSince: [], ownCiRed: [],
      ownConflicts: [], approvedPrs: [], ownReady: [], yourPrs: [], watchedRepoPrs: [],
      threadReplies: [], ownThreads: [], claudeReviewsToAction: [], redTrunks: [],
    };
    const out = dz.onePerPr(
      {
        ...empty,
        threadsAwaiting: [
          t(1, new Date(now - HOUR).toISOString()),
          t(2, new Date(now - DAY).toISOString()),
        ],
      },
      ['thread'],
    );
    expect(out.threadsAwaiting.map((x: any) => x.threadId)).toEqual([2]);
  });
});
