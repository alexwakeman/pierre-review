// db/period-metrics.ts — the twelve-metric period vector and the coverage read, on a THROWAWAY
// sqlite DB.
//
// THE CONTRACTS THIS FILE EXISTS FOR, each of which is a way a period report could ship a
// confident wrong number that nothing downstream would notice:
//  • THE WINDOW IS HALF-OPEN, `[from, to)`, ON EVERY COLUMN. An event at exactly `from` is IN;
//    an event at exactly `to` is OUT. This is THE bug the spec calls out: a one-sided `gte` is
//    what makes three existing getters unusable here, and a two-sided predicate with an
//    INCLUSIVE upper edge double-counts every event that lands on the boundary two adjacent
//    periods share. Pinned below on `mergedAt`, `openedAt`, the first human review, thread
//    `createdAt` and review `submittedAt` — five columns, because getting it right on four
//    proves nothing about the fifth.
//  • AN EMPTY SCOPE IS AN EMPTY WORKSPACE, NOT AN ERROR AND NOT THE WHOLE ACCOUNT. Every metric
//    null, sampleSize 0.
//  • NULL IS NOT ZERO. A median over nothing, a percentage over nothing and a ratio with no
//    denominator are `null`; a count of zero is `0`. The UI renders those differently and the
//    difference has to originate here.
//  • THE UNSIZED-PR RULE. Lean storage defaults the three size columns to 0, so an unhydrated
//    PR is indistinguishable from an empty one — feeding a fabricated 0 into a MEDIAN drags it
//    towards zero by however many rows never hydrated.
//  • `median_time_to_first_human_review_hours` ATTRIBUTES ON THE REVIEW, NOT `openedAt`. A PR
//    opened long before the period still contributes if that is when it was picked up. It also
//    does NOT read `pull_requests.first_review_at`, which records whoever reviewed first
//    regardless of what they are — the column that made this metric report 0h on a workspace
//    whose CI auto-approves on push, against a real human median of 18.3h.
//  • THE VECTOR AND THE LANE PANEL AGREE. They render one above the other and the panel's caption
//    says they are the same measurement, so they share one fold rather than two that match today.
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
    // ⚠ THE ATTRIBUTION ROW. Opened ten days BEFORE the period and still open, but picked up by a
    // person on day 3 of it — so it contributes 312h to the first-review metric and nothing else.
    // Bucketing that metric by `openedAt` (the WorkspaceMetrics tile's rule) would drop it, and
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
    // ── THE BOT-CONTAMINATION ROWS ─────────────────────────────────────────────────────────
    // ⚠ `firstReviewMs` ON THESE IS DELIBERATELY THE **BOT'S** TIMESTAMP — which is what sync
    // actually writes into `pull_requests.first_review_at`, because that column records whoever
    // reviewed first regardless of what they are. Every one of these rows would produce a
    // different (wrong) answer if the metric still read the column, so the column being present
    // and misleading IS the assertion.
    //
    // `bot_first`: a bot reviews the instant it opens (the auto-approve-on-push shape that made
    // the live workspace report 0h across 115 PRs), a person reviews 12h later. Both reviews are
    // INSIDE the window, so the only thing that differs between right and wrong is the VALUE.
    {
      key: 'bot_first',
      repo: repoA,
      openedMs: FROM + 1 * DAY,
      firstReviewMs: FROM + 1 * DAY, // the bot's review — must be ignored
      ci: 'pending',
      additions: 30,
      changedFiles: 2,
    },
    // `human_before`: a person reviewed it a fortnight ago and again mid-window. Its first human
    // review belongs to an EARLIER period, so it must contribute NOTHING here — the case that
    // forces the all-time lookback rather than a window-only scan.
    {
      key: 'human_before',
      repo: repoA,
      openedMs: FROM - 12 * DAY,
      firstReviewMs: FROM - 2 * DAY,
      ci: 'pending',
      additions: 15,
      changedFiles: 1,
    },
    // Human review at EXACTLY `from` — the sixth column carrying the half-open rule. 6h.
    {
      key: 'hr_at_from',
      repo: repoA,
      openedMs: FROM - 6 * HOUR,
      firstReviewMs: FROM,
      ci: 'pending',
      additions: 8,
      changedFiles: 1,
    },
    // Human review at EXACTLY `to` — EXCLUDED. Opened in-window, so it still counts as intake.
    {
      key: 'hr_at_to',
      repo: repoA,
      openedMs: TO - 50 * HOUR,
      firstReviewMs: TO,
      ci: 'pending',
      additions: 9,
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

  // ── Submitted reviews ────────────────────────────────────────────────────────────────────
  // TWO metrics read this table and they read it differently, which is why `pr` had to become a
  // field: reviewer concentration counts in-window reviews per AUTHOR and does not care which PR
  // they are on, whereas the first-human-review metric folds per PR and looks OUTSIDE the window.
  const REVIEWS: { key: string; by: number; atMs: number; state?: string; pr?: string }[] = [
    { key: 'a1', by: alice, atMs: FROM + 1 * DAY },
    { key: 'a2', by: alice, atMs: FROM + 2 * DAY },
    { key: 'a3', by: alice, atMs: FROM + 3 * DAY },
    { key: 'b1', by: bob, atMs: FROM + 4 * DAY },
    // ⚠ FIVE BOT REVIEWS — more than either human alone. If automated reviewers were counted,
    // alice would be 7 of 13 and the metric would read 53.85 instead of 87.5.
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

    // ── The first-HUMAN-review fixtures ────────────────────────────────────────────────────
    // `bot_first`: the bot reviews at the instant the PR opens, the human 12h later. BOTH are
    // in-window, so a metric reading `first_review_at` would report 0h and one reading the
    // reviews table with a lane filter reports 12h. Nothing else distinguishes them.
    { key: 'bf_bot', by: botCr, atMs: FROM + 1 * DAY, pr: 'bot_first' },
    { key: 'bf_human', by: alice, atMs: FROM + 1 * DAY + 12 * HOUR, pr: 'bot_first' },
    // `human_before`: reviewed by a person two days BEFORE the window and again on day 9. Its
    // first human review is not in this period, so it contributes nothing — and the only way to
    // know that is to look outside the window, which is what (4b) does.
    { key: 'hb_old', by: alice, atMs: FROM - 2 * DAY, pr: 'human_before' },
    { key: 'hb_new', by: alice, atMs: FROM + 9 * DAY, pr: 'human_before' },
    // Exactly `from` (IN, 6h) and exactly `to` (OUT).
    { key: 'hf_at_from', by: alice, atMs: FROM, pr: 'hr_at_from' },
    { key: 'hf_at_to', by: alice, atMs: TO, pr: 'hr_at_to' },
    // The slow pickup: opened ten days before the period, picked up by a person on day 3 → 312h.
    { key: 'rl_human', by: alice, atMs: FROM + 3 * DAY, pr: 'reviewed_late' },
  ];
  for (const r of REVIEWS) {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_pm_${r.key}`,
        prId: prIdOf.get(r.pr ?? 'mid_1'),
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
  it('returns every metric, in the shared PERIOD_METRIC_KEYS order', async () => {
    const r = await vector();
    // Length is asserted against the SHARED list rather than a literal, so adding a metric to the
    // contract does not need this line edited — the ORDER assertion below is what has teeth.
    expect(r.metrics).toHaveLength(SHARED_KEYS.length);
    expect(r.metrics.map((m: any) => m.key)).toEqual(pm.PERIOD_METRIC_KEYS);
  });

  it('carries no metric whose name still claims the contaminated v1 meaning', async () => {
    // v1's `median_time_to_first_review_hours` measured "time until ANYONE reviewed", which on a
    // workspace with an auto-approving CI bot is the push time. It was RENAMED rather than
    // redefined in place so that a stored v1 row and a v2 row can never be subtracted from one
    // another under a shared key — the delta would be arithmetic across two definitions.
    const r = await vector();
    const keys = r.metrics.map((m: any) => m.key);
    expect(keys).not.toContain('median_time_to_first_review_hours');
    expect(keys).toContain('median_time_to_first_human_review_hours');
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
    // at_to, mid_1, mid_2, mid_unsized, open_only, bot_first, hr_at_to. `opened_at_to` opened at
    // exactly TO and is out; `at_from` opened 10h before FROM and is out.
    expect(metric(r, 'opened_prs').value).toBe(7);
  });

  it('applies the same rule to the first HUMAN review — and attributes on it, not on openedAt', async () => {
    const r = await vector();
    // hr_at_from (6h, reviewed at exactly FROM), bot_first (12h) and reviewed_late (312h —
    // opened ten days before the period and picked up by a person on day 3).
    // Excluded: hr_at_to (reviewed at exactly TO), human_before (first human review was two days
    // BEFORE the window), and every PR no person reviewed at all.
    const m = metric(r, 'median_time_to_first_human_review_hours');
    expect(m.sampleSize).toBe(3);
    expect(m.value).toBe(12); // median of [6, 12, 312]
    // ⚠ THE ATTRIBUTION PROOF. Bucketing by `openedAt` would drop `reviewed_late` entirely (it
    // opened before the period) and leave [6, 12] — a median of 9, i.e. the right-censoring bias
    // this metric was defined around.
    expect(m.value).not.toBe(9);
  });

  // ── THE REGRESSION THIS WHOLE RENAME EXISTS FOR ──────────────────────────────────────────
  it('ignores a bot that reviewed first, even though `first_review_at` records it', async () => {
    const r = await vector();
    const m = metric(r, 'median_time_to_first_human_review_hours');
    // `bot_first` has BOTH reviews inside the window: CodeRabbit at the instant it opened and
    // alice 12h later. Its `pull_requests.first_review_at` column holds the BOT's timestamp,
    // which is what sync writes and what v1 read — so a metric still reading that column sees a
    // 0h sample here and reports a median of 6 over [0, 6, 312] instead of 12 over [6, 12, 312].
    //
    // Measured live before the fix: `github-actions[bot]` auto-approved 61 of 115 PRs at zero
    // minutes and the reported median was 0h against a human median of 18.3h.
    expect(m.value).not.toBe(6);
    expect(m.value).toBe(12);
    // And the 0h sample is not merely outvoted — it is not in the population at all.
    expect(m.sampleSize).toBe(3);
  });

  it('excludes a PR whose first human review belongs to an EARLIER period', async () => {
    const r = await vector();
    // `human_before` was reviewed by alice two days before the window AND on day 9 of it. A
    // window-only scan would see only the day-9 review, call it the first, and contribute
    // (FROM+9d − (FROM−12d)) = 504h — inventing three weeks of latency on a PR a person had
    // already looked at. Seeing the earlier review is the only way to rule it out, which is why
    // query (4b) reads all of time rather than the window.
    const m = metric(r, 'median_time_to_first_human_review_hours');
    expect(m.sampleSize).toBe(3);
    expect(m.value).not.toBe(312); // the median of [6, 12, 312, 504] would be 162; of [6,12,312] is 12
  });

  it('applies the same rule to thread createdAt and to review submittedAt', async () => {
    const r = await vector();
    // t_at_from (exactly FROM) is in; t_at_to (exactly TO) and t_before are out.
    expect(metric(r, 'review_threads_opened').value).toBe(5);
    // bob's review at exactly TO is out (as is alice's `hf_at_to`), leaving alice 7 + bob 1.
    expect(metric(r, 'reviewer_concentration_pct').sampleSize).toBe(8);
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
    // 7 opens against a floor of 5 — the floor is a FLOOR, so clearing it is not thin.
    expect(metric(r, 'opened_prs')).toEqual({
      key: 'opened_prs',
      value: 7,
      sampleSize: 7,
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
    // alice 7 (a1–a3 plus the four first-review fixtures), bob 1 ⇒ the busiest holds 87.5%.
    expect(m.sampleSize).toBe(8);
    expect(m.value).toBe(87.5);
    // ⚠ THE BOT EXCLUSION, and it is a deliberate reading of "the busiest reviewer". CodeRabbit
    // submitted FIVE reviews in this window — more than either human alone — so counting
    // automated reviewers would answer 53.85 (7 of 13) here, and in a real bot-heavy workspace
    // it would pin the metric near 100% forever and stop it moving at all. This is a bus-factor
    // question and an always-on bot is not a bus factor; any caption must say "among human
    // reviewers".
    expect(m.value).not.toBe(53.85);
    // The draft review is excluded too: counting it would give alice 8 of 9 ⇒ 88.89.
    expect(m.value).not.toBe(88.89);
  });
});

describe('getPeriodMetrics — scope', () => {
  it('an EMPTY repo list yields all-null metrics rather than throwing or widening', async () => {
    const r = await vector({ sc: { workspaceId: scope.workspaceId, repoIds: [] } });
    expect(r.metrics).toHaveLength(SHARED_KEYS.length);
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

// ── The vector and the lane panel must agree about "time until a person reviewed it" ─────────
//
// They are rendered one directly above the other and the panel's caption asserts they are the
// same measurement. On the live database they were NOT: 18.16h in the table against 18.27h in the
// panel, because the lane fold read only reviews INSIDE the window and took each PR's earliest of
// those — so a PR a person had reviewed in an earlier period counted as freshly reviewed.
//
// The fix was one shared fold (`loadFirstHumanReviewHours`) rather than a corrected copy, because
// two folds that agree today are two folds that can drift tomorrow. This is what pins it.
describe('getPeriodMetrics ⇄ getPeriodLanes agree on first human review', () => {
  it('reports the same number in the vector and in the lane breakdown', async () => {
    const [v, l] = await Promise.all([
      pm.getPeriodMetrics(1, scope, { fromMs: FROM, toMs: TO }),
      pm.getPeriodLanes(1, scope, { fromMs: FROM, toMs: TO }),
    ]);
    const fromVector = metric(v, 'median_time_to_first_human_review_hours').value;
    expect(l.medianTimeToFirstHumanReviewHours).toBe(fromVector);
    // Not vacuously equal via a shared null: the fixture has three qualifying PRs.
    expect(fromVector).toBe(12);
  });

  it('excludes `human_before` from BOTH, not just from the vector', async () => {
    // This is the row that made the two disagree. Its first human review is two days before the
    // window and its second is on day 9, so a window-only fold contributes 504h to whichever
    // surface uses it — which is what dragged the panel's median above the table's.
    const l = await pm.getPeriodLanes(1, scope, { fromMs: FROM, toMs: TO });
    expect(l.medianTimeToFirstHumanReviewHours).not.toBe(162); // median of [6, 12, 312, 504]
    expect(l.medianTimeToFirstHumanReviewHours).toBe(12); // median of [6, 12, 312]
  });

  it('files the fixture bots into the lanes their logins imply', async () => {
    const l = await pm.getPeriodLanes(1, scope, { fromMs: FROM, toMs: TO });
    const byLane = new Map<string, any>(l.lanes.map((x: any) => [x.lane as string, x]));
    // Every lane is present in the response even at zero — a missing lane and an empty lane are
    // different facts, and only one of them is legal here.
    for (const lane of ['human', 'code_agent', 'dependency', 'ai_review', 'quality_gate', 'release', 'housekeeping']) {
      expect(byLane.has(lane), `lane '${lane}' missing from the response`).toBe(true);
    }
    // CodeRabbit and Greptile are known vendor logins, so they land in ai_review with no stored
    // row involved — and their comments must NOT be counted as human review activity.
    expect(byLane.get('ai_review')!.comments).toBeGreaterThan(0);
    // Nothing in this fixture is authored by automation, so the share is a real 0, not null.
    expect(l.automationMergeSharePct).toBe(0);
  });
});
