// THE PENDING MUTE, on a THROWAWAY sqlite DB (the my-turn-personal.test.ts pattern).
//
// WHAT THIS PINS, and every item is a decision somebody could reasonably undo by accident:
//
//   1. A MUTED REPOSITORY LEAVES MY TURN ENTIRELY. Its rows are dropped from `getMyTurn`'s seeds —
//      review requests, "New PRs" and threads alike — so the list, every count and the
//      notifications move together. (Before 2026-11-06 a mute only relabelled the rows.)
//   2. THE TWO GRAINS ARE A UNION, NOT A CHAIN. Muting the workspace does not overwrite the repo
//      rows, and un-muting it does not clear them — the repo-muted repo stays muted throughout.
//      `null`-means-inherit is a named bug class in this codebase; this is the test that would
//      fail if someone reintroduced it.
//   3. IT REACHES THE UNSCOPED, ACCOUNT-WIDE `getMyTurn` — the call the browser-notification
//      watcher makes with no `?workspace=`. A mute applied only in the scoped form would leave
//      the most interrupting surface in the product firing.
//   4. THE COUNTS STAY ARITHMETICALLY COHERENT: `direct + maintained + other === myTurnTotal`
//      and `direct + maintained === myTurnPersonalTotal`, before and after.
//   5. OTHER TABS ARE UNAFFECTED. A `merge` card in a muted repo stays, unchanged and scored.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and EVERY import below is dynamic for the same reason — a static value import is hoisted and
// would run config's module graph, and its cached path, first.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, MyTurnCard } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-pending-mute-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

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
  // Untouched "New PRs" are OFF by default (Settings → Pending, "Also show new PRs nobody asked you
  // about"). This fixture's My Turn population is built on them, so it switches them on.
  await (await import('../auth/account.js')).setMyTurnSettings(1, { showNewPrs: true });
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

  // 3. threadsAwaiting on BETA. `ThreadAwaitingItem` carries no repo id, so this row's repo is
  //    reachable ONLY through the prId → repoId map — the case a "reverse the repoFullName"
  //    shortcut would get wrong (`repoNameById`'s own `repo <id>` fallback reverses to nothing).
  //    ⚠ Its PR used to be CLOSED, back when this section did not filter on PR state. THE BALL
  //    RULE added that filter (there is no action owed on a thread whose PR has landed), so a
  //    closed PR here would make the fixture vacuous — the thread would simply not be returned.
  const threadPr = await insertPr(repoId.beta!, 'thread-beta', {
    state: 'open',
    isDraft: false,
    openedAt: new Date(now - 5 * DAY),
    updatedAt: new Date(now - 5 * DAY),
  });
  const [thread] = await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_mute_beta',
      prId: threadPr,
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
        prId: threadPr,
        threadId: betaThreadId,
        authorId: viewerId,
        body: 'please take a look',
        createdAt: new Date(now - 5 * DAY),
      },
      {
        githubNodeId: 'RC_mute_beta_2',
        prId: threadPr,
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

/** Every my-turn row's (relevance, personal), keyed by a stable label. */
async function rowsByLabel(): Promise<Map<string, { relevance?: string; personal?: boolean }>> {
  const res = await q.getMyTurn(1);
  const out = new Map<string, { relevance?: string; personal?: boolean }>();
  for (const r of res.awaitingReview) out.set(`req:${r.prId}`, r);
  for (const r of res.watchedRepoPrs) out.set(`new:${r.prId}`, r);
  for (const r of res.threadsAwaiting) out.set(`thread:${r.threadId}`, r);
  return out;
}

describe('the Pending mute', () => {
  it('leaves everything in place when nothing is muted (the fixture is not vacuous)', async () => {
    const rows = await rowsByLabel();
    for (const key of REPO_KEYS) {
      expect(rows.get(`req:${requestedPr[key]}`)?.relevance, key).toBe('direct');
      expect(rows.get(`new:${newPr[key]}`)?.relevance, key).toBe('maintained');
      expect(rows.get(`new:${newPr[key]}`)?.personal, key).toBe(true);
    }
    expect(rows.get(`thread:${betaThreadId}`)?.relevance).toBe('direct');
  });

  it('removes a REPO-muted repo’s rows from My Turn — and nothing else', async () => {
    const before = await rowsByLabel();
    expect(
      await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, {
        mutedRepoIds: [repoId.beta!],
      }),
    ).toBe(true);
    const after = await rowsByLabel();
    const gone = [`req:${requestedPr.beta}`, `new:${newPr.beta}`, `thread:${betaThreadId}`];
    for (const label of gone) {
      expect(before.has(label), label).toBe(true);
      expect(after.has(label), label).toBe(false);
    }
    expect([...after.keys()].sort()).toEqual([...before.keys()].filter((k) => !gone.includes(k)).sort());
    // The controls are untouched — including gamma, in a different workspace.
    expect(after.get(`req:${requestedPr.alpha}`)?.relevance).toBe('direct');
    expect(after.get(`new:${newPr.alpha}`)?.relevance).toBe('maintained');
    expect(after.get(`req:${requestedPr.gamma}`)?.relevance).toBe('direct');
  });

  it('removes a WORKSPACE-muted workspace’s rows through the UNSCOPED, account-wide call', async () => {
    expect(await mute.setWorkspacePendingMute(1, quietWorkspaceId, { muted: true })).toBe(true);
    // `getMyTurn(1)` with NO scope — the call GET /api/my-turn and the notification watcher make.
    const rows = await rowsByLabel();
    expect(rows.has(`req:${requestedPr.gamma}`)).toBe(false);
    expect(rows.has(`new:${newPr.gamma}`)).toBe(false);
    // alpha is still there.
    expect(rows.get(`req:${requestedPr.alpha}`)?.personal).toBe(true);
  });

  it('is a UNION, not a chain: un-muting the workspace leaves the repo mute standing', async () => {
    await mute.setWorkspacePendingMute(1, quietWorkspaceId, { muted: false });
    const rows = await rowsByLabel();
    // gamma comes back…
    expect(rows.get(`req:${requestedPr.gamma}`)?.relevance).toBe('direct');
    // …and beta, muted by its own row, does not.
    expect(rows.has(`req:${requestedPr.beta}`)).toBe(false);
  });

  it('moves every My Turn count with the list, and keeps them arithmetically coherent', async () => {
    // Baseline with beta muted (the state the previous test left).
    const muted = await q.getWorkspaceInsights(1, undefined, defaultScope);
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, { mutedRepoIds: [] });
    const loud = await q.getWorkspaceInsights(1, undefined, defaultScope);

    for (const ins of [muted, loud]) {
      expect(
        ins.myTurnDirectTotal + ins.myTurnMaintainedTotal + ins.myTurnOtherTotal,
      ).toBe(ins.myTurnTotal);
      expect(ins.myTurnDirectTotal + ins.myTurnMaintainedTotal).toBe(ins.myTurnPersonalTotal);
    }
    // Every My Turn card in beta — a review request, a "New PR", the reader's own ready PR — leaves.
    const betaCards = (loud.cards as MyTurnCard[]).filter(
      (c) => c.kind === 'my_turn' && c.repoId === repoId.beta,
    ).length;
    expect(betaCards).toBeGreaterThan(0);
    expect(muted.myTurnTotal).toBe(loud.myTurnTotal - betaCards);
    expect(muted.myTurnPersonalTotal).toBe(loud.myTurnPersonalTotal - betaCards);
    expect(muted.myTurnOtherTotal).toBe(loud.myTurnOtherTotal);

    // Restore the mute for the test below.
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, {
      mutedRepoIds: [repoId.beta!],
    });
  });

  it('leaves the other tabs alone — a muted repo’s own ready PR goes back to Ready to land, scored', async () => {
    const ins = await q.getWorkspaceInsights(1, undefined, defaultScope, { uncapped: true });
    const merge = ins.cards.find(
      (c: InsightCard) => c.kind === 'merge' && c.prId === mergePrId,
    ) as { id: string; relevance: string; severity: string } | undefined;
    // Your own ready PR is a My Turn card while beta is loud; muted, it is the Ready to land card.
    expect(merge).toBeDefined();
    expect(merge!.relevance).toBe('direct');
    expect(merge!.severity).toBe('warn');
    const { scored } = await workPlan.scoreCards(1, ins.cards, Date.now());
    expect(scored.some((s: { cardId: string }) => s.cardId === merge!.id)).toBe(true);
    // …and no My Turn card of beta's is there to score.
    expect(
      (ins.cards as MyTurnCard[]).some((c) => c.kind === 'my_turn' && c.prId === requestedPr.beta),
    ).toBe(false);
    await mute.setWorkspacePendingMute(1, defaultScope.workspaceId, { mutedRepoIds: [] });
  });
});
