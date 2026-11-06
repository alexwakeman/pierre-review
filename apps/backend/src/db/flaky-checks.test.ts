// FLAKY CHECKS — the pure rule, its loader on a THROWAWAY sqlite DB, and the Pending board carrying
// it (the failing-checks.test.ts pattern).
//
// WHAT THIS PINS:
//   1. THE RULE (`classifyFlakyChecks`): a failing check is flaky when the SAME head was seen with
//      every check passing (`passed_and_failed`), or the CI review at that head diagnosed it
//      `flaky_or_infra` (`ci_review_infra`). A red row that merely omits a name is NOT a pass. A
//      success at ANOTHER head is not this commit. A `not_checked` item, or another category, is
//      no diagnosis. `limn/` statuses are never CI.
//   2. THE LOADER keys on the (PR, head) pair, reads only the NEWEST row at the head (and only while
//      it is red), only the latest SUCCEEDED CI review AT that head, never another account's rows.
//   3. THE BOARD carries `ciFlaky` on the ci_failing 'your_pr' card with `viewerCanPush` from the
//      write set, and a flaky check is still a failure: the card, its names and its count stay.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CiFailingCard, InsightCard } from '@pierre-review/shared';
// ⚠ NO STATIC IMPORT OF ./flaky-checks.js: it imports the db client, which opens DATABASE_URL at
// module load — a static import is hoisted above the line below and writes into the dev DB.
import type { classifyFlakyChecks as ClassifyFn } from './flaky-checks.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-flaky-checks-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// Set in the ONE beforeAll below, after the scratch DB is in place.
let classifyFlakyChecks: typeof ClassifyFn;

describe('classifyFlakyChecks — the rule', () => {
  const H = 'head1';
  it('a check failing on a head that was once all green passed and failed on this commit', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['e2e'],
        log: [
          { headSha: H, status: 'failure', failingChecks: ['e2e'] },
          { headSha: H, status: 'success', failingChecks: [] },
          { headSha: H, status: 'failure', failingChecks: ['e2e'] },
        ],
        ciReviewItems: null,
      }),
    ).toEqual({ checks: [{ name: 'e2e', reasons: ['passed_and_failed'] }], allFailing: true });
  });

  it('a red row that omits a name is no pass — the check may be re-running', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['e2e'],
        log: [
          { headSha: H, status: 'failure', failingChecks: ['e2e', 'lint'] },
          { headSha: H, status: 'pending', failingChecks: [] },
          { headSha: H, status: 'failure', failingChecks: ['e2e'] },
        ],
        ciReviewItems: null,
      }),
    ).toBeNull();
  });

  it('a success at ANOTHER head is not this commit', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['e2e'],
        log: [
          { headSha: 'older', status: 'success', failingChecks: [] },
          { headSha: H, status: 'failure', failingChecks: ['e2e'] },
        ],
        ciReviewItems: null,
      }),
    ).toBeNull();
  });

  it('the CI review’s flaky_or_infra diagnosis marks that check only', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['build', 'e2e'],
        log: [{ headSha: H, status: 'failure', failingChecks: ['build', 'e2e'] }],
        ciReviewItems: [
          { checkName: 'e2e', status: 'diagnosed', category: 'flaky_or_infra' },
          { checkName: 'build', status: 'diagnosed', category: 'code' },
        ],
      }),
    ).toEqual({ checks: [{ name: 'e2e', reasons: ['ci_review_infra'] }], allFailing: false });
  });

  it('a not_checked item is no diagnosis, whatever its category says', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['e2e'],
        log: [],
        ciReviewItems: [{ checkName: 'e2e', status: 'not_checked', category: 'flaky_or_infra' }],
      }),
    ).toBeNull();
  });

  it('both reasons, passed_and_failed first; sorted; deduped', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['zeta', 'e2e', 'e2e'],
        log: [{ headSha: H, status: 'success', failingChecks: [] }],
        ciReviewItems: [{ checkName: 'e2e', status: 'diagnosed', category: 'flaky_or_infra' }],
      }),
    ).toEqual({
      checks: [
        { name: 'e2e', reasons: ['passed_and_failed', 'ci_review_infra'] },
        { name: 'zeta', reasons: ['passed_and_failed'] },
      ],
      allFailing: true,
    });
  });

  it('a limn/ status is never CI — never failing, never flaky, never in the denominator', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: ['e2e', 'limn/review-claude'],
        log: [],
        ciReviewItems: [
          { checkName: 'e2e', status: 'diagnosed', category: 'flaky_or_infra' },
          { checkName: 'limn/review-claude', status: 'diagnosed', category: 'flaky_or_infra' },
        ],
      }),
    ).toEqual({ checks: [{ name: 'e2e', reasons: ['ci_review_infra'] }], allFailing: true });
  });

  it('nothing failing is nothing flaky', () => {
    expect(
      classifyFlakyChecks({
        headSha: H,
        failing: [],
        log: [{ headSha: H, status: 'success', failingChecks: [] }],
        ciReviewItems: null,
      }),
    ).toBeNull();
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let fl: typeof import('./flaky-checks.js');
let scope: any;
let account2 = 0;
const ids = new Map<string, number>();
const P = (k: string): number => ids.get(k)!;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const VIEWER = 'viewer-flaky';

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  fl = await import('./flaky-checks.js');
  classifyFlakyChecks = fl.classifyFlakyChecks;
  const { accounts, ciStatusEvents, ciReviews, ciReviewItems, events, pullRequests, repos, users } = schema;
  const { eq } = await import('drizzle-orm');

  await db.update(accounts).set({ githubLogin: VIEWER }).where(eq(accounts.id, 1)).execute();
  const [a2] = await db
    .insert(accounts)
    .values({ githubUserId: 'U_flaky_theirs', githubLogin: 'flaky-theirs' })
    .returning()
    .execute();
  account2 = a2.id;
  const [viewer] = await db
    .insert(users)
    .values({ githubLogin: VIEWER, githubNodeId: `U_${VIEWER}` })
    .returning()
    .execute();

  const insertRepo = async (name: string, permission: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name,
        githubNodeId: `R_flaky_${name}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        viewerPermission: permission,
        createdAt: new Date(now - 30 * DAY),
      })
      .returning()
      .execute();
    return r.id;
  };
  const writable = await insertRepo('app', 'WRITE');
  const readOnly = await insertRepo('docs', 'READ');

  let n = 1;
  const insertPr = async (key: string, repoId: number, headSha: string, ciStatus = 'failure'): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_flaky_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId: viewer.id,
        openedAt: new Date(now - 3 * DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        mergeStateStatus: 'blocked',
        mergeable: 'mergeable',
        ciStatus,
        headSha,
      })
      .returning()
      .execute();
    ids.set(key, pr.id);
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId: pr.id,
        actorId: viewer.id,
        type: 'commit_pushed',
        occurredAt: new Date(now - DAY),
        dedupeKey: `ev_flaky_${key}`,
      })
      .execute();
    return pr.id;
  };
  const log = async (
    prId: number,
    repoId: number,
    headSha: string,
    status: string,
    names: string[],
    at: number,
    accountId = 1,
  ): Promise<void> => {
    await db
      .insert(ciStatusEvents)
      .values({ accountId, repoId, prId, headSha, status, failingChecks: names, observedAt: new Date(at) })
      .execute();
  };
  const ciReview = async (
    prId: number,
    repoId: number,
    headSha: string,
    status: string,
    items: { checkName: string; category: string; status?: string }[],
  ): Promise<void> => {
    const [run] = await db
      .insert(ciReviews)
      .values({ accountId: 1, workspaceId: 1, prId, repoId, headSha, status, model: 'claude-sonnet-5' })
      .returning()
      .execute();
    for (const i of items) {
      await db
        .insert(ciReviewItems)
        .values({
          ciReviewId: run.id,
          accountId: 1,
          checkName: i.checkName,
          status: i.status ?? 'diagnosed',
          category: i.category,
          assessedAtHead: headSha,
        })
        .execute();
    }
  };

  // (1) passed then failed on the same head — the seeded demo case. Writable repo.
  const rerun = await insertPr('rerun', writable, 'h-rr');
  await log(rerun, writable, 'h-rr', 'success', [], now - 3 * HOUR);
  await log(rerun, writable, 'h-rr', 'failure', ['e2e'], now - HOUR);

  // (2) two failing; the CI review says one is infra, the other is code. Not all flaky.
  const mixed = await insertPr('mixed', writable, 'h-mx');
  await log(mixed, writable, 'h-mx', 'failure', ['build', 'e2e'], now - HOUR);
  await ciReview(mixed, writable, 'h-mx', 'succeeded', [
    { checkName: 'e2e', category: 'flaky_or_infra' },
    { checkName: 'build', category: 'code' },
  ]);

  // (3) the CI review at an OLDER head said infra; a FAILED run at the current head said so too.
  // Neither counts.
  const oldReview = await insertPr('old-review', writable, 'h-new');
  await log(oldReview, writable, 'h-new', 'failure', ['e2e'], now - HOUR);
  await ciReview(oldReview, writable, 'h-old', 'succeeded', [{ checkName: 'e2e', category: 'flaky_or_infra' }]);
  await ciReview(oldReview, writable, 'h-new', 'failed', [{ checkName: 'e2e', category: 'flaky_or_infra' }]);

  // (4) the LATEST succeeded run wins: an earlier run said infra, the later one says code.
  const later = await insertPr('later-run', writable, 'h-lr');
  await log(later, writable, 'h-lr', 'failure', ['e2e'], now - HOUR);
  await ciReview(later, writable, 'h-lr', 'succeeded', [{ checkName: 'e2e', category: 'flaky_or_infra' }]);
  await ciReview(later, writable, 'h-lr', 'succeeded', [{ checkName: 'e2e', category: 'code' }]);

  // (5) flaky, in a repo the reader cannot push to.
  const ro = await insertPr('read-only', readOnly, 'h-ro');
  await log(ro, readOnly, 'h-ro', 'success', [], now - 3 * HOUR);
  await log(ro, readOnly, 'h-ro', 'failure', ['e2e'], now - HOUR);

  // (6) another account's success row for the same (PR, head) pair never makes it flaky.
  const leak = await insertPr('leak', writable, 'h-lk');
  await log(leak, writable, 'h-lk', 'failure', ['e2e'], now - HOUR);
  await log(leak, writable, 'h-lk', 'success', [], now - 2 * HOUR, account2);

  // (7) the newest row at the head is green — not red, nothing to call flaky.
  const green = await insertPr('green-now', writable, 'h-gn');
  await log(green, writable, 'h-gn', 'failure', ['e2e'], now - 2 * HOUR);
  await log(green, writable, 'h-gn', 'success', [], now - HOUR);

  scope = await q.resolveWorkspaceScope(1, null);
  // ⚠ MY TURN TAKES THE VIEWER'S OWN RED BUILD (`own_ci_red`, always on); this file pins the
  // 'your_pr' ci_failing card, built only where My Turn does not hold it. Muting the workspace for
  // Pending removes My Turn's rows and leaves the other tabs as they are.
  const mute = await import('./pending-mute.js');
  await mute.setWorkspacePendingMute(1, scope.workspaceId, { muted: true });
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const asked = (key: string, headSha: string, ciStatus = 'failure') => ({ id: P(key), headSha, ciStatus });

describe('prFlakyChecks — stored rows only, at the current head', () => {
  it('passed and failed on the same head', async () => {
    const m = await fl.prFlakyChecks(1, [asked('rerun', 'h-rr')]);
    expect(m.get(P('rerun'))).toEqual({
      headSha: 'h-rr',
      checks: [{ name: 'e2e', reasons: ['passed_and_failed'] }],
      allFailing: true,
    });
  });

  it('the CI review marks one of two; not all failing are flaky', async () => {
    const m = await fl.prFlakyChecks(1, [asked('mixed', 'h-mx')]);
    expect(m.get(P('mixed'))).toMatchObject({
      checks: [{ name: 'e2e', reasons: ['ci_review_infra'] }],
      allFailing: false,
    });
  });

  it('an older head’s review, or a failed run, never counts', async () => {
    expect((await fl.prFlakyChecks(1, [asked('old-review', 'h-new')])).size).toBe(0);
  });

  it('the latest succeeded run at the head wins', async () => {
    expect((await fl.prFlakyChecks(1, [asked('later-run', 'h-lr')])).size).toBe(0);
  });

  it('never reads another account’s rows', async () => {
    expect((await fl.prFlakyChecks(1, [asked('leak', 'h-lk')])).size).toBe(0);
  });

  it('a PR whose newest row at the head is green, or whose PR row is green, gets nothing', async () => {
    expect((await fl.prFlakyChecks(1, [asked('green-now', 'h-gn')])).size).toBe(0);
    expect((await fl.prFlakyChecks(1, [asked('rerun', 'h-rr', 'success')])).size).toBe(0);
  });

  it('keys on the pair: a head the PR does not hold says nothing', async () => {
    expect((await fl.prFlakyChecks(1, [asked('rerun', 'h-mx')])).size).toBe(0);
  });
});

describe('the Pending board carries it on the red-build card', () => {
  // ONE board fold for the block (a fold is the slow part of this file).
  let boardPromise: Promise<{ cards: InsightCard[]; kindTotals: Record<string, number> }> | undefined;
  const board = () =>
    (boardPromise ??= q.getWorkspaceInsights(1, undefined, scope, { uncapped: true, withFailingChecks: true }));
  const ciCard = (cards: InsightCard[], key: string): CiFailingCard | undefined =>
    cards.find((c): c is CiFailingCard => c.kind === 'ci_failing' && c.arm === 'your_pr' && c.prId === P(key));

  it('ciFlaky rides the your_pr card, with the write set’s viewerCanPush', async () => {
    const res = await board();
    expect(ciCard(res.cards, 'rerun')?.ciFlaky).toEqual({
      checks: [{ name: 'e2e', reasons: ['passed_and_failed'] }],
      allFailing: true,
      viewerCanPush: true,
    });
    expect(ciCard(res.cards, 'read-only')?.ciFlaky).toMatchObject({ allFailing: true, viewerCanPush: false });
    expect(ciCard(res.cards, 'mixed')?.ciFlaky?.allFailing).toBe(false);
    expect(ciCard(res.cards, 'old-review')?.ciFlaky).toBeUndefined();
  });

  it('a flaky check is still a failure: the card, its names and the count stay', async () => {
    const res = await board();
    const card = ciCard(res.cards, 'rerun');
    expect(card?.failingChecks).toEqual(['e2e']);
    expect(card?.failingCheckTotal).toBe(1);
    expect(card?.detail).not.toMatch(/flaky/i);
    // Every PR row here is red and the viewer's: seven cards, flaky or not.
    expect(res.kindTotals.ci_failing).toBe(7);
  });

  it('every other consumer pays nothing', async () => {
    const res = await q.getWorkspaceInsights(1, undefined, scope);
    expect(ciCard(res.cards, 'rerun')?.ciFlaky).toBeUndefined();
  });
});
