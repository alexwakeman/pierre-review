// THE BALL RULE — what puts a PR on your plate and what takes it off — on a THROWAWAY sqlite DB
// (the my-turn-new-prs.test.ts pattern).
//
// THE RULE, in one sentence: it is my turn when there is an action I owe on this PR and nothing I
// have done since the last RELATED thing that happened discharges it. State-derived, recomputed
// on every read, nothing stored.
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. ⚠ "NEW PR" USED TO MEAN "NEW PR, FULL STOP". The section's claim was "open PRs you have
//      not looked at", but the only tests were the repo's add-date, the author and the draft
//      flag — so a PR the viewer had APPROVED eleven days ago still printed "New PR from @alice ·
//      11d ago" every morning. `mineLast == null` is the missing half.
//   2. ⚠ A BARE `commented` REVIEW IS AN ACTION. Seven of the nine reviews behind the original
//      complaint were bodiless `commented` reviews, and `sync/upsert.ts` emits NO `review_submitted`
//      event for those (`isSubstantiveReview` gates it). A rule folded off `events` reads them as
//      "you never touched this PR" — which is precisely the card the user was complaining about.
//      Hence `reviews`/`review_comments`/`pr_comments`/`commits`, never the event log.
//   3. ⚠ A BOT ACTION NEVER RETURNS THE BALL. Not a comment, not a push. This is the DELIBERATE
//      DIVERGENCE from Chronology (db/pr-intervals.ts), which counts every commit regardless of
//      author because it is measuring elapsed time rather than who owes what. Two fixtures, one
//      per bot channel, because a rule that filtered bot COMMENTS and forgot bot PUSHES would
//      pass a one-sided test and still re-summon you for every Dependabot rebase.
//   4. ⚠ RECENCY IS NOT RELATEDNESS. A human PR-level comment after your review does NOT bring the
//      PR back; only a human COMMIT does (new code arrived, so your read is stale). This is the
//      explicitly rejected "anything after me" rule, and it is the one a lax implementation
//      reaches for first.
//   5. ⚠ A THREAD YOU OPENED THAT WENT `likely_addressed` WAS INVISIBLE. `getThreadsAwaiting`
//      required somebody OTHER than you to have had the last word, so the state where the fix
//      probably landed and nobody said so produced no card at all.
//   6. ⚠ DROPPING SEEDS MUST MOVE `myTurnTotal` WITH THEM. The cap disclosure ("50 of 148") is
//      only true while the total counts the same population the list is sliced from, so the ball
//      rule is applied to the SEED LIST — before `ranked.length` is measured — and never to the
//      built cards.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, MyTurnCard, WatchedRepoPrItem } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-ball-test.sqlite';
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
// truncated on write and could turn an intended "after my action" into "at the same instant".
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
// Every fixture PR opens here, well after the repo's cutoff, so `repos.createdAt` never decides
// anything in this file — my-turn-new-prs.test.ts owns that half.
const OPENED = REPO_ADDED + DAY;
// The viewer's action, when they have one. Everything "since" lands after it.
const MY_ACTION = OPENED + DAY;
const AFTER_ME = MY_ACTION + HOUR;

const VIEWER_LOGIN = 'viewer-me';

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let botId = 0;
let prNumber = 1;
const prIdByKey = new Map<string, number>();

/** Insert an open, non-draft PR authored by a human other than the viewer — the shape that
 *  reaches the ball rule at all. Everything the rule turns on is layered on afterwards. */
async function seedPr(key: string): Promise<number> {
  const { pullRequests } = schema;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: `PR_ball_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `${key} fixture`,
      state: 'open',
      isDraft: false,
      authorId: aliceId,
      openedAt: new Date(OPENED),
      updatedAt: new Date(OPENED),
    })
    .returning()
    .execute();
  prIdByKey.set(key, pr.id);
  return pr.id;
}

async function addReview(
  prId: number,
  authorId: number,
  state: string,
  at: number,
  tag: string,
): Promise<void> {
  await db
    .insert(schema.reviews)
    .values({
      githubNodeId: `RV_${tag}`,
      prId,
      authorId,
      state,
      submittedAt: new Date(at),
    })
    .execute();
}

async function addPrComment(
  prId: number,
  authorId: number,
  at: number,
  tag: string,
): Promise<void> {
  await db
    .insert(schema.prComments)
    .values({
      githubNodeId: `PC_${tag}`,
      prId,
      authorId,
      body: 'a comment',
      createdAt: new Date(at),
    })
    .execute();
}

async function addCommit(
  prId: number,
  authorId: number | null,
  at: number,
  tag: string,
): Promise<void> {
  await db
    .insert(schema.commits)
    .values({ sha: `sha_${tag}`, prId, authorId, committedAt: new Date(at) })
    .execute();
}

/** The "New PRs" rows getMyTurn would return right now, keyed by fixture name. */
async function newPrRows(): Promise<Map<string, WatchedRepoPrItem>> {
  const mt = await q.getMyTurn(1, scope);
  const byPrId = new Map<number, WatchedRepoPrItem>(
    (mt.watchedRepoPrs as WatchedRepoPrItem[]).map((r) => [r.prId, r]),
  );
  const out = new Map<string, WatchedRepoPrItem>();
  for (const [key, prId] of prIdByKey) {
    const row = byPrId.get(prId);
    if (row) out.set(key, row);
  }
  return out;
}

/** The my_turn CARDS the Pending board would paint, keyed by fixture name — the copy half. */
async function myTurnCards(): Promise<Map<string, MyTurnCard>> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  const byPrId = new Map<number, MyTurnCard>();
  for (const c of insights.cards as InsightCard[]) {
    if (c.kind !== 'my_turn') continue;
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

  const { accounts, repos, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null and getMyTurn short-circuit to an all-empty response — every assertion below
  // would then be vacuously 0 === 0.
  await db
    .update(accounts)
    .set({ githubLogin: VIEWER_LOGIN })
    .where(eq(accounts.id, 1))
    .execute();

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dev');
  // ⚠ The GLOBAL `users.isBot` set, which is what the rule resolves bot-ness with — not the
  // workspace's automated-reviewer union, which needs a workspaceId `getMyTurn`'s unscoped form
  // (the browser-notification watcher) does not have.
  botId = await insertUser('dependabot', true);

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_ball',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  // ── S2: never touched ────────────────────────────────────────────────────────────────────
  await seedPr('untouched');

  // ── X1: I acted, nothing since ───────────────────────────────────────────────────────────
  await addReview(await seedPr('i-approved'), viewerId, 'approved', MY_ACTION, 'approved');
  // A BARE `commented` review — no body, no event row in production. The single most important
  // negative in this file (see the header, point 2).
  await addReview(
    await seedPr('i-commented-review'),
    viewerId,
    'commented',
    MY_ACTION,
    'commented',
  );
  await addPrComment(await seedPr('i-pr-commented'), viewerId, MY_ACTION, 'mine');
  await addCommit(await seedPr('i-pushed'), viewerId, MY_ACTION, 'mine');

  // ── S3c: I acted, a HUMAN pushed after ───────────────────────────────────────────────────
  {
    const id = await seedPr('human-commit-after');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'hca');
    await addCommit(id, aliceId, AFTER_ME, 'hca1');
    await addCommit(id, aliceId, AFTER_ME + HOUR, 'hca2');
  }

  // ── NOT the ball: a BOT commented after me ───────────────────────────────────────────────
  {
    const id = await seedPr('bot-comment-after');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'bca');
    await addPrComment(id, botId, AFTER_ME, 'bot');
  }

  // ── NOT the ball: a BOT pushed after me (the Chronology divergence) ──────────────────────
  {
    const id = await seedPr('bot-commit-after');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'bcm');
    await addCommit(id, botId, AFTER_ME, 'bot1');
  }

  // ── NOT the ball: a HUMAN commented after me. Recency is not relatedness. ────────────────
  {
    const id = await seedPr('human-comment-after');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'hcm');
    await addPrComment(id, aliceId, AFTER_ME, 'alice');
  }

  // ── NOT the ball: a commit whose author sync could not map. Unproven is not human. ───────
  {
    const id = await seedPr('null-author-commit-after');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'nac');
    await addCommit(id, null, AFTER_ME, 'orphan');
  }

  // ── The boundary: a human commit at the SAME instant as my action is NOT "after" me. ─────
  {
    const id = await seedPr('human-commit-same-instant');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'same');
    await addCommit(id, aliceId, MY_ACTION, 'same');
  }

  // ── S3b: a thread I opened that went `likely_addressed`, with MY comment last ────────────
  // Its PR gets a review of mine so the "New PRs" section cannot also claim it — the thread has
  // to be the reason the card exists, or the assertion proves nothing.
  {
    const id = await seedPr('my-thread-addressed');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'thr');
    const [thread] = await db
      .insert(schema.reviewThreads)
      .values({
        githubNodeId: 'TH_addressed',
        prId: id,
        path: 'src/server.ts',
        line: 12,
        isResolved: false,
        derivedState: 'likely_addressed',
        originalCommenterId: viewerId,
        createdAt: new Date(OPENED),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: 'RC_addressed',
        threadId: thread.id,
        prId: id,
        authorId: viewerId,
        body: 'this needs a null check',
        excerpt: 'this needs a null check',
        createdAt: new Date(MY_ACTION),
      })
      .execute();
  }

  // ── The control for S3b: my thread, MY comment last, still `untouched`. Nothing has moved. ──
  {
    const id = await seedPr('my-thread-untouched');
    await addReview(id, viewerId, 'approved', MY_ACTION, 'thr2');
    const [thread] = await db
      .insert(schema.reviewThreads)
      .values({
        githubNodeId: 'TH_untouched',
        prId: id,
        path: 'src/other.ts',
        line: 3,
        isResolved: false,
        derivedState: 'untouched',
        originalCommenterId: viewerId,
        createdAt: new Date(OPENED),
      })
      .returning()
      .execute();
    await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: 'RC_untouched',
        threadId: thread.id,
        prId: id,
        authorId: viewerId,
        body: 'same question here',
        excerpt: 'same question here',
        createdAt: new Date(MY_ACTION),
      })
      .execute();
  }

  // ── S4: finished Claude reviews, and what "not actioned" actually means ──────────────────
  // ⚠ The parent's `posted_at` is stamped ONLY by the whole-run post path. Posting findings one
  // at a time stamps the FINDING and never the run, which is why these cards were immortal:
  // 96 runs / 2 stamped against 287 findings / 62 stamped on the author's own dev DB.
  {
    const seedRun = async (key: string, prId: number): Promise<number> => {
      const [run] = await db
        .insert(schema.claudeReviews)
        .values({
          accountId: 1,
          prId,
          headSha: `head_${key}`,
          status: 'succeeded',
          model: 'claude-sonnet-5',
          createdAt: new Date(MY_ACTION),
          finishedAt: new Date(MY_ACTION),
        })
        .returning()
        .execute();
      return run.id;
    };
    const seedFinding = async (
      runId: number,
      tag: string,
      severity: string,
      included: boolean,
      posted: boolean,
    ): Promise<void> => {
      await db
        .insert(schema.claudeReviewFindings)
        .values({
          reviewId: runId,
          path: 'src/a.ts',
          line: 1,
          severity,
          title: tag,
          body: tag,
          included,
          postedAt: posted ? new Date(AFTER_ME) : null,
          githubCommentId: posted ? `GC_${tag}` : null,
        })
        .execute();
    };

    // ⚠ Each host PR gets a review of the viewer's, so the "New PRs" section cannot also claim
    // it: the Claude run must be the only thing these fixtures put on the plate.
    const seedActionedPr = async (key: string): Promise<number> => {
      const id = await seedPr(key);
      await addReview(id, viewerId, 'commented', MY_ACTION, key);
      return id;
    };

    // Nothing posted at all — the run was never worked. Stays, exactly as before.
    const fresh = await seedRun('fresh', await seedActionedPr('claude-fresh'));
    await seedFinding(fresh, 'fresh-1', 'warning', false, false);

    // Worked finding-by-finding: everything actionable posted, only a `praise` note left. This
    // is run 95 on the real dev DB, and the card that would not die.
    const worked = await seedRun('worked', await seedActionedPr('claude-worked'));
    await seedFinding(worked, 'worked-1', 'blocker', true, true);
    await seedFinding(worked, 'worked-praise', 'praise', true, false);

    // Worked, but a finding you TICKED is still unposted — you said you meant to send it.
    const partial = await seedRun('partial', await seedActionedPr('claude-partial'));
    await seedFinding(partial, 'partial-1', 'warning', true, true);
    await seedFinding(partial, 'partial-2', 'nit', true, false);

    // Worked, and the leftover is one you never ticked — a triage decision, not a task.
    const skipped = await seedRun('skipped', await seedActionedPr('claude-skipped'));
    await seedFinding(skipped, 'skipped-1', 'warning', true, true);
    await seedFinding(skipped, 'skipped-2', 'nit', false, false);
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and the repo belongs to no workspace and every fold is 0.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the ball rule decides which "New PRs" rows survive', () => {
  it('keeps a PR you have never touched (S2)', async () => {
    const rows = await newPrRows();
    expect(rows.has('untouched')).toBe(true);
    expect(rows.get('untouched')!.ball?.kind).toBe('untouched');
  });

  it('drops a PR you acted on with nothing since (X1) — every channel counts as acting', async () => {
    const rows = await newPrRows();
    // ⚠ `i-commented-review` is the one that matters most: a bodiless `commented` review writes
    // NO `review_submitted` event, so an events-based rule keeps this card and reproduces the bug.
    for (const key of ['i-approved', 'i-commented-review', 'i-pr-commented', 'i-pushed']) {
      expect([key, rows.has(key)]).toEqual([key, false]);
    }
  });

  it('brings a PR back when a HUMAN pushes after your action (S3c)', async () => {
    const rows = await newPrRows();
    const row = rows.get('human-commit-after');
    expect(row).toBeDefined();
    expect(row!.ball).toEqual({
      kind: 'commits_after',
      yourLastAction: 'approved',
      humanCommitsAfter: 2,
      pusherId: aliceId,
    });
    // The clock is the PUSH, not `openedAt` — a row dated off the open time says "29d ago" about
    // something that happened an hour after your review.
    expect(Date.parse(row!.since!)).toBe(AFTER_ME + HOUR);
  });

  it('does NOT bring a PR back for any BOT action', async () => {
    const rows = await newPrRows();
    // Two channels, deliberately. A rule that filtered bot comments and forgot bot pushes would
    // pass half of this and still re-summon you for every dependency bump.
    expect(rows.has('bot-comment-after')).toBe(false);
    expect(rows.has('bot-commit-after')).toBe(false);
  });

  it('does NOT bring a PR back for a human COMMENT — recency is not relatedness', async () => {
    const rows = await newPrRows();
    expect(rows.has('human-comment-after')).toBe(false);
  });

  it('does NOT treat an unattributable commit as a human push', async () => {
    const rows = await newPrRows();
    // `commits.author_id` is null when sync could not map the GitHub author. "A person pushed
    // this" is then unproven, and an unproven push must not summon you.
    expect(rows.has('null-author-commit-after')).toBe(false);
  });

  it('requires the commit to be strictly AFTER your action, not at the same instant', async () => {
    const rows = await newPrRows();
    expect(rows.has('human-commit-same-instant')).toBe(false);
  });
});

describe('the ball rule on threads you opened', () => {
  it('admits a thread that went likely_addressed with you last (S3b)', async () => {
    const mt = await q.getMyTurn(1, scope);
    const item = mt.threadsAwaiting.find((t: any) => t.path === 'src/server.ts');
    expect(item).toBeDefined();
    expect(item.awaitingKind).toBe('likely_addressed');
    // The last comment is YOUR OWN. That is exactly why the row needs its own wording.
    expect(item.lastReplyAuthorId).toBe(viewerId);
  });

  it('leaves an untouched thread of yours alone — nothing has happened on it', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.threadsAwaiting.find((t: any) => t.path === 'src/other.ts')).toBeUndefined();
  });

  it('drops a thread whose PR has merged — X1, which this section never applied', async () => {
    // ⚠ The predicate was missing and a stored dismissal was hiding it: on the author's own dev
    // DB this section returned 31 threads, all 31 on merged or closed PRs. There is no action
    // owed on a thread whose PR has landed.
    const before = await q.getMyTurn(1, scope);
    expect(before.threadsAwaiting.find((t: any) => t.path === 'src/server.ts')).toBeDefined();
    const { pullRequests } = schema;
    const { eq } = await import('drizzle-orm');
    const prId = prIdByKey.get('my-thread-addressed')!;
    await db
      .update(pullRequests)
      .set({ state: 'merged' })
      .where(eq(pullRequests.id, prId))
      .execute();
    const after = await q.getMyTurn(1, scope);
    expect(after.threadsAwaiting.find((t: any) => t.path === 'src/server.ts')).toBeUndefined();
    await db
      .update(pullRequests)
      .set({ state: 'open' })
      .where(eq(pullRequests.id, prId))
      .execute();
  });

  it('words the two thread cases apart — a likely_addressed row never claims a reply', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const card = (insights.cards as InsightCard[]).find(
      (c): c is MyTurnCard => c.kind === 'my_turn' && c.reason === 'thread',
    );
    expect(card).toBeDefined();
    expect(card!.detail).toBe(
      'A later commit touched src/server.ts — check it answers your comment',
    );
    // ⚠ It must not say the thread was ADDRESSED: `likely_addressed` is a heuristic that an
    // unrelated edit or a rename also produces, and the copy has to keep saying so.
    expect(card!.detail).not.toMatch(/replied|addressed|resolved/i);
  });
});

describe('a surviving card says why the ball is yours', () => {
  it('names your action and who pushed since', async () => {
    const cards = await myTurnCards();
    const card = cards.get('human-commit-after');
    expect(card).toBeDefined();
    expect(card!.detail).toBe('You approved · @alice-dev pushed 2 commits since');
  });

  it('still says "New PR" for the one case where that is true', async () => {
    const cards = await myTurnCards();
    const card = cards.get('untouched');
    expect(card).toBeDefined();
    expect(card!.detail).toMatch(/^New PR from @alice-dev · /);
  });
});

describe('dropping seeds keeps the cap disclosure arithmetically true', () => {
  it('moves myTurnTotal with the population, and it equals the cards painted', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const painted = (insights.cards as InsightCard[]).filter((c) => c.kind === 'my_turn').length;
    // Three survivors: the untouched PR, the human-pushed-after PR, and the likely_addressed
    // thread. Every other fixture is a negative.
    expect(painted).toBe(3);
    // ⚠ THE WHOLE POINT OF FILTERING SEEDS RATHER THAN CARDS. `myTurnTotal` is measured after
    // seed assembly and before the 50-slice, so a dropped seed leaves numerator and denominator
    // in step. Under the cap this is an equality; above it, it is what makes "50 of 148" true.
    expect(insights.myTurnTotal).toBe(painted);
    // The three-way relevance split stays exhaustive over the same (post-drop) population.
    expect(
      (insights.myTurnDirectTotal ?? 0) +
        (insights.myTurnMaintainedTotal ?? 0) +
        (insights.myTurnOtherTotal ?? 0),
    ).toBe(insights.myTurnTotal);
  });
});

describe('a finished Claude review retires when there is nothing left to do (S4)', () => {
  const runsByPr = async (): Promise<Map<string, boolean>> => {
    const rows = await q.getUnactionedClaudeReviews(1);
    const live = new Set<number>(rows.map((r: any) => r.prId));
    const out = new Map<string, boolean>();
    for (const key of ['claude-fresh', 'claude-worked', 'claude-partial', 'claude-skipped']) {
      out.set(key, live.has(prIdByKey.get(key)!));
    }
    return out;
  };

  it('keeps a run nothing has been posted from', async () => {
    // ⚠ The branch that stops `included` from retiring every fresh run: the column defaults to
    // false, so a rule that required a ticked finding would retire a run the moment it finished.
    expect((await runsByPr()).get('claude-fresh')).toBe(true);
  });

  it('retires a run whose only unposted finding is praise, even with a NULL parent posted_at', async () => {
    // The real defect: the per-finding post route stamps the FINDING and never the run, so
    // `postedAt != null` on the parent said "never actioned" about a run five comments deep.
    expect((await runsByPr()).get('claude-worked')).toBe(false);
  });

  it('keeps a worked run with a finding you ticked and have not posted', async () => {
    expect((await runsByPr()).get('claude-partial')).toBe(true);
  });

  it('retires a worked run whose leftover you never ticked — that is a triage decision', async () => {
    expect((await runsByPr()).get('claude-skipped')).toBe(false);
  });
});

describe('lastActionClocks reads the columns, not the event log', () => {
  it('reports your newest action across all four channels, and the human push after it', async () => {
    const ids = [...prIdByKey.values()];
    const clocks = await q.lastActionClocks(viewerId, ids);
    expect(clocks.size).toBe(ids.length);

    const untouched = clocks.get(prIdByKey.get('untouched')!);
    expect(untouched.mineLast).toBeNull();
    expect(untouched.mineLastAction).toBeNull();

    const commented = clocks.get(prIdByKey.get('i-commented-review')!);
    expect(commented.mineLast.getTime()).toBe(MY_ACTION);
    expect(commented.mineLastAction).toBe('reviewed');

    const pushed = clocks.get(prIdByKey.get('i-pushed')!);
    expect(pushed.mineLastAction).toBe('pushed');

    const hca = clocks.get(prIdByKey.get('human-commit-after')!);
    expect(hca.humanCommitsAfterMine).toBe(2);
    expect(hca.lastHumanCommitAuthorId).toBe(aliceId);
    expect(hca.othersHumanCommitLast.getTime()).toBe(AFTER_ME + HOUR);

    // A bot push is not counted on EITHER field — `othersHumanCommitLast` is the human clock.
    const bcm = clocks.get(prIdByKey.get('bot-commit-after')!);
    expect(bcm.humanCommitsAfterMine).toBe(0);
    expect(bcm.othersHumanCommitLast).toBeNull();
  });

  it('answers an empty id list without touching the database', async () => {
    const clocks = await q.lastActionClocks(viewerId, []);
    expect(clocks.size).toBe(0);
  });
});
