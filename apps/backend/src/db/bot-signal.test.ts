// Phase 2 "review-bot signal-to-noise" compute, on a THROWAWAY sqlite DB. Seeds one repo +
// open PR with a mix of review-BOT threads (by a coderabbitai user) plus a human thread,
// then asserts (a) getActivity's per-repo botThreads/botThreadsActedOn, and (b)
// getWorkspaceInsights' deterministic bot_signal card — proving the classifier segments bot vs
// human and the acted-on heuristic (resolved|likely_addressed) is counted correctly.
//
// A third block pins the GRAIN the judgement now lives at: one `workspace_reviewers` row per
// (account, workspace, actor). A stored "this is a human" must bite in the workspace being read
// and must be invisible from any other one.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BotSignalCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-bot-signal-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let prId = 0;
let botId = 0;
let repoId = 0;
// BotScope { workspaceId, repoIds } — `workspaceId` decides who counts as a bot, `repoIds`
// narrows the measured data. Resolved through the production resolver in beforeAll.
let scope: any;

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const now = Date.now();
  const { repos, pullRequests, events, users, reviewThreads } = schema;

  // account 1 exists (migration 0008). One repo + one open PR.
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_bs' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_bs',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'bot-signal fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 3 * DAY),
      updatedAt: new Date(now - 1 * DAY),
    })
    .returning()
    .execute();
  prId = pr.id;
  // A recent event so getTeamInsights' non-stale open-PR path is happy.
  await db
    .insert(events)
    .values({
      accountId: 1,
      repoId: repo.id,
      prId: pr.id,
      type: 'pr_opened',
      occurredAt: new Date(now - 3 * DAY),
      dedupeKey: 'pr_opened:PR_bs',
    })
    .execute();

  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cr', isBot: true })
    .returning()
    .execute();
  const [human] = await db
    .insert(users)
    .values({ githubLogin: 'morgan-diaz', githubNodeId: 'U_mo', isBot: false })
    .returning()
    .execute();
  botId = bot.id;

  // 5 BOT threads: 2 acted-on (resolved + likely_addressed), 2 untouched, 1 replied_unresolved.
  // Plus 1 HUMAN untouched thread that must NOT be counted as bot.
  const threads = [
    { node: 'BS_1', state: 'untouched', opener: bot.id, ageDays: 2 },
    { node: 'BS_2', state: 'untouched', opener: bot.id, ageDays: 5 }, // the oldest untouched
    { node: 'BS_3', state: 'replied_unresolved', opener: bot.id, ageDays: 2 },
    { node: 'BS_4', state: 'likely_addressed', opener: bot.id, ageDays: 2 },
    { node: 'BS_5', state: 'resolved', opener: bot.id, ageDays: 2, resolved: true },
    { node: 'BS_H', state: 'untouched', opener: human.id, ageDays: 2 }, // human — excluded
  ];
  for (const t of threads) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: t.node,
        prId: pr.id,
        path: 'src/x.ts',
        line: 1,
        isResolved: t.resolved ?? false,
        isOutdated: false,
        derivedState: t.state,
        originalCommenterId: t.opener,
        createdAt: new Date(now - t.ageDays * DAY),
      })
      .execute();
  }

  // ⚠ Resolve the scope through `resolveWorkspaceScope`, never by hand-building
  // `{workspaceId, repoIds}` — that call runs `ensureRepoMemberships`, which is what puts a repo
  // inserted straight into `repos` (bypassing upsertRepo's in-transaction membership insert) into
  // the account's Default workspace. Hand-build it and the repair never runs, the repo belongs to
  // NO workspace, and `getActivity` returns zero repos — which reads exactly like a segmentation
  // bug and is not one.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('review-bot signal-to-noise (Phase 2)', () => {
  it('getActivity segments bot threads + counts acted-on over open PRs', async () => {
    expect(scope.repoIds).toHaveLength(1); // the seeded repo is in the workspace being read
    const activity = await q.getActivity(1, scope);
    const repo = activity.repos[0];
    expect(repo).toBeDefined();
    // 5 bot threads (the human thread is excluded); acted-on = resolved + likely_addressed = 2.
    expect(repo.stats.botThreads).toBe(5);
    expect(repo.stats.botThreadsActedOn).toBe(2);
  });

  it('getWorkspaceInsights emits a deterministic bot_signal card', async () => {
    // (accountId, window|undefined, scope) — `undefined` keeps the legacy default window.
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const card = insights.cards.find((c: { kind: string }) => c.kind === 'bot_signal') as
      | BotSignalCard
      | undefined;
    expect(card).toBeDefined();
    if (!card) return;
    expect(card.totalThreads).toBe(5);
    expect(card.totalActedOn).toBe(2);
    expect(card.totalUntouched).toBe(2);
    expect(card.actedOnPct).toBe(40); // 2/5
    expect(card.oldestUntouchedDays).toBeGreaterThanOrEqual(4); // ~5d, allowing for call-time drift
    expect(card.vendors).toHaveLength(1);
    expect(card.vendors[0]!.kind).toBe('coderabbit');
    expect(card.vendors[0]!.threads).toBe(5);
    expect(card.vendors[0]!.untouched).toBe(2);
  });
});

// The judgement grain. `automatedReviewerUserIds` unions the known-vendor login set with THIS
// workspace's `workspace_reviewers` rows, and a manual "this is a human" wins both directions —
// it removes even a known vendor login. That makes it the sharpest available probe of which
// workspace a getter actually read: the same row, written to two different workspace ids, must
// produce two different answers. Without this pair a getter that ignored `scope.workspaceId`
// entirely (or read some arbitrary workspace's rows) would pass every other test in this file.
describe('the judgement is a WORKSPACE fact (one row per account+workspace+actor)', () => {
  const humanRow = (workspaceId: number) => ({
    accountId: 1,
    workspaceId,
    authorUserId: botId,
    automated: false,
    role: 'review',
    confidence: 'high',
    source: 'manual', // manual + !automated ⇒ manualHuman ⇒ removed from the automated set
  });

  it('a manual "not a bot" in ANOTHER workspace leaves this workspace\'s segmentation alone', async () => {
    const { workspaceReviewers } = schema;
    const other = await q.createWorkspace(1, 'Other');
    await db.insert(workspaceReviewers).values(humanRow(other.id)).execute();
    try {
      const activity = await q.getActivity(1, scope); // read at the DEFAULT workspace
      expect(activity.repos[0].stats.botThreads).toBe(5); // unchanged — the row is not ours
    } finally {
      await db.delete(workspaceReviewers).execute();
      await q.deleteWorkspace(other.id, 1); // (id, accountId)
    }
  });

  it('the SAME row in the workspace being read does bite (so the check above is not vacuous)', async () => {
    const { workspaceReviewers } = schema;
    await db.insert(workspaceReviewers).values(humanRow(scope.workspaceId)).execute();
    try {
      const activity = await q.getActivity(1, scope);
      expect(activity.repos[0].stats.botThreads).toBe(0); // coderabbitai is a person here
      expect(activity.repos[0].stats.botThreadsActedOn).toBe(0);
    } finally {
      await db.delete(workspaceReviewers).execute();
    }
  });
});

describe('getResolvableBotThreads (Phase 3 bulk-resolve eligibility)', () => {
  it('null (default) returns every likely_addressed unresolved bot thread', async () => {
    const r = await q.getResolvableBotThreads(prId, 1);
    expect(r).toHaveLength(1); // only BS_4 (bot-originated, likely_addressed, unresolved)
  });

  it('an EXPLICIT empty selection resolves NOTHING (not resolve-all)', async () => {
    const r = await q.getResolvableBotThreads(prId, 1, []);
    expect(r).toHaveLength(0);
  });

  it('narrows to exactly the reviewed ids, dropping ineligible/unknown ones', async () => {
    const [only] = await q.getResolvableBotThreads(prId, 1);
    expect(await q.getResolvableBotThreads(prId, 1, [only.id])).toEqual([only]);
    expect(await q.getResolvableBotThreads(prId, 1, [999_999])).toHaveLength(0);
  });
});

// GitHub TEAM review requests (review_requests rows with userId null + teamName set) must count
// as "someone is on the hook": no reviewer_routing card, but the PR still surfaces as
// stalled_review carrying the team's display name. Seeded in a nested beforeAll so the PRs
// added here can't perturb the describes above (they run first).
describe('team review requests satisfy routing but still stall', () => {
  let teamPrId = 0;
  let userPrId = 0;
  let reviewerId = 0;
  let insights: any;

  beforeAll(async () => {
    const now = Date.now();
    const { pullRequests, events, reviewRequests, users } = schema;

    // Both PRs: open, non-draft, 2 days old — past the 4h routing floor AND the 24h stall
    // threshold — with a recent event so the staleness exists-check keeps them.
    const seedPr = async (node: string, number: number, title: string): Promise<number> => {
      const [pr] = await db
        .insert(pullRequests)
        .values({
          githubNodeId: node,
          accountId: 1,
          repoId,
          number,
          title,
          state: 'open',
          isDraft: false,
          openedAt: new Date(now - 2 * DAY),
          updatedAt: new Date(now - 1 * DAY),
        })
        .returning()
        .execute();
      await db
        .insert(events)
        .values({
          accountId: 1,
          repoId,
          prId: pr.id,
          type: 'pr_opened',
          occurredAt: new Date(now - 2 * DAY),
          dedupeKey: `pr_opened:${node}`,
        })
        .execute();
      return pr.id;
    };
    teamPrId = await seedPr('PR_team_req', 2, 'team-requested fixture');
    userPrId = await seedPr('PR_user_req', 3, 'user-requested fixture');

    const [reviewer] = await db
      .insert(users)
      .values({ githubLogin: 'review-rex', githubNodeId: 'U_rx', isBot: false })
      .returning()
      .execute();
    reviewerId = reviewer.id;

    // A TEAM request (userId null) vs the USER-request control.
    await db
      .insert(reviewRequests)
      .values({ prId: teamPrId, userId: null, teamName: 'Platform Team' })
      .execute();
    await db.insert(reviewRequests).values({ prId: userPrId, userId: reviewerId }).execute();

    insights = await q.getWorkspaceInsights(1, undefined, scope);
  });

  it('a team-only request emits NO reviewer_routing card', () => {
    expect(insights.cards.map((c: { id: string }) => c.id)).not.toContain(`route:${teamPrId}`);
  });

  it('…but the PR still stalls, with the team name and no null reviewer id', () => {
    const card = insights.cards.find((c: { id: string }) => c.id === `stalled:${teamPrId}`);
    expect(card).toBeDefined();
    expect(card.requestedTeamNames).toEqual(['Platform Team']);
    expect(card.requestedReviewerIds).toEqual([]); // user-only — the team row must not leak a null
  });

  it('control: a USER request stalls with reviewer ids and no routing card', () => {
    const card = insights.cards.find((c: { id: string }) => c.id === `stalled:${userPrId}`);
    expect(card).toBeDefined();
    expect(card.requestedReviewerIds).toEqual([reviewerId]);
    expect(card.requestedTeamNames).toEqual([]);
    expect(insights.cards.map((c: { id: string }) => c.id)).not.toContain(`route:${userPrId}`);
  });
});
