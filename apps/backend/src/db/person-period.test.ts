// db/person-period.ts — the 1:1-prep person vector, on a THROWAWAY sqlite DB.
//
// THE CONTRACTS THIS FILE EXISTS FOR:
//  • THE MIRRORED KEY LIST + SCHEMA VERSION MATCH SHARED (the period-metrics drift rule — the
//    backend inlines both because shared is types-only and never shipped).
//  • THE WINDOW IS HALF-OPEN `[from, to)` on the windowed keys (merged at exactly `to` is OUT,
//    merged at exactly `from` is IN).
//  • NULL IS NOT ZERO: a median over nothing and the addressed split over zero threads are
//    `null`; a count of zero is `0`.
//  • THE GLOBAL-users RULE: an id with no footprint in the workspace returns null (foreign ids
//    included — no oracle), and the returned identity is login + display name only.
//  • THE LANE RULE: an automation-lane actor returns null — no 1:1 with a bot.
//  • THE ONE-FOLD REUSE: `median_first_human_review_hours_their_prs` counts ONLY PRs the subject
//    authored (the authorUserId narrowing of loadFirstHumanReviewHours), and ignores a bot's
//    earlier review exactly as the period vector does.
//  • LIVE KEYS ARE MARKED `basis: 'live'` and the windowed ones `'window'`.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PERSON_METRIC_KEYS as SHARED_KEYS,
  PERSON_METRICS_SCHEMA_VERSION as SHARED_VERSION,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-person-period-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let pp: any;
let workspaceId = 0;
let repoA = 0;
let repoMid = 0; // added DURING the window — the coverage disclosure
let alice = 0; // the subject
let bob = 0; // another human
let botCr = 0; // a known vendor login → automation lane

const HOUR = 3_600_000;
const DAY = 86_400_000;
const FROM = Date.UTC(2026, 6, 1); // 2026-07-01T00:00:00Z
const TO = Date.UTC(2026, 6, 15); // 2026-07-15T00:00:00Z
const WIN = { fromMs: FROM, toMs: TO };

const prIdOf = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  pp = await import('./person-period.js');
  await runMigrations();

  const { repos, pullRequests, users, reviews, reviewThreads, reviewComments, reviewRequests } =
    schema;

  const mkRepo = async (name: string, node: string, createdAt: number) =>
    (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: node, createdAt: new Date(createdAt) })
        .returning()
        .execute()
    )[0].id;
  repoA = await mkRepo('alpha', 'R_pp_a', FROM - 30 * DAY);
  repoMid = await mkRepo('gamma', 'R_pp_mid', FROM + 3 * DAY);

  const mkUser = async (login: string, node: string, isBot: boolean, name: string | null = null) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: node, isBot, displayName: name })
        .returning()
        .execute()
    )[0].id;
  alice = await mkUser('alice', 'U_pp_alice', false, 'Alice A');
  bob = await mkUser('bob', 'U_pp_bob', false);
  botCr = await mkUser('coderabbitai', 'U_pp_cr', true);

  interface PrSpec {
    key: string;
    author: number;
    openedMs: number;
    mergedMs?: number;
    state?: 'open' | 'merged' | 'closed';
    requestedMs?: number;
  }
  const PRS: PrSpec[] = [
    // Alice's merges: exactly-at-from IN, mid IN, exactly-at-to OUT.
    { key: 'a_at_from', author: alice, openedMs: FROM - 10 * HOUR, mergedMs: FROM },
    { key: 'a_mid', author: alice, openedMs: FROM + 2 * DAY, mergedMs: FROM + 3 * DAY },
    { key: 'a_at_to', author: alice, openedMs: FROM + 8 * DAY, mergedMs: TO },
    // Alice's currently-open PR (WIP), opened in-window → also counts as opened.
    { key: 'a_open', author: alice, openedMs: FROM + 4 * DAY, state: 'open' },
    // Bob's PR that Alice reviews (response time: requested +2h, alice reviews +8h → 6h).
    {
      key: 'b_reviewed',
      author: bob,
      openedMs: FROM + 1 * DAY,
      state: 'open',
      requestedMs: FROM + 1 * DAY + 2 * HOUR,
    },
    // Bob's PR with NO recorded request — alice's review contributes NOTHING to response time.
    { key: 'b_norequest', author: bob, openedMs: FROM + 2 * DAY, state: 'open' },
    // Bob's merged PR — first human review is BOB-authored PR reviewed by alice? No: this one is
    // reviewed by bob himself below; it must NOT enter alice's their-PRs wait (not her PR).
    { key: 'b_merged', author: bob, openedMs: FROM + 5 * DAY, mergedMs: FROM + 6 * DAY },
  ];
  for (const [i, s] of PRS.entries()) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_pp_${s.key}`,
        accountId: 1,
        repoId: repoA,
        number: i + 1,
        title: `fixture ${s.key}`,
        state: s.state ?? (s.mergedMs == null ? 'open' : 'merged'),
        isDraft: false,
        authorId: s.author,
        openedAt: new Date(s.openedMs),
        updatedAt: new Date(s.mergedMs ?? s.openedMs),
        mergedAt: s.mergedMs == null ? null : new Date(s.mergedMs),
        firstReviewRequestedAt: s.requestedMs == null ? null : new Date(s.requestedMs),
      })
      .returning()
      .execute();
    prIdOf.set(s.key, pr.id);
  }

  const mkReview = async (key: string, pr: string, by: number, atMs: number, state = 'commented') =>
    db
      .insert(reviews)
      .values({
        githubNodeId: `RV_pp_${key}`,
        prId: prIdOf.get(pr),
        authorId: by,
        state,
        body: 'lgtm',
        submittedAt: new Date(atMs),
      })
      .execute();
  // Alice's reviews IN the window: on b_reviewed (+8h after request → 6h response) and on
  // b_norequest (no clock — excluded from the response median, still counted as a review).
  await mkReview('a_on_breq', 'b_reviewed', alice, FROM + 1 * DAY + 8 * HOUR);
  await mkReview('a_on_bnoreq', 'b_norequest', alice, FROM + 3 * DAY);
  // Alice's review at EXACTLY `to` — OUT of reviews_given.
  await mkReview('a_at_to', 'b_merged', alice, TO);
  // ── Alice's own PRs' first-human-review wait (the ONE-fold reuse) ──
  // a_mid: the BOT reviews at +1h (must be ignored), BOB reviews at +26h → 26h is the figure.
  await mkReview('bot_on_amid', 'a_mid', botCr, FROM + 2 * DAY + 1 * HOUR, 'approved');
  await mkReview('bob_on_amid', 'a_mid', bob, FROM + 2 * DAY + 26 * HOUR);
  // b_merged reviewed by bob in-window — someone ELSE's PR: must not leak into alice's figure.
  await mkReview('bob_on_bmerged', 'b_merged', bob, FROM + 5 * DAY + 2 * HOUR);

  // ── Threads on Alice's PRs: two roots in-window (one resolved), one at exactly `to` (OUT) ──
  const mkThread = async (key: string, pr: string, rootMs: number, state: string) => {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_pp_${key}`,
        prId: prIdOf.get(pr),
        path: 'src/a.ts',
        line: 1,
        isResolved: state === 'resolved',
        isOutdated: false,
        derivedState: state,
        originalCommenterId: bob,
        createdAt: new Date(rootMs),
      })
      .returning()
      .execute();
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_pp_${key}`,
        threadId: t.id,
        prId: prIdOf.get(pr),
        authorId: bob,
        body: 'root',
        createdAt: new Date(rootMs),
      })
      .execute();
  };
  await mkThread('t1', 'a_mid', FROM + 2 * DAY + 2 * HOUR, 'resolved');
  await mkThread('t2', 'a_open', FROM + 5 * DAY, 'untouched');
  await mkThread('t_at_to', 'a_open', TO, 'untouched');

  // Outstanding review request naming Alice on Bob's OPEN PR → awaiting 1. A second on the
  // MERGED PR must not count (only open PRs are waiting).
  await db
    .insert(reviewRequests)
    .values({ prId: prIdOf.get('b_norequest'), userId: alice })
    .execute();
  await db.insert(reviewRequests).values({ prId: prIdOf.get('b_merged'), userId: alice }).execute();

  // The DEFAULT workspace + memberships, through the production resolver.
  const scope = await q.resolveWorkspaceScope(1, undefined, null);
  workspaceId = scope.workspaceId;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const metric = (p: any, key: string) => p.metrics.find((m: any) => m.key === key);

describe('the shared mirror', () => {
  it('matches the shared key list and schema version exactly', () => {
    expect(pp.PERSON_METRIC_KEYS).toEqual(SHARED_KEYS);
    expect(pp.PERSON_METRICS_SCHEMA_VERSION).toBe(SHARED_VERSION);
  });

  it('has a meta row for every key, and the live/window split is the declared one', () => {
    const liveKeys = SHARED_KEYS.filter((k) => pp.PERSON_METRIC_META[k].basis === 'live');
    expect(liveKeys).toEqual([
      'their_pr_threads_addressed',
      'awaiting_their_review',
      'open_prs_authored',
    ]);
  });
});

describe('getPersonPeriod', () => {
  it('computes the windowed keys with half-open edges', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    expect(p).not.toBeNull();
    expect(p.login).toBe('alice');
    expect(p.name).toBe('Alice A');
    expect(p.metrics.map((m: any) => m.key)).toEqual(pp.PERSON_METRIC_KEYS);
    // Merges: at_from IN, mid IN, at_to OUT.
    expect(metric(p, 'merged_prs_authored').value).toBe(2);
    // Opened in-window: a_mid, a_open, a_at_to (opened +8d) — a_at_from opened before.
    expect(metric(p, 'opened_prs_authored').value).toBe(3);
    // Reviews: two in-window; the one at exactly `to` is out.
    expect(metric(p, 'reviews_given').value).toBe(2);
    expect(metric(p, 'reviews_given').basis).toBe('window');
  });

  it('anchors review response on the recorded request and skips PRs without one', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    const m = metric(p, 'median_review_response_hours');
    expect(m.value).toBe(6); // request +2h → review +8h
    expect(m.sampleSize).toBe(1); // b_norequest contributed nothing
    expect(m.lowSample).toBe(true); // 1 < the median floor of 3
  });

  it("reuses the one first-human-review fold, narrowed to the subject's own PRs", async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    const m = metric(p, 'median_first_human_review_hours_their_prs');
    // a_mid: the bot's +1h review is ignored; bob's +26h review is the first HUMAN one.
    // bob's own b_merged (reviewed in-window) must not leak in — it is not alice's PR.
    expect(m.value).toBe(26);
    expect(m.sampleSize).toBe(1);
  });

  it('splits threads-on-their-PRs (windowed roots) from addressed-now (live)', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    expect(metric(p, 'review_threads_on_their_prs').value).toBe(2); // t_at_to excluded
    const addressed = metric(p, 'their_pr_threads_addressed');
    expect(addressed.value).toBe(1);
    expect(addressed.sampleSize).toBe(2);
    expect(addressed.basis).toBe('live');
  });

  it('counts live waiting/WIP as now-facts', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    // Only the OPEN PR's outstanding request counts; the merged one's row does not.
    expect(metric(p, 'awaiting_their_review').value).toBe(1);
    // a_open + b_norequest is bob's; alice's open set is exactly a_open.
    expect(metric(p, 'open_prs_authored').value).toBe(1);
  });

  it('nulls the addressed split when the person had no threads (null is not zero)', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, bob, WIN);
    expect(metric(p, 'their_pr_threads_addressed').value).toBeNull();
    expect(metric(p, 'median_review_response_hours').value).toBeNull();
    // ...while a genuine zero stays a zero.
    expect(metric(p, 'awaiting_their_review').value).toBe(0);
  });

  it('discloses repo coverage and the first-observed read', async () => {
    const p = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    // repoMid was added mid-window: 1 of 2 repos tracked at the window start.
    expect(p.coverage).toEqual({ trackedRepos: 1, totalRepos: 2, complete: false });
    // Alice's earliest footprint (a_at_from opened FROM−10h) predates the window.
    expect(p.firstObservedMidWindow).toBe(false);
    expect(p.firstSeenAt).toBe(new Date(FROM - 10 * HOUR).toISOString());
  });

  it('returns null for a bot (lane rule) and for a stranger (global-users rule)', async () => {
    expect(await pp.getPersonPeriod(1, workspaceId, botCr, WIN)).toBeNull();
    expect(await pp.getPersonPeriod(1, workspaceId, 999_999, WIN)).toBeNull();
  });
});
