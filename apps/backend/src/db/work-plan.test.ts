// The work plan's CODE-DERIVED EVIDENCE, on a THROWAWAY sqlite DB (the ci-failing-cards.test.ts
// pattern).
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. ⚠ THE ALIGNMENT CONTRACT — THE LOAD-BEARING ONE. The plan sits directly under the daily
//      brief, and both fold the SAME `/api/attention` cards. `getWorkPlan(...).counts` must equal
//      `getDailyBriefEntry(...).counts` field for field, for the same (accountId, workspaceId).
//      A divergence is a defect in ONE fold, not two opinions — and the two folds live in two
//      files (db/work-plan.ts and db/daily-brief.ts) as two hand-maintained spellings, which is
//      exactly the shape that drifts. THE ASSERTION IS MUTATION-TESTED: see its comment.
//   2. THE MERGE CLASSIFICATION. 'unstable' IS mergeable (only NON-required checks are red) and
//      'behind' is NOT (GitHub 405s it). A CONFLICTING PR IS NEITHER even when its
//      `mergeStateStatus` is otherwise ready — the `mergeable !== 'conflicting'` guard is the only
//      thing that excludes it, and a fixture without that row would pass with the guard deleted.
//      Drafts, merged PRs, 'blocked' and 'dirty' are the other negative controls.
//   3. THE THREE RELEVANCE TIERS on the two new kinds: `direct` = you authored it, `maintained` =
//      it is in a repo you maintain (the SAME `viewerMaintainedRepoIds` resolver My Turn and the
//      ci_failing trunk arm use), `none` = neither.
//   4. THE RANK IS THE CODE'S. A mergeable, approved PR outranks a four-day-old untouched thread;
//      a `direct` item outranks an otherwise IDENTICAL `none` item; and the order is STABLE across
//      two calls, because a panel people read top-down may not reshuffle between polls.
//   5. THE EMPTY-WORKSPACE SHORT-CIRCUIT. `scope.repoIds === []` is a real answer ("this workspace
//      is empty"), never a widening to the whole account.
//   6. ⚠ THE ID IS THE MODEL'S JOIN KEY, so ids must be UNIQUE — including across the PR and REPO
//      id spaces, which both start at 1 (the trunk `unblock_ci` row is repo-grained).
//
// ⚠ WHY THERE ARE THREE WORKSPACES. `WORK_PLAN_ITEM_CAP` is 12, and a row pushed out by the cap
// reads EXACTLY like a row the classifier rejected — so every absence assertion ("a conflicting PR
// is neither") would pass with the guard deleted if the fixture were crowded. The 'Plan' workspace
// is therefore kept deliberately UNDER the cap (asserted, so a future addition fails loudly) and
// owns every classification / relevance / rank assertion; 'Default' holds a filler repo whose only
// job is to EXCEED the cap so the disclosure has something to disclose; 'Empty' holds nothing.
//
// The repos in 'Plan' are added with `createdAt: now`, which puts every seeded PR BEFORE their
// My Turn "New PRs" cutoff — that is the documented per-repo rule (my-turn-new-prs.test.ts) and it
// keeps a dozen incidental `watched_repo_pr` cards from crowding the workspace under test.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkPlanEvidence, WorkPlanItem, WorkPlanKind } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-work-plan-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let brief: any;
let workPlan: any;
/** The uncrowded fixture — every classification / relevance / rank assertion reads this. */
let planScope: any;
/** The over-the-cap filler workspace — the disclosure + stability assertions read this. */
let fillerScope: any;
let emptyScope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and could turn an intended "over the 96h bucket" into "just under it".
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const FILLER_PRS = 20;

const VIEWER_LOGIN = 'viewer-me';
const TRUNK_SHA = 'aaaaaaa1111111111111111111111111111111ab';

const repoIdByKey = new Map<string, number>();
const prIdByKey = new Map<string, number>();
let viewerId = 0;
let aliceId = 0;
let bobId = 0;
let threadId = 0;

const pr = (key: string): number => prIdByKey.get(key)!;
const repo = (key: string): number => repoIdByKey.get(key)!;
const itemFor = (ev: WorkPlanEvidence, id: string): WorkPlanItem | undefined =>
  ev.items.find((i) => i.id === id);

async function plan(s: any = planScope): Promise<WorkPlanEvidence> {
  return workPlan.getWorkPlan(1, s);
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
  workPlan = await import('./work-plan.js');

  const { accounts, events, repos, pullRequests, reviews, reviewRequests, reviewThreads, users } =
    schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login, which makes getAccountUserId return
  // null — every relevance tier would collapse and the assertions would be vacuously true.
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
  bobId = await insertUser('bob-dev');

  const insertRepo = async (key: string, values: Record<string, unknown>): Promise<number> => {
    const [row] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_wp_${key}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        createdAt: new Date(now),
        ...values,
      })
      .returning()
      .execute();
    repoIdByKey.set(key, row.id);
    return row.id;
  };

  let n = 1;
  let ev = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_wp_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        // ⚠ Two hours old by default: INSIGHT_ROUTING_MIN_AGE_HOURS is 4, so the default row is
        // NEVER a reviewer_routing orphan — which keeps `getWorkspaceInsights` off the CODEOWNERS
        // network path for the whole fixture.
        openedAt: new Date(now - 2 * HOUR),
        updatedAt: new Date(now - 2 * HOUR),
        lastCommitAt: new Date(now - HOUR),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    return row.id;
  };
  // getWorkspaceInsights' open-PR population requires a real ACTIVITY EVENT inside the 90-day
  // ultra-stale window — `pullRequests.updatedAt` is deliberately not trusted there. An open PR
  // with no event is invisible to the card half of the fold.
  const touch = async (repoId: number, prId: number): Promise<void> => {
    await db
      .insert(events)
      .values({
        accountId: 1,
        repoId,
        prId,
        actorId: aliceId,
        type: 'commit_pushed',
        occurredAt: new Date(now - HOUR),
        dedupeKey: `wp_ev_${ev++}`,
      })
      .execute();
  };
  const review = async (
    prId: number,
    reviewerId: number,
    key: string,
    state: 'approved' | 'commented',
  ): Promise<void> => {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_wp_${key}`,
        prId,
        authorId: reviewerId,
        state,
        submittedAt: new Date(now - HOUR),
      })
      .execute();
  };
  /** A pending request from someone who is NOT the viewer: it keeps the PR off the orphan path
   *  (no CODEOWNERS fetch) and, past 24h, makes it a `stalled_review` card. */
  const requestFrom = async (prId: number, userId: number): Promise<void> => {
    await db.insert(reviewRequests).values({ prId, userId }).execute();
  };
  const untouchedThread = async (
    prId: number,
    key: string,
    path: string,
    createdAt: number,
  ): Promise<number> => {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `TH_wp_${key}`,
        prId,
        path,
        isResolved: false,
        derivedState: 'untouched',
        createdAt: new Date(createdAt),
        originalCommenterId: bobId,
      })
      .returning()
      .execute();
    return t.id;
  };

  // ── repo 'mine': the viewer MAINTAINS it (ADMIN) and its trunk is RED ────────────────────
  const mine = await insertRepo('mine', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: TRUNK_SHA,
    defaultBranchCiStatus: 'failure',
    defaultBranchUpdatedAt: new Date(now - 3 * HOUR),
  });
  // ── repo 'other': READ, and the viewer has landed nothing on its default branch ──────────
  const other = await insertRepo('other', { viewerPermission: 'READ' });

  // ── the merge classification set ─────────────────────────────────────────────────────────
  // POSITIVE: 'clean' + viewer-authored → merge, relevance `direct`. Two approvals, so it also
  // exercises the merge-only APPROVED_BONUS — and, being approved, it is the `direct` half of the
  // ranking twins (same proximity as `t-none` once both clamp to 1).
  await insertPr(mine, 'm-clean-direct', {
    authorId: viewerId,
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    ciStatus: 'success',
  });
  await touch(mine, pr('m-clean-direct'));
  await review(pr('m-clean-direct'), aliceId, 'clean-a', 'approved');
  await review(pr('m-clean-direct'), bobId, 'clean-b', 'approved');

  // POSITIVE: 'unstable' IS mergeable — only NON-required checks are red, GitHub will still take
  // it. Alice's PR in a repo the viewer maintains → relevance `maintained`.
  await insertPr(mine, 'm-unstable', {
    authorId: aliceId,
    mergeable: 'mergeable',
    mergeStateStatus: 'unstable',
    ciStatus: 'failure',
  });
  await touch(mine, pr('m-unstable'));

  // POSITIVE: 'behind' → update_branch, in a repo the viewer neither authored in nor maintains →
  // relevance `none`.
  await insertPr(other, 'm-behind', {
    authorId: aliceId,
    mergeable: 'mergeable',
    mergeStateStatus: 'behind',
    ciStatus: 'success',
  });
  await touch(other, pr('m-behind'));

  // ⚠ NEGATIVE, AND THE SHARPEST ONE: a READY merge state with `mergeable: 'conflicting'`. Only
  // the `mergeable !== 'conflicting'` guard excludes it; without this row the guard could be
  // deleted and every assertion here would still pass.
  await insertPr(mine, 'm-conflicting', {
    authorId: aliceId,
    mergeable: 'conflicting',
    mergeStateStatus: 'clean',
  });
  await touch(mine, pr('m-conflicting'));

  // NEGATIVE for the merge kinds — but it is review-requested and five days old, so it DOES emit a
  // `nudge`, which is the card-derived row the DIRTY_PENALTY assertion looks at.
  await insertPr(mine, 'm-dirty', {
    authorId: aliceId,
    mergeable: 'conflicting',
    mergeStateStatus: 'dirty',
    openedAt: new Date(now - 5 * DAY),
    updatedAt: new Date(now - HOUR),
  });
  await touch(mine, pr('m-dirty'));
  await requestFrom(pr('m-dirty'), bobId);

  // NEGATIVE: 'blocked' — protection is unmet. Not ready, not behind.
  await insertPr(mine, 'm-blocked', {
    authorId: aliceId,
    mergeable: 'mergeable',
    mergeStateStatus: 'blocked',
  });
  await touch(mine, pr('m-blocked'));

  // NEGATIVE: a DRAFT that would otherwise be mergeable.
  await insertPr(mine, 'm-draft', {
    authorId: aliceId,
    isDraft: true,
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
  });
  await touch(mine, pr('m-draft'));

  // NEGATIVE: already merged.
  await insertPr(mine, 'm-merged', {
    authorId: aliceId,
    state: 'merged',
    baseRefName: 'main',
    mergedAt: new Date(now - 3 * HOUR),
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
  });

  // ── the THREAD-WALL row: mergeable, but with three unanswered threads on it ──────────────
  await insertPr(mine, 'wall', {
    authorId: aliceId,
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    ciStatus: 'success',
  });
  await touch(mine, pr('wall'));
  // Under INSIGHT_UNTOUCHED_THREAD_HOURS (24), so these are a WALL for the merge row's proximity
  // without also minting three untouched_thread cards.
  for (let i = 0; i < 3; i++)
    await untouchedThread(pr('wall'), `wall${i}`, `src/wall${i}.ts`, now - 2 * HOUR);

  // ── the `none` half of the ranking twins: same clean state, same age, nobody's repo ──────
  await insertPr(other, 't-none', {
    authorId: aliceId,
    mergeable: 'mergeable',
    mergeStateStatus: 'clean',
    ciStatus: 'success',
  });
  await touch(other, pr('t-none'));

  // ── the viewer's own RED PR (ci_failing 'your_pr') ───────────────────────────────────────
  await insertPr(mine, 'ci-mine', {
    authorId: viewerId,
    ciStatus: 'failure',
    openedAt: new Date(now - 3 * DAY),
    updatedAt: new Date(now - 2 * DAY),
    // The head commit is what the CI verdict is about: 48h → the 0.70 stall bucket.
    lastCommitAt: new Date(now - 2 * DAY),
  });
  await touch(mine, pr('ci-mine'));
  // A submitted review (not a pending REQUEST): it keeps this PR off the reviewer_routing orphan
  // path without also making it a `stalled_review` card, which would add a `nudge` row the Plan
  // workspace has no headroom for.
  await review(pr('ci-mine'), bobId, 'ci-mine-comment', 'commented');

  // ── the STALLED + UNTOUCHED-THREAD PR (two signals, two distinct ids on one PR) ──────────
  await insertPr(mine, 'thr', {
    authorId: aliceId,
    openedAt: new Date(now - 5 * DAY),
    updatedAt: new Date(now - HOUR),
  });
  await touch(mine, pr('thr'));
  await requestFrom(pr('thr'), bobId);
  // FOUR DAYS — the top stall bucket (>= 96h → 1.00).
  threadId = await untouchedThread(pr('thr'), 'thr', 'src/auth/login.ts', now - 4 * DAY);

  // ── the FILLER repo: its only job is to push a workspace OVER the 12-item cap ────────────
  // It keeps the REPO_ADDED cutoff (unlike the two above), so every one of its PRs is a My Turn
  // "New PR" — twenty `review` rows, none of which any assertion names.
  const filler = await insertRepo('filler', {
    viewerPermission: 'READ',
    createdAt: new Date(REPO_ADDED),
  });
  for (let i = 0; i < FILLER_PRS; i++) {
    await insertPr(filler, `f${i}`, { authorId: aliceId });
    await touch(filler, pr(`f${i}`));
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and every count is 0 and the fixture asserts nothing.
  // (Assignment is a MOVE: `mine` and `other` LEAVE Default, so Default keeps only `filler`.)
  const planWs = await q.createWorkspace(1, 'Plan');
  await q.assignReposToWorkspace(planWs.id, 1, [mine, other]);
  planScope = await q.resolveWorkspaceScope(1, planWs.id);
  fillerScope = await q.resolveWorkspaceScope(1, null);
  const emptyWs = await q.createWorkspace(1, 'Empty');
  emptyScope = await q.resolveWorkspaceScope(1, emptyWs.id);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the fixture really is split the way the assertions assume', () => {
  it('puts the two rich repos in Plan and only the filler in Default', () => {
    expect([...planScope.repoIds].sort()).toEqual([repo('mine'), repo('other')].sort());
    expect(fillerScope.repoIds).toEqual([repo('filler')]);
    expect(emptyScope.repoIds).toHaveLength(0);
  });

  it('drops nothing from Plan, so an absence really is a rejection', async () => {
    // ⚠ THE GUARD FOR EVERY `toBeUndefined()` BELOW. A row pushed out by WORK_PLAN_ITEM_CAP reads
    // exactly like a row the classifier rejected, so if a future addition crowds this workspace
    // the negative controls quietly stop testing anything. Fail here instead.
    //
    // Deliberately NOT `< WORK_PLAN_ITEM_CAP`: a fixture sitting exactly ON the cap has still
    // dropped nothing, so pinning the constant fails on a workspace that is perfectly sound. The
    // line below states the property itself.
    const ev = await plan();
    // The direct proof: `totals` is the PRE-CAP fold, so totals === shown means nothing at all was
    // sliced off — every `toBeUndefined()` below really is the classifier's answer.
    const totalRows = Object.values(ev.totals).reduce<number>((s, v) => s + (v ?? 0), 0);
    expect(totalRows).toBe(ev.items.length);
  });
});

describe('the work plan agrees with the daily brief', () => {
  // ⚠ THE LOAD-BEARING ASSERTION, AND IT IS MUTATION-TESTED. With `stalled_review` folded into
  // `untouchedThreads` in db/work-plan.ts's `foldCounts`, this `it` fails on the Plan workspace
  // with `untouchedThreads` 3 against the brief's 1 and `stalled` 0 against 2 — so the assertion
  // can genuinely fail, and the non-vacuity guard is what keeps it that way.
  it.each([
    ['Plan', () => planScope],
    ['Default (filler)', () => fillerScope],
  ])('counts every attention kind exactly as the daily brief does — %s', async (_label, get) => {
    const s = get();
    const ev = await plan(s);
    const { counts } = await brief.getDailyBriefEntry(1, s.workspaceId);
    expect(ev.counts).toEqual({
      myTurn: counts.myTurn,
      myTurnPersonal: counts.myTurnPersonal,
      ciFailing: counts.ciFailing,
      stalled: counts.stalled,
      untouchedThreads: counts.untouchedThreads,
      needsReviewer: counts.needsReviewer,
    });
    expect(ev.workspaceId).toBe(s.workspaceId);
  });

  it('is NOT vacuous — the fixture actually populates the kinds it pins', async () => {
    // Zeros on both sides would make the assertion above pass with either fold deleted.
    const ev = await plan();
    expect(ev.counts.ciFailing).toBeGreaterThan(0);
    expect(ev.counts.stalled).toBeGreaterThan(0);
    expect(ev.counts.untouchedThreads).toBeGreaterThan(0);
    const fill = await plan(fillerScope);
    expect(fill.counts.myTurn).toBe(FILLER_PRS);
  });
});

describe('merge / update_branch classification', () => {
  it('takes clean and unstable, and only `behind` is an update_branch', async () => {
    const ev = await plan();
    const kindOf = (key: string): WorkPlanKind | undefined =>
      ev.items.find((i) => i.prId === pr(key) && (i.kind === 'merge' || i.kind === 'update_branch'))
        ?.kind;
    // 'unstable' means only NON-required checks are red — GitHub will still merge it.
    expect(kindOf('m-clean-direct')).toBe('merge');
    expect(kindOf('m-unstable')).toBe('merge');
    // 'behind' is the one GitHub 405s until the branch is updated.
    expect(kindOf('m-behind')).toBe('update_branch');
  });

  it('a CONFLICTING PR is neither, even with a ready merge state', async () => {
    const ev = await plan();
    // ⚠ `mergeStateStatus: 'clean'` here — the ONLY thing excluding this row is the
    // `mergeable !== 'conflicting'` guard.
    expect(itemFor(ev, `wp:merge:${pr('m-conflicting')}`)).toBeUndefined();
    expect(itemFor(ev, `wp:update_branch:${pr('m-conflicting')}`)).toBeUndefined();
  });

  it('drafts, merged PRs, `blocked` and `dirty` are neither', async () => {
    const ev = await plan();
    for (const key of ['m-draft', 'm-merged', 'm-blocked', 'm-dirty']) {
      expect(itemFor(ev, `wp:merge:${pr(key)}`)).toBeUndefined();
      expect(itemFor(ev, `wp:update_branch:${pr(key)}`)).toBeUndefined();
    }
  });

  it('carries the PR link and GitHub’s merge state verbatim', async () => {
    const ev = await plan();
    const item = itemFor(ev, `wp:merge:${pr('m-unstable')}`);
    expect(item?.githubUrl).toBe(`https://github.com/acme/mine/pull/${item?.prNumber}`);
    expect(item?.facts.mergeStateStatus).toBe('unstable');
    expect(item?.prId).toBe(pr('m-unstable'));
    expect(item?.repoId).toBe(repo('mine'));
    expect(item?.repoFullName).toBe('acme/mine');
  });
});

describe('the three relevance tiers on the two new kinds', () => {
  it('direct = you authored it', async () => {
    const ev = await plan();
    expect(itemFor(ev, `wp:merge:${pr('m-clean-direct')}`)?.relevance).toBe('direct');
  });

  it('maintained = someone else’s PR in a repo you maintain', async () => {
    const ev = await plan();
    expect(itemFor(ev, `wp:merge:${pr('m-unstable')}`)?.relevance).toBe('maintained');
  });

  it('none = neither yours nor in a repo you maintain', async () => {
    const ev = await plan();
    // Both rows live in `other`, where the viewer has READ and has landed nothing.
    expect(itemFor(ev, `wp:update_branch:${pr('m-behind')}`)?.relevance).toBe('none');
    expect(itemFor(ev, `wp:merge:${pr('t-none')}`)?.relevance).toBe('none');
  });

  it('the ci_failing arms keep their own two claims', async () => {
    const ev = await plan();
    // Your own red PR is yours to fix; a red trunk is a repo you maintain, not a PR you own.
    expect(itemFor(ev, `wp:unblock_ci:${pr('ci-mine')}`)?.relevance).toBe('direct');
    expect(itemFor(ev, `wp:unblock_ci:trunk:${repo('mine')}`)?.relevance).toBe('maintained');
  });
});

describe('the deterministic rank', () => {
  it('a mergeable, approved PR outranks a four-day-old untouched thread', async () => {
    const ev = await plan();
    const merge = itemFor(ev, `wp:merge:${pr('m-clean-direct')}`)!;
    const thread = itemFor(ev, `wp:thread:${pr('thr')}:${threadId}`)!;
    expect(merge).toBeDefined();
    expect(thread).toBeDefined();
    // The thread is genuinely at the TOP stall bucket — this is not a comparison against a fresh
    // item that happens to score low.
    expect(thread.stallRisk).toBe(1);
    expect(merge.score).toBeGreaterThan(thread.score);
    expect(ev.items.indexOf(merge)).toBeLessThan(ev.items.indexOf(thread));
  });

  it('a `direct` item outranks an otherwise IDENTICAL `none` item', async () => {
    const ev = await plan();
    const direct = itemFor(ev, `wp:merge:${pr('m-clean-direct')}`)!;
    const none = itemFor(ev, `wp:merge:${pr('t-none')}`)!;
    // Identical in every scoring input but relevance — same kind, same (clamped) proximity, same
    // stall bucket.
    expect(direct.proximity).toBe(none.proximity);
    expect(direct.stallRisk).toBe(none.stallRisk);
    expect(direct.relevance).toBe('direct');
    expect(none.relevance).toBe('none');
    // 0.20 · (1.0 − 0.25) = 0.15, the whole of the difference.
    expect(direct.score - none.score).toBeCloseTo(0.15, 10);
    expect(ev.items.indexOf(direct)).toBeLessThan(ev.items.indexOf(none));
  });

  it('applies the proximity adjustments exactly once', async () => {
    const ev = await plan();
    // merge 0.95 + approved 0.05 + small-diff 0.05 = 1.05, CLAMPED to 1.
    expect(itemFor(ev, `wp:merge:${pr('m-clean-direct')}`)?.proximity).toBe(1);
    expect(itemFor(ev, `wp:merge:${pr('m-clean-direct')}`)?.facts.approvals).toBe(2);
    // merge 0.95 + small-diff 0.05 − thread-wall 0.10 = 0.90 (three untouched threads).
    expect(itemFor(ev, `wp:merge:${pr('wall')}`)?.proximity).toBe(0.9);
    expect(itemFor(ev, `wp:merge:${pr('wall')}`)?.facts.untouchedThreads).toBe(3);
    // nudge 0.25 + small-diff 0.05 − dirty 0.15 = 0.15, on a CARD-derived row: the adjustments are
    // not a merge-fold-only affair.
    expect(itemFor(ev, `wp:nudge:${pr('m-dirty')}`)?.facts.mergeStateStatus).toBe('dirty');
    expect(itemFor(ev, `wp:nudge:${pr('m-dirty')}`)?.proximity).toBe(0.15);
    // A red TRUNK gets its own base (0.65) — it invalidates every open PR in the repo at once —
    // and nothing else: it is repo-grained, so it carries no diff size.
    expect(itemFor(ev, `wp:unblock_ci:trunk:${repo('mine')}`)?.proximity).toBe(0.65);
  });

  it('buckets stall risk off the item’s OWN clock', async () => {
    const ev = await plan();
    // The thread ages from `thread_created` (4 days → 1.00); the viewer's red PR from its head
    // commit (2 days → 0.70); a two-hour-old merge candidate is at the floor.
    const thread = itemFor(ev, `wp:thread:${pr('thr')}:${threadId}`);
    expect(thread?.facts.clock).toBe('thread_created');
    expect(thread?.stallRisk).toBe(1);
    const red = itemFor(ev, `wp:unblock_ci:${pr('ci-mine')}`);
    expect(red?.facts.clock).toBe('last_commit');
    expect(red?.stallRisk).toBe(0.7);
    expect(itemFor(ev, `wp:merge:${pr('t-none')}`)?.stallRisk).toBe(0.15);
    // The stalled_review row ages from `opened`, and the trunk row from OUR observation.
    expect(itemFor(ev, `wp:nudge:${pr('thr')}`)?.facts.clock).toBe('opened');
    expect(itemFor(ev, `wp:unblock_ci:trunk:${repo('mine')}`)?.facts.clock).toBe('observed');
  });

  it('is sorted descending and STABLE across two calls', async () => {
    for (const s of [planScope, fillerScope]) {
      const a = await plan(s);
      const b = await plan(s);
      // A panel people read top-down may not reshuffle between polls.
      expect(b.items.map((i) => i.id)).toEqual(a.items.map((i) => i.id));
      for (let i = 1; i < a.items.length; i++)
        expect(a.items[i]!.score).toBeLessThanOrEqual(a.items[i - 1]!.score);
    }
  });

  it('caps the list and discloses the UNCAPPED population per kind', async () => {
    const ev = await plan(fillerScope);
    expect(ev.items).toHaveLength(workPlan.WORK_PLAN_ITEM_CAP);
    // ⚠ `totals` is the PRE-CAP fold. Counted after the slice it would be bounded by 12 and would
    // stop being a total — a capped list that says nothing is a silent truncation.
    expect(ev.totals.review).toBe(FILLER_PRS);
    const totalRows = Object.values(ev.totals).reduce<number>((s, v) => s + (v ?? 0), 0);
    expect(totalRows).toBeGreaterThan(ev.items.length);
  });
});

describe('the item rows', () => {
  it('have unique ids, including across the PR and REPO id spaces', async () => {
    const ev = await plan();
    const ids = ev.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ⚠ `pull_requests.id` and `repos.id` are separate sequences that both start at 1, so the
    // repo-grained trunk row gets its own segment rather than sharing `wp:unblock_ci:<n>`.
    expect(ids).toContain(`wp:unblock_ci:trunk:${repo('mine')}`);
  });

  it('every row carries a real repo, a link, and a code-written reason', async () => {
    const ev = await plan();
    for (const i of ev.items) {
      expect(planScope.repoIds).toContain(i.repoId);
      expect(i.repoFullName).toMatch(/^acme\//);
      expect(i.githubUrl.startsWith('https://github.com/acme/')).toBe(true);
      expect(i.reason.length).toBeGreaterThan(0);
      // A null prId is a REPO-grained row and nothing else.
      if (i.prId == null) expect(i.kind).toBe('unblock_ci');
    }
  });

  it('gives stalled_review and reviewer_routing DIFFERENT sentences', async () => {
    const ev = await plan();
    // Someone WAS asked here and has not moved; reviewer_routing means nobody was asked at all.
    // Two situations, two reasons — the fixture holds the first, so this pins its wording against
    // the other's.
    const nudge = itemFor(ev, `wp:nudge:${pr('thr')}`);
    expect(nudge?.kind).toBe('nudge');
    expect(nudge?.reason).toContain('nobody has moved');
    expect(nudge?.reason).not.toContain('Nobody has been asked');
    expect(nudge?.facts.pendingReviewers).toBe(1);
  });

  it('carries the thread id and the thread’s own path on a thread row', async () => {
    const ev = await plan();
    const t = itemFor(ev, `wp:thread:${pr('thr')}:${threadId}`);
    expect(t?.threadId).toBe(threadId);
    expect(t?.prId).toBe(pr('thr'));
    expect(t?.reason).toContain('src/auth/login.ts');
  });

  it('a trunk row names no PR and links to the COMMIT page', async () => {
    const ev = await plan();
    const t = itemFor(ev, `wp:unblock_ci:trunk:${repo('mine')}`);
    expect(t?.prId).toBeNull();
    expect(t?.prNumber).toBeNull();
    expect(t?.githubUrl).toContain(`/commit/${TRUNK_SHA}`);
  });

  it('never writes a relative clock into `reason` (it is a hashable field)', async () => {
    // ⚠ `reason` is stable-across-ticks by construction so the plugin can hash it; a "3d ago"
    // inside it would drift on a timer and re-bill a dormant workspace.
    for (const s of [planScope, fillerScope]) {
      for (const i of (await plan(s)).items) expect(i.reason).not.toMatch(/\bago\b/);
    }
  });
});

describe('the empty workspace', () => {
  it('is a real answer, not a widening to the whole account', async () => {
    const ev = await plan(emptyScope);
    expect(ev.items).toEqual([]);
    expect(ev.totals).toEqual({});
    expect(ev.workspaceId).toBe(emptyScope.workspaceId);
    expect(ev.counts).toEqual({
      myTurn: 0,
      myTurnPersonal: 0,
      ciFailing: 0,
      stalled: 0,
      untouchedThreads: 0,
      needsReviewer: 0,
    });
    // …and the brief says the same nothing for the same workspace, so the short-circuit did not
    // buy its speed by disagreeing with the strip.
    const { counts } = await brief.getDailyBriefEntry(1, emptyScope.workspaceId);
    expect([counts.myTurn, counts.ciFailing, counts.stalled, counts.untouchedThreads]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe('one PR is one job', () => {
  // ⚠ THE REGRESSION THIS FILE WAS MISSING. Every fold here is individually correct, so the unit
  // tests all passed while a real workspace rendered `DEFRA/bng-metric-backend#284` TWICE — once
  // from the merge fold ("Mergeable now · 1 approval · checks green") and once from the my_turn
  // fold ("Your PR is approved and waiting on you"). One instruction, printed twice, burning two
  // of the twelve slots. It was only visible by looking at the running app.
  //
  // The id dedup could not catch it: the two rows carry DIFFERENT ids (`wp:merge:<id>` and
  // `wp:review:<id>`), which is precisely why a second pass keyed on the PR exists.
  it('collapses a PR reached by two folds onto its furthest-along action', async () => {
    const ev = await plan();
    const target = pr('m-clean-direct');
    const rows = ev.items.filter((i) => i.prId === target);
    expect(rows).toHaveLength(1);
    // The survivor is the one naming the action furthest from "nothing has happened yet":
    // "merge it" carries strictly more information than "it is approved".
    expect(rows[0]!.kind).toBe('merge');
    expect(rows[0]!.id).toBe(`wp:merge:${target}`);
  });

  it('never lists one PR twice under two PR-grained kinds', async () => {
    const ev = await plan();
    // The invariant, stated over the whole fixture rather than one row — a new signal that
    // reaches an already-covered PR fails here without anyone remembering to add a case.
    // Repo- and thread-grained rows are exempt BY CONSTRUCTION (their id is not `wp:<kind>:<prId>`)
    // and are filtered out the same way the production dedup does it.
    const prGrained = ev.items.filter((i) => i.prId != null && i.id === `wp:${i.kind}:${i.prId}`);
    const seen = prGrained.map((i) => i.prId);
    expect(seen).toEqual([...new Set(seen)]);
  });

  it('keeps a red trunk exempt from the PR dedup, by construction', async () => {
    // A trunk row is REPO-grained: on a live workspace its `prId` names the LANDING PR of the
    // current head — a PR the card deliberately claims nothing about (~11% of red heads are direct
    // pushes and resolve to no PR at all, which is this fixture's case, so `prId` here is null).
    // Were it ever treated as PR-grained, a mergeable landing PR would swallow the only signal
    // saying the default branch is broken — and a red trunk invalidates every open PR in the repo
    // at once.
    //
    // The exemption is structural rather than a special case in the dedup: the row is addressed by
    // its REPO, so its id is not `wp:<kind>:<prId>` and it can never match the PR-grained test.
    const ev = await plan();
    const trunk = ev.items.find((i) => i.id.startsWith('wp:unblock_ci:trunk:'));
    expect(trunk).toBeDefined();
    expect(trunk!.id).toBe(`wp:unblock_ci:trunk:${trunk!.repoId}`);
    expect(trunk!.id).not.toBe(`wp:${trunk!.kind}:${trunk!.prId}`);
  });
});

describe('subject — what a row is ABOUT', () => {
  // ⚠ THIS IS NOT THE DEDUP GRAIN, AND CONFLATING THE TWO SHIPPED TWO BUGS. "Is this row the PR's
  // one job?" (the per-PR dedup) and "is this row about a pull request?" are different questions,
  // and a thread answers NO to the first and YES to the second. Deriving the second from the id
  // shape — which is how the first is answered — told the model that every review thread was a
  // repository default branch, and told the card to draw it as one.
  it('marks ONLY the red-trunk arm as repo-grained', async () => {
    const ev = await plan();
    for (const item of ev.items) {
      const expected = item.id.startsWith('wp:unblock_ci:trunk:') ? 'repo' : 'pr';
      expect([item.id, item.subject]).toEqual([item.id, expected]);
    }
  });

  it('calls a thread a PR, even though it is not the PR’s one job', async () => {
    // The exact row the id-shape derivation got wrong: not PR-grained for dedup (two threads on a
    // PR are two jobs), but unambiguously ABOUT a pull request.
    const ev = await plan();
    const thread = ev.items.find((i) => i.kind === 'thread' || i.kind === 'reply');
    expect(thread).toBeDefined();
    expect(thread!.subject).toBe('pr');
    expect(thread!.prId).not.toBeNull();
    // …and it is still exempt from the per-PR dedup, which is the other half of the distinction.
    expect(thread!.id).not.toBe(`wp:${thread!.kind}:${thread!.prId}`);
  });
});
