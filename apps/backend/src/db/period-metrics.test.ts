// db/period-metrics.ts — the twelve-metric period vector and the coverage read, on a THROWAWAY
// sqlite DB.
//
// THE CONTRACTS THIS FILE EXISTS FOR, each of which is a way a period report could ship a
// confident wrong number that nothing downstream would notice:
//  • THE WINDOW IS HALF-OPEN, `[from, to)`, ON EVERY COLUMN. An event at exactly `from` is IN;
//    an event at exactly `to` is OUT. This is THE bug the spec calls out: a one-sided `gte` is
//    what makes three existing getters unusable here, and a two-sided predicate with an
//    INCLUSIVE upper edge double-counts every event that lands on the boundary two adjacent
//    periods share. Pinned below on `mergedAt`, `openedAt`, `firstReviewAt`, thread `createdAt`
//    and review `submittedAt` — five columns, because getting it right on four proves nothing
//    about the fifth.
//  • AN EMPTY SCOPE IS AN EMPTY WORKSPACE, NOT AN ERROR AND NOT THE WHOLE ACCOUNT. All twelve
//    metrics null, sampleSize 0.
//  • NULL IS NOT ZERO. A median over nothing, a percentage over nothing and a ratio with no
//    denominator are `null`; a count of zero is `0`. The UI renders those differently and the
//    difference has to originate here.
//  • THE UNSIZED-PR RULE. Lean storage defaults the three size columns to 0, so an unhydrated
//    PR is indistinguishable from an empty one — feeding a fabricated 0 into a MEDIAN drags it
//    towards zero by however many rows never hydrated.
//  • `median_time_to_first_review_hours` ATTRIBUTES ON `firstReviewAt`, NOT `openedAt`. A PR
//    opened long before the period still contributes if that is when it was picked up.
//  • THE FINGERPRINT IS STABLE ACROSS CALLS AND MOVES WHEN THE DATA DOES. A fingerprint that
//    folded in anything `Date.now()`-derived would mark every stored report stale forever and
//    invite a re-generation that changes nothing and costs money.
//
// ⚠ Its OWN database file and its OWN fixed window. Every timestamp is derived from two fixed
// UTC anchors, never from `Date.now()`, so the expected figures cannot drift with the clock.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// A test is not in `release/dist`, so it may import the types-only shared package for real —
// which is exactly what lets it prove the backend's mirrored key list has not drifted.
import { PERIOD_METRIC_KEYS as SHARED_KEYS } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-period-metrics-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let pm: any;
let scope: any;
let repoA = 0; // tracked from well before the period
let repoB = 0; // ditto — a second repo, so the scope is genuinely multi-repo
let repoC = 0; // added DURING the period: the coverage rule's whole reason for existing
let repoForeign = 0; // owned by ANOTHER account
let botCr = 0;
let botGr = 0;
let alice = 0;
let bob = 0;

const HOUR = 3_600_000;
const DAY = 86_400_000;

// The period under test: a 14-day sprint, fixed in absolute UTC. Second-aligned by construction
// (sqlite stores `mode: 'timestamp'` as epoch SECONDS, so a sub-second anchor would round).
const FROM = Date.UTC(2026, 6, 1); // 2026-07-01T00:00:00Z
const TO = Date.UTC(2026, 6, 15); // 2026-07-15T00:00:00Z

const prIdOf = new Map<string, number>();

interface PrSpec {
  key: string;
  repo: number;
  openedMs: number;
  mergedMs?: number;
  firstReviewMs?: number;
  ci?: 'success' | 'failure' | 'error' | 'pending' | null;
  additions?: number;
  changedFiles?: number;
  accountId?: number;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  pm = await import('./period-metrics.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, reviews } = schema;

  const mkRepo = async (name: string, node: string, createdAt: number, accountId = 1) =>
    (
      await db
        .insert(repos)
        .values({
          accountId,
          owner: 'acme',
          name,
          githubNodeId: node,
          createdAt: new Date(createdAt),
        })
        .returning()
        .execute()
    )[0].id;
  repoA = await mkRepo('alpha', 'R_pm_a', FROM - 30 * DAY);
  repoB = await mkRepo('beta', 'R_pm_b', FROM - 30 * DAY);
  // Added at EXACTLY the FROM+3d instant — the inclusive edge of the coverage bound.
  repoC = await mkRepo('gamma', 'R_pm_c', FROM + 3 * DAY);
  repoForeign = await mkRepo('theirs', 'R_pm_x', FROM - 30 * DAY, 2);

  const mkUser = async (login: string, node: string, isBot: boolean) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: node, isBot })
        .returning()
        .execute()
    )[0].id;
  // KNOWN VENDOR LOGINS, so `automatedReviewerUserIds` classifies them from the login seed alone
  // — no workspace_reviewers row is involved.
  botCr = await mkUser('coderabbitai', 'U_pm_cr', true);
  botGr = await mkUser('greptile-apps', 'U_pm_gr', true);
  alice = await mkUser('alice', 'U_pm_alice', false);
  bob = await mkUser('bob', 'U_pm_bob', false);

  const PRS: PrSpec[] = [
    // ── The four PRs that MERGE inside the window ──────────────────────────────────────────
    // Merged at EXACTLY `from` — must be INCLUDED. Lead time 10h.
    {
      key: 'at_from',
      repo: repoA,
      openedMs: FROM - 10 * HOUR,
      mergedMs: FROM,
      firstReviewMs: FROM - 8 * HOUR, // BEFORE the window: absent from metric #4
      ci: 'success',
      additions: 10,
      changedFiles: 1,
    },
    // Lead 20h, first review 4h after opening (in window).
    {
      key: 'mid_1',
      repo: repoA,
      openedMs: FROM + 5 * DAY - 20 * HOUR,
      mergedMs: FROM + 5 * DAY,
      firstReviewMs: FROM + 5 * DAY - 16 * HOUR,
      ci: 'success',
      additions: 100,
      changedFiles: 3,
    },
    // Lead 30h, first review 8h after opening. In repo B, so the scope is genuinely multi-repo.
    {
      key: 'mid_2',
      repo: repoB,
      openedMs: FROM + 6 * DAY - 30 * HOUR,
      mergedMs: FROM + 6 * DAY,
      firstReviewMs: FROM + 6 * DAY - 22 * HOUR,
      ci: 'failure',
      additions: 50,
      changedFiles: 2,
    },
    // Lead 40h. SIZE NEVER OBSERVED (all three columns 0) and CI never observed (null) — it
    // counts as a merged PR and a lead time, and is absent from the size median and the CI rate.
    {
      key: 'mid_unsized',
      repo: repoA,
      openedMs: FROM + 7 * DAY - 40 * HOUR,
      mergedMs: FROM + 7 * DAY,
      ci: null,
      additions: 0,
      changedFiles: 0,
    },
    // ── The boundary rows: LOUD, so a leak is unmistakable ─────────────────────────────────
    // Merged at EXACTLY `to` and first-reviewed at EXACTLY `to` — must be EXCLUDED from both.
    // Its OPEN date is inside the window, so it still counts towards `opened_prs`.
    {
      key: 'at_to',
      repo: repoA,
      openedMs: TO - 100 * HOUR,
      mergedMs: TO,
      firstReviewMs: TO,
      ci: 'failure',
      additions: 5000,
      changedFiles: 40,
    },
    // Opened at EXACTLY `to` — excluded from `opened_prs`.
    { key: 'opened_at_to', repo: repoA, openedMs: TO, ci: 'pending', additions: 3000 },
    // Entirely before the period.
    {
      key: 'before',
      repo: repoA,
      openedMs: FROM - 3 * DAY,
      mergedMs: FROM - 1 * DAY,
      firstReviewMs: FROM - 2 * DAY,
      ci: 'success',
      additions: 4000,
      changedFiles: 30,
    },
    // ── Never merged ───────────────────────────────────────────────────────────────────────
    // Opened in-window: intake is intake whether or not it landed.
    { key: 'open_only', repo: repoA, openedMs: FROM + 2 * DAY, ci: 'pending', additions: 7 },
    // ⚠ THE `firstReviewAt` ATTRIBUTION ROW. Opened ten days BEFORE the period and still open,
    // but picked up on day 3 of it — so it contributes 312h to metric #4 and nothing else.
    // Bucketing metric #4 by `openedAt` (the WorkspaceMetrics tile's rule) would drop it, and
    // dropping exactly the slow pickups is what biases that median down.
    {
      key: 'reviewed_late',
      repo: repoB,
      openedMs: FROM - 10 * DAY,
      firstReviewMs: FROM + 3 * DAY,
      ci: 'pending',
      additions: 20,
      changedFiles: 1,
    },
    // ── ANOTHER ACCOUNT'S PR, in another account's repo, merged mid-window ──────────────────
    // Passed explicitly in a hand-built scope below, so the ONLY thing excluding it is the
    // `accountId` predicate. 99,999 lines, so a leak moves both the count and the median.
    {
      key: 'foreign',
      repo: repoForeign,
      accountId: 2,
      openedMs: FROM + 8 * DAY - HOUR,
      mergedMs: FROM + 8 * DAY,
      ci: 'success',
      additions: 99_999,
      changedFiles: 500,
    },
  ];

  for (const [i, spec] of PRS.entries()) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_pm_${spec.key}`,
        accountId: spec.accountId ?? 1,
        repoId: spec.repo,
        number: i + 1,
        title: `fixture ${spec.key}`,
        state: spec.mergedMs == null ? 'open' : 'merged',
        isDraft: false,
        openedAt: new Date(spec.openedMs),
        updatedAt: new Date(spec.mergedMs ?? spec.openedMs),
        mergedAt: spec.mergedMs == null ? null : new Date(spec.mergedMs),
        firstReviewAt: spec.firstReviewMs == null ? null : new Date(spec.firstReviewMs),
        ciStatus: spec.ci ?? null,
        additions: spec.additions ?? 0,
        deletions: 0,
        changedFiles: spec.changedFiles ?? 0,
      })
      .returning()
      .execute();
    prIdOf.set(spec.key, pr.id);
  }

  // ── Review threads: bucketed on the ROOT COMMENT's time (reviewThreads.createdAt) ─────────
  // `reply` is the offset of the FIRST reply from the root; `extra` adds a second reply (used
  // only to carry the null-author comment).
  const THREADS: {
    key: string;
    pr: string;
    rootMs: number;
    rootBy: number;
    reply?: { atMs: number; by: number | null };
    extra?: { atMs: number; by: number | null };
  }[] = [
    // Root at EXACTLY `from` — INCLUDED, and replied in an hour.
    {
      key: 't_at_from',
      pr: 'at_from',
      rootMs: FROM,
      rootBy: botCr,
      reply: { atMs: FROM + HOUR, by: alice },
    },
    // Root at EXACTLY `to` — EXCLUDED.
    {
      key: 't_at_to',
      pr: 'at_to',
      rootMs: TO,
      rootBy: alice,
      reply: { atMs: TO + HOUR, by: alice },
    },
    // Replied in 2h. The third comment has a NULL author (a since-deleted GitHub account) and
    // lands in the HUMAN half of #9/#10 — it is not automated, which is the definition's test.
    {
      key: 't_quick',
      pr: 'mid_1',
      rootMs: FROM + 2 * DAY,
      rootBy: botCr,
      reply: { atMs: FROM + 2 * DAY + 2 * HOUR, by: alice },
      extra: { atMs: FROM + 2 * DAY + 3 * HOUR, by: null },
    },
    // Replied after 40h — a real reply, but OUTSIDE the 36h grace.
    {
      key: 't_slow',
      pr: 'mid_1',
      rootMs: FROM + 3 * DAY,
      rootBy: botCr,
      reply: { atMs: FROM + 3 * DAY + 40 * HOUR, by: alice },
    },
    // Replied at EXACTLY 36h — the grace is inclusive ("≤36h"), so this COUNTS.
    {
      key: 't_edge36',
      pr: 'mid_2',
      rootMs: FROM + 4 * DAY,
      rootBy: botGr,
      reply: { atMs: FROM + 4 * DAY + 36 * HOUR, by: alice },
    },
    // Never replied to.
    { key: 't_none', pr: 'mid_2', rootMs: FROM + 5 * DAY, rootBy: botGr },
    // Entirely before the period.
    {
      key: 't_before',
      pr: 'before',
      rootMs: FROM - 2 * DAY,
      rootBy: botCr,
      reply: { atMs: FROM - 2 * DAY + HOUR, by: alice },
    },
  ];

  for (const t of THREADS) {
    const prId = prIdOf.get(t.pr)!;
    const [thread] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_pm_${t.key}`,
        prId,
        path: 'src/a.ts',
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: t.rootBy,
        // Sync writes this from the thread's FIRST comment, which is what makes it the root's
        // timestamp and therefore the bucket key.
        createdAt: new Date(t.rootMs),
      })
      .returning()
      .execute();
    const comments = [
      { atMs: t.rootMs, by: t.rootBy as number | null },
      ...(t.reply ? [t.reply] : []),
      ...(t.extra ? [t.extra] : []),
    ];
    for (const [n, c] of comments.entries()) {
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: `RC_pm_${t.key}_${n}`,
          threadId: thread.id,
          prId,
          authorId: c.by,
          body: `comment ${n}`,
          createdAt: new Date(c.atMs),
        })
        .execute();
    }
  }

  // ── Submitted reviews, for reviewer concentration ────────────────────────────────────────
  const REVIEWS: { key: string; by: number; atMs: number; state?: string }[] = [
    { key: 'a1', by: alice, atMs: FROM + 1 * DAY },
    { key: 'a2', by: alice, atMs: FROM + 2 * DAY },
    { key: 'a3', by: alice, atMs: FROM + 3 * DAY },
    { key: 'b1', by: bob, atMs: FROM + 4 * DAY },
    // ⚠ FOUR BOT REVIEWS — more than any human. If automated reviewers were counted, the
    // busiest reviewer would be CodeRabbit at 4 of 8 and the metric would read 50 instead of 75.
    { key: 'c1', by: botCr, atMs: FROM + 1 * DAY },
    { key: 'c2', by: botCr, atMs: FROM + 2 * DAY },
    { key: 'c3', by: botCr, atMs: FROM + 3 * DAY },
    { key: 'c4', by: botCr, atMs: FROM + 4 * DAY },
    // A DRAFT: invisible on GitHub, excluded here.
    { key: 'draft', by: alice, atMs: FROM + 5 * DAY, state: 'pending' },
    // Submitted at EXACTLY `to` — excluded (the fifth column carrying the half-open rule).
    { key: 'b_at_to', by: bob, atMs: TO },
    // Before the period.
    { key: 'a_before', by: alice, atMs: FROM - 1 * DAY },
  ];
  for (const r of REVIEWS) {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_pm_${r.key}`,
        prId: prIdOf.get('mid_1'),
        authorId: r.by,
        state: r.state ?? 'commented',
        body: 'lgtm',
        submittedAt: new Date(r.atMs),
      })
      .execute();
  }

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const WINDOW = { fromMs: FROM, toMs: TO };

const vector = (opts: { sc?: any; window?: { fromMs: number; toMs: number } } = {}) =>
  pm.getPeriodMetrics(1, opts.sc ?? scope, opts.window ?? WINDOW);

/** A metric by key — the response always carries all twelve, so a miss is a real failure. */
function metric(
  result: any,
  key: string,
): { key: string; value: number | null; sampleSize: number } {
  const m = result.metrics.find((x: any) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from the vector`);
  return m;
}

describe('getPeriodMetrics — the vector shape', () => {
  it('returns all twelve metrics, in the shared PERIOD_METRIC_KEYS order', async () => {
    const r = await vector();
    expect(r.metrics).toHaveLength(12);
    expect(r.metrics.map((m: any) => m.key)).toEqual(pm.PERIOD_METRIC_KEYS);
  });

  it('the backend key mirror has not drifted from the shared wire contract', async () => {
    // The backend cannot value-import the types-only shared package (the release build greps
    // `release/dist` and fails on a real runtime import of it), so the ordered key list exists
    // TWICE. This is the assertion that keeps the two spellings identical.
    expect(pm.PERIOD_METRIC_KEYS).toEqual(SHARED_KEYS);
    // Every key carries its direction and both floors — the significance rule has no defaults.
    for (const key of SHARED_KEYS) {
      expect(pm.PERIOD_METRIC_META[key]).toBeDefined();
      expect(pm.PERIOD_METRIC_META[key].sampleFloor).toBeGreaterThan(0);
    }
  });
});

describe('getPeriodMetrics — THE WINDOW IS HALF-OPEN on every column', () => {
  it('includes an event at exactly `from` and excludes one at exactly `to` (mergedAt)', async () => {
    const r = await vector();
    // `at_from` merged at exactly FROM and `at_to` at exactly TO. Four merges, not three and
    // not five — and `at_to` carries 5,000 lines, so a leak would be unmissable in the median.
    expect(metric(r, 'merged_prs').value).toBe(4);
    expect(metric(r, 'median_pr_size_lines').value).toBe(50); // [10, 50, 100]
  });

  it('applies the same rule to openedAt', async () => {
    const r = await vector();
    // at_to, mid_1, mid_2, mid_unsized, open_only. `opened_at_to` opened at exactly TO and is
    // out; `at_from` opened 10h before FROM and is out.
    expect(metric(r, 'opened_prs').value).toBe(5);
  });

  it('applies the same rule to firstReviewAt — AND attributes on it, not on openedAt', async () => {
    const r = await vector();
    // mid_1 (4h), mid_2 (8h) and `reviewed_late` (312h — opened ten days before the period and
    // picked up on day 3). `at_from`'s review landed before FROM and `at_to`'s at exactly TO.
    const m = metric(r, 'median_time_to_first_review_hours');
    expect(m.sampleSize).toBe(3);
    expect(m.value).toBe(8); // median of [4, 8, 312]
    // ⚠ THE ATTRIBUTION PROOF. Bucketing by `openedAt` would drop `reviewed_late` entirely (it
    // opened before the period) and leave [4, 8] — a median of 6, i.e. the right-censoring bias
    // this metric was defined around.
    expect(m.value).not.toBe(6);
  });

  it('applies the same rule to thread createdAt and to review submittedAt', async () => {
    const r = await vector();
    // t_at_from (exactly FROM) is in; t_at_to (exactly TO) and t_before are out.
    expect(metric(r, 'review_threads_opened').value).toBe(5);
    // bob's review at exactly TO is out, leaving alice 3 + bob 1.
    expect(metric(r, 'reviewer_concentration_pct').sampleSize).toBe(4);
  });

  it('a window that ends before it starts matches nothing rather than throwing', async () => {
    const r = await vector({ window: { fromMs: TO, toMs: FROM } });
    expect(metric(r, 'merged_prs').value).toBe(0); // a real observation: nothing merged
    expect(metric(r, 'median_lead_time_hours').value).toBeNull(); // no median over nothing
  });
});

describe('getPeriodMetrics — the twelve figures', () => {
  it('counts merges and opens, and medians lead time over the merged population', async () => {
    const r = await vector();
    expect(metric(r, 'merged_prs')).toEqual({
      key: 'merged_prs',
      value: 4,
      sampleSize: 4,
      // 4 merges against a floor of 5 — a thin figure, and stamped as one HERE beside the
      // floors rather than re-derived in the SPA from a second copy of them.
      lowSample: true,
    });
    // 5 opens against a floor of 5 — the floor is a FLOOR, so meeting it is not thin.
    expect(metric(r, 'opened_prs')).toEqual({
      key: 'opened_prs',
      value: 5,
      sampleSize: 5,
      lowSample: false,
    });
    // Lead times 10, 20, 30, 40 hours ⇒ median 25. The unsized PR contributes a lead time even
    // though it contributes no size — the two populations are deliberately different.
    expect(metric(r, 'median_lead_time_hours')).toEqual({
      key: 'median_lead_time_hours',
      value: 25,
      sampleSize: 4,
      lowSample: true,
    });
  });

  it('rates CI over the DETERMINATE merges only — an unobserved status is not a failure', async () => {
    const r = await vector();
    const m = metric(r, 'merge_ci_success_pct');
    // at_from (success), mid_1 (success), mid_2 (failure) = 3 determinate ⇒ 66.67%.
    expect(m.sampleSize).toBe(3);
    expect(m.value).toBe(66.67);
    // ⚠ `mid_unsized` has ciStatus NULL. Counting it as a non-success would read 50% and would
    // report a repo with no CI configured at all as half-broken — a lie with a number attached.
    expect(m.value).not.toBe(50);
  });

  it('THE UNSIZED-PR RULE: a never-hydrated PR is unknown size, never zero lines', async () => {
    const r = await vector();
    const m = metric(r, 'median_pr_size_lines');
    // Sized merges are 10, 100 and 50 ⇒ median 50, over a sample of THREE not four.
    expect(m.sampleSize).toBe(3);
    expect(m.value).toBe(50);
    // Under lean storage the three size columns default to 0, so `mid_unsized` is
    // indistinguishable from an empty PR. Fabricating a 0 would give [0, 10, 50, 100] ⇒ 30.
    expect(m.value).not.toBe(30);
  });

  it('counts threads opened and the share replied to within the 36h grace', async () => {
    const r = await vector();
    expect(metric(r, 'review_threads_opened')).toEqual({
      key: 'review_threads_opened',
      value: 5,
      sampleSize: 5,
      // Threads have a floor of 10, so 5 is thin even though 5 opened PRs was not — the floor is
      // per metric, which is exactly why the marker cannot be a single global rule.
      lowSample: true,
    });
    const m = metric(r, 'threads_replied_within_36h_pct');
    // t_at_from (1h), t_quick (2h) and t_edge36 (EXACTLY 36h) count; t_slow (40h) and t_none
    // do not ⇒ 3 of 5.
    expect(m.sampleSize).toBe(5);
    expect(m.value).toBe(60);
    // The grace is inclusive, so dropping t_edge36 (40%) is a different — and wrong — answer.
    expect(m.value).not.toBe(40);
  });

  it('splits review comments bot/human, and the two halves sum to the total', async () => {
    const r = await vector();
    const bots = metric(r, 'bot_review_comments');
    const humans = metric(r, 'human_review_comments');
    // Five bot roots in window (t_at_from, t_quick, t_slow by CodeRabbit; t_edge36, t_none by
    // Greptile). Four alice replies plus the ONE null-author comment.
    expect(bots.value).toBe(5);
    expect(humans.value).toBe(5);
    // ⚠ THE NULL-AUTHOR ROW. A comment by a since-deleted account is not an automated reviewer,
    // so it belongs in the human half by the definition's own words. Computing the human half
    // with a `notInArray` predicate would silently drop it (SQL three-valued logic) and the two
    // halves would no longer sum to the 10 comments actually in the window.
    expect(bots.value! + humans.value!).toBe(10);
  });

  it('derives bot comments per merged PR, and refuses the ratio with no denominator', async () => {
    const r = await vector();
    // 5 bot comments over 4 merges.
    expect(metric(r, 'bot_comments_per_merged_pr')).toEqual({
      key: 'bot_comments_per_merged_pr',
      value: 1.25,
      sampleSize: 4,
      lowSample: true,
    });
    // A period with no merges has no denominator: null, NOT the 0 that "the bots said nothing"
    // would also produce.
    const quiet = await vector({ window: { fromMs: FROM - 20 * DAY, toMs: FROM - 15 * DAY } });
    expect(metric(quiet, 'merged_prs').value).toBe(0);
    expect(metric(quiet, 'bot_comments_per_merged_pr').value).toBeNull();
  });

  it('measures reviewer concentration over HUMAN reviewers only', async () => {
    const r = await vector();
    const m = metric(r, 'reviewer_concentration_pct');
    // alice 3, bob 1 ⇒ the busiest holds 75%.
    expect(m.sampleSize).toBe(4);
    expect(m.value).toBe(75);
    // ⚠ THE BOT EXCLUSION, and it is a deliberate reading of "the busiest reviewer". CodeRabbit
    // submitted FOUR reviews in this window — more than any human — so counting automated
    // reviewers would answer 50 (4 of 8) here, and in a real bot-heavy workspace it would pin
    // the metric near 100% forever and stop it moving at all. This is a bus-factor question and
    // an always-on bot is not a bus factor; any caption must say "among human reviewers".
    expect(m.value).not.toBe(50);
    // The draft review is excluded too: counting it would give alice 4 of 5 ⇒ 80.
    expect(m.value).not.toBe(80);
  });
});

describe('getPeriodMetrics — scope', () => {
  it('an EMPTY repo list yields all-null metrics rather than throwing or widening', async () => {
    const r = await vector({ sc: { workspaceId: scope.workspaceId, repoIds: [] } });
    expect(r.metrics).toHaveLength(12);
    for (const m of r.metrics) {
      // ⚠ Null, not 0 — "this workspace has no repos" is not "this workspace merged nothing".
      expect(m.value).toBeNull();
      expect(m.sampleSize).toBe(0);
    }
    // And it is genuinely an early return, not a widening: the full scope answers 4.
    expect(metric(await vector(), 'merged_prs').value).toBe(4);
  });

  it('narrowing the repo list narrows the data', async () => {
    const r = await vector({ sc: { workspaceId: scope.workspaceId, repoIds: [repoB] } });
    // Repo B holds only `mid_2` (merged) and `reviewed_late` (open).
    expect(metric(r, 'merged_prs').value).toBe(1);
    expect(metric(r, 'median_lead_time_hours').value).toBe(30);
    // Its two threads (t_edge36, t_none) hang off `mid_2`.
    expect(metric(r, 'review_threads_opened').value).toBe(2);
  });

  it('ANOTHER ACCOUNT’S PR stays invisible even when its repo id is in the scope', async () => {
    // The foreign repo id is passed EXPLICITLY, so the repoId predicate cannot be what excludes
    // the row — only `eq(pullRequests.accountId, accountId)` can. (A cross-account check that
    // the scope filter would have caught anyway is a vacuous one.)
    const r = await vector({
      sc: { workspaceId: scope.workspaceId, repoIds: [...scope.repoIds, repoForeign] },
    });
    expect(metric(r, 'merged_prs').value).toBe(4); // not 5
    // Its 99,999 lines would move the median from 50 to 75 if it leaked.
    expect(metric(r, 'median_pr_size_lines').value).toBe(50);
  });
});

describe('getPeriodCoverage — who was tracked when', () => {
  it('reports the repos already tracked at the instant, inclusive of the boundary', async () => {
    // repoC was added at EXACTLY FROM+3d.
    expect((await pm.getPeriodCoverage(1, [repoA, repoB, repoC], FROM)).trackedRepoIds).toEqual(
      [repoA, repoB].sort((a, b) => a - b),
    );
    expect(
      (await pm.getPeriodCoverage(1, [repoA, repoB, repoC], FROM + 3 * DAY)).trackedRepoIds,
    ).toEqual([repoA, repoB, repoC].sort((a, b) => a - b));
    // ⚠ ONE SECOND EARLIER AND IT IS OUT. sqlite stores timestamps as epoch SECONDS, so the
    // boundary has to be probed a whole second away — and `lte` has to be a real `lte`, not an
    // `lt` against `at + 1ms`, which would round to the same stored value.
    expect(
      (await pm.getPeriodCoverage(1, [repoA, repoB, repoC], FROM + 3 * DAY - 1000)).trackedRepoIds,
    ).toEqual([repoA, repoB].sort((a, b) => a - b));
  });

  it('an empty list is an empty answer, and another account’s repo is never tracked', async () => {
    expect((await pm.getPeriodCoverage(1, [], FROM)).trackedRepoIds).toEqual([]);
    const r = await pm.getPeriodCoverage(1, [repoA, repoForeign], FROM);
    expect(r.trackedRepoIds).toEqual([repoA]);
  });
});

// ⚠ THIS BLOCK MUTATES THE FIXTURE AND MUST STAY LAST — its final test inserts a PR inside the
// window, which moves every count above it.
describe('the data fingerprint', () => {
  it('is stable across identical calls', async () => {
    const a = await vector();
    const b = await vector();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // ⚠ THE POINT OF THE STABILITY: the fingerprint decides `stale` on the FREE cached GET fired
    // whenever a stored report is opened. Fold in anything `Date.now()`-derived and every stored
    // report reads stale forever, inviting a re-generation that changes nothing and costs money
    // — the payload-hash trap this codebase has hit repeatedly.
  });

  it('changes when the window or the scope changes', async () => {
    const base = await vector();
    const shifted = await vector({ window: { fromMs: FROM, toMs: TO - DAY } });
    expect(shifted.fingerprint).not.toBe(base.fingerprint);
    // Membership drift is a real reason for a stored report to go stale even when no row moved.
    const narrowed = await vector({ sc: { workspaceId: scope.workspaceId, repoIds: [repoB] } });
    expect(narrowed.fingerprint).not.toBe(base.fingerprint);
  });

  it('changes when a count underneath it changes', async () => {
    const before = await vector();
    const { pullRequests } = schema;
    await db
      .insert(pullRequests)
      .values({
        githubNodeId: 'PR_pm_latecomer',
        accountId: 1,
        repoId: repoA,
        number: 900,
        title: 'a PR that arrived after the report was written',
        state: 'merged',
        isDraft: false,
        openedAt: new Date(FROM + 9 * DAY - 5 * HOUR),
        updatedAt: new Date(FROM + 9 * DAY),
        mergedAt: new Date(FROM + 9 * DAY),
        ciStatus: 'success',
        additions: 60,
        deletions: 0,
        changedFiles: 2,
      })
      .execute();
    const after = await vector();
    expect(metric(after, 'merged_prs').value).toBe(5);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
