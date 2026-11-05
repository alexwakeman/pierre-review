// MY TURN'S TWO AI REVIEW CARDS, and the AUTO-review half of core, on a THROWAWAY sqlite DB (the
// my-turn-ball.test.ts pattern).
//
// WHAT THIS PINS:
//   1. ⚠ "NEW AI REVIEW" (`claude_review`) IS SEEN-BASED, NOT THE BALL RULE. The newest succeeded full
//      run of your Limn on an open PR is a card until you SEE it (the AI Review tab showed it —
//      `markClaudeReviewSeen`) or dismiss it. Acting on the PR does NOT retire it: auto-posting posts
//      most runs under your own account, and the card used to vanish before you ever read the run.
//      A router skip, a closed PR and an older run under a newer one are never cards.
//   2. THE CARDS ARE MY TURN'S: listed in the My turn tab and counted in every My turn total.
//   3. AN AUTO RUN IS OWNED LIKE A MANUAL ONE. `trigger` rides the card for the "Auto review" label.
//   4. "MERGED AFTER YOUR LIMN APPROVED" (`ai_approved_merged`): a merged PR whose standing Limn
//      auto-approval was posted before the merge, until you open the PR after the merge or dismiss
//      it; never a withdrawn approval, an approval after the merge, or a merge older than 7 days.
//   5. `getAutoReviewCandidates` — the sweeper's population: open, not draft, opened at/after the
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
  extra: Record<string, unknown> = {},
): Promise<number> {
  const [row] = await db
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
      ...extra,
    })
    .returning()
    .execute();
  return row.id;
}

/** An auto-post record that LANDED an APPROVE at `at` as GitHub review `githubReviewId`. */
const approvePost = (githubReviewId: string, at: number, extra: Record<string, unknown> = {}) => ({
  status: 'posted',
  at: new Date(at).toISOString(),
  reason: null,
  error: null,
  findingIds: [],
  postedFindingIds: [],
  githubReviewId,
  verdict: { wanted: 'APPROVE', submitted: 'APPROVE', heldReason: null },
  ...extra,
});

/** Which fixture PRs carry a "Merged after your Limn approved" item right now. */
async function mergedKeys(): Promise<Set<string>> {
  const mt = await q.getMyTurn(1, scope);
  const ids = new Set<number>(mt.approvedMerged.map((c: any) => c.prId));
  const out = new Set<string>();
  for (const [k, id] of prIdByKey) if (ids.has(id)) out.add(k);
  return out;
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
  // The going-forward floor for "Merged after your Limn approved" sits before every fixture merge.
  await db.update(accounts).set({ githubLogin: 'viewer-me', approvedMergedSince: new Date(0) }).where(eq(accounts.id, 1)).execute();
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

  const { markClaudeReviewSeen } = await import('./claude-review-seen.js');

  // ── "New AI review": seen-based ──
  await seedRun(await seedPr('unseen'), 'unseen');
  {
    // Seen in the AI Review tab: retired.
    const id = await seedPr('seen');
    const run = await seedRun(id, 'seen');
    expect(await markClaudeReviewSeen(db, 1, id, run)).toBe(1);
    // A repeat stamps nothing.
    expect(await markClaudeReviewSeen(db, 1, id, run)).toBe(0);
  }
  {
    // You approved after the run finished — the ball rule would have retired it; seen does not.
    const id = await seedPr('acted-after');
    await addReview(id, viewerId, BEFORE_RUN, 'aa0');
    await seedRun(id, 'acted-after');
    await addReview(id, viewerId, AFTER_RUN, 'aa1');
    await addPrComment(id, viewerId, AFTER_RUN, 'ca');
  }
  {
    // An older run you saw, and a newer one you have not: the newer one is a card.
    const id = await seedPr('newer-run');
    const old = await seedRun(id, 'newer-old', 'manual', RUN_DONE - DAY);
    await markClaudeReviewSeen(db, 1, id, old);
    await seedRun(id, 'newer-new');
  }
  {
    // A newer run you SAW over an older one you did not: nothing (only the newest counts).
    const id = await seedPr('newest-seen');
    await seedRun(id, 'newest-seen-old', 'manual', RUN_DONE - DAY);
    const latest = await seedRun(id, 'newest-seen-new');
    await markClaudeReviewSeen(db, 1, id, latest);
  }
  // A router skip read nothing; a closed PR is not My Turn.
  await seedRun(await seedPr('skip'), 'skip', 'manual', RUN_DONE, { reviewMode: 'skip' });
  await seedRun(await seedPr('closed', { state: 'closed' }), 'closed');
  {
    // A Claude + Codex pair: seeing one half sees the pair.
    const id = await seedPr('pair');
    const first = await seedRun(id, 'pair-1', 'manual', RUN_DONE, { pairRole: 'first' });
    await db.update(schema.claudeReviews).set({ pairId: first }).where(eq(schema.claudeReviews.id, first)).execute();
    await seedRun(id, 'pair-2', 'manual', RUN_DONE + 60_000, { pairId: first, pairRole: 'second' });
    expect(await markClaudeReviewSeen(db, 1, id, first)).toBe(2);
  }

  // ── AUTO runs: owned by the account whose workspace switched them on ──
  // Someone else's PR, nobody asked you to review it: still your card.
  await seedRun(await seedPr('auto-stranger'), 'auto-stranger', 'auto');
  await seedRun(await seedPr('auto-mine', { authorId: viewerId }), 'auto-mine', 'auto');

  // ── "Merged after your Limn approved" ──
  const MERGED = now - DAY;
  const merged = async (key: string, mergedAt = MERGED): Promise<number> => {
    const id = await seedPr(key, { state: 'merged' });
    await db
      .update(schema.pullRequests)
      .set({ mergedAt: new Date(mergedAt), mergedById: aliceId })
      .where(eq(schema.pullRequests.id, id))
      .execute();
    return id;
  };
  const approvalRow = async (prId: number, dbId: string, state: string): Promise<void> => {
    await db
      .insert(schema.reviews)
      .values({ githubNodeId: `RV_lim_${dbId}`, prId, authorId: viewerId, state, databaseId: dbId, submittedAt: new Date(MERGED - HOUR) })
      .execute();
  };
  {
    const id = await merged('am-standing');
    await seedRun(id, 'am-standing', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('901', MERGED - HOUR) });
    await approvalRow(id, '901', 'approved');
  }
  {
    // No synced review row yet, and no withdrawal recorded: still standing.
    const id = await merged('am-unsynced');
    await seedRun(id, 'am-unsynced', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('902', MERGED - HOUR) });
  }
  {
    // GitHub says the approval was dismissed (Limn withdrew it).
    const id = await merged('am-withdrawn');
    await seedRun(id, 'am-withdrawn', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('903', MERGED - HOUR) });
    await approvalRow(id, '903', 'dismissed');
  }
  {
    // Opened after the merge: seen.
    const id = await merged('am-viewed');
    await seedRun(id, 'am-viewed', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('904', MERGED - HOUR) });
    await db.insert(schema.prViews).values({ prId: id, lastViewedAt: new Date(MERGED + HOUR) }).execute();
  }
  {
    // Opened only BEFORE the merge: still a card.
    const id = await merged('am-viewed-before');
    await seedRun(id, 'am-viewed-before', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('905', MERGED - HOUR) });
    await db.insert(schema.prViews).values({ prId: id, lastViewedAt: new Date(MERGED - HOUR / 2) }).execute();
  }
  {
    // Merged ten days ago: past the window.
    const id = await merged('am-old', now - 10 * DAY);
    await seedRun(id, 'am-old', 'auto', now - 11 * DAY, { autoPost: approvePost('906', now - 11 * DAY) });
  }
  {
    // A COMMENT, not an approval.
    const id = await merged('am-comment');
    await seedRun(id, 'am-comment', 'auto', MERGED - 2 * HOUR, {
      autoPost: approvePost('907', MERGED - HOUR, { verdict: { wanted: 'COMMENT', submitted: 'COMMENT', heldReason: null } }),
    });
  }
  {
    // An open PR the Limn approved: not merged, no card of this type.
    const id = await seedPr('am-open');
    await seedRun(id, 'am-open', 'auto', MERGED - 2 * HOUR, { autoPost: approvePost('908', MERGED - HOUR) });
  }

  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('"New AI review" is seen-based', () => {
  it('lists the newest unseen run per open PR — acting on the PR does not retire it', async () => {
    const keys = await claudeKeys();
    expect(keys.has('unseen')).toBe(true);
    expect(keys.has('acted-after')).toBe(true);
    expect(keys.has('newer-run')).toBe(true);
  });

  it('retires a run once seen — a pair by either half — and never lists a skip, a closed PR or an older run', async () => {
    const keys = await claudeKeys();
    for (const k of ['seen', 'newest-seen', 'skip', 'closed', 'pair']) expect([k, keys.has(k)]).toEqual([k, false]);
  });

  it('a dismissal hides it; a newer run brings it back', async () => {
    const { dismissMyTurn, restoreMyTurn } = await import('./my-turn-dismissals.js');
    const id = prIdByKey.get('unseen')!;
    await dismissMyTurn(1, { kind: 'pr', id });
    try {
      expect((await claudeKeys()).has('unseen')).toBe(false);
    } finally {
      await restoreMyTurn(1, { kind: 'pr', id });
    }
    expect((await claudeKeys()).has('unseen')).toBe(true);
  });
});

describe('the AI review cards are My turn’s', () => {
  it('lists them in the My turn tab and counts them in every My turn total', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    const { rankPendingTabs } = await import('./pending-tabs.js');
    const board = await rankPendingTabs(1, scope, insights);
    const mt = insights.cards.filter((c: any) => c.kind === 'my_turn');
    const ai = mt.filter((c: any) => c.reason === 'claude_review' || c.reason === 'ai_approved_merged');
    expect(ai.length).toBeGreaterThan(0); // non-vacuous
    const tab = (k: string) => board.tabs.find((t: any) => t.key === k)!;
    for (const c of ai) expect(tab('my_turn').cardIds).toContain(c.id);
    expect(tab('claude').cardIds.some((id: string) => id.startsWith('myturn:'))).toBe(false);
    expect(insights.myTurnTotal).toBe(mt.length);
    expect(insights.kindTotals!.my_turn).toBe(mt.length);
  });

  it('keeps them in GET /api/my-turn, so the reader is notified', async () => {
    const mt = await q.getMyTurn(1, scope);
    expect(mt.claudeReviewsToAction.length).toBeGreaterThan(0);
    expect(mt.approvedMerged.length).toBeGreaterThan(0);
    expect(mt.approvedMerged.every((a: any) => a.personal === true && a.relevance === 'direct')).toBe(true);
  });
});

describe('an AUTO run is owned like a manual one', () => {
  it('raises the card on a PR you neither wrote nor were asked to review', async () => {
    const keys = await claudeKeys();
    expect(keys.has('auto-stranger')).toBe(true);
    expect(keys.has('auto-mine')).toBe(true);
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
    expect((byPr.get(prIdByKey.get('unseen')) as any)?.trigger).toBe('manual');
  });

  it('keeps auto runs in the unscoped read (the notification watcher\'s)', async () => {
    const rows = await q.getUnseenOwnAiReviews(1);
    const ids = new Set(rows.map((r: any) => r.prId));
    expect(ids.has(prIdByKey.get('auto-stranger'))).toBe(true);
    expect(ids.has(prIdByKey.get('unseen'))).toBe(true);
  });
});

describe('"Merged after your Limn approved"', () => {
  it('lists a merged PR whose standing Limn approval came before the merge, until opened after it', async () => {
    const keys = await mergedKeys();
    expect(keys.has('am-standing')).toBe(true);
    expect(keys.has('am-unsynced')).toBe(true);
    expect(keys.has('am-viewed-before')).toBe(true);
    for (const k of ['am-withdrawn', 'am-viewed', 'am-old', 'am-comment', 'am-open']) {
      expect([k, keys.has(k)]).toEqual([k, false]);
    }
  });

  it('is dated by the merge, and a dismissal hides it', async () => {
    const mt = await q.getMyTurn(1, scope);
    const item = mt.approvedMerged.find((a: any) => a.prId === prIdByKey.get('am-standing'));
    expect(Date.parse(item.since)).toBe(now - DAY);
    const { dismissMyTurn, restoreMyTurn } = await import('./my-turn-dismissals.js');
    const id = prIdByKey.get('am-standing')!;
    await dismissMyTurn(1, { kind: 'pr', id });
    try {
      expect((await mergedKeys()).has('am-standing')).toBe(false);
      // Listed under "Dismissed" so it can be brought back.
      const again = await q.getMyTurn(1, scope);
      expect(again.dismissed.some((d: any) => d.target.id === id && d.reason === 'ai_approved_merged')).toBe(true);
    } finally {
      await restoreMyTurn(1, { kind: 'pr', id });
    }
  });

  it('counts only merges from the moment the card type arrived, never retrospectively', async () => {
    const { eq } = await import('drizzle-orm');
    const set = (at: Date | null) =>
      db.update(schema.accounts).set({ approvedMergedSince: at }).where(eq(schema.accounts.id, 1)).execute();
    // am-standing merged at now - DAY: a floor just after it drops it.
    await set(new Date(now - DAY + 1000));
    try {
      expect((await mergedKeys()).has('am-standing')).toBe(false);
    } finally {
      await set(new Date(0));
    }
  });

  it('is off when the type is switched off', async () => {
    const { setMyTurnSettings } = await import('../auth/account.js');
    await setMyTurnSettings(1, { show: { ai_approved_merged: false } });
    try {
      expect((await q.getMyTurn(1, scope)).approvedMerged).toEqual([]);
    } finally {
      await setMyTurnSettings(1, null);
    }
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
    // two auto runs from the "New AI review" fixtures, eight from the "merged after approval" ones,
    // + the failed auto one
    expect(res.autoToday).toBe(11);
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
