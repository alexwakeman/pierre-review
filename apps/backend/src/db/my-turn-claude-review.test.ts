// THE "CLAUDE REVIEW READY" CARD UNDER THE BALL RULE, and the AUTO-review half of core, on a
// THROWAWAY sqlite DB (the my-turn-ball.test.ts pattern).
//
// WHAT THIS PINS:
//   1. ⚠ ACTING ON THE PR RETIRES THE CARD. The card used to retire only on Claude-Review-internal
//      stamps (posted_at), so approving the PR — from the pane or from github.com — left it up
//      (real: PR #335, run 110, approved one minute after the run finished). Any action of yours
//      at or after `finishedAt` discharges it; an action BEFORE the run finished does not.
//   2. ⚠ A BOT ACTION NEVER DISCHARGES IT — the ball rule's standing exception.
//   3. AN AUTO RUN IS OWNED LIKE A MANUAL ONE. This account's workspace switched it on, so its card
//      shows exactly as a clicked run's does; `trigger` rides the card for the "Auto review" label.
//   4. `getAutoReviewCandidates` — the sweeper's population: open, not draft, opened at/after the
//      switch-on, a PERSON under the WORKSPACE's judgement (manual "human" wins over the global bot
//      flag, and a manual "bot" wins over a clean user row), and no claude_reviews row of any kind;
//      plus `reReview` — the same population, already reviewed (a SUCCEEDED run), whose head moved
//      past every run, with no run in flight.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-my-turn-claude-review-test.sqlite`;
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
const REPO_ADDED = now - 30 * DAY;
const OPENED = REPO_ADDED + DAY;
const BEFORE_RUN = OPENED + DAY;
const RUN_DONE = BEFORE_RUN + HOUR;
const AFTER_RUN = RUN_DONE + HOUR;

let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let botId = 0;
let prNumber = 1;
const prIdByKey = new Map<string, number>();

async function seedPr(
  key: string,
  opts: { authorId?: number | null; isDraft?: boolean; openedAt?: number; state?: string } = {},
): Promise<number> {
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_cr_${key}`,
      accountId: 1,
      repoId,
      number: prNumber++,
      title: `${key} fixture`,
      state: opts.state ?? 'open',
      isDraft: opts.isDraft ?? false,
      authorId: opts.authorId === undefined ? aliceId : opts.authorId,
      headSha: `head_${key}`,
      openedAt: new Date(opts.openedAt ?? OPENED),
      updatedAt: new Date(opts.openedAt ?? OPENED),
    })
    .returning()
    .execute();
  prIdByKey.set(key, pr.id);
  return pr.id;
}

async function addReview(prId: number, authorId: number, at: number, tag: string): Promise<void> {
  await db
    .insert(schema.reviews)
    .values({ githubNodeId: `RV_${tag}`, prId, authorId, state: 'approved', submittedAt: new Date(at) })
    .execute();
}

async function addPrComment(prId: number, authorId: number, at: number, tag: string): Promise<void> {
  await db
    .insert(schema.prComments)
    .values({ githubNodeId: `PC_${tag}`, prId, authorId, body: 'x', createdAt: new Date(at) })
    .execute();
}

async function seedRun(
  prId: number,
  key: string,
  trigger: 'manual' | 'auto' = 'manual',
  finishedAt = RUN_DONE,
): Promise<void> {
  await db
    .insert(schema.claudeReviews)
    .values({
      accountId: 1,
      prId,
      headSha: `head_${key}`,
      status: 'succeeded',
      model: 'claude-opus-5-5',
      trigger,
      createdAt: new Date(finishedAt - HOUR / 2),
      finishedAt: new Date(finishedAt),
    })
    .execute();
}

/** Which fixture PRs carry a "Claude review ready" item right now. */
async function claudeKeys(): Promise<Set<string>> {
  const mt = await q.getMyTurn(1, scope);
  const ids = new Set<number>(mt.claudeReviewsToAction.map((c: any) => c.prId));
  const out = new Set<string>();
  for (const [k, id] of prIdByKey) if (ids.has(id)) out.add(k);
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
  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser('viewer-me');
  aliceId = await insertUser('alice-dev');
  botId = await insertUser('dependabot', true);

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_cr',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  repoId = repo.id;

  // ── The ball rule over manual runs ──
  {
    // You reviewed before the run, then approved after it finished: discharged (PR #335).
    const id = await seedPr('acted-after');
    await addReview(id, viewerId, BEFORE_RUN, 'aa0');
    await seedRun(id, 'acted-after');
    await addReview(id, viewerId, AFTER_RUN, 'aa1');
  }
  {
    // You commented after the run (PR #19's shape: findings posted as comments of yours).
    const id = await seedPr('commented-after');
    await seedRun(id, 'commented-after');
    await addPrComment(id, viewerId, AFTER_RUN, 'ca');
  }
  {
    // Your only action predates the run: still yours.
    const id = await seedPr('acted-before');
    await addReview(id, viewerId, BEFORE_RUN, 'ab');
    await seedRun(id, 'acted-before');
  }
  {
    // Never touched: still yours.
    const id = await seedPr('untouched');
    await seedRun(id, 'untouched');
  }
  {
    // Only a BOT acted after the run: still yours.
    const id = await seedPr('bot-after');
    await addReview(id, viewerId, BEFORE_RUN, 'ba0');
    await seedRun(id, 'bot-after');
    await addPrComment(id, botId, AFTER_RUN, 'ba');
    await db
      .insert(schema.commits)
      .values({ sha: 'sha_ba', prId: id, authorId: botId, committedAt: new Date(AFTER_RUN) })
      .execute();
  }

  // ── AUTO runs: owned by the account whose workspace switched them on ──
  // Someone else's PR, nobody asked you to review it: still your card.
  await seedRun(await seedPr('auto-stranger'), 'auto-stranger', 'auto');
  await seedRun(await seedPr('auto-mine', { authorId: viewerId }), 'auto-mine', 'auto');
  {
    // The ball rule still applies: you reviewed after the auto run finished.
    const id = await seedPr('auto-acted-after');
    await seedRun(id, 'auto-acted-after', 'auto');
    await addReview(id, viewerId, AFTER_RUN, 'aaa');
  }
  {
    // Only a bot acted after it: still yours.
    const id = await seedPr('auto-bot-after');
    await seedRun(id, 'auto-bot-after', 'auto');
    await addPrComment(id, botId, AFTER_RUN, 'aba');
  }

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the Claude review card follows the ball rule', () => {
  it('retires when you act on the PR after the run finished', async () => {
    const keys = await claudeKeys();
    expect(keys.has('acted-after')).toBe(false);
    expect(keys.has('commented-after')).toBe(false);
  });

  it('stays when your only action came before the run finished', async () => {
    const keys = await claudeKeys();
    expect(keys.has('acted-before')).toBe(true);
    expect(keys.has('untouched')).toBe(true);
  });

  it('stays when only a bot acted after the run', async () => {
    expect((await claudeKeys()).has('bot-after')).toBe(true);
  });

  it('filters the SEEDS: the retired cards leave the Pending counts too', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const claudeCards = insights.cards.filter(
      (c: any) => c.kind === 'my_turn' && c.reason === 'claude_review',
    );
    const ids = new Set(claudeCards.map((c: any) => c.prId));
    expect(ids.has(prIdByKey.get('acted-after'))).toBe(false);
    expect(ids.has(prIdByKey.get('acted-before'))).toBe(true);
  });
});

describe('the Claude reviews tab', () => {
  it('lists every Claude review card and none in My turn; My turn’s totals leave them out', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    const { rankPendingTabs } = await import('./pending-tabs.js');
    const board = await rankPendingTabs(1, scope, insights);
    const mt = insights.cards.filter((c: any) => c.kind === 'my_turn');
    const claude = mt.filter((c: any) => c.reason === 'claude_review').map((c: any) => c.id);
    const others = mt.filter((c: any) => c.reason !== 'claude_review').map((c: any) => c.id);
    expect(claude.length).toBeGreaterThan(0); // non-vacuous
    const tab = (k: string) => board.tabs.find((t: any) => t.key === k)!;
    expect([...tab('claude').cardIds].sort()).toEqual([...claude].sort());
    expect([...tab('my_turn').cardIds].sort()).toEqual([...others].sort());
    expect(tab('claude').total).toBe(claude.length);
    expect(tab('my_turn').total).toBe(others.length);
    // The fold's own totals are My turn's population — what the brief and the badges count.
    expect(insights.myTurnTotal).toBe(others.length);
    expect(insights.kindTotals!.my_turn).toBe(others.length);
  });

  it('keeps them in GET /api/my-turn, so the reader is still notified', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.claudeReviewsToAction.length).toBeGreaterThan(0);
  });
});

describe('an AUTO run is owned like a manual one', () => {
  it('raises the card on a PR you neither wrote nor were asked to review', async () => {
    const keys = await claudeKeys();
    expect(keys.has('auto-stranger')).toBe(true);
    expect(keys.has('auto-mine')).toBe(true);
  });

  it('still follows the ball rule: your action after the run clears it, a bot\'s does not', async () => {
    const keys = await claudeKeys();
    expect(keys.has('auto-acted-after')).toBe(false);
    expect(keys.has('auto-bot-after')).toBe(true);
  });

  it('marks the item as an auto run', async () => {
    const mt = await q.getMyTurn(1, scope);
    const item = mt.claudeReviewsToAction.find(
      (c: any) => c.prId === prIdByKey.get('auto-stranger'),
    );
    expect(item?.trigger).toBe('auto');
  });

  it('carries the trigger onto the Pending card, for the "Auto review" chip', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const byPr = new Map(
      insights.cards
        .filter((c: any) => c.kind === 'my_turn' && c.reason === 'claude_review')
        .map((c: any) => [c.prId, c]),
    );
    expect((byPr.get(prIdByKey.get('auto-stranger')) as any)?.trigger).toBe('auto');
    expect((byPr.get(prIdByKey.get('untouched')) as any)?.trigger).toBe('manual');
  });

  it('keeps auto runs in the unscoped read (the notification watcher\'s)', async () => {
    const rows = await q.getUnactionedClaudeReviews(1);
    const ids = new Set(rows.map((r: any) => r.prId));
    expect(ids.has(prIdByKey.get('auto-stranger'))).toBe(true);
    expect(ids.has(prIdByKey.get('untouched'))).toBe(true);
  });
});

describe('getAutoReviewCandidates — the sweeper’s population', () => {
  const FLOOR = OPENED + 10 * DAY;
  let wsId = 0;
  const cand: Record<string, number> = {};

  beforeAll(async () => {
    wsId = scope.workspaceId;
    const late = FLOOR + HOUR;
    cand.fresh = await seedPr('c-fresh', { openedAt: late });
    cand.old = await seedPr('c-old', { openedAt: FLOOR - HOUR });
    cand.draft = await seedPr('c-draft', { openedAt: late, isDraft: true });
    cand.closed = await seedPr('c-closed', { openedAt: late, state: 'closed' });
    cand.bot = await seedPr('c-bot', { openedAt: late, authorId: botId });
    cand.unmapped = await seedPr('c-unmapped', { openedAt: late, authorId: null });
    cand.reviewed = await seedPr('c-reviewed', { openedAt: late });
    await seedRun(cand.reviewed, 'c-reviewed', 'manual');
    // A FAILED run settles it too: one review per PR, ever, from auto.
    cand.failed = await seedPr('c-failed', { openedAt: late });
    await db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1,
        prId: cand.failed,
        headSha: 'x',
        status: 'failed',
        model: 'm',
        trigger: 'auto',
      })
      .execute();
    // A workspace judgement: a flagged-bot user who is really a person, and a clean user row the
    // workspace marked as automation. The manual judgement wins both ways.
    const [person] = await db
      .insert(schema.users)
      .values({ githubLogin: 'ci-person', githubNodeId: 'U_cip', isBot: true })
      .returning()
      .execute();
    const [machine] = await db
      .insert(schema.users)
      .values({ githubLogin: 'house-robot', githubNodeId: 'U_hr', isBot: false })
      .returning()
      .execute();
    cand.judgedHuman = await seedPr('c-judged-human', { openedAt: late, authorId: person.id });
    cand.judgedBot = await seedPr('c-judged-bot', { openedAt: late, authorId: machine.id });
    const { workspaceReviewers } = schema;
    await db
      .insert(workspaceReviewers)
      .values([
        {
          accountId: 1,
          workspaceId: wsId,
          authorUserId: person.id,
          automated: false,
          confidence: 'high',
          source: 'manual',
        },
        {
          accountId: 1,
          workspaceId: wsId,
          authorUserId: machine.id,
          automated: true,
          confidence: 'high',
          source: 'manual',
        },
      ])
      .execute();
  });

  it('lists open, non-draft, human PRs opened at/after the floor with no run', async () => {
    const res = await q.getAutoReviewCandidates(1, wsId, {
      openedSinceMs: FLOOR,
      dayStartMs: now - DAY,
      limit: 50,
    });
    const got = new Set(res.prIds);
    expect(got.has(cand.fresh)).toBe(true);
    expect(got.has(cand.judgedHuman)).toBe(true);
    for (const k of ['old', 'draft', 'closed', 'bot', 'unmapped', 'reviewed', 'failed', 'judgedBot'])
      expect([k, got.has(cand[k])]).toEqual([k, false]);
  });

  it('counts only AUTO runs created since the day start', async () => {
    const res = await q.getAutoReviewCandidates(1, wsId, {
      openedSinceMs: FLOOR,
      dayStartMs: 0,
      limit: 0,
    });
    // four auto succeeded runs from the card fixtures + the failed auto one
    expect(res.autoToday).toBe(5);
    expect(res.prIds).toEqual([]);
  });

  it('answers null for a workspace the account does not own', async () => {
    expect(
      await q.getAutoReviewCandidates(1, 99999, { openedSinceMs: 0, dayStartMs: 0, limit: 5 }),
    ).toBeNull();
  });
});

describe('getAutoReviewCandidates — re-review of a moved head', () => {
  const FLOOR = OPENED + 20 * DAY;
  const late = FLOOR + HOUR;
  const r: Record<string, number> = {};
  const run = async (prId: number, headSha: string, status: string, createdAtMs?: number) =>
    db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1,
        prId,
        headSha,
        status,
        model: 'm',
        trigger: 'auto',
        ...(createdAtMs != null ? { createdAt: new Date(createdAtMs) } : {}),
      })
      .execute();

  beforeAll(async () => {
    r.moved = await seedPr('rr-moved', { openedAt: late });
    await run(r.moved, 'old_sha', 'succeeded');
    r.same = await seedPr('rr-same', { openedAt: late });
    await run(r.same, 'head_rr-same', 'succeeded');
    r.onlyFailed = await seedPr('rr-only-failed', { openedAt: late });
    await run(r.onlyFailed, 'old_sha', 'failed');
    r.headHasRun = await seedPr('rr-head-has-run', { openedAt: late });
    await run(r.headHasRun, 'old_sha', 'succeeded');
    await run(r.headHasRun, 'head_rr-head-has-run', 'failed');
    r.inFlight = await seedPr('rr-in-flight', { openedAt: late });
    await run(r.inFlight, 'old_sha', 'succeeded');
    await run(r.inFlight, 'older_sha', 'running');
    // Opened before the switch, reviewed only before it: never followed.
    r.beforeFloor = await seedPr('rr-before-floor', { openedAt: FLOOR - HOUR });
    await run(r.beforeFloor, 'old_sha', 'succeeded', FLOOR - HOUR / 2);
    // Opened before the switch but reviewed SINCE it: followed like any other PR.
    r.beforeFloorReviewedSince = await seedPr('rr-before-floor-since', { openedAt: FLOOR - HOUR });
    await run(r.beforeFloorReviewedSince, 'old_sha', 'succeeded', FLOOR + HOUR);
    r.bot = await seedPr('rr-bot', { openedAt: late, authorId: botId });
    await run(r.bot, 'old_sha', 'succeeded');
  });

  it('offers only a reviewed PR whose head moved past every run, with nothing in flight', async () => {
    const res = await q.getAutoReviewCandidates(1, scope.workspaceId, {
      openedSinceMs: FLOOR,
      dayStartMs: now - DAY,
      limit: 50,
    });
    const offered = new Map(res.reReview.map((x: any) => [x.prId, x.headSha]));
    expect(offered.get(r.moved)).toBe('head_rr-moved');
    expect(offered.get(r.beforeFloorReviewedSince)).toBe('head_rr-before-floor-since');
    // A PR whose only run is a FAILED AUTO run at an older head: the new head is offered (it used
    // to be never reviewed again — not a first review, not a retry, never succeeded).
    expect(offered.get(r.onlyFailed)).toBe('head_rr-only-failed');
    // Still never a FIRST review: the floor gates those.
    expect(res.prIds).not.toContain(r.beforeFloorReviewedSince);
    for (const k of ['same', 'headHasRun', 'inFlight', 'beforeFloor', 'bot'])
      expect([k, offered.has(r[k])]).toEqual([k, false]);
    // A reviewed PR is never a FIRST-review candidate.
    expect(res.prIds).not.toContain(r.moved);
  });
});

describe('getAutoReviewCandidates — retry of a failed auto run at the current head', () => {
  const FLOOR = OPENED + 25 * DAY;
  const late = FLOOR + HOUR;
  const r: Record<string, number> = {};
  const run = async (
    prId: number,
    headSha: string,
    status: string,
    o: { trigger?: 'auto' | 'manual'; error?: string; provider?: string; finishedAtMs?: number } = {},
  ) =>
    db
      .insert(schema.claudeReviews)
      .values({
        accountId: 1,
        prId,
        headSha,
        status,
        model: 'm',
        trigger: o.trigger ?? 'auto',
        error: o.error ?? null,
        provider: o.provider ?? null,
        ...(o.finishedAtMs != null ? { finishedAt: new Date(o.finishedAtMs) } : {}),
      })
      .execute();

  beforeAll(async () => {
    // A FIRST auto review that failed (the live case: Codex's usage limit).
    r.firstFailed = await seedPr('rt-first-failed', { openedAt: late });
    await run(r.firstFailed, 'head_rt-first-failed', 'failed', {
      error: 'Codex could not finish: You’ve hit your usage limit.',
      provider: 'codex',
      finishedAtMs: late + HOUR,
    });
    // Two failed auto attempts at the head: attempts = 2.
    r.twice = await seedPr('rt-twice', { openedAt: late });
    await run(r.twice, 'head_rt-twice', 'failed', { error: 'overloaded' });
    await run(r.twice, 'head_rt-twice', 'failed', { error: 'overloaded' });
    // A re-review at a moved head that failed (a succeeded run on the old head).
    r.reFailed = await seedPr('rt-re-failed', { openedAt: late });
    await run(r.reFailed, 'old_sha', 'succeeded');
    await run(r.reFailed, 'head_rt-re-failed', 'failed', { error: 'interrupted by restart' });
    // Not retries: a succeeded run at the head is final; a MANUAL failure; a reader's Stop; a
    // failure at an OLD head; a run in flight; a failure on a PR opened before the floor.
    r.succeededAfter = await seedPr('rt-succeeded', { openedAt: late });
    await run(r.succeededAfter, 'head_rt-succeeded', 'failed', { error: 'overloaded' });
    await run(r.succeededAfter, 'head_rt-succeeded', 'succeeded');
    r.manual = await seedPr('rt-manual', { openedAt: late });
    await run(r.manual, 'head_rt-manual', 'failed', { trigger: 'manual', error: 'overloaded' });
    r.stopped = await seedPr('rt-stopped', { openedAt: late });
    await run(r.stopped, 'head_rt-stopped', 'cancelled');
    r.oldHead = await seedPr('rt-old-head', { openedAt: late });
    await run(r.oldHead, 'old_sha', 'failed', { error: 'overloaded' });
    r.inFlight = await seedPr('rt-in-flight', { openedAt: late });
    await run(r.inFlight, 'head_rt-in-flight', 'failed', { error: 'overloaded' });
    await run(r.inFlight, 'head_rt-in-flight', 'running');
    r.beforeFloor = await seedPr('rt-before-floor', { openedAt: FLOOR - HOUR });
    await run(r.beforeFloor, 'head_rt-before-floor', 'failed', { error: 'overloaded' });
    // A failed first auto review at an OLDER head (the author pushed since) — and its neighbours
    // that must not be followed: a manual failure, a reader's Stop, a PR opened before the floor.
    r.oldManual = await seedPr('rt-old-manual', { openedAt: late });
    await run(r.oldManual, 'old_sha', 'failed', { trigger: 'manual', error: 'overloaded' });
    r.oldStopped = await seedPr('rt-old-stopped', { openedAt: late });
    await run(r.oldStopped, 'old_sha', 'cancelled');
    r.oldBeforeFloor = await seedPr('rt-old-before-floor', { openedAt: FLOOR - HOUR });
    await run(r.oldBeforeFloor, 'old_sha', 'failed', { error: 'overloaded' });
    // A review SUCCEEDED at the head, then a comment-triggered auto re-review at the same head
    // failed: never retried by itself (a success at the head is final), but a press retries it.
    r.sameHeadAfterSuccess = await seedPr('rt-same-after-success', { openedAt: late });
    await run(r.sameHeadAfterSuccess, 'head_rt-same-after-success', 'succeeded', { trigger: 'manual' });
    await run(r.sameHeadAfterSuccess, 'head_rt-same-after-success', 'failed', { error: 'overloaded' });
  });

  it('lists only a failed AUTO run that is still the latest at the head, with the attempt count', async () => {
    const res = await q.getAutoReviewCandidates(1, scope.workspaceId, {
      openedSinceMs: FLOOR,
      dayStartMs: now - DAY,
      limit: 50,
    });
    const byPr = new Map(res.retry.map((x: any) => [x.prId, x]));
    expect(byPr.get(r.firstFailed)).toMatchObject({
      headSha: 'head_rt-first-failed',
      attempts: 1,
      provider: 'codex',
      error: 'Codex could not finish: You’ve hit your usage limit.',
      failedAtMs: late + HOUR,
    });
    expect(byPr.get(r.twice)).toMatchObject({ attempts: 2, provider: 'claude', error: 'overloaded' });
    expect(byPr.get(r.reFailed)).toMatchObject({ headSha: 'head_rt-re-failed', attempts: 1 });
    for (const k of ['succeededAfter', 'manual', 'stopped', 'oldHead', 'inFlight', 'beforeFloor'])
      expect([k, byPr.has(r[k])]).toEqual([k, false]);
    // A failed PR is still never a FIRST-review candidate (it has a row).
    expect(res.prIds).not.toContain(r.firstFailed);
  });

  // A FAILED FIRST auto review, then the author pushed: nothing at the new head, nothing ever
  // succeeded. It is not a first review (it has a row), not a retry (nothing at this head) — it is
  // offered as a MOVED HEAD (the sweeper's settle wait applies), in the first-review population.
  it('a failed first auto review followed by new commits is offered as a moved head', async () => {
    const res = await q.getAutoReviewCandidates(1, scope.workspaceId, {
      openedSinceMs: FLOOR,
      dayStartMs: now - DAY,
      limit: 50,
    });
    const head = res.reReview.find((x: any) => x.prId === r.oldHead);
    expect(head).toMatchObject({ headSha: 'head_rt-old-head', reason: 'head', commentsAtMs: null });
    expect(typeof head?.lastRunAtMs).toBe('number');
    const reIds = res.reReview.map((x: any) => x.prId);
    // Not followed: a MANUAL failure or a reader's Stop at an older head, an auto failure on a PR
    // opened before the floor, and a run still in flight.
    for (const k of ['oldManual', 'oldStopped', 'oldBeforeFloor', 'inFlight'])
      expect([k, reIds.includes(r[k])]).toEqual([k, false]);
    expect(res.prIds).not.toContain(r.oldHead);
  });

  // RETRY ON ONE PR (`pressPrId`): what the AI Review tab shows Retry on, the read lists.
  it('a press on one PR lists its failed auto run whatever the floor or an earlier success at the head', async () => {
    const opts = { openedSinceMs: FLOOR, dayStartMs: now - DAY, limit: 50 };
    const base = await q.getAutoReviewCandidates(1, scope.workspaceId, opts);
    const baseRetry = base.retry.map((x: any) => x.prId);
    expect(baseRetry).not.toContain(r.sameHeadAfterSuccess);
    expect(baseRetry).not.toContain(r.beforeFloor);
    const afterSuccess = await q.getAutoReviewCandidates(1, scope.workspaceId, { ...opts, pressPrId: r.sameHeadAfterSuccess });
    expect(afterSuccess.retry.find((x: any) => x.prId === r.sameHeadAfterSuccess)).toMatchObject({
      headSha: 'head_rt-same-after-success',
      error: 'overloaded',
      attempts: 1,
    });
    const before = await q.getAutoReviewCandidates(1, scope.workspaceId, { ...opts, pressPrId: r.beforeFloor });
    expect(before.retry.map((x: any) => x.prId)).toContain(r.beforeFloor);
    // An older head, before the floor: the press offers the new head.
    const oldBefore = await q.getAutoReviewCandidates(1, scope.workspaceId, { ...opts, pressPrId: r.oldBeforeFloor });
    expect(oldBefore.reReview.map((x: any) => x.prId)).toContain(r.oldBeforeFloor);
    // The press waives nothing for a PR whose latest run is not a failed AUTO run.
    for (const k of ['manual', 'stopped', 'succeededAfter', 'oldManual']) {
      const res = await q.getAutoReviewCandidates(1, scope.workspaceId, { ...opts, pressPrId: r[k] });
      expect([k, res.retry.some((x: any) => x.prId === r[k]), res.reReview.some((x: any) => x.prId === r[k])]).toEqual([
        k,
        false,
        false,
      ]);
    }
  });
});
