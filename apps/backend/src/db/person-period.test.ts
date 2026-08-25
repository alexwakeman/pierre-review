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
//  • EVIDENCE IS ADDITIVE (the People report): requesting it never changes a metric cell, each
//    group is the counting predicate's own rows (window-pure where the metric is), caps at
//    PERSON_EVIDENCE_CAP with the remainder in `more`, and the global `commitFiles` table is
//    reached only through the subject's own evidence-set shas.
//  • THE 'person_report' SYNTHESIS INPUT rides the SAME fold: `pm…` items byte-identical to the
//    'person' grain, `pe2:`-prefixed evidence ids, every hash-relevant field a plain DB read.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PERSON_EVIDENCE_CAP as SHARED_EVIDENCE_CAP,
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
let si: any; // synthesis-input (the 'person_report' grain reads the same fixture)
let workspaceId = 0;
let wsRepoIds: number[] = [];
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
const threadIdOf = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  pp = await import('./person-period.js');
  si = await import('./synthesis-input.js');
  await runMigrations();

  const {
    repos,
    pullRequests,
    users,
    reviews,
    reviewThreads,
    reviewComments,
    reviewRequests,
    prComments,
    commits,
    commitFiles,
  } = schema;

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
    threadIdOf.set(key, t.id);
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_pp_${key}`,
        threadId: t.id,
        prId: prIdOf.get(pr),
        authorId: bob,
        body: 'root',
        excerpt: 'root',
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

  // ── Evidence fixtures (the People report) ──
  // TEN inline review comments by Alice on t2 (her own PR's thread — bob's earlier root keeps
  // the thread-root excerpt) → review_comments_written = 10, and with the two in-window PR
  // comments below the comments evidence group overflows its cap (12 rows → 8 + more 4).
  for (let i = 0; i < 10; i++) {
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `RC_pp_ac_${i}`,
        threadId: threadIdOf.get('t2'),
        prId: prIdOf.get('a_open'),
        authorId: alice,
        body: `alice reply ${i}`,
        excerpt: `alice reply ${i}`,
        createdAt: new Date(FROM + 6 * DAY + i * HOUR),
      })
      .execute();
  }
  // Issue-level PR comments: two in-window (they join the evidence card group but NOT the
  // inline-only metric), one after `to` (window purity — in neither).
  const mkPrComment = async (key: string, pr: string, by: number, atMs: number) =>
    db
      .insert(prComments)
      .values({
        githubNodeId: `PC_pp_${key}`,
        prId: prIdOf.get(pr),
        authorId: by,
        body: `pc ${key}`,
        createdAt: new Date(atMs),
      })
      .execute();
  await mkPrComment('pc1', 'b_reviewed', alice, FROM + 7 * DAY);
  await mkPrComment('pc2', 'b_reviewed', alice, FROM + 6 * DAY + 4 * HOUR + 30 * 60_000);
  await mkPrComment('pc_out', 'b_reviewed', alice, TO + HOUR);

  // Commits + changed files for the path areas: two commits on Alice's authored evidence PRs
  // (a_mid, a_open) and one on BOB's PR that must NOT count. `commitFiles` is the GLOBAL
  // sha→paths table — c3's row exists there and stays invisible to Alice's areas.
  const mkCommit = async (sha: string, pr: string, atMs: number, paths: string[]) => {
    await db
      .insert(commits)
      .values({
        sha,
        prId: prIdOf.get(pr),
        authorId: alice,
        committedAt: new Date(atMs),
      })
      .execute();
    await db.insert(commitFiles).values({ sha, paths }).execute();
  };
  await mkCommit('c1_pp', 'a_mid', FROM + 2 * DAY + 12 * HOUR, [
    'apps/backend/src/db/x.ts',
    'apps/backend/src/db/y.ts',
    'docs/README.md',
  ]);
  await mkCommit('c2_pp', 'a_open', FROM + 5 * DAY, ['apps/backend/src/api/z.ts']);
  await mkCommit('c3_pp', 'b_merged', FROM + 5 * DAY, ['apps/backend/src/db/w.ts']);

  // The DEFAULT workspace + memberships, through the production resolver.
  const scope = await q.resolveWorkspaceScope(1, undefined, null);
  workspaceId = scope.workspaceId;
  wsRepoIds = scope.repoIds;
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
    expect(pp.PERSON_EVIDENCE_CAP).toBe(SHARED_EVIDENCE_CAP);
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

describe('getPersonPeriod evidence (the People report)', () => {
  const withEv = () => pp.getPersonPeriod(1, workspaceId, alice, WIN, { evidence: true });

  it('is absent unless requested, and requesting it changes NO metric cell', async () => {
    const plain = await pp.getPersonPeriod(1, workspaceId, alice, WIN);
    const rich = await withEv();
    expect(plain.evidence).toBeUndefined();
    expect(rich.evidence).toBeDefined();
    expect(rich.metrics).toEqual(plain.metrics);
    expect(rich.coverage).toEqual(plain.coverage);
  });

  it('lists each PR-backed metric population newest-first with the counting predicate', async () => {
    const ev = (await withEv()).evidence;
    // Merged: a_mid (merged +3d) before a_at_from (merged AT from); a_at_to's TO merge is out.
    expect(ev.prs.merged_prs_authored.rows.map((r: any) => r.prId)).toEqual([
      prIdOf.get('a_mid'),
      prIdOf.get('a_at_from'),
    ]);
    expect(ev.prs.merged_prs_authored.more).toBe(0);
    // Opened in-window, newest-first: a_at_to (+8d), a_open (+4d), a_mid (+2d).
    expect(ev.prs.opened_prs_authored.rows.map((r: any) => r.prId)).toEqual([
      prIdOf.get('a_at_to'),
      prIdOf.get('a_open'),
      prIdOf.get('a_mid'),
    ]);
    // The medians list their SAMPLE PRs (per-PR hours do not travel — DigestPrRef rows only).
    expect(ev.prs.median_review_response_hours.rows.map((r: any) => r.prId)).toEqual([
      prIdOf.get('b_reviewed'),
    ]);
    expect(ev.prs.median_first_human_review_hours_their_prs.rows.map((r: any) => r.prId)).toEqual(
      [prIdOf.get('a_mid')],
    );
    // Live sets: awaiting (open PR with an outstanding request) + open authored.
    expect(ev.prs.awaiting_their_review.rows.map((r: any) => r.prId)).toEqual([
      prIdOf.get('b_norequest'),
    ]);
    expect(ev.prs.open_prs_authored.rows.map((r: any) => r.prId)).toEqual([prIdOf.get('a_open')]);
    // DigestPrRef rows are served from persisted columns (title/author/repo resolved).
    const merged = ev.prs.merged_prs_authored.rows[0];
    expect(merged.title).toBe('fixture a_mid');
    expect(merged.repoFullName).toBe('acme/alpha');
    expect(merged.authorLogin).toBe('alice');
  });

  it('caps the comments group at PERSON_EVIDENCE_CAP across both channels and discloses `more`', async () => {
    const p = await withEv();
    const { rows, more } = p.evidence.comments;
    // 10 inline + 2 in-window PR comments = 12 → 8 shown, 4 more; the out-of-window PR comment
    // is in neither (window purity).
    expect(rows.length).toBe(SHARED_EVIDENCE_CAP);
    expect(more).toBe(4);
    // ...while the METRIC stays inline-only (the evidence group is wider than the cell on
    // purpose, and neither leaks into the other).
    expect(metric(p, 'review_comments_written').value).toBe(10);
    // Newest first, both channels interleaved; bodies inline.
    expect(rows[0].targetKind).toBe('pr_comment');
    expect(rows[0].body).toBe('pc pc1');
    expect(rows.some((r: any) => r.targetKind === 'review_comment')).toBe(true);
    for (const r of rows) {
      const at = Date.parse(r.createdAt);
      expect(at).toBeGreaterThanOrEqual(FROM);
      expect(at).toBeLessThan(TO);
      expect(r.mlLabel).toBeNull(); // nothing stored for a human — null, never invented
    }
  });

  it('lists thread roots once (windowed population, live state chips) with excerpts', async () => {
    const ev = (await withEv()).evidence;
    // t2 (+5d) then t1 (+2d2h); the root at exactly `to` stays out.
    expect(ev.threads.rows.map((t: any) => t.threadId)).toEqual([
      threadIdOf.get('t2'),
      threadIdOf.get('t1'),
    ]);
    expect(ev.threads.more).toBe(0);
    const t2 = ev.threads.rows[0];
    expect(t2.derivedState).toBe('untouched');
    expect(t2.excerpt).toBe('root'); // bob's ROOT comment, not alice's later replies
    expect(t2.prNumber).toBeGreaterThan(0);
    expect(t2.repoFullName).toBe('acme/alpha');
  });

  it("buckets path areas over the subject's own evidence PRs only (global-table rule)", async () => {
    const ev = (await withEv()).evidence;
    // c1 (a_mid) + c2 (a_open) count; c3 sits on BOB's PR and its commitFiles row — present in
    // the GLOBAL table — must stay invisible here.
    expect(ev.pathAreas).toEqual([
      { bucket: 'apps/backend/**', files: 3, commits: 2 },
      { bucket: 'docs/README.md', files: 1, commits: 1 },
    ]);
  });

  it('degrades exactly like the plain fold for bots and strangers', async () => {
    expect(await pp.getPersonPeriod(1, workspaceId, botCr, WIN, { evidence: true })).toBeNull();
    expect(await pp.getPersonPeriod(1, workspaceId, 999_999, WIN, { evidence: true })).toBeNull();
  });
});

describe("getSynthesisInput kind 'person_report'", () => {
  const repScope = () => ({
    kind: 'person_report',
    workspaceId,
    repoIds: wsRepoIds,
    window: 'rolling_14',
    userId: alice,
    fromMs: FROM,
    toMs: TO,
  });

  it("carries the 'person' grain's pm items with only the AUTHOR LABEL re-spelled, plus pe2: evidence ids only", async () => {
    const rep = await si.getSynthesisInput(1, repScope());
    const per = await si.getSynthesisInput(1, { ...repScope(), kind: 'person' });
    expect(rep.kind).toBe('person_report');
    const pmItems = rep.items.filter((i: any) => i.id.startsWith('pm'));
    // The HASHED half (id + createdAt) and the bodies stay byte-identical — two kinds must not
    // describe two vectors — and `authorLabel` is not hashed.
    const sansAuthor = (xs: any[]) => xs.map((i) => ({ ...i, authorLabel: null }));
    expect(sansAuthor(pmItems)).toEqual(sansAuthor(per.items));
    // …but a dashboard figure line is a BRIEF line here, which is the person_report legend's own
    // word for it; the 1:1 'person' kind keeps the login ITS prompt defines author as.
    expect(pmItems.every((i: any) => i.authorLabel === 'brief')).toBe(true);
    expect(per.items.every((i: any) => i.authorLabel === 'alice')).toBe(true);
    for (const i of rep.items) {
      if (!i.id.startsWith('pm')) expect(i.id.startsWith('pe2:')).toBe(true);
    }
  });

  it('items are the evidence rows: authored PRs, own comments (two id spaces), thread roots, areas', async () => {
    const rep = await si.getSynthesisInput(1, repScope());
    const byId = new Map(rep.items.map((i: any) => [i.id, i]));
    // Authored-PR titles at their REAL openedAt (a hash-stable DB read).
    const pr = byId.get(`pe2:pr:${prIdOf.get('a_mid')}`) as any;
    expect(pr.kind).toBe('pr');
    expect(pr.body).toBe('fixture a_mid');
    expect(pr.createdAt).toBe(new Date(FROM + 2 * DAY).toISOString());
    // Their own comments, rc:/pc: namespaced by target kind.
    expect(rep.items.some((i: any) => i.id.startsWith('pe2:rc:') && i.kind === 'review_comment')).toBe(true);
    expect(rep.items.some((i: any) => i.id.startsWith('pe2:pc:') && i.kind === 'pr_comment')).toBe(true);
    // Thread roots — feedback RECEIVED, never labelled with the subject's login.
    const th = byId.get(`pe2:th:${threadIdOf.get('t2')}`) as any;
    expect(th.kind).toBe('thread');
    expect(th.authorLabel).toBe('reviewer');
    expect(th.body).toBe('root');
    // Path areas: count-encoded id, epoch-zero createdAt (content hash, never a date hash).
    const area = byId.get('pe2:area:apps/backend/**:3') as any;
    expect(area.kind).toBe('path_area');
    expect(area.createdAt).toBe(new Date(0).toISOString());
    // The capped comments group discloses through `truncated`.
    expect(rep.truncated).toBe(true);
  });

  it('is deterministic across calls (the free GET recomputes the hash from these ids)', async () => {
    const a = await si.getSynthesisInput(1, repScope());
    const b = await si.getSynthesisInput(1, repScope());
    expect(a.items.map((i: any) => `${i.id}@${i.createdAt}`)).toEqual(
      b.items.map((i: any) => `${i.id}@${i.createdAt}`),
    );
  });

  it('answers EMPTY for a stranger and throws on a missing required triple', async () => {
    const empty = await si.getSynthesisInput(1, { ...repScope(), userId: 999_999 });
    expect(empty.items).toEqual([]);
    expect(empty.totalCount).toBe(0);
    await expect(
      si.getSynthesisInput(1, { ...repScope(), userId: undefined }),
    ).rejects.toThrow(/person_report/);
  });
});
