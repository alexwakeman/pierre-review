// getBotDedupClusters + the same-line overlap ROI metric, on a THROWAWAY sqlite DB — the FIRST
// test over the dedup surface (the 23-identical-pills bug shipped precisely because none
// existed). Both surfaces cluster through THE shared ±3-line definition (db/line-overlap.ts).
//
// What this file pins:
//  • members are COLLAPSED per bot: the live-DB scenario (one verbose bot × 23 null-line
//    threads + one CodeRabbit thread in the same file) emits ONE cluster with TWO members —
//    a ×23 one and a ×1 one — never 24 pills;
//  • the entry gate is ≥2 threads from ≥2 DISTINCT USERS: two distinct in-house bots DO
//    cluster (the old kind-distinct gate could never see them); a single bot's pile does NOT;
//  • quality_check-role bots are excluded from clusters entirely (a rule firing is not review
//    consensus);
//  • member labels resolve per REVIEWER (custom label → vendor name → login/display name), so
//    two in-house bots are distinguishable instead of both reading "In-house AI";
//  • the ROI overlap metric (getBotAnalytics) uses the SAME ±3 window but EXCLUDES null-line
//    threads (outdated/file-level — they manufacture overlap), credits each side's threads,
//    attributes a top partner, and emits the advisory overlap suggestion only past BOTH gates
//    (threads ≥ 5 AND share ≥ 0.4) — while the verdict stays pure thread math;
//  • getBotBehaviourAnalytics's lineOverlapClusters counts the same clusters (±3, null-line
//    excluded), so the two analytics surfaces can no longer disagree about "same line".
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-dedup-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let scope: any;
let repoId = 0;
let prId = 0;
let inhouseA = 0; // the verbose in-house bot — custom label 'DeepSource'
let inhouseB = 0; // a second, distinct in-house bot (same kind — user-distinct must see it)
let coderabbitId = 0; // known vendor — auto-classified
let qcId = 0; // roled quality_check — excluded everywhere

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
const recent = new Date(now - 2 * HOUR); // inside every window, inside the 36h overdue grace

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_dedup' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_dedup',
      accountId: 1,
      repoId,
      number: 1,
      title: 'dedup fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 5 * DAY),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  prId = pr.id;

  const mkUser = async (login: string, nodeId: string) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: nodeId, isBot: true })
        .returning()
        .execute()
    )[0].id;
  inhouseA = await mkUser('inhouse-bot-a', 'U_dd_a');
  inhouseB = await mkUser('inhouse-bot-b', 'U_dd_b');
  coderabbitId = await mkUser('coderabbitai', 'U_dd_cr');
  qcId = await mkUser('quality-bot', 'U_dd_qc');

  // THE THREADS. All recent (in-window), all untouched.
  //  • src/proc.ts — the 23-identical-pills scenario: 23 null-line threads from inhouseA + 1
  //    null-line CodeRabbit thread (outdated threads lose their line; the dedup keeps the
  //    per-file catch-all, the ROI metric must NOT count it).
  //  • src/two.ts — five ±3 line pairs (10|12, 30|31, 50|52, 70|71, 90|93) split across the
  //    TWO in-house bots: five user-distinct clusters, and 100% of inhouseB's output overlaps.
  //  • src/single.ts — inhouseA alone on adjacent lines: never a cluster.
  //  • src/qc.ts — inhouseA + the quality check on the SAME line: never a cluster.
  const threads: Array<{ userId: number; path: string; line: number | null; nodeId: string }> = [];
  for (let i = 0; i < 23; i++)
    threads.push({ userId: inhouseA, path: 'src/proc.ts', line: null, nodeId: `T_dd_a_null_${i}` });
  threads.push({ userId: coderabbitId, path: 'src/proc.ts', line: null, nodeId: 'T_dd_cr_null' });
  const pairs: Array<[number, number]> = [
    [10, 12],
    [30, 31],
    [50, 52],
    [70, 71],
    [90, 93],
  ];
  for (const [i, [la, lb]] of pairs.entries()) {
    threads.push({ userId: inhouseA, path: 'src/two.ts', line: la, nodeId: `T_dd_a_two_${i}` });
    threads.push({ userId: inhouseB, path: 'src/two.ts', line: lb, nodeId: `T_dd_b_two_${i}` });
  }
  threads.push({ userId: inhouseA, path: 'src/single.ts', line: 5, nodeId: 'T_dd_a_s0' });
  threads.push({ userId: inhouseA, path: 'src/single.ts', line: 6, nodeId: 'T_dd_a_s1' });
  threads.push({ userId: inhouseA, path: 'src/qc.ts', line: 20, nodeId: 'T_dd_a_qc' });
  threads.push({ userId: qcId, path: 'src/qc.ts', line: 20, nodeId: 'T_dd_qc' });
  const inserted = await db
    .insert(reviewThreads)
    .values(
      threads.map((t) => ({
        githubNodeId: t.nodeId,
        prId,
        path: t.path,
        line: t.line,
        isResolved: false,
        isOutdated: t.line == null,
        derivedState: 'untouched',
        originalCommenterId: t.userId,
        createdAt: recent,
      })),
    )
    .returning()
    .execute();
  // One in-window review COMMENT: getBotBehaviourAnalytics builds its bot set from touches
  // (reviews/comments) and early-returns with zeroed overlap when there are none — in real data
  // a thread always has its originating comment behind it.
  await db
    .insert(reviewComments)
    .values({
      githubNodeId: 'RC_dd_a0',
      threadId: inserted[0].id,
      prId,
      authorId: inhouseA,
      body: 'the originating finding',
      createdAt: recent,
    })
    .execute();

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
  // Two DISTINCT in-house bots — kind 'in_house' both, one with a custom label. coderabbitai
  // auto-classifies (known vendor login); the quality check is what the role excludes.
  await q.setWorkspaceReviewer(1, inhouseA, {
    workspaceId: scope.workspaceId,
    automated: true,
    label: 'DeepSource',
  });
  await q.setWorkspaceReviewer(1, inhouseB, { workspaceId: scope.workspaceId, automated: true });
  await q.setWorkspaceReviewer(1, qcId, {
    workspaceId: scope.workspaceId,
    automated: true,
    role: 'quality_check',
  });
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getBotDedupClusters (per-bot collapse, user-distinct gate)', () => {
  it('collapses a verbose bot into ONE ×N member — the 23-identical-pills scenario', async () => {
    const resp = await q.getBotDedupClusters(prId, 1);
    // Biggest hit leads (most members, then most threads): the null-line catch-all with 24.
    const c = resp.clusters[0]!;
    expect(c.path).toBe('src/proc.ts');
    expect(c.line).toBeNull();
    expect(c.members).toHaveLength(2); // TWO pills, never 24
    const a = c.members.find((m: any) => m.userId === inhouseA)!;
    expect(a.threadIds).toHaveLength(23);
    expect(a.threadId).toBe(a.threadIds[0]); // representative = first thread in cluster order
    const cr = c.members.find((m: any) => m.userId === coderabbitId)!;
    expect(cr.threadIds).toHaveLength(1);
  });

  it('labels resolve per REVIEWER — custom label / vendor name / login', async () => {
    const resp = await q.getBotDedupClusters(prId, 1);
    const c = resp.clusters[0]!;
    expect(c.members.find((m: any) => m.userId === inhouseA)!.label).toBe('DeepSource');
    expect(c.members.find((m: any) => m.userId === coderabbitId)!.label).toBe('CodeRabbit');
  });

  it('two DISTINCT in-house bots cluster (user-distinct replaced the kind-distinct gate)', async () => {
    const resp = await q.getBotDedupClusters(prId, 1);
    const twos = resp.clusters.filter((c: any) => c.path === 'src/two.ts');
    expect(twos).toHaveLength(5); // one per ±3 pair, anchored at the group's first line
    expect(twos.map((c: any) => c.line).sort((x: number, y: number) => x - y)).toEqual([
      10, 30, 50, 70, 90,
    ]);
    for (const c of twos) {
      expect(c.members).toHaveLength(2);
      // Same kind ('in_house'), different bots — and the labels tell them apart.
      const labels = c.members.map((m: any) => m.label).sort();
      expect(labels).toEqual(['DeepSource', 'inhouse-bot-b']);
    }
  });

  it('a single-bot pile is NOT a cluster, and quality checks never cluster', async () => {
    const resp = await q.getBotDedupClusters(prId, 1);
    expect(resp.clusters.some((c: any) => c.path === 'src/single.ts')).toBe(false);
    expect(resp.clusters.some((c: any) => c.path === 'src/qc.ts')).toBe(false);
    expect(resp.clusters).toHaveLength(6); // the null-line catch-all + the five pairs
  });
});

describe('getBotAnalytics same-line overlap (advisory ROI signal)', () => {
  it('credits each side of a ±3 cluster and attributes the top partner', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const a = resp.vendors.find((v: any) => v.key === `u${inhouseA}`)!;
    const b = resp.vendors.find((v: any) => v.key === `u${inhouseB}`)!;
    // inhouseA: 31 window threads (23 null + 5 pairs + 2 single + 1 qc-file), 5 overlapping.
    expect(a.threads).toBe(31);
    expect(a.overlapThreads).toBe(5);
    expect(a.overlapPct).toBe(16); // round(5/31 · 100)
    expect(a.topOverlapPartner).toEqual({ key: `u${inhouseB}`, label: 'inhouse-bot-b', clusters: 5 });
    // inhouseB: everything it said overlaps inhouseA.
    expect(b.threads).toBe(5);
    expect(b.overlapThreads).toBe(5);
    expect(b.overlapPct).toBe(100);
    expect(b.topOverlapPartner).toEqual({ key: `u${inhouseA}`, label: 'DeepSource', clusters: 5 });
  });

  it('null-line threads NEVER count toward the metric (the dedup catch-all is not overlap)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    // CodeRabbit shares the src/proc.ts null-line lump with inhouseA — the dedup surface shows
    // that; the METRIC must not (outdated threads lose their line; any two chatty bots would
    // otherwise "overlap" forever).
    const cr = resp.vendors.find((v: any) => v.kind === 'coderabbit')!;
    expect(cr.overlapThreads).toBe(0);
    expect(cr.overlapPct).toBe(0);
    expect(cr.topOverlapPartner).toBeNull();
  });

  it('quality checks are excluded from the pass (0 overlap despite a same-line thread)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const qc = resp.qualityChecks.find((v: any) => v.key === `u${qcId}`)!;
    expect(qc.overlapThreads).toBe(0);
    expect(qc.topOverlapPartner).toBeNull();
    // …and its same-line thread bought inhouseA no overlap either (see the 5 above, not 6).
  });

  it('emits the advisory overlap suggestion past both gates, and only there', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const overlapSuggestions = resp.suggestions.filter((s: any) => s.partnerLabel != null);
    // inhouseB: 5 threads (≥5), 100% share (≥40%) → fires. inhouseA: 16% → silent.
    // CodeRabbit: 1 thread → silent. The quality check: excluded by role.
    expect(overlapSuggestions).toHaveLength(1);
    const s = overlapSuggestions[0]!;
    expect(s.label).toBe('inhouse-bot-b');
    expect(s.partnerLabel).toBe('DeepSource');
    expect(s.pathGlob).toBeNull();
    expect(s.severity).toBeNull();
    expect(s.volume).toBe(5);
    expect(s.untouchedPct).toBe(100); // the share this suggestion keys on
    expect(s.rationale).toBe(
      "5 of inhouse-bot-b's threads land on lines DeepSource also flagged — redundant coverage; consider narrowing one of them.",
    );
  });

  it('the verdict stays pure thread math — 100% overlap does not move it', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const b = resp.vendors.find((v: any) => v.key === `u${inhouseB}`)!;
    // botVerdict(5 threads, 0% acted-on, 0 overdue) = 'tune' — exactly what the thread math
    // says with or without overlap (overlap is advisory; the semantics are pinned by
    // bot-analytics-verdict.test.ts).
    expect(b.verdict).toBe('tune');
  });
});

describe('getBotBehaviourAnalytics lineOverlapClusters (the unified definition)', () => {
  it('counts the same ±3 clusters, null-line excluded', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    // The five src/two.ts pairs — NOT the null-line lump (was counted under the old exact-line
    // key `${pr}|${path}|n`), NOT the qc pairing (role 'review' upstream).
    expect(resp.overlap.lineOverlapClusters).toBe(5);
    expect(resp.overlap.lineOverlapPrs).toBe(1);
  });
});
