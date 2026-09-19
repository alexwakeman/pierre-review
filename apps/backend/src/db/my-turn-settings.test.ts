// MY TURN SETTINGS AND THE NEW SUMMONSES, on a THROWAWAY sqlite DB (the my-turn-ball.test.ts
// pattern). What a reader switches in Settings → My Turn is applied INSIDE `getMyTurn`, so every
// assertion here is about a population — the list, its totals, the brief, the board's order — and
// not about a filter somebody applies on screen.
//
// WHAT THIS PINS, and why each is a real defect rather than a restatement of the code:
//   1. A TYPE SWITCHED OFF IS REMOVED — from the section, `kindTotals.my_turn`, `myTurnTotal`, the
//      brief and the account-wide call alike. A gate applied after the fold (or only in the scoped
//      form) leaves a total describing cards nobody can open, or a notification for a type the
//      reader just switched off.
//   2. THE NEW SUMMONSES ARE HUMAN-ONLY AND RELATED. A reply to YOUR comment, a comment right after
//      YOUR PR comment, a person's @mention — never a bot of either kind (including one only
//      GitHub's type says is a bot), and never "anything after me".
//   3. A PROMOTION MOVES A CARD, IT NEVER COPIES IT. Every combination of the four own-work switches
//      and the three trunk scopes is swept: no PR, thread or repo is ever both a promoted my_turn
//      card and its home card, none is lost, and capped and uncapped `kindTotals` agree.
//   4. THE BOARD AND THE PLAN RANK BY THE READER'S RULES — the type order groups My turn, the
//      weights score every tab, the response says which rules it used, and a promoted card keeps
//      its home plan id so the Pro plan's evidence does not change shape under it.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  InsightCard,
  MyTurnCard,
  MyTurnSettings,
  MyTurnToggle,
  MyTurnTrunkCard,
  PendingCardScore,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-settings-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let eq: any;
let setMyTurnSettings: (id: number, s: MyTurnSettings | null) => Promise<unknown>;
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
      isDraft: false,
      ciStatus: o.ci ?? null,
      mergeStateStatus: o.mss ?? null,
      mergeable: o.mergeable ?? null,
      baseRefName: 'main',
      dependencyVendor: o.dependencyVendor ?? null,
      headRefName: o.headRefName ?? null,
      lastCommitAt: ago(2 * DAY),
      openedAt: ago(5 * DAY),
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

async function review(prId: number, authorId: number, state: string, at: number): Promise<number> {
  const [row] = await db
    .insert(schema.reviews)
    .values({ prId, githubNodeId: `RV_mts_${seq++}`, authorId, state, submittedAt: new Date(at) })
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

/** Run `fn` under these settings, and put the defaults back whatever happens. */
async function withSettings<T>(s: MyTurnSettings | null, fn: () => Promise<T>): Promise<T> {
  await setMyTurnSettings(1, s);
  try {
    return await fn();
  } finally {
    await setMyTurnSettings(1, null);
  }
}

const fold = (uncapped = true) => q.getWorkspaceInsights(1, undefined, scope, { uncapped });
const myTurnCards = (cards: InsightCard[]) =>
  cards.filter((c): c is MyTurnCard | MyTurnTrunkCard => c.kind === 'my_turn');
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
  await review(await mkPr('review-then-comment'), viewerId, 'commented', now - DAY);
  await comment(P('review-then-comment'), aliceId, now - 4 * HOUR);
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

  // ── Precedence: a review request AND a mention on one PR ─────────────────────────────────
  await mkPr('req-and-mention');
  await db.insert(reviewRequests).values({ prId: P('req-and-mention'), userId: viewerId }).execute();
  await mention(P('req-and-mention'), now - HOUR, aliceId);

  // ── OWN WORK in the WRITE repo, and its home cards ───────────────────────────────────────
  await mkPr('own-red', { author: viewerId, ci: 'failure', mss: 'blocked', mergeable: 'mergeable' });
  await mkPr('own-conflict', { author: viewerId, ci: 'success', mss: 'dirty', mergeable: 'conflicting' });
  await mkPr('own-ready', { author: viewerId, ci: 'success', mss: 'clean', mergeable: 'mergeable' });
  await review(P('own-ready'), bobId, 'approved', now - 6 * HOUR);
  // …and you last opened it BEFORE that approval, so it is also "new activity on your PR" — the
  // approval card claims it first, and the ready card must take that claim over.
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

describe('the defaults', () => {
  it('leaves an untouched stranger PR out — until "New PRs" is switched on', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.watchedRepoPrs).toEqual([]);
    expect(mt.off).toEqual(['own_ci_red', 'own_conflicts', 'trunk_red', 'own_ready', 'own_thread', 'watched_repo_pr']);
    await withSettings({ show: { watched_repo_pr: true } }, async () => {
      const on = await q.getMyTurn(1, scope);
      expect(on.watchedRepoPrs.map((r: { prId: number }) => r.prId)).toContain(P('untouched'));
      expect(on.off).not.toContain('watched_repo_pr');
      expect(on.configKey).not.toBe(mt.configKey);
    });
  });
});

describe('pushed since you reviewed (S3c)', () => {
  it('is its own DIRECT type, and only a person pushing makes it', async () => {
    const mt = await q.getMyTurn(1, scope);
    const row = mt.pushedSince.find((r: { prId: number }) => r.prId === P('pushed'));
    expect(row?.relevance).toBe('direct');
    const cards = myTurnCards((await fold()).cards);
    const card = cards.find((c) => c.id === `myturn:pushed_since:${P('pushed')}`) as MyTurnCard;
    expect(card?.reason).toBe('pushed_since');
    expect(card?.relevance).toBe('direct');
    // A bot push never returns the ball — including a bot only GitHub's type knows about.
    const pushed = new Set(mt.pushedSince.map((r: { prId: number }) => r.prId));
    expect(pushed.has(P('bot-pushed'))).toBe(false);
    expect(pushed.has(P('typed-bot-pushed'))).toBe(false);
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

describe('a comment right after your PR comment (S5)', () => {
  const byPr = async () =>
    new Map<number, any>((await q.getMyTurn(1, scope)).commentReplies.map((r: any) => [r.prId, r]));

  it('summons you, clocked at the FIRST person\'s comment after yours', async () => {
    const r = (await byPr()).get(P('comment-reply'));
    expect(r?.replyAuthorId).toBe(aliceId);
    expect(Date.parse(r?.since)).toBe(now - 4 * HOUR);
    expect(r?.replyExcerpt).toBe('Thanks — could you also check the migration?');
    expect(r?.relevance).toBe('direct');
  });

  it('only when your LAST action was a PR comment, and only for a person', async () => {
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

describe('one PR, one summons', () => {
  it('lists a review request that is also a mention ONCE, as the review request', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.awaitingReview.map((r: { prId: number }) => r.prId)).toContain(P('req-and-mention'));
    expect(mt.mentions.some((r: { prId: number }) => r.prId === P('req-and-mention'))).toBe(false);
  });

  it('lets a switched-off type claim nothing — the PR falls through to the next', async () => {
    await withSettings({ show: { review_request: false } }, async () => {
      const mt = await q.getMyTurn(1, scope);
      expect(mt.awaitingReview).toEqual([]);
      expect(mt.mentions.map((r: { prId: number }) => r.prId)).toContain(P('req-and-mention'));
    });
  });
});

describe('switching a type off REMOVES it', () => {
  const sections: Record<string, string> = {
    mention: 'mentions',
    thread: 'threadsAwaiting',
    thread_reply: 'threadReplies',
    comment_reply: 'commentReplies',
    pushed_since: 'pushedSince',
  };
  for (const [reason, section] of Object.entries(sections)) {
    it(`${reason}: from the section, both totals, the brief and the account-wide call`, async () => {
      const brief = await import('./daily-brief.js');
      const before = await fold();
      const count = myTurnCards(before.cards).filter((c) => c.reason === reason).length;
      // Non-vacuity: the fixture really holds this type.
      expect(count).toBeGreaterThan(0);
      const beforeBrief = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
      await withSettings({ show: { [reason]: false } }, async () => {
        const after = await fold();
        expect(myTurnCards(after.cards).filter((c) => c.reason === reason)).toEqual([]);
        expect(after.kindTotals.my_turn).toBe(before.kindTotals.my_turn - count);
        expect(after.myTurnTotal).toBe(before.myTurnTotal - count);
        const afterBrief = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
        expect(afterBrief.myTurn).toBe(beforeBrief.myTurn - count);
        // The UNSCOPED call — what the browser notification reads — obeys it too.
        expect((await q.getMyTurn(1))[section]).toEqual([]);
      });
    });
  }
});

describe('promotions MOVE a card out of its home tab', () => {
  type Promo = { show: MyTurnToggle; mine: string[]; home: string[] };
  const cases = (): Promo[] => [
    { show: 'own_ci_red', mine: [`myturn:own_ci_red:${P('own-red')}`], home: [`cifail:pr:${P('own-red')}`] },
    {
      show: 'own_conflicts',
      mine: [`myturn:own_conflicts:${P('own-conflict')}`],
      home: [`conflicts:${P('own-conflict')}`],
    },
    {
      show: 'own_ready',
      mine: [`myturn:own_ready:${P('own-ready')}`, `myturn:own_ready:${P('own-behind')}`],
      home: [`wp:merge:${P('own-ready')}`, `wp:update_branch:${P('own-behind')}`],
    },
    {
      show: 'own_thread',
      mine: [`myturn:own_thread:${T('own-untouched')}`],
      home: [`thread:${T('own-untouched')}`],
    },
  ];

  it('each own-work switch: ON moves the card and its count, OFF moves them back', async () => {
    const before = await fold();
    for (const c of cases()) {
      for (const id of c.home) expect([c.show, ids(before.cards).has(id)]).toEqual([c.show, true]);
      for (const id of c.mine) expect([c.show, ids(before.cards).has(id)]).toEqual([c.show, false]);
      await withSettings({ show: { [c.show]: true } }, async () => {
        const after = await fold();
        for (const id of c.home) expect([c.show, id, ids(after.cards).has(id)]).toEqual([c.show, id, false]);
        for (const id of c.mine) expect([c.show, id, ids(after.cards).has(id)]).toEqual([c.show, id, true]);
        expect(after.kindTotals.my_turn).toBe(before.kindTotals.my_turn + c.mine.length - (c.show === 'own_ready' ? 1 : 0));
      });
    }
    const back = await fold();
    expect(back.kindTotals).toEqual(before.kindTotals);
  });

  it('own_ready replaces the approval card for the same PR — one job, one card', async () => {
    const approved = `myturn:pr_approved:${P('own-ready')}`;
    const yours = `myturn:your_pr:${P('own-ready')}`;
    const mine = (cards: InsightCard[]) =>
      myTurnCards(cards)
        .filter((c) => (c as MyTurnCard).prId === P('own-ready'))
        .map((c) => c.reason);
    // Non-vacuity: with no approval card to claim it, the PR IS "new activity on your PR".
    await withSettings({ show: { pr_approved: false } }, async () => {
      expect(ids((await fold()).cards).has(yours)).toBe(true);
    });
    expect(mine((await fold()).cards)).toEqual(['pr_approved']);
    await withSettings({ show: { own_ready: true } }, async () => {
      const c = await fold();
      // ⚠ Not ['own_ready', 'your_pr']: the ready card takes the approval card's claim, so
      // switching a promotion on never turns one card into two.
      expect(mine(c.cards)).toEqual(['own_ready']);
      expect(ids(c.cards).has(approved)).toBe(false);
      const card = c.cards.find((x: InsightCard) => x.id === `myturn:own_ready:${P('own-ready')}`);
      expect(card.own).toMatchObject({ kind: 'ready', forward: 'merge', viewerCanPush: true });
      const mt = await q.getMyTurn(1);
      expect(mt.yourPrs.some((r: { prId: number }) => r.prId === P('own-ready'))).toBe(false);
    });
  });

  it('red trunk: "Repos you maintain" moves the home card; "Every repo" adds the others too', async () => {
    const homeW = `cifail:trunk:${writeRepo}:shaWRITE000000000000000000000000000000000`;
    const mineW = `myturn:trunk_red:${writeRepo}:shaWRITE000000000000000000000000000000000`;
    const mineR = `myturn:trunk_red:${readRepo}:shaREAD0000000000000000000000000000000000`;
    expect(ids((await fold()).cards).has(homeW)).toBe(true);
    await withSettings({ trunkScope: 'maintained' }, async () => {
      const c = ids((await fold()).cards);
      expect([c.has(homeW), c.has(mineW), c.has(mineR)]).toEqual([false, true, false]);
    });
    await withSettings({ trunkScope: 'all' }, async () => {
      const c = ids((await fold()).cards);
      expect([c.has(homeW), c.has(mineW), c.has(mineR)]).toEqual([false, true, true]);
    });
  });

  it('never lists one thing twice, never loses one — across every combination, capped and not', async () => {
    const toggles = ['own_ci_red', 'own_conflicts', 'own_ready', 'own_thread'] as const;
    const watched = {
      ci: P('own-red'),
      conflict: P('own-conflict'),
      ready: P('own-ready'),
      behind: P('own-behind'),
      thread: T('own-untouched'),
    };
    let combos = 0;
    for (let mask = 0; mask < 16; mask++) {
      for (const trunkScope of ['off', 'maintained', 'all'] as const) {
        const show = Object.fromEntries(toggles.map((t, i) => [t, (mask & (1 << i)) !== 0]));
        await withSettings({ show, trunkScope }, async () => {
          const uncapped = await fold(true);
          const capped = await fold(false);
          expect(capped.kindTotals).toEqual(uncapped.kindTotals);
          for (const f of [uncapped, capped]) {
            const cards = f.cards as InsightCard[];
            const promoted = (reasons: string[]) =>
              myTurnCards(cards).filter((c) => reasons.includes(c.reason));
            const promotedPr = new Set(
              promoted(['own_ci_red', 'own_conflicts', 'own_ready']).map((c) => (c as MyTurnCard).prId),
            );
            const promotedThread = new Set(promoted(['own_thread']).map((c) => c.threadId));
            const promotedRepo = new Set(promoted(['trunk_red']).map((c) => (c as MyTurnTrunkCard).repoId));
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
            const homeThread = new Set(
              cards.filter((c) => c.kind === 'untouched_thread').map((c: any) => c.threadId),
            );
            const homeRepo = new Set(
              cards.filter((c) => c.kind === 'ci_failing' && c.arm === 'trunk').map((c: any) => c.repoId),
            );
            for (const id of [watched.ci, watched.conflict, watched.ready, watched.behind]) {
              // Exactly one of the two — never both, never neither.
              expect([mask, trunkScope, id, promotedPr.has(id) !== homePr.has(id)]).toEqual([
                mask,
                trunkScope,
                id,
                true,
              ]);
            }
            expect(promotedThread.has(watched.thread) !== homeThread.has(watched.thread)).toBe(true);
            expect(promotedRepo.has(writeRepo) !== homeRepo.has(writeRepo)).toBe(true);
          }
        });
        combos += 1;
      }
    }
    expect(combos).toBe(48);
  });

  it('never promotes a PR carrying a dependency tool\'s marker, though your token opened it', async () => {
    await withSettings({ show: { own_ci_red: true } }, async () => {
      const c = ids((await fold()).cards);
      expect(c.has(`myturn:own_ci_red:${P('own-snyk')}`)).toBe(false);
      expect(c.has(`cifail:pr:${P('own-snyk')}`)).toBe(false);
      // Its one card is the Dependencies card.
      expect(c.has(`deps:${P('own-snyk')}`) || c.has(`security:${P('own-snyk')}`)).toBe(true);
    });
  });
});

describe('a promoted red trunk you do not maintain', () => {
  const readTrunk = (cards: InsightCard[]) =>
    myTurnCards(cards).find(
      (c): c is MyTurnTrunkCard => c.reason === 'trunk_red' && c.repoId === readRepo,
    );

  it('is DIRECT and notifies — you added it — and the mute still downgrades it without removing it', async () => {
    await withSettings({ trunkScope: 'all' }, async () => {
      const f = await fold();
      const card = readTrunk(f.cards)!;
      expect(card.relevance).toBe('direct');
      expect(card.personal).toBe(true);
      expect(card.maintained).toBe(false);
      const mt = myTurnCards(f.cards);
      expect(f.myTurnPersonalTotal).toBe(mt.filter((c) => c.relevance !== 'none').length);

      const mute = await import('./pending-mute.js');
      await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [readRepo] });
      try {
        const muted = readTrunk((await fold()).cards)!;
        expect(muted).toBeDefined();
        expect(muted.relevance).toBe('none');
        expect(muted.personal).toBe(false);
        expect(muted.muted).toBe(true);
      } finally {
        await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [] });
      }
    });
  });

  it('names its landing PR\'s author the way the ci_failing trunk card does — one side of the lens', async () => {
    await withSettings({ trunkScope: 'all' }, async () => {
      const f = await fold();
      const read = readTrunk(f.cards)!;
      expect(read.authorId).toBe(botId);
      expect(read.automation?.role).toBe('dependency');
      // No landing PR resolved on the WRITE repo's head: nobody, and the people side.
      const write = myTurnCards(f.cards).find(
        (c): c is MyTurnTrunkCard => c.reason === 'trunk_red' && c.repoId === writeRepo,
      )!;
      expect(write.automation).toBeNull();
      const tabs = await import('./pending-tabs.js');
      const board = await tabs.rankPendingTabs(1, scope, f);
      const myTurn = board.tabs.find((t: { key: string }) => t.key === 'my_turn')!;
      expect(myTurn.authorTotals!.automation).toBeGreaterThanOrEqual(1);
      expect(myTurn.authorTotals!.people + myTurn.authorTotals!.automation).toBe(myTurn.total);
    });
  });
});

describe('the Pending mute on own work', () => {
  it('downgrades a muted repo\'s promoted rows to none — and removes nothing', async () => {
    const mute = await import('./pending-mute.js');
    await withSettings({ show: { own_ci_red: true } }, async () => {
      await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [writeRepo] });
      try {
        const mt = await q.getMyTurn(1, scope);
        const row = mt.ownCiRed.find((r: { prId: number }) => r.prId === P('own-red'));
        expect(row).toBeDefined();
        expect(row.relevance).toBe('none');
        expect(row.muted).toBe(true);
      } finally {
        await mute.setWorkspacePendingMute(1, scope.workspaceId, { mutedRepoIds: [] });
      }
    });
  });
});

describe('the daily brief', () => {
  it('counts a promoted red trunk once — in My Turn, not on the red-trunk line', async () => {
    const brief = await import('./daily-brief.js');
    const before = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
    expect(before.trunkRed.map((t: { repoId: number }) => t.repoId).sort()).toEqual([writeRepo, readRepo].sort());
    await withSettings({ trunkScope: 'maintained' }, async () => {
      const after = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
      expect(after.trunkRed.map((t: { repoId: number }) => t.repoId)).toEqual([readRepo]);
      expect(after.myTurn).toBe(before.myTurn + 1);
    });
  });

  it('leaves a promoted own red build out of the CI-failing line', async () => {
    const brief = await import('./daily-brief.js');
    const before = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
    await withSettings({ show: { own_ci_red: true } }, async () => {
      const after = (await brief.getDailyBriefEntry(1, scope.workspaceId)).counts;
      expect(after.ciFailing).toBe(before.ciFailing! - 1);
      expect(after.myTurn).toBe(before.myTurn + 1);
    });
  });

  it('drops the cached roll-up counts when the settings change', async () => {
    const brief = await import('./daily-brief.js');
    brief.clearDailyBriefCache();
    const cached = await brief.getDailyBriefCounts(1, scope.workspaceId);
    await withSettings({ show: { own_ci_red: true } }, async () => {
      // Without the clear, the five-minute cache still answers with the old population…
      expect((await brief.getDailyBriefCounts(1, scope.workspaceId)).ciFailing).toBe(cached.ciFailing);
      brief.clearDailyBriefCountsFor(1);
      // …and after it, the new one.
      expect((await brief.getDailyBriefCounts(1, scope.workspaceId)).ciFailing).toBe(cached.ciFailing! - 1);
    });
    brief.clearDailyBriefCache();
  });
});

describe('the board ranks by the reader\'s rules', () => {
  const board = async () => {
    const f = await fold();
    const tabs = await import('./pending-tabs.js');
    return { f, ...(await tabs.rankPendingTabs(1, scope, f)) };
  };
  const reasonsInOrder = (b: Awaited<ReturnType<typeof board>>) => {
    const byId = new Map(b.cards.map((c: InsightCard) => [c.id, c]));
    const myTurn = b.tabs.find((t: { key: string }) => t.key === 'my_turn')!;
    return myTurn.cardIds.map((id: string) => (byId.get(id) as MyTurnCard).reason);
  };

  it('groups My turn by the type order, then by score — and says which rules it used', async () => {
    const { getMyTurnSettings, rankRulesOf } = await import('./my-turn-settings.js');
    const b = await board();
    expect(b.rules).toEqual(rankRulesOf(await getMyTurnSettings(1)));
    const order = b.rules.myTurnOrder;
    const reasons = reasonsInOrder(b);
    const myTurn = b.tabs.find((t: { key: string }) => t.key === 'my_turn')!;
    for (let i = 1; i < reasons.length; i++) {
      const [a, c] = [order.indexOf(reasons[i - 1]!), order.indexOf(reasons[i]!)];
      expect(a).toBeLessThanOrEqual(c);
      if (a === c) {
        expect(b.scores[myTurn.cardIds[i - 1]!]!.score).toBeGreaterThanOrEqual(
          b.scores[myTurn.cardIds[i]!]!.score,
        );
      }
    }
    expect(new Set(reasons).size).toBeGreaterThan(3);
  });

  it('a custom order swaps two groups, whatever their scores', async () => {
    const before = reasonsInOrder(await board());
    expect(before.indexOf('mention')).toBeLessThan(before.indexOf('pushed_since'));
    await withSettings({ order: ['pushed_since', 'mention'] }, async () => {
      const after = reasonsInOrder(await board());
      expect(after.indexOf('pushed_since')).toBeLessThan(after.indexOf('mention'));
      // Nothing but the order moved.
      expect([...after].sort()).toEqual([...before].sort());
    });
  });

  it('scores every card with the reader\'s weights ("Mine first": 30 / 10 / 60)', async () => {
    const { DO_NEXT_RULES, DO_NEXT_PRESETS } = await import('@pierre-review/shared');
    await withSettings({ weights: DO_NEXT_PRESETS.mine_first }, async () => {
      const b = await board();
      expect(b.rules.preset).toBe('mine_first');
      expect(b.rules.weights).toEqual({ proximity: 0.3, stall: 0.1, relevance: 0.6 });
      const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
      const scores = Object.values(b.scores) as PendingCardScore[];
      expect(scores.length).toBeGreaterThan(5);
      for (const s of scores) {
        expect(s.score).toBe(
          round4(
            0.3 * s.proximity +
              0.1 * s.stallRisk +
              0.6 * (DO_NEXT_RULES.relevanceWeight as Record<string, number>)[s.relevance]!,
          ),
        );
      }
    });
  });
});

describe('the Pro plan does not change shape under a promotion', () => {
  it('keeps a promoted red build as the same unblock_ci row, pointing at its my_turn card', async () => {
    const workPlan = await import('./work-plan.js');
    const { getMyTurnSettings } = await import('./my-turn-settings.js');
    // Every candidate row, before the plan's twelve-row cap picks among them.
    const rowFor = async () => {
      const { candidates } = await workPlan.scoreCards(
        1,
        (await fold()).cards,
        now,
        (await getMyTurnSettings(1)).weights,
      );
      return candidates
        .map((c: { item: any }) => c.item)
        .find((i: { id: string }) => i.id === `wp:unblock_ci:${P('own-red')}`);
    };
    const row = await rowFor();
    expect(row?.cardId).toBe(`cifail:pr:${P('own-red')}`);
    await withSettings({ show: { own_ci_red: true } }, async () => {
      const moved = await rowFor();
      expect(moved?.kind).toBe('unblock_ci');
      expect(moved?.cardId).toBe(`myturn:own_ci_red:${P('own-red')}`);
      // The hashed half of the row is untouched: same reason, same facts, same relevance.
      expect(moved?.reason).toBe(row?.reason);
      expect(moved?.facts).toEqual(row?.facts);
      expect(moved?.relevance).toBe(row?.relevance);
    });
  });
});
