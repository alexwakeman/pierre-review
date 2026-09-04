// THE PENDING MUTE, on a THROWAWAY sqlite DB (the my-turn-personal.test.ts pattern).
//
// WHAT THIS PINS, and every item is a decision somebody could reasonably undo by accident:
//
//   1. A MUTE NEVER REMOVES A ROW. Every section still returns exactly the same items; only
//      `relevance` / `personal` / `muted` change. "The work is real, it is just not yours, and
//      hiding it would delete work rather than route it" is the rule the whole Pending board is
//      built on — a fixture that only counted the narrow figure would not notice the section
//      being filtered instead of flagged.
//   2. THE TWO GRAINS ARE A UNION, NOT A CHAIN. Muting the workspace does not overwrite the repo
//      rows, and un-muting it does not clear them — the repo-muted repo stays muted throughout.
//      `null`-means-inherit is a named bug class in this codebase; this is the test that would
//      fail if someone reintroduced it.
//   3. IT REACHES THE UNSCOPED, ACCOUNT-WIDE `getMyTurn` — the call the browser-notification
//      watcher makes with no `?workspace=`. A mute applied only in the scoped form would leave
//      the most interrupting surface in the product firing.
//   4. THE THREAD SECTION IS MUTED TOO. `ThreadAwaitingItem` carries no repo id, so it resolves
//      through a `prId → repoId` map; a thread on a CLOSED PR (not in `openRows`) exercises the
//      path that a naive "look it up in the open list" implementation would miss.
//   5. THE COUNTS STAY ARITHMETICALLY COHERENT: `direct + maintained + other === myTurnTotal`
//      and `direct + maintained === myTurnPersonalTotal`, before and after.
//   6. THE TWO FORWARD KINDS ARE EXEMPT. `merge` / `update_branch` carry `relevance` for the
//      ranker's weight and the severity accent, not as an ownership claim, and are counted by no
//      notification surface — muting them would re-colour "you can land this now" cards and
//      suppress nothing.
//   7. THE RANK MOVES, DELIBERATELY. `score = … + 0.20 · RELEVANCE_WEIGHT[relevance]`, so a muted
//      item slides down the "Do next" head. That is accepted rather than insulated (two relevance
//      values in flight would be two answers to one question) — and it is invisible on screen, so
//      it is pinned here as a decision rather than left as an emergent surprise.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and EVERY import below is dynamic for the same reason — a static value import is hoisted and
// would run config's module graph, and its cached path, first.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, MyTurnCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pending-mute-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let mute: any;
let workPlan: any;

const DAY = 24 * 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const VIEWER_LOGIN = 'viewer-mute';

/** alpha is the control; beta gets a REPO mute; gamma lives in a workspace that gets muted. */
const REPO_KEYS = ['alpha', 'beta', 'gamma'] as const;

const repoId: Record<string, number> = {};
const requestedPr: Record<string, number> = {};
const newPr: Record<string, number> = {};
let betaThreadId = 0;
let mergePrId = 0;
let quietWorkspaceId = 0;
let defaultScope: any;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  mute = await import('./pending-mute.js');
  workPlan = await import('./work-plan.js');

  const { accounts, repos, pullRequests, reviewRequests, reviewThreads, reviewComments, users } =
    schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null and getMyTurn short-circuit to an all-empty response — every assertion below
  // would then be vacuously true.
  await db
    .update(accounts)
    .set({ githubLogin: VIEWER_LOGIN })
    .where(eq(accounts.id, 1))
    .execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  const viewerId = await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-mute');

  let n = 1;
  const insertPr = async (
    rId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_mute_${key}`,
        accountId: 1,
        repoId: rId,
        number: n++,
        title: `${key} fixture`,
        authorId: aliceId,
        ...values,
      })
      .returning()
      .execute();
    return pr.id;
  };

  for (const key of REPO_KEYS) {
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_mute_${key}`,
        // WRITE everywhere, so the "New PRs" section is 'maintained' rather than 'none' — a
        // fixture where it was already 'none' could not tell a mute from the status quo.
        viewerPermission: 'WRITE',
        defaultBranch: 'main',
        // The "New PRs" cutoff. Explicit: the default is "now", which would put every seeded PR
        // before it and leave the section empty.
        createdAt: new Date(REPO_ADDED),
      })
      .returning()
      .execute();
    repoId[key] = repo.id;

    // 1. awaitingReview — 'direct' by construction (a review requested of the viewer).
    requestedPr[key] = await insertPr(repo.id, `req-${key}`, {
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 2 * DAY),
      updatedAt: new Date(now - 2 * DAY),
      firstReviewRequestedAt: new Date(now - 2 * DAY),
    });
    await db
      .insert(reviewRequests)
      .values({ prId: requestedPr[key], userId: viewerId })
      .execute();

    // 2. watchedRepoPrs ("New PRs") — 'maintained' (WRITE on the repo, somebody else's PR).
    newPr[key] = await insertPr(repo.id, `new-${key}`, {
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - DAY),
      updatedAt: new Date(now - DAY),
    });
  }

  // 3. threadsAwaiting on BETA, on a CLOSED PR. `ThreadAwaitingItem` carries no repo id and the
  //    section does not filter on PR state, so this row is reachable ONLY through the
  //    prId → repoId map — the exact case a "look it up among the open PRs" shortcut would miss.
  const closedPr = await insertPr(repoId.beta!, 'thread-beta', {
    state: 'closed',
    isDraft: false,
    openedAt: new Date(now - 5 * DAY),
    updatedAt: new Date(now - 5 * DAY),
  });
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_mute_beta',
      prId: closedPr,
      path: 'src/index.ts',
      isResolved: false,
      derivedState: 'replied_unresolved',
      originalCommenterId: viewerId,
      createdAt: new Date(now - 5 * DAY),
    })
    .returning()
    .execute();
  betaThreadId = thread.id;
  await db
    .insert(reviewComments)
    .values([
      {
        githubNodeId: 'RC_mute_beta_1',
        prId: closedPr,
        threadId: betaThreadId,
        authorId: viewerId,
        body: 'please take a look',
        createdAt: new Date(now - 5 * DAY),
      },
      {
        githubNodeId: 'RC_mute_beta_2',
        prId: closedPr,
        threadId: betaThreadId,
        authorId: aliceId,
        body: 'done',
        createdAt: new Date(now - 4 * DAY),
      },
    ])
    .execute();

  // 4. A FORWARD card in beta: the viewer's own PR, mergeable and clean → a `merge` card with
  //    relevance 'direct'. It must stay 'direct' after beta is muted.
  mergePrId = await insertPr(repoId.beta!, 'merge-beta', {
    state: 'open',
    isDraft: false,
    authorId: viewerId,
    openedAt: new Date(now - 3 * DAY),
    updatedAt: new Date(now - 3 * DAY),
    lastCommitAt: new Date(now - 3 * DAY),
    mergeStateStatus: 'clean',
    mergeable: 'mergeable',
  });

  // The merge-card emitter's open-PR query requires an EVENT inside the staleness window (a PR
  // with no recent event is abandoned-but-unclosed and is deliberately not surfaced). Without
  // this row the forward-kind assertion below would pass vacuously against no card at all.
  await db
    .insert(schema.events)
    .values({
      accountId: 1,
      repoId: repoId.beta!,
      prId: mergePrId,
      actorId: viewerId,
      type: 'commit_pushed',
      occurredAt: new Date(now - 3 * DAY),
      dedupeKey: `commit_pushed:mute-merge-beta`,
    })
    .execute();

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and the repo belongs to no workspace and every count is 0.
  defaultScope = await q.resolveWorkspaceScope(1, null);

  // gamma moves into its own workspace, which is what the WORKSPACE half of the mute acts on.
  const quiet = await q.createWorkspace(1, 'Quiet');
  quietWorkspaceId = quiet.id;
  await q.assignReposToWorkspace(quietWorkspaceId, 1, [repoId.gamma!]);
  // Re-resolve: gamma has left Default, so the default scope is alpha + beta now.
  defaultScope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

/** Every my-turn row's (relevance, personal, muted), keyed by a stable label. */
async function rowsByLabel(): Promise<
  Map<string, { relevance?: string; personal?: boolean; muted?: boolean }>
> {
  const res = await q.getMyTurn(1);
  const out = new Map<string, { relevance?: string; personal?: boolean; muted?: boolean }>();
  for (const r of res.awaitingReview) out.set(`req:${r.prId}`, r);
  for (const r of res.watchedRepoPrs) out.set(`new:${r.prId}`, r);
  for (const r of res.threadsAwaiting) out.set(`thread:${r.threadId}`, r);
  return out;
}

describe('the Pending mute', () => {
  it('leaves everything personal when nothing is muted (the fixture is not vacuous)', async () => {
    const rows = await rowsByLabel();
    for (const key of REPO_KEYS) {
      expect(rows.get(`req:${requestedPr[key]}`)?.relevance, key).toBe('direct');
      expect(rows.get(`new:${newPr[key]}`)?.relevance, key).toBe('maintained');
      expect(rows.get(`new:${newPr[key]}`)?.personal, key).toBe(true);
    }
    expect(rows.get(`thread:${betaThreadId}`)?.relevance).toBe('direct');
    // Nothing carries the flag while nothing is muted — `muted` is set only when true.
    for (const [, v] of rows) expect(v.muted).toBeUndefined();
  });

  it('downgrades a REPO-muted repo — and removes nothing', async () => {
    const before = await rowsByLabel();
    expect(
      await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, {
        mutedRepoIds: [repoId.beta!],
      }),
    ).toBe(true);
    const after = await rowsByLabel();

    // RULE 1: identical population. A filter instead of a flag fails here, not in the counts.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    for (const label of [`req:${requestedPr.beta}`, `new:${newPr.beta}`, `thread:${betaThreadId}`]) {
      expect(after.get(label)?.relevance, label).toBe('none');
      expect(after.get(label)?.personal, label).toBe(false);
      expect(after.get(label)?.muted, label).toBe(true);
    }
    // The controls are untouched — including gamma, in a different workspace.
    expect(after.get(`req:${requestedPr.alpha}`)?.relevance).toBe('direct');
    expect(after.get(`new:${newPr.alpha}`)?.relevance).toBe('maintained');
    expect(after.get(`req:${requestedPr.gamma}`)?.relevance).toBe('direct');
  });

  it('downgrades a WORKSPACE-muted workspace through the UNSCOPED, account-wide call', async () => {
    expect(await mute.setWorkspacePendingMute(1, quietWorkspaceId, { muted: true })).toBe(true);
    // `getMyTurn(1)` with NO scope — the call GET /api/my-turn and the notification watcher make.
    const rows = await rowsByLabel();
    expect(rows.get(`req:${requestedPr.gamma}`)?.relevance).toBe('none');
    expect(rows.get(`req:${requestedPr.gamma}`)?.personal).toBe(false);
    expect(rows.get(`new:${newPr.gamma}`)?.muted).toBe(true);
    // alpha is still loud.
    expect(rows.get(`req:${requestedPr.alpha}`)?.personal).toBe(true);
  });

  it('is a UNION, not a chain: un-muting the workspace leaves the repo mute standing', async () => {
    await mute.setWorkspacePendingMute(1, quietWorkspaceId, { muted: false });
    const rows = await rowsByLabel();
    // gamma comes back…
    expect(rows.get(`req:${requestedPr.gamma}`)?.relevance).toBe('direct');
    expect(rows.get(`req:${requestedPr.gamma}`)?.muted).toBeUndefined();
    // …and beta, muted by its own row, does not.
    expect(rows.get(`req:${requestedPr.beta}`)?.relevance).toBe('none');
    expect(rows.get(`req:${requestedPr.beta}`)?.muted).toBe(true);
  });

  it('keeps the card counts arithmetically coherent, and moves the personal total only', async () => {
    // Baseline with beta muted (the state the previous test left).
    const muted = await q.getWorkspaceInsights(1, undefined, defaultScope);
    // Now clear it and compare — same population, different split.
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, { mutedRepoIds: [] });
    const loud = await q.getWorkspaceInsights(1, undefined, defaultScope);

    for (const ins of [muted, loud]) {
      expect(
        ins.myTurnDirectTotal + ins.myTurnMaintainedTotal + ins.myTurnOtherTotal,
      ).toBe(ins.myTurnTotal);
      expect(ins.myTurnDirectTotal + ins.myTurnMaintainedTotal).toBe(ins.myTurnPersonalTotal);
    }
    // ⚠ THE BROAD POPULATION NEVER MOVES — that is the whole promise of "it stays on the board".
    expect(muted.myTurnTotal).toBe(loud.myTurnTotal);
    // The narrow one does: beta contributes a review request, a "New PR" and a thread.
    expect(muted.myTurnPersonalTotal).toBe(loud.myTurnPersonalTotal - 3);
    expect(muted.myTurnOtherTotal).toBe(loud.myTurnOtherTotal + 3);

    // Restore the mute for the two tests below.
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, {
      mutedRepoIds: [repoId.beta!],
    });
  });

  it('carries `muted` onto the card, and never onto a card the reader did not mute', async () => {
    const ins = await q.getWorkspaceInsights(1, undefined, defaultScope);
    const myTurn = ins.cards.filter((c: InsightCard) => c.kind === 'my_turn') as MyTurnCard[];
    const betaCards = myTurn.filter((c) => c.prId === requestedPr.beta);
    const alphaCards = myTurn.filter((c) => c.prId === requestedPr.alpha);
    expect(betaCards.length).toBe(1);
    expect(alphaCards.length).toBe(1);
    expect(betaCards[0]!.muted).toBe(true);
    expect(betaCards[0]!.relevance).toBe('none');
    // DERIVED, never carried alongside: `personal` and `relevance` cannot disagree.
    expect(betaCards[0]!.personal).toBe(false);
    expect(alphaCards[0]!.muted).toBeUndefined();
    expect(alphaCards[0]!.personal).toBe(true);
  });

  it('leaves the two FORWARD kinds alone — a mute is about interruption, and they do not interrupt', async () => {
    const ins = await q.getWorkspaceInsights(1, undefined, defaultScope);
    const merge = ins.cards.find(
      (c: InsightCard) => c.kind === 'merge' && c.prId === mergePrId,
    ) as { relevance: string; severity: string } | undefined;
    expect(merge).toBeDefined();
    // beta IS muted, and this card is in beta. Its relevance drives the ranker weight and the
    // severity ACCENT, not an ownership claim — muting it would re-colour "you can land this
    // now" and suppress nothing (no notification surface counts a forward card).
    expect(merge!.relevance).toBe('direct');
    expect(merge!.severity).toBe('warn');
  });

  it('DOES lower the "Do next" rank of a muted item — accepted, and pinned so it is a decision', async () => {
    const insMuted = await q.getWorkspaceInsights(1, undefined, defaultScope);
    const planMuted = await workPlan.rankWorkPlan(1, defaultScope, insMuted);
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, { mutedRepoIds: [] });
    const insLoud = await q.getWorkspaceInsights(1, undefined, defaultScope);
    const planLoud = await workPlan.rankWorkPlan(1, defaultScope, insLoud);

    const scoreFor = (plan: any, prId: number): number | undefined =>
      plan.items.find((i: { prId: number }) => i.prId === prId)?.score;

    const betaMuted = scoreFor(planMuted, requestedPr.beta!);
    const betaLoud = scoreFor(planLoud, requestedPr.beta!);
    expect(betaMuted).toBeDefined();
    expect(betaLoud).toBeDefined();
    // score = 0.50·proximity + 0.30·stallRisk + 0.20·RELEVANCE_WEIGHT[relevance], and
    // RELEVANCE_WEIGHT drops 1.0 → 0.25 on a downgrade to 'none'. Insulating the ranker would
    // mean two relevance values in flight — two answers to one question — so the coupling is
    // accepted; it is asserted here because nothing on screen says the head re-ordered.
    expect(betaMuted!).toBeLessThan(betaLoud!);
    // ⚠ AND IT IS A RE-ORDERING, NEVER A FILTER: the item is still in the plan either way.
    expect(scoreFor(planMuted, requestedPr.alpha!)).toBe(scoreFor(planLoud, requestedPr.alpha!));
  });
});
