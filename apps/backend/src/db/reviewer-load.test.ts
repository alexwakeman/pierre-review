// The `reviewer_load` card's population — REVIEW DEBT, not the raw `review_requests` count — on a
// THROWAWAY sqlite DB (the pending-card-review-standing.test.ts pattern).
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. A PAIR IS DISCHARGED BY THE REVIEWER'S OWN REVIEW, NOT BY THE PR HAVING ONE. GitHub
//      re-requests reviewers who have already reviewed and `sync/upsert.ts` reconciles
//      `review_requests` by delete + reinsert on every walk, so those rows are LIVE, not stale.
//      MEASURED on the reporting account: 70 of 334 outstanding user pairs on open non-draft PRs,
//      plus 6 more on `approved` PRs; one reviewer's card read "24 pending reviews" of which 16
//      were PRs they had already reviewed. ⚠ The `other-reviewed` fixture is what catches an
//      implementation that reused the PR-grained `reviewedPrIds` set instead.
//   2. A 'pending' ROW IS A DRAFT, NOT A REVIEW. It says nothing about where the reviewer stands
//      (the same rule `computeReviewStandingsByPr` applies), so it must not discharge a request.
//   3. THE COUNT AND THE LIST ARE ONE MAP — the FILTER-THE-SEED rule. Filtering the built
//      `pendingPrs` array while `pendingCount` still counted the wide map would print
//      "5 pending reviews" above three rows, and nothing would error.
//   4. A REVIEWER WHOSE EVERY PAIR IS DISCHARGED LOSES THE CARD ENTIRELY. It is a population
//      change, not just a smaller number — 17 of 77 reviewers on the reporting account.
//   5. ⚠ THE COUPLING GUARD, AND IT IS THE MOST IMPORTANT TEST IN THIS FILE. The narrowing stops
//      at ONE map. Folding it up into `pendingByPr` would print the literal words "waiting on —
//      no reviewer requested" on 38 measured stalled_review cards whose PRs carry live
//      outstanding GitHub requests (none of the 38 has a team request to fall back on), and
//      narrowing `requestedPrIds` would move those PRs onto the reviewer_routing orphan path.
//      Both are silent, type-safe, and false on screen.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, ReviewerLoadCard, StalledReviewCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-reviewer-load-test.sqlite';
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
// truncated on write.
const now = Math.floor(Date.now() / 1000) * 1000;

const VIEWER_LOGIN = 'viewer-me';

const prIdByKey = new Map<string, number>();
const prNumberByKey = new Map<string, number>();
let rexId = 0;
let ninaId = 0;
let authorId = 0;

const pr = (key: string): number => prIdByKey.get(key)!;

async function cards(): Promise<InsightCard[]> {
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  return insights.cards as InsightCard[];
}
async function loadCard(reviewerId: number): Promise<ReviewerLoadCard | undefined> {
  return (await cards()).find(
    (c): c is ReviewerLoadCard => c.kind === 'reviewer_load' && c.reviewerId === reviewerId,
  );
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

  const { accounts, events, repos, pullRequests, reviews, reviewRequests, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login. The viewer is deliberately NEITHER
  // reviewer here — this card is a workspace survey, not a personal summons — but the login is set
  // all the same so `getAccountUserId` resolves and the fold takes its ordinary path.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  await insertUser(VIEWER_LOGIN);
  rexId = await insertUser('rex-reviewer');
  ninaId = await insertUser('nina-reviewer');
  authorId = await insertUser('alice-dev');

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'load',
      githubNodeId: 'R_load',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'READ',
      // ⚠ `createdAt: now` puts every seeded PR BEFORE the repo's My Turn "New PRs" cutoff, so no
      // incidental my_turn card crowds the board.
      createdAt: new Date(now),
    })
    .returning()
    .execute();

  let n = 1;
  let ev = 1;
  const insertPr = async (key: string, values: Record<string, unknown> = {}): Promise<number> => {
    const number = n++;
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_load_${key}`,
        accountId: 1,
        repoId: repo.id,
        number,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        // TWO DAYS OLD: past INSIGHT_STALLED_REVIEW_HOURS (24), so every fixture PR is ALSO a
        // stalled_review card — which is what makes the coupling guard below assertable.
        // ⚠ `mergeable`/`mergeStateStatus` stay NULL so no merge / update_branch / conflicts card
        // appears and the board holds only the two kinds this file is about.
        openedAt: new Date(now - 2 * DAY),
        updatedAt: new Date(now - HOUR),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    prNumberByKey.set(key, number);
    // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
    // ultra-stale window — an open PR with no event is invisible to the whole fold.
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: row.id,
        actorId: authorId,
        type: 'commit_pushed',
        occurredAt: new Date(now - HOUR),
        dedupeKey: `load_ev_${ev++}`,
      })
      .execute();
    return row.id;
  };
  const request = async (key: string, userId: number): Promise<void> => {
    await db.insert(reviewRequests).values({ prId: pr(key), userId }).execute();
  };
  let rv = 1;
  const review = async (key: string, reviewerId: number, state: string): Promise<void> => {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_load_${rv++}`,
        prId: pr(key),
        authorId: reviewerId,
        state,
        submittedAt: new Date(now - HOUR),
      })
      .execute();
  };

  // (1) COUNTS — the ordinary case: requested, nothing said, GitHub has no verdict.
  await insertPr('plain');
  await request('plain', rexId);

  // (2) DROPS — rex has already spoken on this PR and GitHub is re-requesting him.
  await insertPr('self-reviewed');
  await request('self-reviewed', rexId);
  await review('self-reviewed', rexId, 'commented');

  // (3) COUNTS — ⚠ THE PER-PAIR PROOF. Somebody ELSE reviewed it; rex still owes one. An
  // implementation that reused the PR-grained `reviewedPrIds` set drops this and passes
  // everything else in the file.
  await insertPr('other-reviewed');
  await request('other-reviewed', rexId);
  await review('other-reviewed', ninaId, 'commented');

  // (4) DROPS — GitHub's own verdict on the PR is `approved`; nobody owes it a review, whoever is
  // still listed as requested.
  await insertPr('approved-decision', { reviewDecision: 'approved' });
  await request('approved-decision', rexId);

  // (5) COUNTS — a 'pending' row is a review DRAFT that was never submitted.
  await insertPr('draft-review');
  await request('draft-review', rexId);
  await review('draft-review', rexId, 'pending');

  // (6) DROPS, AND TAKES NINA'S WHOLE CARD WITH IT — her only outstanding pair is discharged.
  await insertPr('nina-only');
  await request('nina-only', ninaId);
  await review('nina-only', ninaId, 'changes_requested');

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and every count is 0 and the fixture asserts nothing.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the fixture is not vacuous', () => {
  it('really does put all six PRs on the board as stalled reviews', async () => {
    // Every assertion below is an absence or a smaller number; without this the file could go
    // green on an empty board.
    const stalled = (await cards()).filter((c) => c.kind === 'stalled_review');
    expect(stalled).toHaveLength(6);
  });
});

describe('reviewer_load counts review DEBT, not outstanding requests', () => {
  it('drops the pairs the reviewer has already answered and the approved PR', async () => {
    const card = await loadCard(rexId);
    // Five requests to rex; `self-reviewed` and `approved-decision` are discharged.
    expect(card?.pendingCount).toBe(3);
  });

  it('⚠ is per PAIR, not per PR — somebody else’s review does not discharge yours', async () => {
    const card = await loadCard(rexId);
    expect(card?.pendingPrs.map((p) => p.prId)).toContain(pr('other-reviewed'));
  });

  it('a review DRAFT does not discharge a request', async () => {
    const card = await loadCard(rexId);
    expect(card?.pendingPrs.map((p) => p.prId)).toContain(pr('draft-review'));
  });

  it('⚠ the count and the list are ONE map — filter the seed, never the built array', async () => {
    const card = await loadCard(rexId);
    expect(card).toBeDefined();
    // Valid because the fixture stays under the 8-row `pendingPrs` cap: below it the sample IS
    // the population, so a count that disagrees means the two were narrowed independently.
    expect(card!.pendingPrs).toHaveLength(card!.pendingCount);
    expect(card!.pendingPrs.map((p) => p.prNumber).sort((a, b) => a - b)).toEqual(
      ['plain', 'other-reviewed', 'draft-review']
        .map((k) => prNumberByKey.get(k)!)
        .sort((a, b) => a - b),
    );
  });

  it('a reviewer whose every pair is discharged gets NO card at all', async () => {
    // A POPULATION change, not just a smaller number — 17 of 77 reviewers on the reporting
    // account lose their card outright.
    expect(await loadCard(ninaId)).toBeUndefined();
    expect((await cards()).map((c) => c.id)).not.toContain(`load:${ninaId}`);
  });
});

describe('⚠ the narrowing stops at ONE map', () => {
  it.each([['self-reviewed'], ['approved-decision']])(
    'still names the requested reviewer on the stalled card for %s',
    async (key) => {
      // THE COUPLING GUARD. `pendingByPr` answers "who is on the hook", which a re-request still
      // is. Narrow it alongside `pendingByReviewer` and AttentionCards prints the literal words
      // "waiting on — no reviewer requested" on 38 measured PRs that carry live outstanding
      // GitHub requests, none of which has a team request to fall back on.
      const card = (await cards()).find(
        (c): c is StalledReviewCard => c.id === `stalled:${pr(key)}`,
      );
      expect(card).toBeDefined();
      expect(card?.requestedReviewerIds).toEqual([rexId]);
      expect(card?.requestedTeamNames).toEqual([]);
    },
  );

  it.each([['self-reviewed'], ['approved-decision']])(
    'leaves %s off the reviewer_routing orphan path',
    async (key) => {
      // `requestedPrIds` is unnarrowed too. Narrowing it would move these PRs onto the orphan
      // path and break the in-code agreement with `getSuggestedReviewersBasis`' `wants` gate —
      // and would reach CODEOWNERS over the network from this unit test.
      expect((await cards()).map((c) => c.id)).not.toContain(`route:${pr(key)}`);
    },
  );
});
