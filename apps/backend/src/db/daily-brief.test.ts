// The daily brief's COUNTS vs the list each one clicks into, on a THROWAWAY sqlite DB (the
// my-turn-new-prs.test.ts pattern).
//
// WHAT THIS PINS — one sentence: the strip's headline must equal what the click actually shows,
// at every moment, with nobody having cleared a cache in between.
//
// The bug it exists for: the brief used to serve EVERY slice from a module-level 5-minute TTL,
// while GET /api/attention recomputed the same getWorkspaceInsights fold on every request. So
// dismissing two "New PR" cards moved the board from 5 rows to 3 and left the strip saying 5 for
// up to five more minutes — a headline the very next click disproved. Nothing busted the cache
// (`clearDailyBriefCache` had no production caller), so the number was not "≤5 min stale", it was
// wrong, and it self-corrected only when the window happened to lapse.
//
// The fixture drives the fold with the SAME write the product uses: `POST /api/my-turn/dismiss`
// inserts a `my_turn_dismissals` row, and the `watched_repo_pr` kind is STICKY (no timestamp
// comparison), so the population is 3 → 1 with no clock in the assertion. The second `it` walks
// every counted kind rather than just `myTurn`: the count loop (db/daily-brief.ts) and the route's
// bot-card filter (api/routes/insights.ts) are two hand-maintained spellings of "which kinds
// count", and a kind added to one and not the other reproduces "header 5, list 3" with no cache
// involved at all.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-daily-brief-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let brief: any;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and could turn an intended "after the cutoff" into "just before it".
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 10 * DAY;

const VIEWER_LOGIN = 'viewer-me';
const NEW_PR_KEYS = ['new-1', 'new-2', 'new-3'] as const;
const prIdByKey = new Map<string, number>();

/** The two bot kinds GET /api/attention drops (they live in the free Bots console) — mirrored
 *  here on purpose: if that filter and the brief's count loop ever disagree, this copy is what
 *  makes the disagreement fail rather than ship. */
const BOT_CARD_KINDS = new Set<InsightCard['kind']>(['bot_signal', 'bot_only_review']);

/** What GET /api/attention would return right now, counted by kind — the LIST side of the pair. */
async function liveCardCounts(): Promise<Record<string, number>> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  const out: Record<string, number> = {};
  for (const c of insights.cards as InsightCard[]) {
    if (BOT_CARD_KINDS.has(c.kind)) continue;
    out[c.kind] = (out[c.kind] ?? 0) + 1;
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
  brief = await import('./daily-brief.js');

  const { accounts, repos, pullRequests, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null and getMyTurn short-circuit to an all-empty response — every assertion below
  // would then be vacuously 0 === 0.
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
  await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-dev');

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'api',
      githubNodeId: 'R_brief',
      // The "New PRs" cutoff. Explicit, because the default is "now" — which would put every
      // seeded PR before it and leave the brief counting nothing.
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();

  let n = 1;
  for (const key of NEW_PR_KEYS) {
    const openedAt = new Date(REPO_ADDED + n * DAY);
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_brief_${key}`,
        accountId: 1,
        repoId: repo.id,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId: aliceId,
        openedAt,
        updatedAt: openedAt,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
  }

  // ── one READY-TO-LAND PR, so the "counted by nobody" pin is not vacuous ───────────────────
  // ⚠ IT NEEDS AN `events` ROW. `getWorkspaceInsights`' open-PR population is gated on a real
  // activity event inside INSIGHT_MAX_STALE_DAYS, so a PR seeded without one produces NO card at
  // all — and the assertion that the strip does not count it would pass because nothing exists to
  // count. (The `my_turn` fixtures above need no event: they come from `getMyTurn`, a different
  // fold with a different population.)
  {
    const { events, reviewRequests } = schema;
    const bobId = await insertUser('bob-dev');
    // ⚠ OPENED BEFORE THE REPO'S "New PRs" CUTOFF (`repos.createdAt`), so it is NOT also a
    // `my_turn` watched-repo card — which would move the my_turn count this file's first
    // assertion pins, for a reason that has nothing to do with what this pin is about.
    const openedAt = new Date(REPO_ADDED - DAY);
    const [readyPr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_brief_ready',
        accountId: 1,
        repoId: repo.id,
        number: n++,
        title: 'ready to land fixture',
        state: 'open',
        isDraft: false,
        authorId: aliceId,
        openedAt,
        updatedAt: openedAt,
        lastCommitAt: new Date(now - 60 * 60 * 1000),
        mergeable: 'mergeable',
        mergeStateStatus: 'clean',
        ciStatus: 'success',
      })
      .returning()
      .execute();
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: readyPr.id,
        actorId: aliceId,
        type: 'commit_pushed',
        occurredAt: new Date(now - 60 * 60 * 1000),
        dedupeKey: 'brief_ev_ready',
      })
      .execute();
    // A pending request from someone who is NOT the viewer keeps this PR off the
    // `reviewer_routing` orphan path — which would otherwise reach for CODEOWNERS over the
    // network from a unit test.
    await db.insert(reviewRequests).values({ prId: readyPr.id, userId: bobId }).execute();
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and the repo belongs to no workspace, every count is 0, and
  // the fixture asserts nothing.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the daily brief counts what the click opens', () => {
  it('tracks the my_turn population the moment a dismissal changes it — no cache clear', async () => {
    expect(scope.repoIds).toHaveLength(1); // the seeded repo really is in the workspace being read

    const before = await brief.getDailyBriefEntry(1, scope.workspaceId);
    expect(before.counts.myTurn).toBe(NEW_PR_KEYS.length);
    expect(before.counts.myTurn).toBe((await liveCardCounts()).my_turn);

    // The write POST /api/my-turn/dismiss performs — nothing else. In particular NO
    // clearDailyBriefCache(): the route has never called it, and the brief must not need it.
    const { myTurnDismissals } = schema;
    for (const key of ['new-1', 'new-2']) {
      await db
        .insert(myTurnDismissals)
        .values({
          accountId: 1,
          kind: 'watched_repo_pr',
          refId: prIdByKey.get(key)!,
          dismissedAt: new Date(now),
        })
        .execute();
    }

    const after = await brief.getDailyBriefEntry(1, scope.workspaceId);
    // The regression: this read used to answer 3 from a ≤5-min-old snapshot while the board
    // — recomputing the same fold per request — already showed 1.
    expect(after.counts.myTurn).toBe(1);
    expect(after.counts.myTurn).toBe((await liveCardCounts()).my_turn);
    // And `generatedAt` describes THIS read, not the first one.
    expect(after.computedAt.getTime()).toBeGreaterThanOrEqual(before.computedAt.getTime());
  });

  it('counts every kind exactly as the attention board would list it', async () => {
    const live = await liveCardCounts();
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);
    // Zeros are meaningful here: a kind the brief counts but the board filters out (or vice
    // versa) shows up as a mismatch on one of these five, whatever the fixture happens to hold.
    //
    // ⚠ EVERY kind the brief counts belongs in this object. `ci_failing` was added to the union,
    // the count loop and the render switch in one change; a future kind added to the loop and not
    // here would leave the pair unpinned exactly where it matters.
    expect({
      my_turn: counts.myTurn,
      ci_failing: counts.ciFailing,
      stalled_review: counts.stalled,
      untouched_thread: counts.untouchedThreads,
      reviewer_routing: counts.needsReviewer,
    }).toEqual({
      my_turn: live.my_turn ?? 0,
      ci_failing: live.ci_failing ?? 0,
      stalled_review: live.stalled_review ?? 0,
      untouched_thread: live.untouched_thread ?? 0,
      reviewer_routing: live.reviewer_routing ?? 0,
    });
  });

  // ⚠ THE TWO FORWARD KINDS ARE COUNTED BY NOBODY, ON PURPOSE — and that is a DECISION, so it
  // gets a pin rather than an absence.
  //
  // `merge` and `update_branch` reach the Pending board (and the ranked head), but the daily-brief
  // strip does not count them: the strip answers "how much is WAITING ON YOU", and a PR that is
  // ready to land is not waiting on anyone. Adding them to `computeBriefCounts`' allow-list would
  // also stop the strip self-hiding on a clear workspace, since something is nearly always
  // mergeable. The board's own header carries the all-clear wording instead.
  //
  // The fixture must actually PRODUCE a merge card for this to mean anything — hence the
  // assertion that one exists before the assertion that nothing counted it.
  it('lets a ready-to-land PR reach the board WITHOUT entering the brief', async () => {
    const live = await liveCardCounts();
    expect((live.merge ?? 0) + (live.update_branch ?? 0)).toBeGreaterThan(0);
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);
    // Not folded into any scalar the strip renders.
    const total =
      counts.myTurn +
      (counts.ciFailing ?? 0) +
      counts.stalled +
      counts.untouchedThreads +
      counts.needsReviewer;
    const board = Object.entries(live).reduce((n, [, v]) => n + v, 0);
    expect(board).toBeGreaterThan(total);
  });
});
