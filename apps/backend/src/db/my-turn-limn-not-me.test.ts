// "EVERYTHING LIMN DOES ON MY BEHALF IS NOT ME" — My Turn and the Feed (docs/BACKEND.md § My Turn;
// docs/TEAM-REVIEW.md rule 2), on a THROWAWAY sqlite DB, in the shape sync leaves rows once Limn's
// actions are attributed to the reader's `limn:<login>` bot (author = the bot, the person in
// `limn_*_by_user_id`; docs/CLAUDE-REVIEW.md § Limn's actions are bots).
//
// What this pins, each with a fixture shaped like the dev-DB case that reported it:
//   1. #444 / #449 — Limn's auto reviews (and the empty wrapper beside them) on a PR the reader never
//      touched in person are not "your last action": a person's push after them is not "pushed since".
//   2. #455 — a Limn story-check comment is not "you commented": a person's comment after it is not a
//      comment reply, and a push after it is not "pushed since".
//   3. Your PERSONAL review still anchors "pushed since", and a Limn push after it neither clears the
//      card nor counts as you acting.
//   4. The three cleared review requests (#154, #102, #579): a request only a Limn review answered
//      still stands ("Waiting on you: review request"), dated by the request; a request you answered
//      in person, one somebody withdrew, or one that vanished with no Limn review behind it does not.
//   5. A PR Limn OPENED for the reader is "Your PRs" (its red CI is your card), and the Feed counts it
//      as authored by you.
//   6. Thread summons: a person replying to your Limn finding does not summon you; a thread you opened
//      in person does; a Limn-rooted thread you replied in, in person, does.
//   7. #466 — the Feed flags a PR as yours only for what you did in person: Limn's approval and Limn's
//      comments under your name are not participation.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsolidatedFeedItem } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-my-turn-limn-not-me-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let feed: typeof import('../feed/my-turn.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const T0 = now - 10 * DAY;
const at = (h: number) => new Date(T0 + h * HOUR);

const MARK = '\n\n<!-- pierre:claude-review v=2 -->';
let viewer = 0;
let limn = 0;
let alice = 0;
let bob = 0;
let repoId = 0;
let n = 0;
const id: Record<string, number> = {};

async function pr(key: string, o: Record<string, unknown> = {}): Promise<number> {
  n += 1;
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_lnm_${n}`,
      accountId: 1,
      repoId,
      number: 400 + n,
      title: key,
      state: 'open',
      isDraft: false,
      authorId: alice,
      openedAt: at(0),
      updatedAt: at(0),
      ...o,
    })
    .returning()
    .execute();
  id[key] = row.id;
  return row.id;
}
const review = (prId: number, authorId: number, state: string, h: number, body: string | null, postedFor: number | null = null) =>
  db
    .insert(schema.reviews)
    .values({
      githubNodeId: `RV_lnm_${++n}`,
      prId,
      authorId,
      state,
      submittedAt: at(h),
      body,
      limnPostedByUserId: postedFor,
    })
    .execute();
const commit = (prId: number, authorId: number, h: number, pushedFor: number | null = null) =>
  db
    .insert(schema.commits)
    .values({ sha: `sha_lnm_${++n}_000000`, prId, authorId, committedAt: at(h), limnPushedByUserId: pushedFor })
    .execute();
const prComment = (prId: number, authorId: number, h: number, body: string, postedFor: number | null = null) =>
  db
    .insert(schema.prComments)
    .values({ githubNodeId: `IC_lnm_${++n}`, prId, authorId, body, createdAt: at(h), limnPostedByUserId: postedFor })
    .execute();
const requestEvent = (prId: number, kind: 'requested' | 'removed', h: number, reviewer = viewer) =>
  db
    .insert(schema.reviewRequestEvents)
    .values({ prId, githubNodeId: `RRE_lnm_${++n}`, kind, occurredAt: at(h), reviewerKind: 'user', reviewerUserId: reviewer })
    .execute();
async function thread(prId: number, opener: number, h: number): Promise<number> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `T_lnm_${++n}`,
      prId,
      path: 'src/a.ts',
      line: 1,
      isResolved: false,
      isOutdated: false,
      derivedState: 'replied_unresolved',
      addressedConfidence: 'none',
      originalCommenterId: opener,
      createdAt: at(h),
    })
    .returning()
    .execute();
  return t.id;
}
const threadComment = (threadId: number, prId: number, authorId: number, h: number, body: string, postedFor: number | null = null) =>
  db
    .insert(schema.reviewComments)
    .values({ githubNodeId: `RC_lnm_${++n}`, threadId, prId, authorId, body, createdAt: at(h), limnPostedByUserId: postedFor })
    .execute();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  feed = await import('../feed/my-turn.js');
  const { eq } = await import('drizzle-orm');
  const { accounts, users, repos } = schema;

  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const user = async (login: string, o: Record<string, unknown> = {}): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, ...o }).returning().execute())[0].id;
  viewer = await user('viewer-me', { githubNodeId: 'U_viewer' });
  limn = await user('limn:viewer-me', { isBot: true, isBotOverridden: true });
  alice = await user('alice-dev', { githubNodeId: 'U_alice' });
  bob = await user('bob-dev', { githubNodeId: 'U_bob' });
  repoId = (
    await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'app', githubNodeId: 'R_lnm', createdAt: new Date(REPO_ADDED), viewerPermission: 'WRITE' })
      .returning()
      .execute()
  )[0].id;
  await q.assignReposToWorkspace(await q.ensureDefaultWorkspace(1), 1, [repoId]);

  // 1. #444: two Limn auto reviews (one approving) and the empty wrapper beside a finding; alice pushes after.
  const p444 = await pr('p444');
  await review(p444, limn, 'commented', 1, `Two findings.${MARK}`, viewer);
  await review(p444, limn, 'commented', 1.001, '', viewer);
  await review(p444, limn, 'approved', 5, `Looks right now.${MARK}`, viewer);
  await commit(p444, alice, 6);
  //    #449: a single Limn auto review, then alice pushes.
  const p449 = await pr('p449');
  await review(p449, limn, 'commented', 1, `One finding.${MARK}`, viewer);
  await commit(p449, alice, 3);

  // 2. #455: a Limn story check under the reader's name; alice comments and pushes after.
  const p455 = await pr('p455');
  await prComment(p455, limn, 1, `**Story check** — one gap.${MARK}`, viewer);
  await prComment(p455, alice, 2, 'Fixed the gap, thanks.');
  await commit(p455, alice, 2.5);

  // 3. You reviewed in person; alice pushed after; then Limn pushed (AI Fix) for you.
  const pMine = await pr('pMine');
  await review(pMine, viewer, 'commented', 1, 'Please split this function.');
  await commit(pMine, alice, 2);
  await commit(pMine, limn, 3, viewer);

  // 4. Review requests. GitHub dropped each `review_requests` row when Limn's review was submitted.
  const r154 = await pr('r154'); // requested, then Limn commented and approved.
  await requestEvent(r154, 'requested', 1);
  await review(r154, limn, 'commented', 1.1, `Tidy.${MARK}`, viewer);
  await review(r154, limn, 'approved', 1.6, `Approving.${MARK}`, viewer);
  const r579 = await pr('r579'); // asked twice; Limn reviewed before and after the second ask.
  await review(r579, limn, 'dismissed', 0.5, `Gap.${MARK}`, viewer);
  await requestEvent(r579, 'requested', 1);
  await review(r579, limn, 'commented', 2, `Still a gap.${MARK}`, viewer);
  await requestEvent(r579, 'requested', 20);
  await review(r579, limn, 'approved', 21, `Fixed.${MARK}`, viewer);
  const rPerson = await pr('rPerson'); // you answered it in person after Limn.
  await requestEvent(rPerson, 'requested', 1);
  await review(rPerson, limn, 'commented', 1.2, `Note.${MARK}`, viewer);
  await review(rPerson, viewer, 'approved', 3, 'LGTM');
  const rRemoved = await pr('rRemoved'); // somebody withdrew the request.
  await requestEvent(rRemoved, 'requested', 1);
  await review(rRemoved, limn, 'commented', 1.2, `Note.${MARK}`, viewer);
  await requestEvent(rRemoved, 'removed', 2);
  const rVanished = await pr('rVanished'); // the row is gone and no Limn review explains it.
  await requestEvent(rVanished, 'requested', 1);
  const rStanding = await pr('rStanding'); // the ordinary card: the row still exists.
  await requestEvent(rStanding, 'requested', 1);
  await db.insert(schema.reviewRequests).values({ prId: rStanding, userId: viewer }).execute();

  // 5. A PR Limn opened for you (Implement), red CI, with recent activity.
  const pOpened = await pr('pOpened', { authorId: limn, limnOpenedForUserId: viewer, ciStatus: 'failure', lastCommitAt: at(1) });
  await commit(pOpened, limn, 1, viewer);
  await db
    .insert(schema.events)
    .values({ accountId: 1, repoId, actorId: limn, prId: pOpened, type: 'pr_opened', occurredAt: new Date(now - DAY), dedupeKey: 'lnm:opened' })
    .execute();

  // 6. Threads on alice's PR.
  const pThreads = await pr('pThreads');
  const onFinding = await thread(pThreads, limn, 1); // your Limn's finding; bob replied.
  await threadComment(onFinding, pThreads, limn, 1, `**Warning** x${MARK}`, viewer);
  await threadComment(onFinding, pThreads, bob, 2, 'I disagree.');
  id.onFinding = onFinding;
  const yours = await thread(pThreads, viewer, 1); // yours in person; bob replied.
  await threadComment(yours, pThreads, viewer, 1, 'Why this name?');
  await threadComment(yours, pThreads, bob, 2, 'Convention.');
  id.yours = yours;
  const joined = await thread(pThreads, limn, 1); // a Limn finding you replied to in person; bob answered you.
  await threadComment(joined, pThreads, limn, 1, `**Minor** y${MARK}`, viewer);
  await threadComment(joined, pThreads, viewer, 2, 'Agreed with Limn here.');
  await threadComment(joined, pThreads, bob, 3, 'Will change it.');
  id.joined = joined;

  // 7. #466 (merged): your only "participation" is Limn's approval and a Limn comment.
  await pr('p466', { state: 'merged', mergedAt: at(5), mergedById: limn, limnMergedForUserId: viewer });
  await review(id.p466!, limn, 'approved', 2, `Approving.${MARK}`, viewer);
  await prComment(id.p466!, limn, 2.1, `**SonarCloud** on abc: 0 issues.${MARK}`, viewer);
  //    …and a PR you reviewed in person (the control).
  await pr('pReviewed', { state: 'merged', mergedAt: at(5) });
  await review(id.pReviewed!, viewer, 'approved', 2, 'Ship it');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const prIdsOf = (rows: { prId: number }[]) => rows.map((r) => r.prId);
const allPrIds = (mt: any): number[] =>
  [
    ...mt.awaitingReview,
    ...mt.mentions,
    ...mt.commentReplies,
    ...mt.pushedSince,
    ...mt.ownCiRed,
    ...mt.ownConflicts,
    ...mt.approvedPrs,
    ...mt.ownReady,
    ...mt.ownThreads,
    ...mt.watchedRepoPrs,
    ...mt.threadsAwaiting,
    ...mt.threadReplies,
  ].map((r: { prId: number }) => r.prId);

describe('My Turn counts only what you did in person', () => {
  it('#444 / #449: Limn reviews are not your last action — a push after them is no card', async () => {
    const mt = await q.getMyTurn(1);
    expect(allPrIds(mt)).not.toContain(id.p444);
    expect(allPrIds(mt)).not.toContain(id.p449);
  });

  it('#455: a Limn story check is not your comment — a reply or a push after it is no card', async () => {
    const mt = await q.getMyTurn(1);
    expect(prIdsOf(mt.commentReplies)).not.toContain(id.p455);
    expect(prIdsOf(mt.pushedSince)).not.toContain(id.p455);
  });

  it('your own review anchors "pushed since", and a Limn push after it neither clears nor counts', async () => {
    const mt = await q.getMyTurn(1);
    const row = mt.pushedSince.find((r: any) => r.prId === id.pMine);
    expect(row).toBeDefined();
    // Only alice's push: the Limn push is automation and is not you acting either.
    expect(row.ball.humanCommitsAfter).toBe(1);
  });

  it('a review request only Limn answered still stands, dated by the request', async () => {
    const mt = await q.getMyTurn(1);
    const awaiting = new Map(mt.awaitingReview.map((r: any) => [r.prId, r.since]));
    expect(awaiting.get(id.r154)).toBe(at(1).toISOString());
    // Asked twice: the newest ask is the clock.
    expect(awaiting.get(id.r579)).toBe(at(20).toISOString());
    expect(awaiting.has(id.rStanding)).toBe(true);
    // Answered in person, withdrawn, or gone with no Limn review behind it: no card.
    expect(awaiting.has(id.rPerson)).toBe(false);
    expect(awaiting.has(id.rRemoved)).toBe(false);
    expect(awaiting.has(id.rVanished)).toBe(false);
  });

  it('a PR Limn opened for you is Your PRs: its red CI is your card', async () => {
    const mt = await q.getMyTurn(1);
    expect(prIdsOf(mt.ownCiRed)).toContain(id.pOpened);
    // …and it is never a "new PR" from somebody else.
    expect(prIdsOf(mt.watchedRepoPrs)).not.toContain(id.pOpened);
  });

  it('a person replying to your Limn finding does not summon you; your own threads do', async () => {
    const mt = await q.getMyTurn(1);
    const threads = [...mt.threadsAwaiting, ...mt.threadReplies].map((t: any) => t.threadId);
    expect(threads).not.toContain(id.onFinding);
    expect(mt.threadsAwaiting.map((t: any) => t.threadId)).toContain(id.yours);
    // You replied in person on a Limn-rooted thread, and bob answered you: S3(d).
    expect(mt.threadReplies.map((t: any) => t.threadId)).toContain(id.joined);
  });
});

describe('the Feed flags only PRs you took part in, in person', () => {
  const item = (key: string, o: Partial<ConsolidatedFeedItem> = {}): ConsolidatedFeedItem =>
    ({
      id: `feed:${key}`,
      isMyTurn: false,
      myTurnReasons: [],
      kind: 'pr_merged',
      actorId: alice,
      content: null,
      prId: id[key],
      ...o,
    }) as ConsolidatedFeedItem;

  it('#466: Limn’s approval and Limn’s comments under your name are not participation', async () => {
    const items = [item('p466'), item('p466', { id: 'feed:p466:o', kind: 'pr_opened' }), item('pReviewed')];
    await feed.enrichMyTurn(1, items);
    expect(items.map((i) => [i.prId, i.isMyTurn])).toEqual([
      [id.p466, false],
      [id.p466, false],
      [id.pReviewed, true],
    ]);
    expect(items[2]!.myTurnReasons).toEqual(['reviewed']);
  });

  it('a PR Limn opened for you is authored by you; a request only Limn answered is still a request', async () => {
    const items = [
      item('pOpened', { kind: 'commit_pushed' as ConsolidatedFeedItem['kind'] }),
      item('r154', { kind: 'pr_comment' }),
      item('p455', { kind: 'pr_comment', content: 'Fixed the gap, thanks.' }),
    ];
    await feed.enrichMyTurn(1, items);
    expect(items[0]!.isMyTurn).toBe(true);
    expect(items[0]!.myTurnReasons).toEqual(['authored']);
    expect(items[1]!.isMyTurn).toBe(true);
    expect(items[1]!.myTurnReasons).toEqual(['requested']);
    // #455: your only "comment" there was Limn's story check.
    expect(items[2]!.isMyTurn).toBe(false);
  });
});
