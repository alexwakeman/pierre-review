// MY TURN — THE FIXED SHAPE AND ITS ONE SWITCH, on a THROWAWAY sqlite DB (the my-turn-ball.test.ts
// pattern). Everything is applied INSIDE `getMyTurn`, so every assertion here is about a
// population — the list, its totals, the brief, the board's order — and not about a filter
// somebody applies on screen.
//
// WHAT THIS PINS, and why each is a real defect rather than a restatement of the code:
//   1. THE SURVEY ("Also show new PRs nobody asked you about") is the one switch, OFF by default.
//      Old stored type switches, orders and weights are IGNORED.
//   2. THE SUMMONSES ARE HUMAN-ONLY AND RELATED. A reply to YOUR comment, a comment right after
//      YOUR PR comment or YOUR review with a body, a person's @mention — never a bot of either kind
//      (including one only GitHub's type says is a bot), and never "anything after me". A DRAFT
//      never summons.
//   3. YOUR OWN WORK IS ALWAYS IN MY TURN AND MOVES, IT NEVER COPIES. No PR or thread is ever both
//      an own-work my_turn card and its home card, and capped and uncapped `kindTotals` agree. A red
//      default branch is never a My Turn card: it stays in Needs fixing.
//   4. THE REMOVED TYPES (`your_pr`, `claude_review`, `ai_approved_merged`) never appear.
//   5. A MUTED REPOSITORY LEAVES MY TURN, from the list and every count.
//   6. THE BOARD LISTS MY TURN IN ITS FIXED GROUPS, longest waiting first, "Older" last; every other
//      tab scores with the fixed weights; a promoted card keeps its home plan id.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, MyTurnCard, PendingCardScore } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-my-turn-settings-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let eq: any;
let setMyTurnSettings: (id: number, s: { showNewPrs: boolean }) => Promise<unknown>;
let scope: { workspaceId: number; repoIds: number[] };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const ago = (ms: number) => new Date(now - ms);

let viewerId = 0;
let aliceId = 0;
let bobId = 0;
let botId = 0;
/** A GitHub App account `users.isBot` misses (google-cla, socket-security…): is_bot 0, type Bot. */
let typedBotId = 0;
let writeRepo = 0;
let readRepo = 0;
const pr = new Map<string, number>();
const thread = new Map<string, number>();
let n = 1;
let seq = 1;

const P = (key: string): number => {
  const id = pr.get(key);
  if (id == null) throw new Error(`no fixture PR ${key}`);
  return id;
};
const T = (key: string): number => {
  const id = thread.get(key);
  if (id == null) throw new Error(`no fixture thread ${key}`);
  return id;
};

async function mkPr(
  key: string,
  o: {
    repo?: number;
    author?: number | null;
    state?: 'open' | 'merged' | 'closed';
    ci?: 'failure' | 'success';
    mss?: string;
    mergeable?: string;
    dependencyVendor?: string;
    headRefName?: string;
    draft?: boolean;
    openedAgo?: number;
  } = {},
): Promise<number> {
  const repoId = o.repo ?? writeRepo;
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_mts_${key}`,
      accountId: 1,
      repoId,
      number: n++,
      title: `${key} fixture`,
      authorId: o.author === undefined ? aliceId : o.author,
      state: o.state ?? 'open',
      isDraft: o.draft ?? false,
      ciStatus: o.ci ?? null,
      mergeStateStatus: o.mss ?? null,
      mergeable: o.mergeable ?? null,
      baseRefName: 'main',
      dependencyVendor: o.dependencyVendor ?? null,
      headRefName: o.headRefName ?? null,
      lastCommitAt: ago(2 * DAY),
      openedAt: ago(o.openedAgo ?? 5 * DAY),
      updatedAt: ago(DAY),
    })
    .returning()
    .execute();
  // A real activity event inside the 90-day window — the board's "not abandoned" gate, which the
  // own-work promotions share with their home cards.
  await db
    .insert(schema.events)
    .values({
      accountId: 1,
      repoId,
      prId: row.id,
      type: 'pr_opened',
      occurredAt: ago(5 * DAY),
      dedupeKey: `pr_opened:PR_mts_${key}`,
    })
    .execute();
  pr.set(key, row.id);
  return row.id;
}

async function comment(prId: number, authorId: number, at: number, body = 'a comment'): Promise<number> {
  const [row] = await db
    .insert(schema.prComments)
    .values({ prId, githubNodeId: `IC_mts_${seq++}`, authorId, body, createdAt: new Date(at) })
    .returning()
    .execute();
  return row.id;
}

async function review(
  prId: number,
  authorId: number,
  state: string,
  at: number,
  body: string | null = null,
): Promise<number> {
  const [row] = await db
    .insert(schema.reviews)
    .values({ prId, githubNodeId: `RV_mts_${seq++}`, authorId, state, body, submittedAt: new Date(at) })
    .returning()
    .execute();
  return row.id;
}

async function commit(prId: number, authorId: number | null, at: number): Promise<void> {
  await db
    .insert(schema.commits)
    .values({ sha: `sha_mts_${seq++}`, prId, authorId, committedAt: new Date(at) })
    .execute();
}

async function mkThread(
  key: string,
  prId: number,
  originator: number,
  createdAt: number,
  derivedState = 'replied_unresolved',
): Promise<number> {
  const [row] = await db
    .insert(schema.reviewThreads)
    .values({
      prId,
      githubNodeId: `RT_mts_${key}`,
      path: `src/${key}.ts`,
      isResolved: derivedState === 'resolved',
      derivedState,
      originalCommenterId: originator,
      createdAt: new Date(createdAt),
    })
    .returning()
    .execute();
  thread.set(key, row.id);
  await threadComment(row.id, prId, originator, createdAt);
  return row.id;
}

async function threadComment(threadId: number, prId: number, authorId: number, at: number): Promise<number> {
  const [row] = await db
    .insert(schema.reviewComments)
    .values({
      prId,
      threadId,
      githubNodeId: `RC_mts_${seq++}`,
      authorId,
      body: 'a thread comment',
      createdAt: new Date(at),
    })
    .returning()
    .execute();
  return row.id;
}

async function mention(prId: number, at: number | null, byId: number | null, repoId = writeRepo) {
  await db
    .insert(schema.prMentions)
    .values({
      accountId: 1,
      repoId,
      prId,
      login: 'viewer',
      mentionedAt: at == null ? null : new Date(at),
      mentionedByUserId: byId,
    })
    .execute();
}

/** Run `fn` with the survey switched on, and put the default back whatever happens. */
async function withSurvey<T>(fn: () => Promise<T>): Promise<T> {
  await setMyTurnSettings(1, { showNewPrs: true });
  try {
    return await fn();
  } finally {
    await setMyTurnSettings(1, { showNewPrs: false });
  }
}

/** Write a raw stored value, as an older version of Limn left it. */
async function storeRaw(value: unknown): Promise<void> {
  await db.update(schema.accounts).set({ myTurnSettings: value }).where(eq(schema.accounts.id, 1)).execute();
}

const fold = (uncapped = true) => q.getWorkspaceInsights(1, undefined, scope, { uncapped });
const myTurnCards = (cards: InsightCard[]) =>
  cards.filter((c): c is MyTurnCard => c.kind === 'my_turn');
const ids = (cards: InsightCard[]) => new Set(cards.map((c) => c.id));

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
  ({ setMyTurnSettings } = await import('../auth/account.js'));
  const { accounts, users, repos, reviewRequests, branchCommits } = schema;

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId return
  // null and getMyTurn short-circuit — every assertion below would then be vacuously true.
  await db.update(accounts).set({ githubLogin: 'viewer' }).where(eq(accounts.id, 1)).execute();
  const user = async (login: string, extra: Record<string, unknown> = {}) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_mts_${login}`, isBot: false, ...extra })
        .returning()
        .execute()
    )[0].id as number;
  viewerId = await user('viewer');
  aliceId = await user('alice');
  bobId = await user('bob');
  botId = await user('dependabot[bot]', { isBot: true });
  typedBotId = await user('google-cla', { githubType: 'Bot' });

  const repo = async (name: string, perm: string, sha: string) =>
    (
      await db
        .insert(repos)
        .values({
          accountId: 1,
          owner: 'acme',
          name,
          githubNodeId: `R_mts_${name}`,
          viewerPermission: perm,
          defaultBranch: 'main',
          defaultBranchName: 'main',
          defaultBranchHeadSha: sha,
          defaultBranchCiStatus: 'failure',
          defaultBranchUpdatedAt: ago(HOUR),
          createdAt: new Date(REPO_ADDED),
        })
        .returning()
        .execute()
    )[0].id as number;
  // Both default branches are RED. Only the WRITE one is "a repo you maintain", so only it has a
  // home ci_failing trunk card — the READ one reaches My Turn only under trunkScope 'all'.
  writeRepo = await repo('api', 'WRITE', 'shaWRITE000000000000000000000000000000000');
  readRepo = await repo('docs', 'READ', 'shaREAD0000000000000000000000000000000000');

  // ── S2: an untouched stranger's PR (a "New PR") ─────────────────────────────────────────
  await mkPr('untouched', { repo: readRepo });

  // ── S3c: pushed since you reviewed ─────────────────────────────────────────────────────
  await review(await mkPr('pushed'), viewerId, 'commented', now - 3 * DAY);
  await commit(P('pushed'), aliceId, now - 5 * HOUR);
  await review(await mkPr('bot-pushed'), viewerId, 'commented', now - 3 * DAY);
  await commit(P('bot-pushed'), botId, now - 5 * HOUR);
  await review(await mkPr('typed-bot-pushed'), viewerId, 'commented', now - 3 * DAY);
  await commit(P('typed-bot-pushed'), typedBotId, now - 5 * HOUR);
  // A PR OPENED before the repo was added: the floor applies to the COMMITS, not the PR's age.
  await review(await mkPr('pushed-old-pr', { openedAgo: 60 * DAY }), viewerId, 'commented', now - 3 * DAY);
  await commit(P('pushed-old-pr'), aliceId, now - 4 * HOUR);
  // …and one whose only commits after your review are from before the floor: history.
  await review(await mkPr('pushed-old-commits', { openedAgo: 60 * DAY }), viewerId, 'commented', now - 50 * DAY);
  await commit(P('pushed-old-commits'), aliceId, now - 40 * DAY);

  // ── S3d: a reply to YOUR comment in somebody else's thread ────────────────────────────────
  const other = await mkThread('other', await mkPr('other-thread'), bobId, now - 2 * DAY);
  await threadComment(other, P('other-thread'), viewerId, now - DAY);
  await threadComment(other, P('other-thread'), aliceId, now - 3 * HOUR);
  const botAfter = await mkThread('bot-after', await mkPr('bot-after-thread'), bobId, now - 2 * DAY);
  await threadComment(botAfter, P('bot-after-thread'), viewerId, now - DAY);
  await threadComment(botAfter, P('bot-after-thread'), botId, now - 3 * HOUR);
  // Every comment predates the repo being ADDED — the onboarding floor.
  const old = await mkThread('old', await mkPr('old-thread'), bobId, now - 50 * DAY);
  await threadComment(old, P('old-thread'), viewerId, now - 45 * DAY);
  await threadComment(old, P('old-thread'), aliceId, now - 40 * DAY);

  // ── S3a: threads YOU opened — a bot's word is never the last word ─────────────────────────
  const human = await mkThread('own-human', await mkPr('own-thread-human'), viewerId, now - 2 * DAY);
  await threadComment(human, P('own-thread-human'), aliceId, now - DAY);
  await threadComment(human, P('own-thread-human'), botId, now - 2 * HOUR);
  const botOnly = await mkThread('own-bot-only', await mkPr('own-thread-bot'), viewerId, now - 2 * DAY);
  await threadComment(botOnly, P('own-thread-bot'), botId, now - DAY);

  // ── S5: a comment right after YOUR PR comment ────────────────────────────────────────────
  await comment(await mkPr('comment-reply'), viewerId, now - DAY);
  await comment(P('comment-reply'), aliceId, now - 4 * HOUR, 'Thanks — could you also check the migration?');
  await comment(P('comment-reply'), bobId, now - 3 * HOUR);
  // A review with NO body is not something to answer…
  await review(await mkPr('review-then-comment'), viewerId, 'commented', now - DAY);
  await comment(P('review-then-comment'), aliceId, now - 4 * HOUR);
  // …a review WITH a body is: the next person's PR comment answers it.
  await review(await mkPr('review-body-then-comment'), viewerId, 'changes_requested', now - DAY, 'Please split this.');
  await comment(P('review-body-then-comment'), aliceId, now - 4 * HOUR, 'Split into two PRs.');
  await comment(await mkPr('bot-comment-after'), viewerId, now - DAY);
  await comment(P('bot-comment-after'), botId, now - 4 * HOUR);
  await comment(await mkPr('typed-bot-comment'), viewerId, now - DAY);
  await comment(P('typed-bot-comment'), typedBotId, now - 4 * HOUR);
  // The onboarding floor: a reply from before the repo was added is history, not a summons…
  await comment(await mkPr('comment-reply-old'), viewerId, now - 45 * DAY);
  await comment(P('comment-reply-old'), aliceId, now - 40 * DAY);
  // …so when a newer reply follows it, the card is clocked at the newer one.
  await comment(await mkPr('comment-reply-straddle'), viewerId, now - 45 * DAY);
  await comment(P('comment-reply-straddle'), aliceId, now - 40 * DAY);
  await comment(P('comment-reply-straddle'), bobId, now - 2 * DAY, 'Picking this back up.');

  // ── S6: @mentions (the scanner's rows, stamped directly) ─────────────────────────────────
  await mention(await mkPr('mentioned'), now - 2 * HOUR, aliceId);
  await mention(await mkPr('mention-null'), null, null);
  await mention(await mkPr('mention-closed', { state: 'closed' }), now - 2 * HOUR, aliceId);
  await mention(await mkPr('mention-old'), now - 40 * DAY, aliceId);

  // ── DRAFTS never summon: a review request, a mention, a comment after yours, a thread reply ──
  await mkPr('draft-req', { draft: true });
  await db.insert(schema.reviewRequests).values({ prId: P('draft-req'), userId: viewerId }).execute();
  await mention(await mkPr('draft-mention', { draft: true }), now - 2 * HOUR, aliceId);
  await comment(await mkPr('draft-comment', { draft: true }), viewerId, now - DAY);
  await comment(P('draft-comment'), aliceId, now - 4 * HOUR);
  const draftThread = await mkThread('draft-thread', await mkPr('draft-thread-pr', { draft: true }), viewerId, now - 2 * DAY);
  await threadComment(draftThread, P('draft-thread-pr'), aliceId, now - DAY);

  // ── OLDER: a review asked of you 20 days ago (its clock is the PR's open time here) ───────
  await mkPr('old-request', { openedAgo: 20 * DAY });
  await db.insert(schema.reviewRequests).values({ prId: P('old-request'), userId: viewerId }).execute();

  // ── Precedence: a review request AND a mention on one PR ─────────────────────────────────
  await mkPr('req-and-mention');
  await db.insert(reviewRequests).values({ prId: P('req-and-mention'), userId: viewerId }).execute();
  await mention(P('req-and-mention'), now - HOUR, aliceId);

  // ── OWN WORK in the WRITE repo, and its home cards ───────────────────────────────────────
  await mkPr('own-red', { author: viewerId, ci: 'failure', mss: 'blocked', mergeable: 'mergeable' });
  await mkPr('own-conflict', { author: viewerId, ci: 'success', mss: 'dirty', mergeable: 'conflicting' });
  await mkPr('own-ready', { author: viewerId, ci: 'success', mss: 'clean', mergeable: 'mergeable' });
  await review(P('own-ready'), bobId, 'approved', now - 6 * HOUR);
  // …and you last opened it BEFORE that approval: it once made a "new activity on your PR" card,
  // a type that no longer exists.
  await db.insert(schema.prViews).values({ prId: P('own-ready'), lastViewedAt: ago(12 * HOUR) }).execute();
  await db
    .insert(schema.events)
    .values({
      accountId: 1,
      repoId: writeRepo,
      prId: P('own-ready'),
      type: 'review_submitted',
      occurredAt: ago(6 * HOUR),
      dedupeKey: 'review_submitted:PR_mts_own-ready',
    })
    .execute();
  await mkPr('own-behind', { author: viewerId, ci: 'success', mss: 'behind', mergeable: 'mergeable' });
  // An unanswered thread on your own PR, older than the tab's one-day floor.
  await mkThread('own-untouched', P('own-red'), aliceId, now - 30 * HOUR, 'untouched');
  // ⚠ A DEPENDENCY TOOL'S MARKER under your own login (a Snyk fix pushed with your token): a
  // dependency PR, listed in Dependencies — never promoted, even with its red build.
  await mkPr('own-snyk', {
    author: viewerId,
    ci: 'failure',
    mss: 'blocked',
    mergeable: 'mergeable',
    dependencyVendor: 'snyk',
    headRefName: 'snyk-fix-abc123',
  });

  // The READ repo's red head was landed by a Dependabot PR — the trunk card's author fields.
  await mkPr('landing', { repo: readRepo, author: botId, state: 'merged' });
  const [landing] = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.id, P('landing')))
    .execute();
  await db
    .insert(branchCommits)
    .values({
      accountId: 1,
      repoId: readRepo,
      sha: 'shaREAD0000000000000000000000000000000000',
      messageHeadline: 'Bump x',
      committedAt: ago(2 * HOUR),
      ciStatus: 'failure',
      prNumber: landing.number,
    })
    .execute();

  await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the one switch: "Also show new PRs nobody asked you about"', () => {
  it('leaves an untouched stranger PR out — until the survey is switched on', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.watchedRepoPrs).toEqual([]);
    expect(mt.off).toEqual(['watched_repo_pr']);
    await withSurvey(async () => {
      const on = await q.getMyTurn(1, scope);
      expect(on.watchedRepoPrs.map((r: { prId: number }) => r.prId)).toContain(P('untouched'));
      expect(on.off).toEqual([]);
      expect(on.configKey).not.toBe(mt.configKey);
    });
  });

  it('ignores an older stored blob’s type switches, order and weights', async () => {
    const before = await fold();
    try {
      await storeRaw({
        show: { review_request: false, own_ci_red: false, mention: false },
        order: ['pushed_since', 'mention'],
        weights: { proximity: 30, stall: 10, relevance: 60 },
      });
      const after = await fold();
      expect(after.kindTotals.my_turn).toBe(before.kindTotals.my_turn);
      expect(ids(after.cards)).toEqual(ids(before.cards));
      const mt = await q.getMyTurn(1, scope);
      expect(mt.awaitingReview.length).toBeGreaterThan(0);
      const { MY_TURN_ORDER } = await import('@pierre-review/shared');
      expect(mt.order).toEqual([...MY_TURN_ORDER]);
      expect(mt.watchedRepoPrs).toEqual([]);
      // …but an old `show.watched_repo_pr: true` IS the switch.
      await storeRaw({ show: { watched_repo_pr: true }, weights: { proximity: 80, stall: 10, relevance: 10 } });
      expect((await q.getMyTurn(1, scope)).watchedRepoPrs.length).toBeGreaterThan(0);
    } finally {
      await storeRaw(null);
    }
  });
});

describe('the removed types never appear', () => {
  it('no "new activity on your PR", "AI review ready" or "merged after your Limn approved" card', async () => {
    await withSurvey(async () => {
      const reasons = new Set(myTurnCards((await fold()).cards).map((c) => c.reason as string));
      for (const gone of ['your_pr', 'claude_review', 'ai_approved_merged']) expect(reasons.has(gone)).toBe(false);
      const mt = await q.getMyTurn(1);
      for (const gone of ['yourPrs', 'claudeReviewsToAction', 'approvedMerged']) expect(mt[gone]).toBeUndefined();
    });
  });
});

describe('pushed since you reviewed (S3c)', () => {
  const pushed = async () =>
    new Set((await q.getMyTurn(1, scope)).pushedSince.map((r: { prId: number }) => r.prId));

  it('is its own DIRECT type, and only a person pushing makes it', async () => {
    const mt = await q.getMyTurn(1, scope);
    const row = mt.pushedSince.find((r: { prId: number }) => r.prId === P('pushed'));
    expect(row?.relevance).toBe('direct');
    const cards = myTurnCards((await fold()).cards);
    const card = cards.find((c) => c.id === `myturn:pushed_since:${P('pushed')}`) as MyTurnCard;
    expect(card?.reason).toBe('pushed_since');
    expect(card?.relevance).toBe('direct');
    // A bot push never returns the ball — including a bot only GitHub's type knows about.
    const p = await pushed();
    expect(p.has(P('bot-pushed'))).toBe(false);
    expect(p.has(P('typed-bot-pushed'))).toBe(false);
  });

  it('fires on a PR opened BEFORE the repo was added when the commits are after it', async () => {
    const mt = await q.getMyTurn(1, scope);
    const row = mt.pushedSince.find((r: { prId: number }) => r.prId === P('pushed-old-pr'));
    expect(row).toBeDefined();
    expect(row.ball.humanCommitsAfter).toBe(1);
    expect(Date.parse(row.since)).toBe(now - 4 * HOUR);
  });

  it('never for commits from before the repo was added', async () => {
    expect((await pushed()).has(P('pushed-old-commits'))).toBe(false);
  });
});

describe('a reply to your comment in somebody else\'s thread (S3d)', () => {
  const replies = async () =>
    new Set((await q.getMyTurn(1, scope)).threadReplies.map((t: { threadId: number }) => t.threadId));

  it('summons you when a person answers after your comment', async () => {
    const mt = await q.getMyTurn(1, scope);
    const t = mt.threadReplies.find((x: { threadId: number }) => x.threadId === T('other'));
    expect(t?.lastReplyAuthorId).toBe(aliceId);
    expect(t?.relevance).toBe('direct');
    const card = myTurnCards((await fold()).cards).find((c) => c.id === `myturn:thread_reply:${T('other')}`);
    expect(card?.detail).toMatch(/^@alice replied to your comment /);
  });

  it('never for a bot answering, and never from before the repo was added', async () => {
    const r = await replies();
    expect(r.has(T('bot-after'))).toBe(false);
    expect(r.has(T('old'))).toBe(false);
  });

  it('clears when you reply, when the thread is resolved, and when the PR merges', async () => {
    const mine = await threadComment(T('other'), P('other-thread'), viewerId, now - HOUR);
    expect((await replies()).has(T('other'))).toBe(false);
    await db.delete(schema.reviewComments).where(eq(schema.reviewComments.id, mine)).execute();
    expect((await replies()).has(T('other'))).toBe(true);

    await db
      .update(schema.reviewThreads)
      .set({ derivedState: 'resolved' })
      .where(eq(schema.reviewThreads.id, T('other')))
      .execute();
    expect((await replies()).has(T('other'))).toBe(false);
    await db
      .update(schema.reviewThreads)
      .set({ derivedState: 'replied_unresolved' })
      .where(eq(schema.reviewThreads.id, T('other')))
      .execute();

    await db
      .update(schema.pullRequests)
      .set({ state: 'merged' })
      .where(eq(schema.pullRequests.id, P('other-thread')))
      .execute();
    expect((await replies()).has(T('other'))).toBe(false);
    await db
      .update(schema.pullRequests)
      .set({ state: 'open' })
      .where(eq(schema.pullRequests.id, P('other-thread')))
      .execute();
    expect((await replies()).has(T('other'))).toBe(true);
  });
});

describe('threads you opened (S3a) — the last HUMAN word', () => {
  it('keeps a person\'s reply as the reply when a bot posts after it', async () => {
    const mt = await q.getMyTurn(1, scope);
    const t = mt.threadsAwaiting.find((x: { threadId: number }) => x.threadId === T('own-human'));
    expect(t?.awaitingKind).toBe('reply');
    // ⚠ Not the bot. A card naming the bot as the reply would summon you to answer a bot.
    expect(t?.lastReplyAuthorId).toBe(aliceId);
  });

  it('shows nothing when only a bot has answered you', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.threadsAwaiting.some((x: { threadId: number }) => x.threadId === T('own-bot-only'))).toBe(false);
  });
});

describe('a comment after your PR comment or review (S5)', () => {
  const byPr = async () =>
    new Map<number, any>((await q.getMyTurn(1, scope)).commentReplies.map((r: any) => [r.prId, r]));

  it('summons you, clocked at the FIRST person\'s comment after yours', async () => {
    const r = (await byPr()).get(P('comment-reply'));
    expect(r?.replyAuthorId).toBe(aliceId);
    expect(Date.parse(r?.since)).toBe(now - 4 * HOUR);
    expect(r?.replyExcerpt).toBe('Thanks — could you also check the migration?');
    expect(r?.relevance).toBe('direct');
  });

  it('after a review WITH a body, too', async () => {
    const r = (await byPr()).get(P('review-body-then-comment'));
    expect(r?.replyAuthorId).toBe(aliceId);
    expect(r?.replyExcerpt).toBe('Split into two PRs.');
  });

  it('never after a review with no body, and only for a person', async () => {
    const m = await byPr();
    expect(m.has(P('review-then-comment'))).toBe(false);
    expect(m.has(P('bot-comment-after'))).toBe(false);
    // ⚠ The GLOBAL automation set: this account is `is_bot = 0`, GitHub types it a Bot.
    expect(m.has(P('typed-bot-comment'))).toBe(false);
  });

  it('never from before the repo was added — and clocks a later reply at the later one', async () => {
    const m = await byPr();
    expect(m.has(P('comment-reply-old'))).toBe(false);
    const r = m.get(P('comment-reply-straddle'));
    expect(r?.replyAuthorId).toBe(bobId);
    expect(Date.parse(r?.since)).toBe(now - 2 * DAY);
    expect(r?.replyExcerpt).toBe('Picking this back up.');
  });

  it('clears the moment you act on the PR in any way', async () => {
    const id = await review(P('comment-reply'), viewerId, 'commented', now - HOUR);
    expect((await byPr()).has(P('comment-reply'))).toBe(false);
    await db.delete(schema.reviews).where(eq(schema.reviews.id, id)).execute();
    expect((await byPr()).has(P('comment-reply'))).toBe(true);
  });
});

describe('@mentions (S6)', () => {
  const byPr = async () =>
    new Map<number, any>((await q.getMyTurn(1, scope)).mentions.map((r: any) => [r.prId, r]));

  it('summons you on an open PR, clocked at the mention', async () => {
    const m = (await byPr()).get(P('mentioned'));
    expect(m?.mentionedById).toBe(aliceId);
    expect(Date.parse(m?.since)).toBe(now - 2 * HOUR);
    const card = myTurnCards((await fold()).cards).find((c) => c.id === `myturn:mention:${P('mentioned')}`);
    expect(card?.detail).toMatch(/^@alice mentioned you /);
  });

  it('never for an unstamped row, a closed PR, or a mention from before the repo was added', async () => {
    const m = await byPr();
    expect(m.has(P('mention-null'))).toBe(false);
    expect(m.has(P('mention-closed'))).toBe(false);
    expect(m.has(P('mention-old'))).toBe(false);
  });

  it('clears when you act after the mention', async () => {
    const id = await comment(P('mentioned'), viewerId, now - HOUR);
    expect((await byPr()).has(P('mentioned'))).toBe(false);
    await db.delete(schema.prComments).where(eq(schema.prComments.id, id)).execute();
    expect((await byPr()).has(P('mentioned'))).toBe(true);
  });
});

describe('a draft never summons', () => {
  it('no review request, mention, comment reply or thread reply on a draft — even with the survey on', async () => {
    await withSurvey(async () => {
      const mt = await q.getMyTurn(1);
      const prIds = new Set<number>();
      for (const key of ['awaitingReview', 'mentions', 'commentReplies', 'pushedSince', 'watchedRepoPrs', 'threadsAwaiting']) {
        for (const r of mt[key]) prIds.add(r.prId);
      }
      for (const d of ['draft-req', 'draft-mention', 'draft-comment', 'draft-thread-pr']) {
        expect([d, prIds.has(P(d))]).toEqual([d, false]);
      }
      // Non-vacuity: the same shapes on non-draft PRs do summon.
      expect(prIds.has(P('req-and-mention'))).toBe(true);
      expect(prIds.has(P('comment-reply'))).toBe(true);
      expect(prIds.has(P('own-thread-human'))).toBe(true);
    });
  });
});

describe('one PR, one summons', () => {
  it('lists a review request that is also a mention ONCE, as the review request', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.awaitingReview.map((r: { prId: number }) => r.prId)).toContain(P('req-and-mention'));
    expect(mt.mentions.some((r: { prId: number }) => r.prId === P('req-and-mention'))).toBe(false);
  });
});

describe('your own PRs are always in My Turn, and MOVE out of their home tab', () => {
  const cases = () => [
    { mine: [`myturn:own_ci_red:${P('own-red')}`], home: [`cifail:pr:${P('own-red')}`] },
    { mine: [`myturn:own_conflicts:${P('own-conflict')}`], home: [`conflicts:${P('own-conflict')}`] },
    {
      mine: [`myturn:own_ready:${P('own-ready')}`, `myturn:own_ready:${P('own-behind')}`],
      home: [`wp:merge:${P('own-ready')}`, `wp:update_branch:${P('own-behind')}`],
    },
  ];

  it('each own-work card is in My turn and its home card is not', async () => {
    const c = ids((await fold()).cards);
    for (const x of cases()) {
      for (const id of x.mine) expect([id, c.has(id)]).toEqual([id, true]);
      for (const id of x.home) expect([id, c.has(id)]).toEqual([id, false]);
    }
    // The unanswered thread sits on the red PR: one card per PR, so the build failure (higher in
    // the fixed order) is My turn's card and the thread stays in Unanswered threads — exactly one.
    const mine = `myturn:own_thread:${T('own-untouched')}`;
    const home = `thread:${T('own-untouched')}`;
    expect(c.has(mine) !== c.has(home)).toBe(true);
    expect(c.has(home)).toBe(true);
  });

  it('own_ready replaces the approval card for the same PR — one job, one card', async () => {
    const c = await fold();
    const mine = myTurnCards(c.cards)
      .filter((x) => (x as MyTurnCard).prId === P('own-ready'))
      .map((x) => x.reason);
    expect(mine).toEqual(['own_ready']);
    const card = c.cards.find((x: InsightCard) => x.id === `myturn:own_ready:${P('own-ready')}`);
    expect(card.own).toMatchObject({ kind: 'ready', forward: 'merge', viewerCanPush: true });
  });

  it('red trunk: never a My Turn card — the home card stays in Needs fixing', async () => {
    const homeW = `cifail:trunk:${writeRepo}:shaWRITE000000000000000000000000000000000`;
    const c = (await fold()).cards as InsightCard[];
    expect(ids(c).has(homeW)).toBe(true);
    expect(c.some((x) => x.id.startsWith('myturn:trunk_red:'))).toBe(false);
  });

  it('never lists one thing twice — capped and not', async () => {
    const uncapped = await fold(true);
    const capped = await fold(false);
    expect(capped.kindTotals).toEqual(uncapped.kindTotals);
    for (const f of [uncapped, capped]) {
      const cards = f.cards as InsightCard[];
      const promotedPr = new Set(
        myTurnCards(cards)
          .filter((c) => ['own_ci_red', 'own_conflicts', 'own_ready'].includes(c.reason))
          .map((c) => (c as MyTurnCard).prId),
      );
      const homePr = new Set(
        cards
          .filter(
            (c) =>
              (c.kind === 'ci_failing' && c.arm === 'your_pr') ||
              c.kind === 'conflicts' ||
              c.kind === 'merge' ||
              c.kind === 'update_branch',
          )
          .map((c: any) => c.prId),
      );
      for (const id of [P('own-red'), P('own-conflict'), P('own-ready'), P('own-behind')]) {
        expect([id, promotedPr.has(id), homePr.has(id)]).toEqual([id, true, false]);
      }
    }
  });

  it('never promotes a PR carrying a dependency tool\'s marker, though your token opened it', async () => {
    const c = ids((await fold()).cards);
    expect(c.has(`myturn:own_ci_red:${P('own-snyk')}`)).toBe(false);
    expect(c.has(`cifail:pr:${P('own-snyk')}`)).toBe(false);
    // Its one card is the Dependencies card.
    expect(c.has(`deps:${P('own-snyk')}`) || c.has(`security:${P('own-snyk')}`)).toBe(true);
  });
});

describe('the Pending mute removes a repository from My Turn', () => {
  it('drops every row of the muted repo from the list and every count — and gives it back', async () => {
    const mute = await import('./pending-mute.js');
    const brief = await import('./daily-brief.js');
    const before = await fold();
    const inWrite = myTurnCards(before.cards).filter((c) => (c as MyTurnCard).repoId === writeRepo).length;
    // Non-vacuity: the WRITE repo holds My Turn cards, own work included.
    expect(inWrite).toBeGreaterThan(3);
    await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [writeRepo] });
    try {
      brief.clearDailyBriefCache();
      const after = await fold();
      expect(myTurnCards(after.cards).filter((c) => (c as MyTurnCard).repoId === writeRepo)).toEqual([]);
      expect(after.kindTotals.my_turn ?? 0).toBe(before.kindTotals.my_turn - inWrite);
      expect(after.myTurnTotal ?? 0).toBe(before.myTurnTotal - inWrite);
      expect(after.myTurnPersonalTotal ?? 0).toBe(before.myTurnPersonalTotal - inWrite);
      // The account-wide call — what the notification watcher reads — obeys it too.
      const mt = await q.getMyTurn(1);
      expect(mt.ownCiRed.some((r: { prId: number }) => r.prId === P('own-red'))).toBe(false);
      expect(mt.threadReplies.some((t: { threadId: number }) => t.threadId === T('other'))).toBe(false);
      // Other tabs are not muted: your own red build goes back to Needs fixing.
      expect(ids(after.cards).has(`cifail:pr:${P('own-red')}`)).toBe(true);
    } finally {
      await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [] });
      brief.clearDailyBriefCache();
    }
    expect((await fold()).kindTotals.my_turn).toBe(before.kindTotals.my_turn);
  });
});

describe('the daily brief', () => {
  it('lists every red trunk on the red-trunk line — none is a My Turn card', async () => {
    const brief = await import('./daily-brief.js');
    const counts = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
    expect(counts.trunkRed.map((t: { repoId: number }) => t.repoId).sort()).toEqual([writeRepo, readRepo].sort());
  });

  it('counts the survey only when it is on, and drops the cached counts on a save', async () => {
    const brief = await import('./daily-brief.js');
    brief.clearDailyBriefCache();
    const off = await brief.getDailyBriefCounts(1, scope.workspaceId);
    await withSurvey(async () => {
      // Without the clear, the five-minute cache still answers with the old population…
      expect((await brief.getDailyBriefCounts(1, scope.workspaceId)).myTurn).toBe(off.myTurn);
      brief.clearDailyBriefCountsFor(1);
      // …and after it, the new one.
      expect((await brief.getDailyBriefCounts(1, scope.workspaceId)).myTurn).toBeGreaterThan(off.myTurn);
    });
    brief.clearDailyBriefCache();
  });
});

describe('the board lists My turn in its fixed groups', () => {
  const board = async () => {
    const f = await fold();
    const tabs = await import('./pending-tabs.js');
    return { f, ...(await tabs.rankPendingTabs(1, scope, f, now)) };
  };

  it('Waiting on you, Re-review, Your PRs, then Older — longest waiting first in each', async () => {
    const { MY_TURN_GROUPS, myTurnGroupOf } = await import('@pierre-review/shared');
    const b = await board();
    const byId = new Map(b.cards.map((c: InsightCard) => [c.id, c]));
    const myTurn = b.tabs.find((t: { key: string }) => t.key === 'my_turn')!;
    const cards = myTurn.cardIds.map((id: string) => byId.get(id) as MyTurnCard);
    const groups = cards.map((c) => MY_TURN_GROUPS.indexOf(myTurnGroupOf(c, now)));
    for (let i = 1; i < cards.length; i++) {
      expect(groups[i - 1]!).toBeLessThanOrEqual(groups[i]!);
      if (groups[i - 1] === groups[i]) {
        expect(Date.parse(cards[i - 1]!.since)).toBeLessThanOrEqual(Date.parse(cards[i]!.since));
      }
    }
    // Every group is present in the fixture (non-vacuity), and the 20-day request is Older, last.
    expect(new Set(groups.map((g) => MY_TURN_GROUPS[g!]))).toEqual(new Set(['waiting', 'rereview', 'yours', 'older']));
    expect(cards[cards.length - 1]!.id).toBe(`myturn:review_request:${P('old-request')}`);
    // Older is still counted.
    expect(myTurn.total).toBe(cards.length);
  });

  it('a card is Older only past 14 days', async () => {
    const { myTurnGroupOf, MY_TURN_OLDER_DAYS } = await import('@pierre-review/shared');
    expect(MY_TURN_OLDER_DAYS).toBe(14);
    const at = (days: number) => new Date(now - days * DAY).toISOString();
    expect(myTurnGroupOf({ reason: 'review_request', since: at(13.9) }, now)).toBe('waiting');
    expect(myTurnGroupOf({ reason: 'review_request', since: at(14.1) }, now)).toBe('older');
    expect(myTurnGroupOf({ reason: 'pushed_since', since: at(1) }, now)).toBe('rereview');
    expect(myTurnGroupOf({ reason: 'own_ci_red', since: at(1) }, now)).toBe('yours');
  });

  it('scores every card with the fixed weights, and says so', async () => {
    const { DO_NEXT_RULES } = await import('@pierre-review/shared');
    const b = await board();
    expect(b.rules.weights).toEqual(DO_NEXT_RULES.weights);
    expect(b.rules.myTurnOff).toEqual(['watched_repo_pr']);
    const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
    const scores = Object.values(b.scores) as PendingCardScore[];
    expect(scores.length).toBeGreaterThan(5);
    for (const s of scores) {
      expect(s.score).toBe(
        round4(
          0.5 * s.proximity +
            0.3 * s.stallRisk +
            0.2 * (DO_NEXT_RULES.relevanceWeight as Record<string, number>)[s.relevance]!,
        ),
      );
    }
  });
});

describe('the work plan keeps a promoted card\'s home row', () => {
  it('keeps your red build as the unblock_ci row, pointing at its my_turn card', async () => {
    const workPlan = await import('./work-plan.js');
    const { candidates } = await workPlan.scoreCards(1, (await fold()).cards, now);
    const row = candidates
      .map((c: { item: any }) => c.item)
      .find((i: { id: string }) => i.id === `wp:unblock_ci:${P('own-red')}`);
    expect(row?.kind).toBe('unblock_ci');
    expect(row?.cardId).toBe(`myturn:own_ci_red:${P('own-red')}`);
  });
});
