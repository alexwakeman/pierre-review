// THE HEADING FACTS on Pending cards (db/my-turn-card-facts.ts) — on a THROWAWAY sqlite DB (the
// my-turn-card-extras.test.ts pattern).
//
//   1. The pure excerpt: markdown and HTML stripped, capped on a word boundary, a deep mention
//      brought into view, a blank body refused.
//   2. Each fact lands on its card: who mentioned you and what they wrote (quoted lines are not the
//      mention), the thread's file + line, who wrote the commit after your comment, an unanswered
//      thread's opening comment (own_thread AND untouched_thread), who did the new things on your PR
//      (you excluded, capped, with an uncapped total), who asked you to review (the newest request
//      naming you; absent on a legacy NULL, a self-request, a newer withdrawal or a capped history).
//   3. BOARD ONLY AND DISPLAY ONLY: without the board flag no fact is set, and with it the cards,
//      their ids, their `detail` and every total are exactly the same.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CARD_EXCERPT_MAX_CHARS,
  YOUR_PR_NEW_ACTORS_SHOWN,
  type InsightCard,
  type MyTurnCard,
  type UntouchedThreadCard,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-card-facts-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let facts: typeof import('./my-turn-card-facts.js');
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const OPENED = REPO_ADDED + DAY;
const MY_ACTION = OPENED + DAY;

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let bobId = 0;
let carolId = 0;
let daveId = 0;
let botId = 0;
let prNumber = 1;
let eventN = 0;
const prIdByKey = new Map<string, number>();
const threadIdByTag = new Map<string, number>();

async function addEvent(prId: number, type: string, actorId: number | null, at: number) {
  await db
    .insert(schema.events)
    .values({
      accountId: 1,
      repoId,
      prId,
      actorId,
      type,
      occurredAt: new Date(at),
      dedupeKey: `ev_${eventN++}`,
    })
    .execute();
}

async function seedPr(key: string, authorId = aliceId): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_facts_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `${key} fixture`,
      state: 'open',
      isDraft: false,
      authorId,
      openedAt: new Date(OPENED),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  prIdByKey.set(key, pr.id);
  // Recent activity, so the open-PR gates (90-day quiet floor) admit it.
  await addEvent(pr.id, 'pr_opened', authorId, now - 2 * DAY);
  return pr.id;
}

async function addThread(
  prId: number,
  tag: string,
  opener: number,
  state: string,
  comments: { authorId: number; body: string; at: number }[],
  line: number | null = 7,
): Promise<number> {
  const [thread] = await db
    .insert(schema.reviewThreads)
    .values({
      githubNodeId: `TH_${tag}`,
      prId,
      path: `src/${tag}.ts`,
      line,
      isResolved: false,
      derivedState: state,
      originalCommenterId: opener,
      createdAt: new Date(OPENED),
    })
    .returning()
    .execute();
  let n = 0;
  for (const c of comments) {
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: `RC_${tag}_${n++}`,
        threadId: thread.id,
        prId,
        authorId: c.authorId,
        body: c.body,
        excerpt: c.body.slice(0, 140),
        createdAt: new Date(c.at),
      })
      .execute();
  }
  threadIdByTag.set(tag, thread.id);
  return thread.id;
}

async function addCommit(prId: number, authorId: number | null, at: number, sha: string, paths: string[]) {
  await db
    .insert(schema.commits)
    .values({ sha, prId, authorId, committedAt: new Date(at) })
    .execute();
  await db.insert(schema.commitFiles).values({ sha, paths }).execute();
}

let rrEventN = 0;
/** A pending request to the viewer (`review_requests`) plus its stored history. */
async function seedReviewRequest(
  key: string,
  history: { kind: 'requested' | 'removed'; reviewer: number; by: number | null; at: number }[],
): Promise<number> {
  const id = await seedPr(key);
  await db.insert(schema.reviewRequests).values({ prId: id, userId: viewerId }).execute();
  for (const h of history) {
    await db
      .insert(schema.reviewRequestEvents)
      .values({
        prId: id,
        githubNodeId: `RRE_facts_${rrEventN++}`,
        kind: h.kind,
        occurredAt: new Date(h.at),
        reviewerKind: 'user',
        reviewerUserId: h.reviewer,
        requesterUserId: h.by,
      })
      .execute();
  }
  return id;
}

async function insights(board: boolean) {
  return q.getWorkspaceInsights(1, undefined, scope, board ? { withFailingChecks: true } : {});
}

function myTurnByKey(cards: InsightCard[]): Map<string, MyTurnCard> {
  const byPrId = new Map<number, MyTurnCard>();
  for (const c of cards) {
    if (c.kind !== 'my_turn' || c.reason === 'trunk_red') continue;
    byPrId.set(c.prId, c);
  }
  const out = new Map<string, MyTurnCard>();
  for (const [key, prId] of prIdByKey) {
    const card = byPrId.get(prId);
    if (card) out.set(key, card);
  }
  return out;
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
  facts = await import('./my-turn-card-facts.js');
  const { eq } = await import('drizzle-orm');
  await db
    .update(schema.accounts)
    // own_thread is OFF by default; switch it on so the promotion is built.
    .set({ githubLogin: 'viewer-me', myTurnSettings: { show: { own_thread: true } } })
    .where(eq(schema.accounts.id, 1))
    .execute();
  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(schema.users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser('viewer-me');
  aliceId = await insertUser('alice-dev');
  bobId = await insertUser('bob-dev');
  carolId = await insertUser('carol-dev');
  daveId = await insertUser('dave-dev');
  botId = await insertUser('coderabbitai', true);
  const [repo] = await db
    .insert(schema.repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_facts',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  // ── MENTION: Alice quote-replied an older mention, then mentioned me herself ──
  {
    const id = await seedPr('mention');
    const at = MY_ACTION + 2 * HOUR;
    await db
      .insert(schema.prComments)
      .values([
        {
          githubNodeId: 'PC_quote',
          prId: id,
          authorId: aliceId,
          body: '> @viewer-me said something\n\nagreed',
          createdAt: new Date(MY_ACTION),
        },
        {
          githubNodeId: 'PC_mention',
          prId: id,
          authorId: aliceId,
          body: '**@viewer-me** can you [confirm](https://x.test) the `schema`?',
          createdAt: new Date(at),
        },
      ])
      .execute();
    await db
      .insert(schema.prMentions)
      .values({
        accountId: 1,
        repoId,
        prId: id,
        login: 'viewer-me',
        mentionedAt: new Date(at),
        mentionedByUserId: aliceId,
      })
      .execute();
  }

  // ── THREAD REPLY in my thread: path + line ──
  {
    const id = await seedPr('thread-reply');
    await addThread(id, 'mine-replied', viewerId, 'replied_unresolved', [
      { authorId: viewerId, body: 'why this?', at: MY_ACTION },
      { authorId: aliceId, body: 'because', at: MY_ACTION + HOUR },
    ]);
  }

  // ── LIKELY ADDRESSED: commits before my comment / on another file are not it; Bob's is ──
  {
    const id = await seedPr('addressed');
    await addThread(id, 'mine-addressed', viewerId, 'likely_addressed', [
      { authorId: viewerId, body: 'please rename', at: MY_ACTION },
    ]);
    await addCommit(id, aliceId, MY_ACTION - HOUR, 'sha_before', ['src/mine-addressed.ts']);
    await addCommit(id, carolId, MY_ACTION + HOUR, 'sha_other_file', ['README.md']);
    await addCommit(id, bobId, MY_ACTION + 2 * HOUR, 'sha_touch', ['src/mine-addressed.ts']);
    await addCommit(id, daveId, MY_ACTION + 3 * HOUR, 'sha_later', ['src/mine-addressed.ts']);
  }
  // ── LIKELY ADDRESSED where a bot and I touched the file first: Carol is the one named ──
  {
    const id = await seedPr('addressed-bot');
    await addThread(id, 'mine-addressed-bot', viewerId, 'likely_addressed', [
      { authorId: viewerId, body: 'please split this', at: MY_ACTION },
    ]);
    await addCommit(id, botId, MY_ACTION + HOUR, 'sha_bot_fmt', ['src/mine-addressed-bot.ts']);
    await addCommit(id, viewerId, MY_ACTION + 2 * HOUR, 'sha_mine', ['src/mine-addressed-bot.ts']);
    await addCommit(id, carolId, MY_ACTION + 3 * HOUR, 'sha_carol', ['src/mine-addressed-bot.ts']);
  }
  // ── LIKELY ADDRESSED where only a bot touched the file: nobody is named ──
  {
    const id = await seedPr('addressed-onlybot');
    await addThread(id, 'mine-addressed-onlybot', viewerId, 'likely_addressed', [
      { authorId: viewerId, body: 'format this', at: MY_ACTION },
    ]);
    await addCommit(id, botId, MY_ACTION + HOUR, 'sha_bot_only', ['src/mine-addressed-onlybot.ts']);
  }
  // ── LIKELY ADDRESSED with no stored touching commit (outdated / marker): no committer ──
  {
    const id = await seedPr('addressed-nocommit');
    await addThread(id, 'mine-outdated', viewerId, 'likely_addressed', [
      { authorId: viewerId, body: 'nit', at: MY_ACTION },
    ]);
  }

  // ── OWN THREAD: CodeRabbit's unanswered thread on my PR ──
  {
    const id = await seedPr('own-thread', viewerId);
    await addThread(
      id,
      'bot-on-mine',
      botId,
      'untouched',
      [
        {
          authorId: botId,
          body: '_⚠️ Potential issue_\n\n<details><summary>x</summary></details>\n\n**Null check** missing here.',
          at: OPENED,
        },
      ],
      null,
    );
  }

  // ── UNTOUCHED THREAD on someone else's PR (Unanswered threads tab) ──
  {
    const id = await seedPr('untouched', bobId);
    await addThread(id, 'bob-untouched', aliceId, 'untouched', [
      { authorId: aliceId, body: `${'This needs a test. '.repeat(30)}`, at: OPENED },
    ]);
  }

  // ── UNTOUCHED THREAD whose opening body is blank: the next comment is quoted ──
  {
    const id = await seedPr('untouched-blank', bobId);
    await addThread(id, 'bob-untouched-blank', aliceId, 'untouched', [
      { authorId: aliceId, body: '   ', at: OPENED },
      { authorId: carolId, body: 'Second comment carries the words.', at: OPENED + HOUR },
    ]);
  }

  // ── YOUR PR with new activity since I last looked: four other actors, a bot, and me ──
  {
    const id = await seedPr('your-pr', viewerId);
    const viewed = now - 10 * HOUR;
    await db
      .insert(schema.prViews)
      .values({ prId: id, lastViewedAt: new Date(viewed) })
      .execute();
    await addEvent(id, 'pr_comment', aliceId, viewed - HOUR); // before the view: not new
    await addEvent(id, 'pr_comment', carolId, viewed + 1 * HOUR);
    await addEvent(id, 'review_submitted', botId, viewed + 2 * HOUR);
    await addEvent(id, 'commit_pushed', bobId, viewed + 3 * HOUR);
    await addEvent(id, 'review_comment', daveId, viewed + 4 * HOUR);
    await addEvent(id, 'pr_comment', viewerId, viewed + 5 * HOUR); // mine: never "new" to me
    await addEvent(id, 'commit_pushed', carolId, viewed + 6 * HOUR);
  }

  // ── REVIEW REQUESTS: who asked me ──
  // Dave asked me; Carol asked Bob afterwards (not about me).
  await seedReviewRequest('rr-named', [
    { kind: 'requested', reviewer: viewerId, by: daveId, at: MY_ACTION },
    { kind: 'requested', reviewer: bobId, by: carolId, at: MY_ACTION + HOUR },
  ]);
  // Carol asked, withdrew, then Dave re-asked: the newest request names Dave.
  await seedReviewRequest('rr-reasked', [
    { kind: 'requested', reviewer: viewerId, by: carolId, at: MY_ACTION },
    { kind: 'removed', reviewer: viewerId, by: carolId, at: MY_ACTION + HOUR },
    { kind: 'requested', reviewer: viewerId, by: daveId, at: MY_ACTION + 2 * HOUR },
  ]);
  // Synced before migration 0081: no requester.
  await seedReviewRequest('rr-legacy', [
    { kind: 'requested', reviewer: viewerId, by: null, at: MY_ACTION },
  ]);
  // I requested myself: nobody to name.
  await seedReviewRequest('rr-self', [
    { kind: 'requested', reviewer: viewerId, by: viewerId, at: MY_ACTION },
  ]);
  // The newest stored event about me is a withdrawal: the history does not explain the card.
  await seedReviewRequest('rr-withdrawn', [
    { kind: 'requested', reviewer: viewerId, by: daveId, at: MY_ACTION },
    { kind: 'removed', reviewer: viewerId, by: daveId, at: MY_ACTION + HOUR },
  ]);
  // A history at the selection's cap: the real newest request may not be stored.
  await seedReviewRequest(
    'rr-capped',
    Array.from({ length: 25 }, (_, i) => ({
      kind: 'requested' as const,
      reviewer: i === 0 ? viewerId : bobId,
      by: daveId,
      at: MY_ACTION + i * 60_000,
    })),
  );

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the heading excerpt (pure)', () => {
  it('strips markdown and HTML to the words a person typed', () => {
    expect(
      facts.markdownToPlainText(
        '## Title\n\n> quoted\n\n- **bold** and _em_ and `code` and [link](https://x)\n<!-- hidden -->\n<b>tag</b> ![img](y.png) a &amp; b snake_case_name',
      ),
    ).toBe('Title quoted bold and em and code and link tag a & b snake_case_name');
  });

  it('keeps a short body, cuts a long one on a word and refuses a blank one', () => {
    expect(facts.cardExcerpt('  hi  ')).toEqual({ text: 'hi', truncated: false });
    expect(facts.cardExcerpt('   ')).toBeNull();
    expect(facts.cardExcerpt(null)).toBeNull();
    const long = facts.cardExcerpt('word '.repeat(100));
    expect(long!.truncated).toBe(true);
    expect(long!.text.length).toBeLessThanOrEqual(CARD_EXCERPT_MAX_CHARS);
    expect(long!.text).toMatch(/word…$/);
  });

  it('brings a deep mention into view', () => {
    const body = `${'Some long preamble about the change. '.repeat(10)}@viewer-me can you confirm the schema?`;
    const ex = facts.cardExcerpt(body, { focusLogin: 'viewer-me' })!;
    expect(ex.truncated).toBe(true);
    expect(ex.text.startsWith('…')).toBe(true);
    expect(ex.text).toContain('@viewer-me can you confirm the schema?');
    expect(ex.text.length).toBeLessThanOrEqual(CARD_EXCERPT_MAX_CHARS);
  });
});

describe('each fact lands on its card (board fold)', () => {
  it('mention: who, and the comment they typed — never a quote-reply of it', async () => {
    const card = myTurnByKey((await insights(true)).cards).get('mention')!;
    expect(card.reason).toBe('mention');
    expect(card.mentionedById).toBe(aliceId);
    expect(card.mentionExcerpt).toEqual({
      text: '@viewer-me can you confirm the schema?',
      truncated: false,
    });
  });

  it('thread reply: the file and line', async () => {
    const card = myTurnByKey((await insights(true)).cards).get('thread-reply')!;
    expect(card.reason).toBe('thread');
    expect(card.threadPath).toBe('src/mine-replied.ts');
    expect(card.threadLine).toBe(7);
    expect(card.committerId).toBeUndefined();
  });

  it('likely_addressed: the FIRST commit after my comment that changed the file', async () => {
    const res = await insights(true);
    const card = myTurnByKey(res.cards).get('addressed')!;
    expect(card.reason).toBe('thread');
    expect(card.threadPath).toBe('src/mine-addressed.ts');
    expect(card.committerId).toBe(bobId);
    // The client can name them.
    expect(res.users.map((u: { id: number }) => u.id)).toContain(bobId);
    // No stored touching commit: absent, never guessed.
    expect(myTurnByKey(res.cards).get('addressed-nocommit')!.committerId).toBeUndefined();
  });

  it('likely_addressed: a bot commit or my own is never named as why the ball came back', async () => {
    const res = await insights(true);
    expect(myTurnByKey(res.cards).get('addressed-bot')!.committerId).toBe(carolId);
    // Only a bot touched it: absent, so the heading says "A commit".
    expect(myTurnByKey(res.cards).get('addressed-onlybot')!.committerId).toBeUndefined();
  });

  it('own_thread: the opening comment, as plain text, with its author', async () => {
    const card = myTurnByKey((await insights(true)).cards).get('own-thread')!;
    expect(card.reason).toBe('own_thread');
    expect(card.threadPath).toBe('src/bot-on-mine.ts');
    // An unanchored thread carries no line.
    expect(card.threadLine).toBeUndefined();
    expect(card.firstComment).toMatchObject({
      authorId: botId,
      text: '⚠️ Potential issue x Null check missing here.',
      truncated: false,
    });
  });

  it('untouched_thread: the opening comment, capped, and the line', async () => {
    const res = await insights(true);
    const card = res.cards.find(
      (c: InsightCard) =>
        c.kind === 'untouched_thread' && c.threadId === threadIdByTag.get('bob-untouched'),
    ) as UntouchedThreadCard;
    expect(card).toBeDefined();
    expect(card.line).toBe(7);
    expect(card.firstComment!.authorId).toBe(aliceId);
    expect(card.firstComment!.truncated).toBe(true);
    expect(card.firstComment!.text.length).toBeLessThanOrEqual(CARD_EXCERPT_MAX_CHARS);
  });

  it('untouched_thread: a blank opening body moves on to the next comment', async () => {
    const res = await insights(true);
    const card = res.cards.find(
      (c: InsightCard) =>
        c.kind === 'untouched_thread' && c.threadId === threadIdByTag.get('bob-untouched-blank'),
    ) as UntouchedThreadCard;
    expect(card.firstComment).toMatchObject({
      authorId: carolId,
      text: 'Second comment carries the words.',
    });
  });

  it('your_pr: who is new, newest first, me excluded, capped with a total', async () => {
    const card = myTurnByKey((await insights(true)).cards).get('your-pr')!;
    expect(card.reason).toBe('your_pr');
    // carol (newest commit) · dave · bob · the bot; alice was before the view, I am never news.
    expect(card.newActorTotal).toBe(4);
    expect(card.newActorIds).toHaveLength(YOUR_PR_NEW_ACTORS_SHOWN);
    expect(card.newActorIds).toEqual([carolId, daveId, bobId]);
  });
});

describe('review_request: who asked you', () => {
  it('names the requester of the newest request naming me, and the client can name them', async () => {
    const res = await insights(true);
    const cards = myTurnByKey(res.cards);
    expect(cards.get('rr-named')!.reason).toBe('review_request');
    expect(cards.get('rr-named')!.requesterId).toBe(daveId);
    expect(cards.get('rr-reasked')!.requesterId).toBe(daveId);
    expect(res.users.map((u: { id: number }) => u.id)).toContain(daveId);
  });

  it('is absent — never guessed — on a legacy row, a self-request, a newer withdrawal or a capped history', async () => {
    const cards = myTurnByKey((await insights(true)).cards);
    for (const key of ['rr-legacy', 'rr-self', 'rr-withdrawn', 'rr-capped']) {
      expect(cards.get(key)!.reason).toBe('review_request');
      expect(cards.get(key)!.requesterId).toBeUndefined();
    }
  });

  it('reviewRequesters: a viewer we cannot place reads nothing', async () => {
    expect((await facts.reviewRequesters([prIdByKey.get('rr-named')!], null)).size).toBe(0);
  });
});

describe('board only, display only', () => {
  it('without the board flag no fact is set', async () => {
    const res = await insights(false);
    for (const c of res.cards as InsightCard[]) {
      if (c.kind === 'my_turn' && c.reason !== 'trunk_red') {
        for (const k of [
          'mentionedById',
          'mentionExcerpt',
          'threadPath',
          'threadLine',
          'committerId',
          'firstComment',
          'newActorIds',
          'newActorTotal',
          'requesterId',
        ]) {
          expect(c).not.toHaveProperty(k);
        }
      }
      if (c.kind === 'untouched_thread') expect(c.firstComment).toBeUndefined();
    }
  });

  it('the cards, their ids, details and every total are the same with or without it', async () => {
    const [plain, board] = await Promise.all([insights(false), insights(true)]);
    const shape = (r: any) => ({
      ids: (r.cards as InsightCard[]).map((c) => c.id),
      details: (r.cards as InsightCard[]).map((c) => ('detail' in c ? c.detail : null)),
      kindTotals: r.kindTotals,
      myTurnTotal: r.myTurnTotal,
      myTurnPersonalTotal: r.myTurnPersonalTotal,
    });
    expect(shape(board)).toEqual(shape(plain));
  });
});

describe('deferred to the listed cards (the board)', () => {
  it('with a sink, nothing is read until run, and then only for the listed ids', async () => {
    const sink: { run: ((listed: ReadonlySet<string>) => Promise<number[]>) | null } = { run: null };
    const res = await q.getWorkspaceInsights(1, undefined, scope, {
      uncapped: true,
      withFailingChecks: true,
      boardFacts: sink,
    });
    const byKey = myTurnByKey(res.cards);
    const mention = byKey.get('mention')!;
    const addressed = byKey.get('addressed')!;
    expect(mention.mentionExcerpt).toBeUndefined();
    expect(addressed.committerId).toBeUndefined();
    expect(sink.run).not.toBeNull();
    const ids = await sink.run!(new Set([mention.id]));
    expect(mention.mentionExcerpt?.text).toBe('@viewer-me can you confirm the schema?');
    // Not listed: never read.
    expect(addressed.committerId).toBeUndefined();
    expect(addressed.threadPath).toBeUndefined();
    const untouched = res.cards.find(
      (c: InsightCard) => c.kind === 'untouched_thread',
    ) as UntouchedThreadCard;
    expect(untouched.firstComment).toBeUndefined();
    expect(Array.isArray(ids)).toBe(true);
  });
});
