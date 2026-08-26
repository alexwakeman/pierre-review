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
    // versa) shows up as a mismatch on one of these four, whatever the fixture happens to hold.
    expect({
      my_turn: counts.myTurn,
      stalled_review: counts.stalled,
      untouched_thread: counts.untouchedThreads,
      reviewer_routing: counts.needsReviewer,
    }).toEqual({
      my_turn: live.my_turn ?? 0,
      stalled_review: live.stalled_review ?? 0,
      untouched_thread: live.untouched_thread ?? 0,
      reviewer_routing: live.reviewer_routing ?? 0,
    });
  });
});
