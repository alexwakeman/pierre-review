// THE PR PANE AND THE PENDING CARD, ON THE SAME PULL REQUEST — on a THROWAWAY sqlite DB
// (the pending-card-review-standing.test.ts pattern; a sibling rather than an extension so this
// file can own the fixture the regression needs and that one's chip expectations stay put).
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. ⚠ THE PANE NO LONGER FOLDS `reviews` ITSELF. `ChecksTab` used to pick "the latest
//      NON-PENDING review per author", so a reviewer who APPROVED and later left a bare comment
//      was silently demoted to `commented` — while the Pending card, built from
//      `computeReviewStandingsByPr`, still said `approved` one click away. Measured on this
//      account's live open PRs: 59 disagreeing reviewer-PR pairs. `approvalThenComment` below is
//      that exact shape, and it is the assertion the whole change exists for.
//   2. THE TWO SURFACES READ ONE FOLD, so the test compares them DIRECTLY rather than comparing
//      each against a hand-written expectation — two expectations can both be updated to agree
//      with a bug, one comparison cannot.
//   3. ⚠ `reviewerCount` IS THE FOLD'S OWN TOTAL and INCLUDES the reviewer whose GitHub account is
//      gone, who cannot appear in the list. The pane is UNCAPPED, so its list is every NAMEABLE
//      reviewer and the difference is exactly the unnameable ones — never a "+N" the client
//      subtracted its way to.
//   4. A 'pending' review draft is NOT a standing. It names someone who has not spoken.
//   5. ⚠ MERGE-QUEUE MEMBERSHIP IS THREE-STATE ON THE PANE TOO. `null` is NOT OBSERVED and must
//      survive as null: coerced to `false`, the Overview row would tell a reader a PR is not
//      queued on the strength of never having asked.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InsightCard, InsightPrRef, PrDetail } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-pr-detail-review-standing-test.sqlite';
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
// truncated on write and the standingAt comparisons below would drift by milliseconds.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'viewer-me';
const prIdByKey = new Map<string, number>();
const loginByUserId = new Map<number, string>();

async function detail(key: string): Promise<PrDetail> {
  const d = await q.getPrDetail(prIdByKey.get(key)!, 1);
  expect(d, `no PR detail for ${key}`).not.toBeNull();
  return d as PrDetail;
}

/** The Pending board's own view of the same PR. Any PR-bearing kind will do — they are all the
 *  one `prRef` builder — so this takes the first and asserts one exists. */
async function card(key: string): Promise<InsightCard & InsightPrRef> {
  const prId = prIdByKey.get(key)!;
  const insights = await q.getWorkspaceInsights(1, undefined, scope);
  const hit = (insights.cards as InsightCard[]).find(
    (c) => 'prId' in c && (c as InsightCard & InsightPrRef).prId === prId,
  );
  // ⚠ THE ANTI-VACUITY GUARD. Without it, a board that emitted no card for this PR would make
  // every agreement assertion below trivially true.
  expect(hit, `the board emitted no card for ${key}`).toBeTruthy();
  return hit as InsightCard & InsightPrRef;
}

/** (login, standing, standingAt) read together — a standing beside the wrong person is the
 *  failure, and asserting the three apart would miss it. */
const triple = (r: { userId: number; standing: string; standingAt: string }): [string, string, number] => [
  loginByUserId.get(r.userId) ?? `user${r.userId}`,
  r.standing,
  Date.parse(r.standingAt),
];

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');

  const { accounts, events, repos, pullRequests, reviews, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null — half of getPrDetail's viewer fields would then be dead.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    loginByUserId.set(u.id, login);
    return u.id;
  };
  await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-dev');
  const bobId = await insertUser('bob-dev');
  const carolId = await insertUser('carol-dev');

  const [repo] = await db
    .insert(repos)
    .values({
      accountId: 1,
      owner: 'acme',
      name: 'pane',
      githubNodeId: 'R_pane',
      defaultBranch: 'main',
      defaultBranchName: 'main',
      viewerPermission: 'WRITE',
      createdAt: new Date(REPO_ADDED),
    })
    .returning()
    .execute();
  const repoId = repo.id;

  let n = 1;
  let ev = 1;
  const insertPr = async (
    key: string,
    authorId: number,
    values: Record<string, unknown> = {},
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_pane_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(REPO_ADDED + DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        mergeStateStatus: 'clean',
        mergeable: 'mergeable',
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
    // ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there.
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId: pr.id,
        actorId: authorId,
        type: 'commit_pushed',
        occurredAt: new Date(now - DAY),
        dedupeKey: `ev_pane_${ev++}`,
      })
      .execute();
    return pr.id;
  };

  let rv = 1;
  const addReview = async (
    prId: number,
    authorId: number | null,
    state: string,
    at: number,
  ): Promise<void> => {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_pane_${rv++}`,
        prId,
        authorId,
        state,
        submittedAt: new Date(at),
      })
      .execute();
  };

  // ── (1) `approvalThenComment` — THE REGRESSION, in one PR.
  //
  // alice approves, then leaves a bare comment two days later. The retired client fold took her
  // LATEST non-pending review and read `commented`; the canonical fold keeps the VERDICT, so both
  // surfaces read `approved` — dated by the approval, not by the comment. bob is the control:
  // one comment and nothing else, which must stay `commented` on both.
  const atcId = await insertPr('approvalThenComment', carolId, { reviewDecision: 'approved' });
  await addReview(atcId, aliceId, 'approved', now - 5 * DAY);
  await addReview(atcId, aliceId, 'commented', now - 3 * DAY);
  await addReview(atcId, bobId, 'commented', now - 4 * DAY);
  // A review draft that was never submitted. Not a standing: it would name someone who has not
  // spoken, and it is dated most recently of all, so a fold that let it through would win.
  await addReview(atcId, carolId, 'pending', now - 1 * HOUR);
  // ⚠ A DELETED GITHUB ACCOUNT — unnameable, so absent from both lists, and still counted.
  await addReview(atcId, null, 'approved', now - 6 * DAY);

  // ── (2) `unobserved` — never reviewed, synced before the merge-queue columns existed. Every
  // new field at its honest empty, and NOT ONE of them a negative claim.
  await insertPr('unobserved', bobId);

  // ── (3) `queued` — in GitHub's merge queue and being EJECTED. `mergeStateStatus` is `blocked`
  // because GitHub's enum has no QUEUED member, which is the whole reason these two are columns.
  await insertPr('queued', bobId, {
    mergeStateStatus: 'blocked',
    inMergeQueue: true,
    mergeQueueEntryState: 'unmergeable',
  });

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into Default.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the PR pane reads the canonical standing fold', () => {
  it('⚠ keeps an approval that a later bare comment used to withdraw', async () => {
    const d = await detail('approvalThenComment');
    const byLogin = new Map(d.reviewStandings.map((r) => [loginByUserId.get(r.userId)!, r]));
    const alice = byLogin.get('alice-dev')!;
    // The retired client rule read `commented` here — 59 reviewer-PR pairs on live open PRs.
    expect(alice.standing).toBe('approved');
    // ⚠ AND IT IS DATED BY THE REVIEW THAT SET IT. Dating the approval by the later comment would
    // print "approved · 3d ago" over a five-day-old approval: a false claim about a person.
    expect(Date.parse(alice.standingAt)).toBe(now - 5 * DAY);
    // The control: a reviewer who only ever commented is unaffected in either rule.
    expect(byLogin.get('bob-dev')!.standing).toBe('commented');
  });

  it('drops the unnameable reviewer from the list and keeps them in the count', async () => {
    const d = await detail('approvalThenComment');
    // alice, bob — and NOT carol, whose only row is an unsubmitted draft.
    expect(d.reviewStandings.map((r) => loginByUserId.get(r.userId)).sort()).toEqual([
      'alice-dev',
      'bob-dev',
    ]);
    // Three standings: the two above plus the deleted account's approval.
    expect(d.reviewerCount).toBe(3);
    // ⚠ The difference IS the unnameable ones. The pane is uncapped, so there is no other reason
    // for the two numbers to differ, and the row it draws says so in words.
    expect(d.reviewerCount - d.reviewStandings.length).toBe(1);
  });

  it('reports nothing at all on a PR nobody has reviewed', async () => {
    const d = await detail('unobserved');
    expect(d.reviewStandings).toEqual([]);
    expect(d.reviewerCount).toBe(0);
  });
});

describe('the pane and the Pending card describe one PR the same way', () => {
  it('⚠ agree reviewer for reviewer, standing for standing, clock for clock', async () => {
    const d = await detail('approvalThenComment');
    const c = await card('approvalThenComment');
    // Compared DIRECTLY rather than each against its own expectation: two expectations can both
    // be edited to agree with a bug; one comparison cannot. The card caps at five and this PR has
    // two nameable reviewers, so the lists are the same population here — sorted because the card
    // RE-RANKS (blocking first, humans before bots) and the pane keeps the fold's own order.
    const sorted = (rs: { userId: number; standing: string; standingAt: string }[]) =>
      rs.map(triple).sort((a, b) => a[0].localeCompare(b[0]));
    expect(sorted(d.reviewStandings)).toEqual(sorted(c.reviewers));
    // ⚠ AND SO DOES THE TOTAL, which is what the "+N" and the pane's deleted-account row are both
    // measured against.
    expect(d.reviewerCount).toBe(c.reviewerCount);
  });

  it('⚠ the approval COUNT the card publishes is the one this fold produces', async () => {
    const c = await card('approvalThenComment');
    // alice + the deleted account. `reviewApprovals` is hashed into stored Pro work plans, so a
    // count that moves re-bills every affected workspace — this asserts the value the pane's
    // change was required not to touch.
    expect(c.reviewApprovals).toBe(2);
    expect(c.reviewChangesRequested).toBe(false);
  });
});

describe('the merge queue on the pane', () => {
  it('⚠ preserves an unobserved queue as null — never coerced to false', async () => {
    const d = await detail('unobserved');
    expect(d.inMergeQueue).toBeNull();
    expect(d.mergeQueueEntryState).toBeNull();
  });

  it('carries membership and the ejection state, which is what the Overview row reads', async () => {
    const d = await detail('queued');
    expect(d.inMergeQueue).toBe(true);
    // The value that earns the column: GitHub is taking the entry back out. Before it reached the
    // pane, the only way to find out was to press Merge and read the failure.
    expect(d.mergeQueueEntryState).toBe('unmergeable');
    // ⚠ AND THE SYNCED STATUS STILL SAYS `blocked`, because GitHub's enum has no QUEUED member.
    // That is precisely why the Overview row cannot answer "can this land?" from it alone.
    expect(d.mergeStateStatus).toBe('blocked');
  });
});
