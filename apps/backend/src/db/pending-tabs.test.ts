// The Pending board's "Needs a reviewer" population and its suggestion pass, on a THROWAWAY sqlite
// DB (the work-plan.test.ts pattern).
//
// WHAT THIS PINS, and why each needs a fixture of its own:
//
//   1. THE POPULATION IS EVERY ORPHAN. "N PRs need a reviewer" is a fact about the PRs — nobody
//      asked, nobody reviewed — not about whether we could name someone. The capped fold (what the
//      Pro surfaces read) still drops an orphan with no suggestion, so its CARD count and the true
//      population differ; `kindTotals` must carry the population, and the daily brief's line must
//      say that number, because it opens the board's "Needs a reviewer" chip, which shows it.
//      MUTATION-TESTED: with the brief reading its card count again, test 2 fails (1 vs 17).
//   2. THE BOARD LISTS EVERY ORPHAN and looks suggestions up for only `routingSuggestCap` of them —
//      the lookup is network-backed per PR, so a 173-card tab must not mean 173 lookups.
//
// work-plan.test.ts cannot hold these: its fixture keeps every PR under the 4-hour orphan floor on
// purpose, so nothing there ever reaches the network-backed suggester. Here the suggester's
// NETWORK half (`enrichReviewerSuggestions`: CODEOWNERS + team history) is mocked; the DB half is
// real.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReviewerRoutingCard, ReviewerSuggestion } from '@pierre-review/shared';
import { PENDING_LIMITS } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pending-tabs-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

// The one PR the (mocked) CODEOWNERS lookup can name a reviewer for — everything else gets none.
let suggestFor = -1;
const enrichCalls: number[] = [];
vi.mock('../github/reviewer-suggest.js', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    enrichReviewerSuggestions: vi.fn(
      async (args: { paths: string[]; userSuggestions: ReviewerSuggestion[]; name: string }) => {
        enrichCalls.push(1);
        const hit = args.paths.includes(`src/pr-${suggestFor}.ts`);
        return {
          suggestions: hit
            ? [
                {
                  kind: 'team',
                  login: null,
                  userId: null,
                  teamSlug: 'core',
                  teamName: 'Core',
                  reason: 'owns these paths',
                  source: 'codeowners',
                } as unknown as ReviewerSuggestion,
              ]
            : args.userSuggestions,
          extraUsers: [],
        };
      },
    ),
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let q: any;
let brief: any;
let tabs: any;
let closeDb: (() => Promise<void>) | undefined;
let scope: any;
const ORPHANS = PENDING_LIMITS.routingSuggestCap + 2;
const prIds: number[] = [];

const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  brief = await import('./daily-brief.js');
  tabs = await import('./pending-tabs.js');
  const { db, schema } = client;
  const { accounts, events, repos, pullRequests, users } = schema;
  const { eq } = await import('drizzle-orm');

  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const [authorRow] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_alice', isBot: false })
    .returning()
    .execute();
  const [repoRow] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'orphans',
      githubNodeId: 'R_orphans',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'READ',
      // Added now: every PR below predates it, so none is a My Turn "New PR" — the board holds
      // exactly the orphans this file is about.
      createdAt: new Date(now),
    })
    .returning()
    .execute();
  const author = authorRow!;
  const repo = repoRow!;
  for (let i = 0; i < ORPHANS; i++) {
    // Older PRs first, so the ranker (longer wait wins a tie) has a deterministic order.
    const openedAt = new Date(now - (48 + i) * HOUR);
    const [inserted] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_orphan_${i}`,
        accountId: 1,
        repoId: repo.id,
        number: i + 1,
        title: `orphan ${i}`,
        state: 'open',
        isDraft: false,
        authorId: author.id,
        openedAt,
        updatedAt: openedAt,
        lastCommitAt: openedAt,
        // Files present, so the suggester never takes its GitHub files-backfill path.
        files: [{ path: `src/pr-${i + 1}.ts`, additions: 1, deletions: 0 }],
      })
      .returning()
      .execute();
    const row = inserted!;
    prIds.push(row.id);
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId: row.id,
        actorId: author.id,
        type: 'commit_pushed',
        occurredAt: new Date(now - HOUR),
        dedupeKey: `orphan_ev_${i}`,
      })
      .execute();
  }
  // PR number 3 is the one a reviewer can be suggested for.
  suggestFor = 3;
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('"Needs a reviewer" counts every orphan', () => {
  it('the capped fold keeps its old cards but reports the whole population', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const routing = insights.cards.filter((c: { kind: string }) => c.kind === 'reviewer_routing');
    // Only orphans the suggester could name someone for, and only the first `cardCap` of them —
    // exactly as before, because the Pro surfaces read this fold.
    expect(routing).toHaveLength(1);
    expect(insights.kindTotals.reviewer_routing).toBe(ORPHANS);
  });

  it('the daily brief says the population, not the card count', async () => {
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);
    expect(counts.needsReviewer).toBe(ORPHANS);
  });
});

describe('the board lists every orphan and suggests for the top few', () => {
  it('lists all of them in the "Waiting on review" tab, with the count to match', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    const board = await tabs.rankPendingTabs(1, scope, insights);
    const review = board.tabs.find((t: { key: string }) => t.key === 'review');
    expect(review.kindTotals.reviewer_routing).toBe(ORPHANS);
    expect(review.cardIds).toHaveLength(ORPHANS);
  });

  it(`looks suggestions up for the top ${PENDING_LIMITS.routingSuggestCap} only`, async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true });
    enrichCalls.length = 0;
    const board = await tabs.rankPendingTabs(1, scope, insights);
    // The uncapped fold itself does no lookups; the board's pass does exactly the cap.
    expect(enrichCalls).toHaveLength(PENDING_LIMITS.routingSuggestCap);
    const review = board.tabs.find((t: { key: string }) => t.key === 'review');
    const cards = new Map(board.cards.map((c: ReviewerRoutingCard) => [c.id, c]));
    const listed = review.cardIds.map((id: string) => cards.get(id) as ReviewerRoutingCard);
    // The suggestable PR (#3) is among the ranked top, so it carries its suggestion…
    const three = listed.find((c: ReviewerRoutingCard) => c.prNumber === 3)!;
    expect(listed.indexOf(three)).toBeLessThan(PENDING_LIMITS.routingSuggestCap);
    expect(three.suggestedReviewers).toHaveLength(1);
    // …and every card past the cap carries none, because nobody looked.
    for (const c of listed.slice(PENDING_LIMITS.routingSuggestCap)) {
      expect(c.suggestedReviewers).toEqual([]);
    }
  });
});
