// WHERE THE REVIEW STANDS, and IS IT QUEUED — the two facts the Pending card gained, on a
// THROWAWAY sqlite DB (the pending-card-source.test.ts pattern, sibling to it rather than an
// extension so the source fixture's PRs stay review-free and its assertions stay about identity).
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. EVERY PR-BEARING CARD KIND CARRIES THE FIELDS. They are built in the ONE `prRef` builder,
//      whose second argument is REQUIRED precisely so a kind that never folded its ids is a
//      compile error rather than a card that reports "nobody has reviewed this" forever. The
//      fixture emits five of the six kinds and asserts the SET of kinds seen, so it cannot go
//      vacuous the day a kind stops being emitted. (`update_branch` is the sixth; it is the same
//      `prRef` call as `merge`, one branch of one ternary away.)
//   2. THE CHIPS ARE RANKED, NOT CHRONOLOGICAL: changes_requested → approved → commented →
//      dismissed, HUMANS BEFORE BOTS inside each tier. MEASURED on real data: 39% of reviewer
//      standings on open PRs are bot-authored and 477 of 478 of those are merely 'commented', so
//      a chronological list buries the one human approval under a wall of vendor chips.
//   3. ⚠ A REVIEWER'S BOT-NESS COMES FROM THE SAME UNION THE AUTHOR'S DOES — a manual workspace
//      judgement wins BOTH directions, then `users.isBot`, then the login seeds a vendor. A second
//      classifier here would type-check, pass a naive fixture, and paint a vendor chip on someone
//      the Timeline beside it calls a person.
//   4. ⚠ `inMergeQueue: null` IS "NOT OBSERVED" AND SURVIVES AS null. Coercing it to `false` tells
//      the board a PR is not queued on the strength of never having asked — and a queued PR
//      reports `mergeStateStatus: 'blocked'`, so the board would offer a Merge button GitHub
//      refuses.
//   5. ⚠ `reviewerCount` IS THE FOLD'S OWN TOTAL, not `reviewers.length`. It counts the reviewers
//      the cap dropped AND the unnameable ones (a deleted GitHub account) that the chips omit, so
//      the "+N" has a denominator of its own instead of being subtracted client-side.
//   6. THE COUNTS AND THE CHIPS ARE THE SAME ROWS. `reviewApprovals` is folded from the standings
//      the chips are built from, so "3 approvals" beside two approval chips is arithmetic the
//      reader can check, not two reads of `reviews` that may disagree.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, InsightPrRef } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pending-review-standing-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'viewer-me';

const prIdByKey = new Map<string, number>();
const loginByUserId = new Map<number, string>();

/** Every PR-bearing card the board would paint, grouped by the fixture PR's name. A card kind is
 *  PR-bearing exactly when it extends `InsightPrRef`; `ci_failing` deliberately does NOT (its
 *  subject can be a repo's trunk, and a repo-grained row must never be described as a PR). */
async function prCards(): Promise<Map<string, (InsightCard & InsightPrRef)[]>> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  const keyByPrId = new Map([...prIdByKey].map(([k, v]) => [v, k]));
  const out = new Map<string, (InsightCard & InsightPrRef)[]>();
  for (const c of insights.cards as InsightCard[]) {
    if (
      c.kind !== 'my_turn' &&
      c.kind !== 'stalled_review' &&
      c.kind !== 'untouched_thread' &&
      c.kind !== 'reviewer_routing' &&
      c.kind !== 'merge' &&
      c.kind !== 'update_branch'
    )
      continue;
    const key = keyByPrId.get(c.prId);
    if (key == null) continue;
    out.set(key, [...(out.get(key) ?? []), c]);
  }
  return out;
}

/** One card per fixture PR, for the assertions that are about the PR's facts rather than a kind. */
async function oneCardPerPr(): Promise<Map<string, InsightCard & InsightPrRef>> {
  const out = new Map<string, InsightCard & InsightPrRef>();
  for (const [key, cards] of await prCards()) out.set(key, cards[0]!);
  return out;
}

/** A chip as the tuple that has to be read together — a standing with the wrong identity beside it
 *  is exactly the "vendor chip on a colleague" failure, and asserting them apart would miss it. */
function chip(r: InsightPrRef['reviewers'][number]): [string, string, boolean, string | null] {
  return [loginByUserId.get(r.userId) ?? `user${r.userId}`, r.standing, r.isBot, r.botKind];
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

  const {
    accounts,
    events,
    repos,
    pullRequests,
    reviews,
    reviewRequests,
    reviewThreads,
    users,
    workspaceReviewers,
  } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId return
  // null — the my_turn fold would then match nobody and this file's fourth card kind would vanish.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    loginByUserId.set(u.id, login);
    return u.id;
  };
  const viewerId = await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-dev');
  const bobId = await insertUser('bob-dev');
  const carolId = await insertUser('carol-dev');
  const daveId = await insertUser('dave-dev');
  // `users.isBot` and NOTHING else: no vendor login, no workspace row. The unbranded CI service
  // account — a bot we recognise whose vendor we do not, which is a REAL and COMMON state.
  const unbrandedId = await insertUser('acme-ci-runner', true);
  // A KNOWN AI-review vendor login. `hiddenBotUserIds` seeds it from the login table even though
  // `users.isBot` is false here, and `classificationKindForUser` gives it its brand.
  const vendorId = await insertUser('coderabbitai[bot]', false);
  // ⚠ The same shape of login, MARKED HUMAN by a person in this workspace. It must come back a
  // person in BOTH halves of the chip — flag and kind.
  const vouchedId = await insertUser('greptile-apps[bot]', true);

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'standing',
      githubNodeId: 'R_standing',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'WRITE',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  const repoId = repo.id;

  let n = 1;
  let ev = 1;
  const insertPr = async (
    key: string,
    authorId: number,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_standing_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(REPO_ADDED + DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        mergeStateStatus: 'clean',
        mergeable: 'mergeable',
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
    // ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there.
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId: pr.id,
        actorId: authorId,
        type: 'commit_pushed',
        occurredAt: new Date(now - DAY),
        dedupeKey: `ev_standing_${ev++}`,
      })
      .execute();
    return pr.id;
  };

  let rv = 1;
  const addReview = async (
    prId: number,
    authorId: number | null,
    state: string,
    at: number,
  ): Promise<void> => {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_standing_${rv++}`,
        prId,
        authorId,
        state,
        submittedAt: new Date(at),
      })
      .execute();
  };

  // ── (1) `ranked` — eight standings on one PR, which is more than the chip cap and more kinds of
  // reviewer than a chronological list could order usefully. GitHub says `approved`; our fold says
  // somebody is blocking. Both travel.
  const rankedId = await insertPr('ranked', aliceId, { reviewDecision: 'approved' });
  await addReview(rankedId, bobId, 'changes_requested', now - 4 * DAY);
  await addReview(rankedId, unbrandedId, 'changes_requested', now - 6 * HOUR);
  await addReview(rankedId, aliceId, 'approved', now - 5 * DAY);
  await addReview(rankedId, vendorId, 'approved', now - 1 * DAY);
  await addReview(rankedId, vouchedId, 'commented', now - 2 * DAY);
  await addReview(rankedId, carolId, 'commented', now - 3 * DAY);
  await addReview(rankedId, daveId, 'dismissed', now - 7 * DAY);
  // ⚠ A DELETED GITHUB ACCOUNT. Unnameable, so no chip — and still counted, because omitting it
  // from the total would understate how many people have looked. Its approval counts too.
  await addReview(rankedId, null, 'approved', now - 8 * DAY);
  // A 'pending' row: a review draft that was never submitted. It says nothing about where the
  // reviewer stands, and a chip for it would name someone who has not spoken.
  await addReview(rankedId, carolId, 'pending', now - 1 * HOUR);

  // ── (2) `queued` — in GitHub's merge queue and being EJECTED. A queued PR reports
  // `mergeStateStatus: 'blocked'` (GitHub's enum has no QUEUED member), which is why the columns
  // had to become stored at all — and why this PR emits an untouched_thread card rather than a
  // merge one.
  const queuedId = await insertPr('queued', bobId, {
    mergeStateStatus: 'blocked',
    inMergeQueue: true,
    mergeQueueEntryState: 'unmergeable',
    reviewDecision: 'review_required',
  });
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_standing_queued',
      prId: queuedId,
      path: 'src/app.ts',
      isResolved: false,
      derivedState: 'untouched',
      originalCommenterId: vendorId,
      createdAt: new Date(now - 3 * DAY),
    })
    .execute();
  await addReview(queuedId, vendorId, 'commented', now - 3 * DAY);

  // ── (3) `unobserved` — synced before the merge-queue columns existed and never reviewed. Every
  // new field is at its honest empty, and NOT ONE of them is a negative claim.
  await insertPr('unobserved', carolId);

  // ── (4) `stalled` — a review request the viewer has not answered, on a PR opened well past
  // INSIGHT_STALLED_REVIEW_HOURS. Emits BOTH a stalled_review card and a my_turn one, which is how
  // this fixture reaches its card kinds without one PR per kind.
  const stalledId = await insertPr('stalled', aliceId, { reviewDecision: 'review_required' });
  await db.insert(reviewRequests).values({ prId: stalledId, userId: viewerId }).execute();
  await addReview(stalledId, bobId, 'approved', now - 2 * DAY);

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into Default.
  scope = await q.resolveWorkspaceScope(1, null);

  // The manual "this is a human" vouch, in this workspace. `source: 'manual'` is what makes it
  // un-re-derivable; `automated: false` + manual IS the vouch.
  await db
    .insert(workspaceReviewers)
    .values({
      accountId: 1,
      workspaceId: scope.workspaceId,
      authorUserId: vouchedId,
      automated: false,
      role: 'review',
      confidence: 'high',
      source: 'manual',
      identitySource: 'manual',
    })
    .execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('every PR-bearing card kind carries the review standing and the queue', () => {
  it('reaches five kinds, and each of them carries all seven fields', async () => {
    const byPr = await prCards();
    const kinds = new Set<string>();
    let cards = 0;
    for (const list of byPr.values())
      for (const c of list) {
        kinds.add(c.kind);
        cards += 1;
        // The fields, on every kind. A kind that skipped `prRef` would fail here rather than
        // silently shipping a card that says nobody has reviewed the PR.
        expect(typeof c.reviewApprovals, `${c.kind} reviewApprovals`).toBe('number');
        expect(typeof c.reviewChangesRequested, `${c.kind} reviewChangesRequested`).toBe('boolean');
        expect(Array.isArray(c.reviewers), `${c.kind} reviewers`).toBe(true);
        expect(typeof c.reviewerCount, `${c.kind} reviewerCount`).toBe('number');
        expect(c, `${c.kind} reviewDecision`).toHaveProperty('reviewDecision');
        expect(c, `${c.kind} inMergeQueue`).toHaveProperty('inMergeQueue');
        expect(c, `${c.kind} mergeQueueEntryState`).toHaveProperty('mergeQueueEntryState');
        // The cap's own rule, everywhere: chips never exceed the total they are disclosed against.
        expect(c.reviewers.length, `${c.kind} chips ≤ count`).toBeLessThanOrEqual(c.reviewerCount);
      }
    // ⚠ THE ANTI-VACUITY GUARD. Every assertion above is inside a loop; without this the suite
    // would go green on an empty board the day the fixture stops emitting cards.
    expect([...kinds].sort()).toEqual([
      'merge',
      'my_turn',
      'reviewer_routing',
      'stalled_review',
      'untouched_thread',
    ]);
    expect(cards).toBeGreaterThanOrEqual(5);
  });

  it('carries the SAME standing on every card of the same PR', async () => {
    // `stalled` emits three kinds. One `prRef` builder means one answer; three emitters each
    // resolving their own would be three chances to disagree on one screen.
    const cards = (await prCards()).get('stalled')!;
    expect(cards.length).toBeGreaterThan(1);
    const distinct = new Set(cards.map((c) => JSON.stringify(c.reviewers)));
    expect(distinct.size).toBe(1);
  });
});

describe('the reviewer chips', () => {
  it('⚠ rank by standing, humans before bots — never by the clock', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    // changes_requested → approved → commented → dismissed, and inside each tier a person before
    // a bot. Reading straight down the timestamps would instead have led with `acme-ci-runner`
    // (6h ago) and pushed alice's approval off the bottom of the cap.
    expect(card.reviewers.map(chip)).toEqual([
      ['bob-dev', 'changes_requested', false, null],
      ['acme-ci-runner', 'changes_requested', true, null],
      ['alice-dev', 'approved', false, null],
      ['coderabbitai[bot]', 'approved', true, 'coderabbit'],
      ['greptile-apps[bot]', 'commented', false, null],
    ]);
  });

  it('⚠ cap at five and disclose the real total, including the reviewer it cannot name', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    expect(card.reviewers).toHaveLength(5);
    // Eight standings: seven nameable + one on a deleted account. The 'pending' draft is not a
    // standing and is not among them.
    expect(card.reviewerCount).toBe(8);
    // The unnameable one is absent from the chips — a chip with no name says nothing — while
    // still inside the total above.
    expect(card.reviewers.every((r) => r.userId != null)).toBe(true);
  });

  it('⚠ resolves a reviewer through the SAME union as the author, in both directions', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    const by = new Map(card.reviewers.map((r) => [loginByUserId.get(r.userId)!, r]));
    // The vendor login, with `users.isBot` FALSE on the row: the login seed is what catches it —
    // the half a fold spelled `users.isBot` alone would miss.
    expect([by.get('coderabbitai[bot]')!.isBot, by.get('coderabbitai[bot]')!.botKind]).toEqual([
      true,
      'coderabbit',
    ]);
    // ⚠ The direction that matters most: this login is in the review-bot table AND flagged
    // `users.isBot`, and a person in this workspace has said otherwise. Any classifier that
    // consulted the login would paint a Greptile chip on a colleague.
    expect([by.get('greptile-apps[bot]')!.isBot, by.get('greptile-apps[bot]')!.botKind]).toEqual([
      false,
      null,
    ]);
    // ⚠ `isBot: true` with a NULL kind is real and common — an unbranded CI account. The server
    // must not invent a brand for it, and must not drop the flag for want of one.
    expect([by.get('acme-ci-runner')!.isBot, by.get('acme-ci-runner')!.botKind]).toEqual([
      true,
      null,
    ]);
    // The negative control the whole flag exists to leave alone.
    expect([by.get('bob-dev')!.isBot, by.get('bob-dev')!.botKind]).toEqual([false, null]);
  });

  it('dates a standing by the review that SET it, not by later activity', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    const alice = card.reviewers.find((r) => loginByUserId.get(r.userId) === 'alice-dev')!;
    expect(Date.parse(alice.standingAt)).toBe(now - 5 * DAY);
  });
});

describe('the counts beside the chips', () => {
  it('are folded from the same rows the chips are', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    // alice + coderabbit + the deleted account. The dismissal and the two comments count as
    // nothing, exactly as they did before the chips existed.
    expect(card.reviewApprovals).toBe(3);
    // ⚠ Approvals and a block COEXIST. The card leads with the block; it does not get to delete
    // the three approvals to say so.
    expect(card.reviewChangesRequested).toBe(true);
  });

  it('⚠ keeps GitHub’s verdict beside ours when the two disagree', async () => {
    const card = (await oneCardPerPr()).get('ranked')!;
    // GitHub says the protection rule is satisfied; our fold says bob is blocking. Merging these
    // into one field would pick a winner silently.
    expect(card.reviewDecision).toBe('approved');
    expect(card.reviewChangesRequested).toBe(true);
  });

  it('⚠ a null reviewDecision is "this repo requires no review", never "nobody looked"', async () => {
    const card = (await oneCardPerPr()).get('unobserved')!;
    expect(card.reviewDecision).toBeNull();
    // The separate fact, carried separately. ~90% of open non-draft PRs are in exactly this state.
    expect(card.reviewerCount).toBe(0);
    expect(card.reviewers).toEqual([]);
    expect(card.reviewApprovals).toBe(0);
    expect(card.reviewChangesRequested).toBe(false);
  });
});

describe('the merge queue', () => {
  it('⚠ preserves an unobserved queue as null — never coerced to false', async () => {
    const card = (await oneCardPerPr()).get('unobserved')!;
    expect(card.inMergeQueue).toBeNull();
    expect(card.mergeQueueEntryState).toBeNull();
  });

  it('carries membership and the ejection state on a queued PR', async () => {
    const card = (await oneCardPerPr()).get('queued')!;
    expect(card.inMergeQueue).toBe(true);
    // The value that earns the column: GitHub is ejecting the entry because its checks failed,
    // and this is the only warning a reader gets that the PR has fallen out of the queue.
    expect(card.mergeQueueEntryState).toBe('unmergeable');
  });

  it('says false when GitHub said false', async () => {
    // A positive statement from GitHub, distinct from the null above at the type level and on
    // screen. Written on the `ranked` fixture via the same column the sync writes.
    const { pullRequests } = schema;
    const { eq } = await import('drizzle-orm');
    await db
      .update(pullRequests)
      .set({ inMergeQueue: false, mergeQueueEntryState: null })
      .where(eq(pullRequests.id, prIdByKey.get('ranked')!))
      .execute();
    const card = (await oneCardPerPr()).get('ranked')!;
    expect(card.inMergeQueue).toBe(false);
  });
});
