// "Waiting on others" and the review-target note (db/review-waits.ts, the (3b) block and
// `noteReviewTargets` in getWorkspaceInsights, `listByWait` in db/pending-tabs.ts) on a THROWAWAY
// sqlite DB (the reviewer-load.test.ts pattern).
//
// WHAT THIS PINS:
//   1. THE POPULATION: the reader's own open, non-draft PRs with an outstanding request to a PERSON
//      or a TEAM. Not a request to a bot, not somebody else's PR, not a PR where a person asked for
//      changes after the last push and the newest request (the author's move), not a PR with a My
//      Turn item on it (the ball rule).
//   2. ⚠ READ-ONLY, COUNTED ONLY IN ITS TAB: the DEFAULT fold (the brief's, the work plan's, chat's)
//      builds none, and no `myTurn*` total moves.
//   3. THE CLOCK is the newest request event naming the reviewer, in WORKING hours; a long wait
//      carries `overReviewTarget`, a fresh one does not. Somebody else's stalled review carries the
//      same note.
//   4. THE TAB lists the longest wait first and gives the cards no score.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  InsightCard,
  MyTurnCard,
  StalledReviewCard,
  WaitingOnOthersCard,
} from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-waiting-on-others-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER_LOGIN = 'viewer-me';

const prIdByKey = new Map<string, number>();
const pr = (key: string): number => prIdByKey.get(key)!;
let viewerId = 0;
let rexId = 0;
let ninaId = 0;
let botId = 0;

async function boardFold(): Promise<any> {
  return q.getWorkspaceInsights(1, undefined, scope, {
    uncapped: true,
    withFailingChecks: true,
    withWaiting: true,
  });
}
const waitingOf = (cards: InsightCard[]): WaitingOnOthersCard[] =>
  cards.filter((c): c is WaitingOnOthersCard => c.kind === 'waiting_on_others');

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');

  const { accounts, events, repos, pullRequests, reviews, reviewRequests, reviewRequestEvents, users } =
    schema;
  const { eq } = await import('drizzle-orm');
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  rexId = await insertUser('rex-reviewer');
  ninaId = await insertUser('nina-reviewer');
  botId = await insertUser('review-robot[bot]', true);
  const aliceId = await insertUser('alice-dev');

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'waits',
      githubNodeId: 'R_waits',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'WRITE',
      // Added before every fixture event, so a My Turn rule can see the one comment below (the
      // onboarding floor). "New PR" is off by default, so nothing else crowds the board.
      createdAt: new Date(now - 30 * DAY),
    })
    .returning()
    .execute();

  let n = 1;
  let ev = 1;
  const insertPr = async (key: string, values: Record<string, unknown> = {}): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_waits_${key}`,
        accountId: 1,
        repoId: repo.id,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId: viewerId,
        openedAt: new Date(now - 20 * DAY),
        updatedAt: new Date(now - HOUR),
        lastCommitAt: new Date(now - 15 * DAY),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    // The fold's open-PR population needs an activity event inside 90 days. The viewer's own, so
    // it is no "new activity on your PR".
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: row.id,
        actorId: (values.authorId as number | undefined) ?? viewerId,
        type: 'commit_pushed',
        occurredAt: new Date(now - 15 * DAY),
        dedupeKey: `waits_ev_${ev++}`,
      })
      .execute();
    return row.id;
  };
  let rre = 1;
  const request = async (
    key: string,
    who: { userId: number } | { team: string; slug: string },
    atMs: number,
  ): Promise<void> => {
    if ('userId' in who) {
      await db.insert(reviewRequests).values({ prId: pr(key), userId: who.userId }).execute();
    } else {
      await db.insert(reviewRequests).values({ prId: pr(key), teamName: who.team }).execute();
    }
    await db
      .insert(reviewRequestEvents)
      .values({
        prId: pr(key),
        githubNodeId: `RRE_${rre++}`,
        kind: 'requested',
        occurredAt: new Date(atMs),
        reviewerKind: 'userId' in who ? 'user' : 'team',
        reviewerUserId: 'userId' in who ? who.userId : null,
        teamSlug: 'userId' in who ? null : who.slug,
      })
      .execute();
  };
  let rv = 1;
  const review = async (key: string, authorId: number, state: string, atMs: number): Promise<void> => {
    await db
      .insert(reviews)
      .values({ githubNodeId: `RV_waits_${rv++}`, prId: pr(key), authorId, state, submittedAt: new Date(atMs) })
      .execute();
  };

  // (1) LISTED — rex asked ten days ago (an OLDER request first: the clock is the NEWEST).
  await insertPr('rex-long');
  await request('rex-long', { userId: rexId }, now - 14 * DAY);
  await request('rex-long', { userId: rexId }, now - 10 * DAY);

  // (2) LISTED — a team, matched to its event by slug; a shorter wait than (1).
  await insertPr('team');
  await request('team', { team: 'Platform Team', slug: 'platform-team' }, now - 3 * DAY);

  // (3) LISTED, NOT OVER — asked a minute ago.
  await insertPr('fresh');
  await request('fresh', { userId: ninaId }, now - 60_000);

  // (4) NOT LISTED — only a bot was asked.
  await insertPr('bot-only');
  await request('bot-only', { userId: botId }, now - 5 * DAY);

  // (5) NOT LISTED — nina asked for changes after the last push and the newest request.
  await insertPr('changes');
  await request('changes', { userId: rexId }, now - 6 * DAY);
  await review('changes', ninaId, 'changes_requested', now - 2 * DAY);

  // (6) LISTED — the same, but the author pushed after the changes were asked for.
  await insertPr('changes-answered', { lastCommitAt: new Date(now - DAY) });
  await request('changes-answered', { userId: rexId }, now - 6 * DAY);
  await review('changes-answered', ninaId, 'changes_requested', now - 2 * DAY);

  // (7) NOT LISTED — a draft.
  await insertPr('draft', { isDraft: true });
  await request('draft', { userId: rexId }, now - 5 * DAY);

  // (8) NOT LISTED, BUT A STALLED REVIEW WITH THE NOTE — somebody else's PR.
  await insertPr('alices', { authorId: aliceId });
  await request('alices', { userId: rexId }, now - 8 * DAY);

  // (9) NOT LISTED — a review is asked of the VIEWER on the viewer's own… no: on alice's PR, so it
  // is a My Turn `review_request` card, and it carries the note for the viewer's own wait.
  await insertPr('asks-me', { authorId: aliceId });
  await request('asks-me', { userId: viewerId }, now - 7 * DAY);

  // (10) NOT LISTED — rex is asked, but nina @-mentioned the reader since: a My Turn `mention`
  // item, so the ball is the reader's.
  await insertPr('busy');
  await request('busy', { userId: rexId }, now - 4 * DAY);
  await db
    .insert(schema.prMentions)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr('busy'),
      login: VIEWER_LOGIN,
      mentionedAt: new Date(now - HOUR),
      mentionedByUserId: ninaId,
    })
    .execute();

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('waiting on others — who is listed', () => {
  it('lists the reader’s own PRs held by a person or a team, and nothing else', async () => {
    const waiting = waitingOf((await boardFold()).cards);
    expect(waiting.map((c) => c.prId).sort((a, b) => a - b)).toEqual(
      [pr('rex-long'), pr('team'), pr('fresh'), pr('changes-answered')].sort((a, b) => a - b),
    );
  });

  it('names who has it — a person by id, a team by name', async () => {
    const waiting = waitingOf((await boardFold()).cards);
    const rex = waiting.find((c) => c.prId === pr('rex-long'))!;
    expect(rex.holders.map((h) => h.userId)).toEqual([rexId]);
    const team = waiting.find((c) => c.prId === pr('team'))!;
    expect(team.holders).toMatchObject([{ userId: null, teamName: 'Platform Team' }]);
  });

  it('dates a request from the NEWEST request event naming that reviewer', async () => {
    const rex = waitingOf((await boardFold()).cards).find((c) => c.prId === pr('rex-long'))!;
    expect(rex.holders[0]!.since).toBe(new Date(now - 10 * DAY).toISOString());
  });

  it('flags a wait over the review target, and not a fresh one', async () => {
    const waiting = waitingOf((await boardFold()).cards);
    const rex = waiting.find((c) => c.prId === pr('rex-long'))!;
    // Ten days hold at least six working days of nine hours under the default calendar.
    expect(rex.targetHours).toBe(4);
    expect(rex.waitHours).toBeGreaterThan(40);
    expect(rex.overReviewTarget).toEqual({ targetHours: 4, waitedHours: rex.waitHours });
    const fresh = waiting.find((c) => c.prId === pr('fresh'))!;
    expect(fresh.waitHours).toBeLessThan(1);
    expect(fresh.overReviewTarget).toBeUndefined();
  });

  it('⚠ is not built by the default fold, and moves no My Turn figure', async () => {
    const capped = await q.getWorkspaceInsights(1, undefined, scope);
    expect(waitingOf(capped.cards)).toHaveLength(0);
    expect(capped.kindTotals.waiting_on_others).toBeUndefined();
    const board = await boardFold();
    expect(board.kindTotals.waiting_on_others).toBe(4);
    expect(board.myTurnTotal).toBe(capped.myTurnTotal);
    expect(board.myTurnPersonalTotal).toBe(capped.myTurnPersonalTotal);
  });

  it('leaves out a PR with a My Turn item on it — the ball rule', async () => {
    const { cards } = await boardFold();
    // Not vacuous: the PR really does carry a My Turn card (nina mentioned the reader)…
    expect(cards.some((c: InsightCard) => c.kind === 'my_turn' && c.prId === pr('busy'))).toBe(true);
    // …so it is the reader's turn, not someone else's.
    expect(waitingOf(cards).map((c) => c.prId)).not.toContain(pr('busy'));
  });
});

describe('the review-target note on other cards', () => {
  it('marks somebody else’s stalled review and a review asked of the reader', async () => {
    const cards: InsightCard[] = (await boardFold()).cards;
    const stalled = cards.find(
      (c): c is StalledReviewCard => c.kind === 'stalled_review' && c.prId === pr('alices'),
    )!;
    expect(stalled.overReviewTarget?.targetHours).toBe(4);
    expect(stalled.overReviewTarget!.waitedHours).toBeGreaterThan(4);
    const mine = cards.find(
      (c): c is MyTurnCard =>
        c.kind === 'my_turn' && c.reason === 'review_request' && c.prId === pr('asks-me'),
    );
    expect(mine?.overReviewTarget?.waitedHours).toBeGreaterThan(4);
  });

  it('is board only — the default fold carries no note', async () => {
    const capped = await q.getWorkspaceInsights(1, undefined, scope);
    for (const c of capped.cards as InsightCard[]) {
      expect('overReviewTarget' in c && c.overReviewTarget != null).toBe(false);
    }
  });
});

describe('the Waiting on others tab', () => {
  it('lists the longest wait first, unscored, and counts its own population', async () => {
    const insights = await boardFold();
    const tabs = await import('./pending-tabs.js');
    const board = await tabs.rankPendingTabs(1, scope, insights, now, { suggestReviewers: false });
    const tab = board.tabs.find((t) => t.key === 'waiting')!;
    expect(tab.total).toBe(4);
    expect(tab.cardIds[0]).toBe(`waiting:${pr('rex-long')}`);
    expect(tab.cardIds[tab.cardIds.length - 1]).toBe(`waiting:${pr('fresh')}`);
    for (const id of tab.cardIds) expect(board.scores[id]).toBeUndefined();
    // Never named by the work plan: it may only name scored, listed cards.
    const listed = tabs.listedCardIds(insights.cards, [], []);
    for (const id of tab.cardIds) expect(listed.has(id)).toBe(false);
  });
});

describe('the PR pane’s review waits', () => {
  it('lists every outstanding request with its wait, and the write gate', async () => {
    const resp = await q.getPrReviewWaits(pr('rex-long'), 1, now);
    expect(resp.targetHours).toBe(4);
    expect(resp.viewerCanRequest).toBe(true);
    expect(resp.waits.map((w: any) => w.userId)).toEqual([rexId]);
  });

  it('leaves out a request to automation, and 404s another account’s PR', async () => {
    expect((await q.getPrReviewWaits(pr('bot-only'), 1, now)).waits).toEqual([]);
    expect(await q.getPrReviewWaits(pr('rex-long'), 2, now)).toBeNull();
  });
});

describe('the empty board', () => {
  it('ignores Waiting on others — the empty board lists those same PRs', async () => {
    const { boardIsEmpty } = await import('./pending-first-landing.js');
    expect(boardIsEmpty([{ key: 'my_turn', total: 0 }, { key: 'waiting', total: 3 }])).toBe(true);
    expect(boardIsEmpty([{ key: 'my_turn', total: 1 }, { key: 'waiting', total: 0 }])).toBe(false);
  });
});
