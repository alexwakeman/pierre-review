// The `ci_failing` attention cards — red builds the VIEWER is on the hook for — on a THROWAWAY
// sqlite DB (the my-turn-personal.test.ts pattern).
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. TWO ARMS, TWO DIFFERENT CLAIMS. 'your_pr' is an open PR you AUTHORED whose head CI is red;
//      'trunk' is the default branch of a repo you MAINTAIN being red right now. Somebody else's
//      red PR in a repo you maintain is NEITHER — it is a review, not your build — and a fixture
//      that only seeded the viewer's own rows would pass with the author test deleted.
//   2. RED IS THE PAIR `failure` | `error`, NEVER ONE OF THEM. `error` is how GitHub reports the
//      infrastructure/permissions half, which is the half that most often needs a human. A fold
//      spelled `=== 'failure'` type-checks perfectly and silently drops it.
//   3. THE MAINTAINER GATE IS REAL. A red trunk in a repo the viewer only READS emits nothing —
//      otherwise the card is just the existing workspace-wide `trunkRed` brief line with a
//      personal label glued on.
//   4. ⚠ A TRUNK CARD WITH NO LANDING PR STILL SHIPS. ~11% of red heads on real data are DIRECT
//      PUSHES to the default branch — a legitimate steady state, not a sync gap. The card must
//      still say trunk is red and simply not name a PR; degrading to "emit nothing" would hide a
//      broken trunk exactly where nobody is watching a PR.
//   5. ⚠ THE BLOCK RUNS ABOVE getWorkspaceInsights' `openPrIds.length === 0` GUARD. A workspace
//      with no qualifying open PR at all must still report its red trunks — the whole
//      "maintained-repo" arm sits on the far side of that early return otherwise. That guard is
//      WORKSPACE-WIDE, not per repo, which is why the fixture builds a SECOND workspace holding
//      only quiet repos: with everything in Default, `mine`'s open PRs keep the population
//      non-empty and a block moved below the guard would still pass.
//   6. `ciFailingTotal` is the PRE-CAP fold, exactly like `myTurnTotal`.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CiFailingCard, InsightCard } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-ci-failing-test.sqlite';
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
let quietScope: any;
let quietWorkspaceId = 0;

const DAY = 24 * 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write.
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;

const VIEWER_LOGIN = 'viewer-me';

const repoIdByKey = new Map<string, number>();
const prIdByKey = new Map<string, number>();
let viewerId = 0;
let aliceId = 0;

/** Every ci_failing card the board would paint right now, in the given workspace scope. */
async function ciCards(s: any = scope): Promise<CiFailingCard[]> {
  const insights = await q.getWorkspaceInsights(1, undefined, s);
  return (insights.cards as InsightCard[]).filter(
    (c): c is CiFailingCard => c.kind === 'ci_failing',
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
  brief = await import('./daily-brief.js');

  const { accounts, branchCommits, events, repos, pullRequests, users } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId
  // return null — the 'your_pr' arm would then match nobody and every assertion below would be
  // vacuously 0 === 0.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();

  const insertUser = async (login: string): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: false })
      .returning()
      .execute();
    return u.id;
  };
  viewerId = await insertUser(VIEWER_LOGIN);
  aliceId = await insertUser('alice-dev');

  let n = 1;
  let ev = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ci_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        openedAt: new Date(REPO_ADDED + DAY),
        updatedAt: new Date(now - DAY),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    return pr.id;
  };
  // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the
  // 90-day ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there.
  // An open PR with no event is invisible to the whole function, arm 1 included.
  const touch = async (repoId: number, prId: number): Promise<void> => {
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId,
        actorId: aliceId,
        type: 'commit_pushed',
        occurredAt: new Date(now - DAY),
        dedupeKey: `ev_${ev++}`,
      })
      .execute();
  };

  const insertRepo = async (
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [repo] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_ci_${key}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        createdAt: new Date(REPO_ADDED),
        ...values,
      })
      .returning()
      .execute();
    repoIdByKey.set(key, repo.id);
    return repo.id;
  };

  // ── repo 'mine': the viewer MAINTAINS it (ADMIN), trunk is red at a sha that resolves to a PR
  //    the VIEWER merged. Also carries the viewer's own red PR and two negative controls.
  const mine = await insertRepo('mine', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: 'aaaaaaa1111111111111111111111111111111ab',
    defaultBranchCiStatus: 'failure',
    defaultBranchUpdatedAt: new Date(now - 3600_000),
  });
  // arm 1: the viewer's own open PR, red.
  await insertPr(mine, 'my-red', {
    state: 'open',
    isDraft: false,
    authorId: viewerId,
    ciStatus: 'failure',
    lastCommitAt: new Date(now - 2 * DAY),
  });
  await touch(mine, prIdByKey.get('my-red')!);
  // The OTHER half of the red pair, on the arm that tests it row by row. `error` is GitHub's
  // infrastructure/permissions failure and a fold spelled `=== 'failure'` type-checks perfectly
  // while dropping it — this row is the only thing that notices.
  await insertPr(mine, 'my-errored', {
    state: 'open',
    isDraft: false,
    authorId: viewerId,
    ciStatus: 'error',
    lastCommitAt: new Date(now - 3 * DAY),
  });
  await touch(mine, prIdByKey.get('my-errored')!);
  // NEGATIVE: someone ELSE's red PR in a repo the viewer maintains. That is a REVIEW, not the
  // viewer's build — the arm is authorship, not repo ownership.
  await insertPr(mine, 'alice-red', {
    state: 'open',
    isDraft: false,
    authorId: aliceId,
    ciStatus: 'failure',
  });
  await touch(mine, prIdByKey.get('alice-red')!);
  // NEGATIVE: the viewer's own open PR that is GREEN.
  await insertPr(mine, 'my-green', {
    state: 'open',
    isDraft: false,
    authorId: viewerId,
    ciStatus: 'success',
  });
  await touch(mine, prIdByKey.get('my-green')!);
  // The landing PR of the red trunk head — merged BY THE VIEWER, which is the whole of the
  // trunk card's attribution (of LANDING, never of breaking).
  const landed = await insertPr(mine, 'landed', {
    state: 'merged',
    isDraft: false,
    authorId: aliceId,
    mergedById: viewerId,
    baseRefName: 'main',
    mergedAt: new Date(now - 4 * DAY),
  });
  await db
    .insert(branchCommits)
    .values({
      accountId: 1,
      repoId: mine,
      sha: 'aaaaaaa1111111111111111111111111111111ab',
      messageHeadline: 'the commit trunk is red at',
      committedAt: new Date(now - 4 * DAY),
      ciStatus: 'failure',
      // The stored association the card's PR half is resolved through.
      prNumber: (
        await db.select().from(pullRequests).where(eq(pullRequests.id, landed)).execute()
      )[0].number,
    })
    .execute();

  // ── repo 'read-only': trunk red (as `error`, the other half of the pair), but the viewer has
  //    READ and no merge history. Nothing here is theirs.
  const readOnly = await insertRepo('read-only', {
    viewerPermission: 'READ',
    defaultBranchHeadSha: 'bbbbbbb2222222222222222222222222222222cd',
    defaultBranchCiStatus: 'error',
    defaultBranchUpdatedAt: new Date(now - 3600_000),
  });
  await insertPr(readOnly, 'stranger-red', {
    state: 'open',
    isDraft: false,
    authorId: aliceId,
    ciStatus: 'error',
  });
  await touch(readOnly, prIdByKey.get('stranger-red')!);

  // ── repo 'no-open-prs': the viewer maintains it BY MERGE HISTORY (READ permission), trunk is
  //    red as `error`, and there is NO qualifying open PR anywhere in it — the control for the
  //    early-return trap, and for the 'error' half of the red pair.
  const noOpen = await insertRepo('no-open-prs', {
    viewerPermission: 'READ',
    defaultBranchHeadSha: 'ccccccc3333333333333333333333333333333ef',
    defaultBranchCiStatus: 'error',
    defaultBranchUpdatedAt: new Date(now - 7200_000),
  });
  await insertPr(noOpen, 'no-open-merged', {
    state: 'merged',
    isDraft: false,
    authorId: aliceId,
    mergedById: viewerId,
    baseRefName: 'main',
    mergedAt: new Date(now - 6 * DAY),
  });
  // ⚠ NO branch_commits row for this repo's head: the DIRECT-PUSH case. The card must still ship.

  // ── repo 'green': maintained, trunk green. The silent control.
  await insertRepo('green', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: 'ddddddd4444444444444444444444444444444ab',
    defaultBranchCiStatus: 'success',
    defaultBranchUpdatedAt: new Date(now - 3600_000),
  });

  // ⚠ A SECOND WORKSPACE HOLDING ONLY REPOS WITH NO OPEN PRs — the early-return control, and it
  // has to be its own workspace because that guard is WORKSPACE-WIDE, not per repo. With every
  // repo in Default, `mine`'s open PRs keep the population non-empty and a block moved below the
  // guard would still emit `no-open-prs`' trunk card, so the trap would go unpinned.
  // (Assignment is a MOVE: these two leave Default.)
  const quiet = await q.createWorkspace(1, 'Quiet');
  quietWorkspaceId = quiet.id;
  await q.assignReposToWorkspace(quiet.id, 1, [
    repoIdByKey.get('no-open-prs')!,
    repoIdByKey.get('green')!,
  ]);

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and every count is 0 and the fixture asserts nothing.
  scope = await q.resolveWorkspaceScope(1, null);
  quietScope = await q.resolveWorkspaceScope(1, quietWorkspaceId);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ci_failing cards', () => {
  it('split the four repos across the two workspaces being read', async () => {
    // Assignment is a MOVE, so Default keeps exactly the two noisy repos.
    expect([...scope.repoIds].sort()).toEqual(
      [repoIdByKey.get('mine'), repoIdByKey.get('read-only')].sort(),
    );
    expect([...quietScope.repoIds].sort()).toEqual(
      [repoIdByKey.get('no-open-prs'), repoIdByKey.get('green')].sort(),
    );
  });

  it('emits exactly the three red builds that are the viewer’s', async () => {
    const cards = await ciCards();
    expect(cards.map((c) => c.id).sort()).toEqual(
      [
        `cifail:pr:${prIdByKey.get('my-red')}`,
        `cifail:pr:${prIdByKey.get('my-errored')}`,
        `cifail:trunk:${repoIdByKey.get('mine')}:aaaaaaa1111111111111111111111111111111ab`,
      ].sort(),
    );
  });

  it('does NOT claim someone else’s red PR in a repo the viewer maintains', async () => {
    // The arm is AUTHORSHIP. Alice's red PR in `mine` needs a review, not a fix from the viewer —
    // and it is already on the board as review work.
    const cards = await ciCards();
    expect(cards.some((c) => c.prId === prIdByKey.get('alice-red'))).toBe(false);
  });

  it('does NOT claim a red trunk in a repo the viewer only reads', async () => {
    const cards = await ciCards();
    expect(cards.some((c) => c.repoId === repoIdByKey.get('read-only'))).toBe(false);
  });

  it('counts `error` as red on BOTH arms, not just `failure`', async () => {
    // ⚠ BOTH ARMS, because they ask the question differently: the trunk arm pushes the pair into
    // SQL (`inArray`) and the your_pr arm tests it row by row (`isRedCiStatus`). Pinning only one
    // of them leaves the other free to drift to `=== 'failure'`, which type-checks perfectly.
    expect(
      (await ciCards(quietScope)).find((c) => c.repoId === repoIdByKey.get('no-open-prs'))
        ?.ciStatus,
    ).toBe('error');
    expect(
      (await ciCards()).find((c) => c.prId === prIdByKey.get('my-errored'))?.ciStatus,
    ).toBe('error');
  });

  it('still reports a red trunk in a repo with NO qualifying open PR (the early-return trap)', async () => {
    // getWorkspaceInsights returns early once the WORKSPACE's open-PR population is empty. The
    // Quiet workspace holds only `no-open-prs` (merged PRs only) and `green` (nothing at all), so
    // this card exists only because the block runs ABOVE that guard. ⚠ Reading it from Default
    // instead would prove nothing: `mine`'s open PRs keep that population non-empty.
    const cards = await ciCards(quietScope);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card?.arm).toBe('trunk');
    // …and it names no PR, because a direct push to trunk has none. Degrading to "emit nothing"
    // would hide a broken trunk precisely where no PR is being watched.
    expect(card?.prId).toBeNull();
    expect(card?.prNumber).toBeNull();
    expect(card?.mergedById).toBeNull();
    expect(card?.viewerMerged).toBe(false);
    // The card still points somewhere useful: the commit page for the red head.
    expect(card?.githubUrl).toContain('/commit/ccccccc3333333333333333333333333333333ef');
  });

  it('names the landing PR and marks that the viewer merged it', async () => {
    const cards = await ciCards();
    const card = cards.find((c) => c.repoId === repoIdByKey.get('mine') && c.arm === 'trunk');
    expect(card?.prId).toBe(prIdByKey.get('landed'));
    expect(card?.mergedById).toBe(viewerId);
    expect(card?.viewerMerged).toBe(true);
    // Landing the commit trunk is red at is the strongest claim the data supports, so it is the
    // one case that outranks the rest of the maintained repos.
    expect(card?.severity).toBe('high');
  });

  it('a maintained repo with a green trunk says nothing', async () => {
    const cards = await ciCards(quietScope);
    expect(cards.some((c) => c.repoId === repoIdByKey.get('green'))).toBe(false);
  });

  it('the your_pr card carries the PR, its head clock and the PR page', async () => {
    const cards = await ciCards();
    const card = cards.find((c) => c.prId === prIdByKey.get('my-red'));
    expect(card?.prId).toBe(prIdByKey.get('my-red'));
    expect(card?.headSha).toBeNull();
    expect(card?.viewerMerged).toBe(false);
    expect(card?.severity).toBe('high');
    // `lastCommitAt`, not openedAt — the head commit is what the CI verdict is about.
    expect(card?.observedAt).toBe(new Date(now - 2 * DAY).toISOString());
    expect(card?.githubUrl).toContain('/pull/');
  });

  // ── the count pair ─────────────────────────────────────────────────────────────────────────
  it('the brief’s count and total agree with the cards the board paints', async () => {
    const insights = await q.getWorkspaceInsights(1, undefined, scope);
    const cards = await ciCards();
    const { counts } = await brief.getDailyBriefEntry(1, scope.workspaceId);
    expect(counts.ciFailing).toBe(cards.length);
    // ⚠ The PRE-CAP fold. Below INSIGHT_CARD_CAP the two agree, which is what makes this a
    // same-snapshot check rather than a cap check — the cap rule itself is pinned by
    // ciFailingCapDisclosure's own test on the client.
    expect(counts.ciFailingTotal).toBe(insights.ciFailingTotal);
    expect(insights.ciFailingTotal).toBe(cards.length);
  });
});
