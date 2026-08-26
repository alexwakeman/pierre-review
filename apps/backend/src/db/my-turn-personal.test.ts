// My Turn's PERSONAL-RELEVANCE flag, on a THROWAWAY sqlite DB (the my-turn-new-prs.test.ts
// pattern).
//
// WHAT THIS PINS. The "New PRs" section admits every non-draft human PR in every repo the account
// has added. On a real account that is hundreds of strangers' PRs in repos the viewer only reads
// — correct for the "Needs attention" BOARD (they do need a review) and completely wrong for the
// NOTIFICATION surfaces, which reach for the user rather than waiting to be opened. So each row
// carries an advisory `personal` flag, and:
//
//   1. The flag is a MAINTAINER test, and "maintainer" is a UNION of two independent signals —
//      WRITE/MAINTAIN/ADMIN on the repo, OR having landed a PR on its DEFAULT branch. Either one
//      alone is wrong on a real account (the column is null on old rows and READ on fork-and-merge
//      arrangements; the merge history exists without any permission grant), so a fixture that
//      only exercised one half would pass with the other half deleted.
//   2. A merge into a NON-default branch does not elevate the merger — that rule lives in
//      `getMergers` and this asserts it still reaches the flag.
//   3. The other five sections are personal BY CONSTRUCTION (they exist only because you are
//      involved), so a review requested of you in a repo you merely read is still personal. That
//      control is what stops "personal" quietly collapsing into "maintained".
//   4. ⚠ NOTHING IS NARROWED. `getMyTurn` returns every row and the board paints every card —
//      the flag is advisory. A fixture that only counted the narrow figure would not notice the
//      section being filtered instead of flagged.
//   5. ⚠ `myTurnPersonalTotal` is folded off the PRE-CAP array. Counted after the 50-card slice
//      it would be bounded by 50 and stop being a total; the fixture seeds 60 my_turn rows with
//      the NON-personal ones deliberately newest, so a post-cap fold reads a different number.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, MyTurnCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-my-turn-personal-test.sqlite';
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
const MINUTE = 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and could turn an intended "after the cutoff" into "just before it".
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'viewer-me';

// The server-side my_turn card cap (MY_TURN_CARD_CAP, db/queries.ts). Mirrored rather than
// imported because it is module-private; the fixture only needs to seed past it.
const CARD_CAP = 50;
// Enough maintained "New PRs" to push part of the personal population out of the cap.
const MAINTAINED_PRS = 55;

/** The five repos, each a different answer to "does the viewer maintain this?". */
const REPOS = [
  {
    key: 'write-perm',
    viewerPermission: 'WRITE',
    /** viewer merged into… */ mergedInto: null as string | null,
    maintained: true,
    why: 'WRITE permission — GitHub says so outright',
  },
  {
    key: 'merged-default',
    viewerPermission: 'READ',
    mergedInto: 'main',
    maintained: true,
    why: 'READ, but the viewer has landed a PR on the default branch',
  },
  {
    key: 'merged-side',
    viewerPermission: 'READ',
    mergedInto: 'develop',
    maintained: false,
    why: 'the merge targeted a side branch — not the maintainer signal',
  },
  {
    key: 'read-only',
    viewerPermission: 'READ',
    mergedInto: null,
    maintained: false,
    why: 'read access and no merge history — the erxes case this exists for',
  },
  {
    key: 'null-perm',
    viewerPermission: null,
    mergedInto: null,
    maintained: false,
    why: 'permission never synced — unknown is not a grant',
  },
] as const;

const repoIdByKey = new Map<string, number>();
/** The single "New PRs" PR seeded per repo, keyed by repo. */
const newPrIdByRepo = new Map<string, number>();
let requestedPrId = 0;
let viewerId = 0;

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

  const { accounts, repos, pullRequests, reviewRequests, users } = schema;
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
  viewerId = await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-dev');

  let n = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_personal_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        authorId: aliceId,
        ...values,
      })
      .returning()
      .execute();
    return pr.id;
  };

  for (const r of REPOS) {
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: r.key,
        githubNodeId: `R_personal_${r.key}`,
        viewerPermission: r.viewerPermission,
        // Known on every repo, so the "merged into a side branch" case is a POSITIVE exclusion
        // rather than getMergers' unknown-branch backward-compat allowance.
        defaultBranch: 'main',
        // The "New PRs" cutoff. Explicit, because the default is "now" — which would put every
        // seeded PR before it and leave the section empty.
        createdAt: new Date(REPO_ADDED),
      })
      .returning()
      .execute();
    repoIdByKey.set(r.key, repo.id);

    // The merge history half of the maintainer test. Merged PRs never enter `open`, so this
    // only ever reaches the flag through getMergers.
    if (r.mergedInto != null) {
      await insertPr(repo.id, `merge-${r.key}`, {
        state: 'merged',
        mergedById: viewerId,
        baseRefName: r.mergedInto,
        openedAt: new Date(REPO_ADDED + DAY),
        mergedAt: new Date(REPO_ADDED + 2 * DAY),
        updatedAt: new Date(REPO_ADDED + 2 * DAY),
      });
    }

    // One "New PRs" row per repo. ⚠ These are the NEWEST my_turn rows in the fixture (see the
    // cap note in the header): the three non-personal ones must sort INSIDE the cap so the
    // pre-cap/post-cap folds of `myTurnPersonalTotal` disagree.
    const openedAt = new Date(now - MINUTE * (REPOS.length - REPOS.indexOf(r)));
    newPrIdByRepo.set(
      r.key,
      await insertPr(repo.id, `new-${r.key}`, {
        state: 'open',
        isDraft: false,
        openedAt,
        updatedAt: openedAt,
      }),
    );
  }

  // The control for rule 3: a review requested of the viewer in a repo they only READ. It must
  // come out personal anyway — the section exists BECAUSE the viewer is involved.
  const readOnlyRepoId = repoIdByKey.get('read-only')!;
  requestedPrId = await insertPr(readOnlyRepoId, 'requested', {
    state: 'open',
    isDraft: false,
    openedAt: new Date(now - 2 * DAY),
    updatedAt: new Date(now - 2 * DAY),
    firstReviewRequestedAt: new Date(now - 2 * DAY),
  });
  await db
    .insert(reviewRequests)
    .values({ prId: requestedPrId, userId: viewerId })
    .execute();

  // The cap fixture: enough personal "New PRs" (in the WRITE repo) that part of the personal
  // population falls outside the 50-card slice. Deliberately OLDER than the per-repo rows above.
  const maintainedRepoId = repoIdByKey.get('write-perm')!;
  for (let i = 0; i < MAINTAINED_PRS; i += 1) {
    const openedAt = new Date(now - DAY - i * MINUTE);
    await insertPr(maintainedRepoId, `bulk-${i}`, {
      state: 'open',
      isDraft: false,
      openedAt,
      updatedAt: openedAt,
    });
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and the repo belongs to no workspace and every count is 0.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('My Turn personal-relevance flag', () => {
  it('flags a "New PR" personal only in a repo the viewer maintains', async () => {
    const res = await q.getMyTurn(1);
    const byPrId = new Map<number, boolean>(
      res.watchedRepoPrs.map((p: { prId: number; personal?: boolean }) => [
        p.prId,
        p.personal,
      ]),
    );
    for (const r of REPOS) {
      const prId = newPrIdByRepo.get(r.key)!;
      expect(byPrId.get(prId), `${r.key} (${r.why})`).toBe(r.maintained);
    }
  });

  it('keeps returning every row — the flag is advisory, not a filter', async () => {
    const res = await q.getMyTurn(1);
    const ids = new Set<number>(res.watchedRepoPrs.map((p: { prId: number }) => p.prId));
    // Every seeded "New PR" is still there, INCLUDING the three non-personal ones. The CLI
    // status board and the Done tab's restorability contract both read this full set.
    for (const r of REPOS) expect(ids.has(newPrIdByRepo.get(r.key)!), r.key).toBe(true);
    expect(ids.size).toBe(REPOS.length + MAINTAINED_PRS);
    expect(
      res.watchedRepoPrs.filter((p: { personal?: boolean }) => !p.personal).length,
    ).toBe(REPOS.filter((r) => !r.maintained).length);
  });

  it('flags an involved section personal even in a repo the viewer only reads', async () => {
    const res = await q.getMyTurn(1);
    const requested = res.awaitingReview.find(
      (p: { prId: number }) => p.prId === requestedPrId,
    );
    // Vacuity guard: if the review request never took, the assertion below asserts nothing.
    expect(requested, 'the review-requested control must reach awaitingReview').toBeTruthy();
    expect(requested.personal).toBe(true);
  });

  it('counts myTurnPersonalTotal off the PRE-CAP population', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const myTurnCards = (insights.cards as InsightCard[]).filter(
      (c): c is MyTurnCard => c.kind === 'my_turn',
    );
    const shownPersonal = myTurnCards.filter((c) => c.personal).length;

    // The board is capped and the totals are not.
    expect(myTurnCards.length).toBe(CARD_CAP);
    expect(insights.myTurnTotal).toBe(REPOS.length + MAINTAINED_PRS + 1);
    // The bulk rows + one per MAINTAINED repo + the review request.
    expect(insights.myTurnPersonalTotal).toBe(
      MAINTAINED_PRS + REPOS.filter((r) => r.maintained).length + 1,
    );
    // ⚠ THE DISCRIMINATOR. The non-personal rows are the newest, so they sit inside the cap and
    // the personal population spills past it: a post-cap fold would report `shownPersonal`.
    expect(insights.myTurnPersonalTotal).toBeGreaterThan(shownPersonal);
  });

  it('carries a MATCHED narrow pair into the daily brief', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const shownPersonal = (insights.cards as InsightCard[]).filter(
      (c): c is MyTurnCard => c.kind === 'my_turn' && c.personal,
    ).length;
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);

    // The narrow figure counts CARDS (what the board paints), exactly like `myTurn`.
    expect(counts.myTurnPersonal).toBe(shownPersonal);
    expect(counts.myTurnPersonalTotal).toBe(insights.myTurnPersonalTotal);
    // ⚠ The pair must be narrow-with-narrow. Borrowing `myTurnTotal` as the denominator would
    // mix two populations in one row AND break the cap disclosure, which only fires when the
    // displayed figure equals the count it qualifies.
    expect(counts.myTurnPersonal).toBeLessThan(counts.myTurn);
    expect(counts.myTurnPersonalTotal).toBeLessThan(counts.myTurnTotal);
    expect(counts.myTurnPersonalTotal).toBeGreaterThan(counts.myTurnPersonal);
  });
});
