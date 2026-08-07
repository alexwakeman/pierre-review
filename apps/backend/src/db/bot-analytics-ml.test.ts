// getBotAnalytics — the WINDOWED ML label fold + the nit-ratio suggestion, on a THROWAWAY
// sqlite DB. Plus getBotVendorComments (the comments drill-down) against the same fixture.
//
// What this file pins:
//  • the per-vendor ml* fields aggregate `ml_comment_labels` over the SAME window as the ROI
//    columns (labels outside the window are invisible), with getBotSeverityRollup's exclusion
//    semantics — summaries and praise are labelled work but NOT findings, and every rate
//    divides by findings;
//  • a bot with NO in-window labels ships the fields ABSENT (blanks, never zeros);
//  • the nit suggestion fires only past BOTH gates (findings ≥ 20 AND nit share ≥ 0.7), fills
//    the severity slot, and NEVER fires for a quality_check-roled bot;
//  • those SAME gates escalate the verdict 'keep' → 'tune', so the chip and the advisory under
//    the table always agree (the escalation's own matrix — boundaries, no-downgrade — lives in
//    bot-analytics-verdict.test.ts);
//  • `notAddressedBySeverity` splits the untouched threads by the severity of the finding that
//    OPENED each one — addressed threads, praise and summaries never count;
//  • response-level `ml` totals cover the whole automated set (both roles), `pending` counts
//    only unlabelled bot text INSIDE the window, and `totals.overlapClusters` counts the
//    shared line areas ONCE (it is not the sum of the per-vendor overlap columns).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-ml-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let ml: any;
let scope: any;
let repoId = 0;
let prId = 0;
let coderabbitId = 0;
let greptileId = 0;
let qbotId = 0;
let oldbotId = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
const inWindow = new Date(now - 1 * DAY); // inside every window
const outWindow = new Date(now - 40 * DAY); // outside rolling_14 AND rolling_30

// Invented ML target ids start high so they can never collide with a REAL reviewComments.id
// used by the drill-down fixture at the bottom (the unique is (account, kind, target_id)).
let targetSeq = 1000;
function mlRow(
  userId: number,
  severity: 'nit' | 'minor' | 'major' | 'critical',
  opts: { at?: Date; isSummary?: boolean; categories?: string[] } = {},
) {
  const ord = { nit: 0, minor: 1, major: 2, critical: 3 }[severity];
  targetSeq += 1;
  return {
    accountId: 1,
    repoId,
    prId,
    targetKind: 'review_comment' as const,
    targetId: targetSeq,
    authorUserId: userId,
    severity,
    severityOrd: ord,
    severityProb: 0.8,
    categories: opts.categories ?? ['nitpick'],
    categoryProbs: {},
    isSummary: opts.isSummary ?? false,
    backend: 'modernbert-onnx',
    modelVersion: 'test',
    bodyHash: `h${targetSeq}`,
    targetCreatedAt: opts.at ?? inWindow,
  };
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  ml = await import('./ml-labels.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, prComments } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_ml_fold' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_ml_fold',
      accountId: 1,
      repoId,
      number: 1,
      title: 'ml fold fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
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
  coderabbitId = await mkUser('coderabbitai', 'U_ml_cr'); // known vendor — auto-classified
  greptileId = await mkUser('greptile-apps', 'U_ml_gr'); // known vendor — auto-classified
  qbotId = await mkUser('quality-bot', 'U_ml_qb'); // in-house, roled quality_check below
  oldbotId = await mkUser('old-bot', 'U_ml_ob'); // in-house; labels only OUTSIDE the window

  // One recent untouched thread per bot: the FOOTPRINT (setWorkspaceReviewer refuses an actor
  // without one) and the window activity that earns each a row. Two for coderabbit so its
  // thread math is distinguishable.
  const threads: Array<[number, string]> = [
    [coderabbitId, 'T_cr0'],
    [coderabbitId, 'T_cr1'],
    [greptileId, 'T_gr0'],
    [qbotId, 'T_qb0'],
    [oldbotId, 'T_ob0'],
  ];
  for (const [userId, nodeId] of threads) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: nodeId,
        prId,
        path: 'src/a.ts',
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: userId,
        createdAt: new Date(now - 2 * HOUR),
      })
      .execute();
  }

  // Unlabelled bot TEXT for the windowed `pending`: one PR comment inside the window (counts),
  // one outside (must not).
  await db
    .insert(prComments)
    .values([
      {
        githubNodeId: 'PC_ml_in',
        prId,
        authorId: coderabbitId,
        body: 'an unlabelled remark inside the window',
        createdAt: inWindow,
      },
      {
        githubNodeId: 'PC_ml_out',
        prId,
        authorId: coderabbitId,
        body: 'an unlabelled remark outside the window',
        createdAt: outWindow,
      },
    ])
    .execute();

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
  await q.setWorkspaceReviewer(1, qbotId, {
    workspaceId: scope.workspaceId,
    automated: true,
    role: 'quality_check',
  });
  await q.setWorkspaceReviewer(1, oldbotId, {
    workspaceId: scope.workspaceId,
    automated: true,
  });

  // THE LABELS.
  // coderabbit in-window: 21 nit + 2 minor + 1 major findings (= 24, nit share 87.5%), one
  // summary and one praise (labelled but never findings) — and 2 OLD nits the window must hide.
  const rows = [
    ...Array.from({ length: 21 }, () => mlRow(coderabbitId, 'nit')),
    mlRow(coderabbitId, 'minor', { categories: ['style_readability'] }),
    mlRow(coderabbitId, 'minor', { categories: ['style_readability'] }),
    mlRow(coderabbitId, 'major', { categories: ['correctness_bug'] }),
    mlRow(coderabbitId, 'minor', { isSummary: true }),
    mlRow(coderabbitId, 'nit', { categories: ['praise'] }),
    mlRow(coderabbitId, 'nit', { at: outWindow }),
    mlRow(coderabbitId, 'nit', { at: outWindow }),
    // greptile: 100% nits but only 5 findings — under the ≥20 gate, so NO suggestion.
    ...Array.from({ length: 5 }, () => mlRow(greptileId, 'nit')),
    // quality check: 25 nit findings — over both gates, but roled quality_check → NO suggestion.
    ...Array.from({ length: 25 }, () => mlRow(qbotId, 'nit')),
    // oldbot: labels exist but ONLY outside the window → its row ships NO ml fields.
    ...Array.from({ length: 3 }, () => mlRow(oldbotId, 'nit', { at: outWindow })),
  ];
  await db.insert(schema.mlCommentLabels).values(rows).execute();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getBotAnalytics ML fold (windowed, findings-only)', () => {
  it('aggregates per-bot labels over the SAME window as the ROI columns', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const cr = resp.vendors.find((v: { kind: string }) => v.kind === 'coderabbit')!;
    // 24 findings — the summary, the praise and the 2 out-of-window nits are all excluded.
    expect(cr.mlFindings).toBe(24);
    expect(cr.mlBySeverity).toEqual({ nit: 21, minor: 2, major: 1, critical: 0 });
    expect(cr.mlNitPct).toBe(88); // round(21/24 · 100)
    expect(cr.mlHighPct).toBe(4); // round(1/24 · 100)
  });

  it('a bot with labels only OUTSIDE the window ships the fields ABSENT — blanks, not zeros', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const ob = resp.vendors.find((v: { login: string | null }) => v.login === 'old-bot')!;
    expect(ob).toBeDefined(); // the row survives on its thread activity…
    expect(ob.mlFindings).toBeUndefined(); // …but carries no ML claim at all
    expect(ob.mlBySeverity).toBeUndefined();
    expect(ob.mlNitPct).toBeUndefined();
    expect(ob.mlHighPct).toBeUndefined();
  });

  it('response-level ml totals cover BOTH roles, and pending counts only in-window text', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    // labelled = coderabbit 26 (24+summary+praise) + greptile 5 + qbot 25. oldbot's 3 are old.
    expect(resp.ml.labelled).toBe(56);
    expect(resp.ml.findings).toBe(54);
    expect(resp.ml.summaries).toBe(1);
    expect(resp.ml.praise).toBe(1);
    expect(resp.ml.bySeverity).toEqual({ nit: 51, minor: 2, major: 1, critical: 0 });
    // The praise row's category is NOT a finding category; nitpick leads.
    expect(resp.ml.byCategory[0]).toEqual({ category: 'nitpick', count: 51 });
    expect(resp.ml.backends).toEqual(['modernbert-onnx']);
    expect(resp.ml.truncated).toBe(false);
    // One unlabelled bot comment inside the window; the out-of-window one is invisible.
    expect(resp.ml.pending).toBe(1);
  });

  it('emits the nit suggestion past both gates, in the severity slot, advisory copy', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const nitSuggestions = resp.suggestions.filter(
      (s: { severity: string | null }) => s.severity === 'nit',
    );
    expect(nitSuggestions).toHaveLength(1);
    const s = nitSuggestions[0]!;
    expect(s.vendorKind).toBe('coderabbit');
    expect(s.pathGlob).toBeNull();
    expect(s.volume).toBe(24); // scored findings, not labelled
    expect(s.untouchedPct).toBe(88); // the share the suggestion keys on
    expect(s.rationale).toContain('88% of');
    expect(s.rationale).toContain('24 scored findings are nits');
    expect(s.rationale).toContain('severity floor');
  });

  it('does NOT suggest for a small sample (greptile: 100% nits but only 5 findings)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const gr = resp.vendors.find((v: { kind: string }) => v.kind === 'greptile')!;
    expect(gr.mlFindings).toBe(5);
    expect(gr.mlNitPct).toBe(100);
    expect(
      resp.suggestions.some(
        (s: { severity: string | null; vendorKind: string }) =>
          s.severity === 'nit' && s.vendorKind === 'greptile',
      ),
    ).toBe(false);
  });

  it('does NOT suggest for a quality check, though its row still carries the mix', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const qb = resp.qualityChecks.find((v: { login: string | null }) => v.login === 'quality-bot')!;
    // The fold reaches quality checks (labels ARE computed for them — role 'all')…
    expect(qb.mlFindings).toBe(25);
    expect(qb.mlNitPct).toBe(100);
    // …but a linter's findings being nits is its job, not a tuning signal.
    expect(
      resp.suggestions.some((s: { label: string }) => s.label.includes('quality-bot')),
    ).toBe(false);
  });

  it('the nit ratio ESCALATES the verdict — 88% nits turns keep into tune', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const cr = resp.vendors.find((v: { kind: string }) => v.kind === 'coderabbit')!;
    // Thread math alone: 2 threads, 0 acted on, 0 overdue (both 2h old, inside the 36h grace) →
    // botVerdict(2, 0, 0) = 'keep'. The 88% nit share over 24 findings clears both gates, so the
    // chip agrees with the suggestion this same response emits rather than contradicting it.
    expect(cr.threads).toBe(2);
    expect(cr.overdueUntouched).toBe(0);
    expect(cr.verdict).toBe('tune');
    // greptile is the control: 100% nits, but only 5 findings — under the volume gate, so its
    // thread math (1 young untouched thread) still decides.
    const gr = resp.vendors.find((v: { kind: string }) => v.kind === 'greptile')!;
    expect(gr.mlNitPct).toBe(100);
    expect(gr.verdict).toBe('keep');
  });

  it('totals.overlapClusters counts each shared line area ONCE, not per bot', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    // Every fixture thread sits on (src/a.ts, line 1) of the same PR, so the ±3-line clustering
    // makes ONE area — shared by coderabbit ×2, greptile and old-bot (quality-bot is roled
    // quality_check and never enters the pass).
    expect(resp.totals.overlapClusters).toBe(1);
    // ⚠ THE POINT OF THE SEPARATE COUNT: a cluster credits EVERY member, so summing the rows'
    // overlapThreads gives 4 for the one area. The strip's tile must not be derivable that way.
    const summed = [...resp.vendors, ...resp.qualityChecks].reduce(
      (s: number, v: { overlapThreads: number }) => s + v.overlapThreads,
      0,
    );
    expect(summed).toBe(4);
  });
});

// The comments drill-down, on the same fixture — a REAL review comment is inserted here (after
// the fold assertions above have run) with its label keyed to the real row id.
describe('getBotVendorComments (the Comments drill-down)', () => {
  let rcId = 0;

  beforeAll(async () => {
    const [thread] = await db
      .insert(schema.reviewThreads)
      .values({
        githubNodeId: 'T_cr_dd',
        prId,
        path: 'src/dd.ts',
        line: 3,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: coderabbitId,
        createdAt: inWindow,
      })
      .returning()
      .execute();
    const [rc] = await db
      .insert(schema.reviewComments)
      .values({
        githubNodeId: 'RC_cr_dd',
        threadId: thread.id,
        prId,
        authorId: coderabbitId,
        body: 'A real inline finding body.',
        createdAt: inWindow,
      })
      .returning()
      .execute();
    rcId = rc.id;
    await db
      .insert(schema.mlCommentLabels)
      .values({
        accountId: 1,
        repoId,
        prId,
        targetKind: 'review_comment',
        targetId: rcId,
        authorUserId: coderabbitId,
        severity: 'major',
        severityOrd: 2,
        severityProb: 0.9,
        categories: ['security'],
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: 'h_dd',
        targetCreatedAt: inWindow,
      })
      .execute();
  });

  it('ships the vendor rows with the ML label INLINE (and unscored rows unbadged)', async () => {
    const resp = await ml.getBotVendorComments(1, { userId: coderabbitId }, 'rolling_14', scope);
    expect(resp.key).toBe(`u${coderabbitId}`);
    expect(resp.kind).toBe('coderabbit');
    // The real inline comment, its thread context, and its label — one response.
    const rc = resp.comments.find(
      (c: { targetKind: string; targetId: number }) =>
        c.targetKind === 'review_comment' && c.targetId === rcId,
    );
    expect(rc).toBeDefined();
    expect(rc.path).toBe('src/dd.ts');
    expect(rc.derivedState).toBe('untouched');
    expect(rc.repoFullName).toBe('acme/api');
    expect(rc.prNumber).toBe(1);
    expect(rc.mlLabel?.severity).toBe('major');
    expect(rc.mlLabel?.categories).toEqual(['security']);
    // The unlabelled in-window PR comment appears too — unbadged, never dropped…
    const pc = resp.comments.find((c: { targetKind: string }) => c.targetKind === 'pr_comment');
    expect(pc).toBeDefined();
    expect(pc.mlLabel).toBeNull();
    // …while the out-of-window PR comment is invisible.
    expect(resp.comments).toHaveLength(2);
    expect(resp.truncated).toBe(false);
  });

  it('answers EMPTY for the pierre sentinel and for an unclassified user id', async () => {
    const pierre = await ml.getBotVendorComments(1, { kind: 'pierre' }, 'rolling_14', scope);
    expect(pierre.key).toBe('pierre');
    expect(pierre.comments).toEqual([]);
    const unknown = await ml.getBotVendorComments(1, { userId: 999_999 }, 'rolling_14', scope);
    expect(unknown.comments).toEqual([]);
  });
});

// ── "Not addressed" split by the severity of the finding that OPENED the thread ──────────────
// Seeded AFTER the assertions above (its rows would move the fold's counts). Every case here is
// a way the split must DIFFER from a naive "label the untouched threads" pass:
//   • an ADDRESSED thread with a major finding must not appear anywhere;
//   • a praise-categorised or summary label is not a finding, so it is not an ignored one either;
//   • an untouched thread whose opening comment was never scored counts toward `untouched` and
//     toward NOTHING here — which is why the four numbers need not sum to that column.
describe('notAddressedBySeverity (the untouched column, split by severity)', () => {
  beforeAll(async () => {
    // (thread node id, derivedState, path, the origin comment's label — null = unscored)
    const cases: Array<[string, string, string, null | { severity: string; ord: number; isSummary?: boolean; categories?: string[] }]> = [
      ['T_na_major', 'untouched', 'src/na1.ts', { severity: 'major', ord: 2, categories: ['correctness_bug'] }],
      ['T_na_nit', 'untouched', 'src/na2.ts', { severity: 'nit', ord: 0 }],
      // Addressed — the thread was resolved, so it is not an ignored finding at all.
      ['T_na_done', 'resolved', 'src/na3.ts', { severity: 'critical', ord: 3, categories: ['security'] }],
      // Praise and a walkthrough: labelled work, never findings (the fold's exclusion, verbatim).
      ['T_na_praise', 'untouched', 'src/na4.ts', { severity: 'nit', ord: 0, categories: ['praise'] }],
      ['T_na_summary', 'untouched', 'src/na5.ts', { severity: 'minor', ord: 1, isSummary: true }],
      // Unscored: counted by `untouched`, invisible to the split.
      ['T_na_unscored', 'untouched', 'src/na6.ts', null],
    ];
    let seq = 0;
    for (const [nodeId, state, path, label] of cases) {
      seq += 1;
      const [thread] = await db
        .insert(schema.reviewThreads)
        .values({
          githubNodeId: nodeId,
          prId,
          path,
          line: 10,
          isResolved: state === 'resolved',
          isOutdated: false,
          derivedState: state,
          originalCommenterId: coderabbitId,
          createdAt: new Date(now - 3 * HOUR),
        })
        .returning()
        .execute();
      // TWO comments on each thread, the bot's first: the split must key on the OPENING
      // comment, so a later comment's label (here: always critical) must never be read.
      const [origin] = await db
        .insert(schema.reviewComments)
        .values({
          githubNodeId: `RC_${nodeId}_a`,
          threadId: thread.id,
          prId,
          authorId: coderabbitId,
          body: 'the finding that opened the thread',
          createdAt: new Date(now - 3 * HOUR),
        })
        .returning()
        .execute();
      const [followUp] = await db
        .insert(schema.reviewComments)
        .values({
          githubNodeId: `RC_${nodeId}_b`,
          threadId: thread.id,
          prId,
          authorId: coderabbitId,
          body: 'a later remark from the same bot',
          createdAt: new Date(now - 2 * HOUR),
        })
        .returning()
        .execute();
      const mk = (targetId: number, severity: string, ord: number, opts: { isSummary?: boolean; categories?: string[] } = {}) => ({
        accountId: 1,
        repoId,
        prId,
        targetKind: 'review_comment' as const,
        targetId,
        authorUserId: coderabbitId,
        severity,
        severityOrd: ord,
        severityProb: 0.9,
        categories: opts.categories ?? ['maintainability_refactor'],
        categoryProbs: {},
        isSummary: opts.isSummary ?? false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: `h_na_${seq}_${targetId}`,
        targetCreatedAt: new Date(now - 3 * HOUR),
      });
      const rows = [mk(followUp.id, 'critical', 3, { categories: ['security'] })];
      if (label) rows.push(mk(origin.id, label.severity, label.ord, label));
      await db.insert(schema.mlCommentLabels).values(rows).execute();
    }
  });

  it('buckets ONLY the untouched threads whose opening finding was scored', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const cr = resp.vendors.find((v: { kind: string }) => v.kind === 'coderabbit')!;
    // nit: T_na_nit. major: T_na_major PLUS the drill-down suite's own untouched thread, whose
    // real inline comment carries a major label — a second scored thread reaching this split
    // through the ordinary path. The resolved critical, the praise, the summary and the unscored
    // thread all contribute nothing, and NO cell picks up the follow-up comments' critical
    // labels, which is what proves the join keys on the OPENING comment.
    expect(cr.notAddressedBySeverity).toEqual({ nit: 1, minor: 0, major: 2, critical: 0 });
    // …while the total it splits counts every untouched thread, scored or not: 3 from the suites
    // above (2 fixture + 1 drill-down) + the 5 untouched ones seeded here. 8 ≠ 1 + 2, and that
    // gap is the contract — the four numbers split the LABELLED subset, nothing more.
    expect(cr.untouched).toBe(8);
  });

  it('a bot with no in-window labels ships the split ABSENT, like its ml* siblings', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const ob = resp.vendors.find((v: { login: string | null }) => v.login === 'old-bot')!;
    expect(ob.mlFindings).toBeUndefined();
    expect(ob.notAddressedBySeverity).toBeUndefined();
  });

  it('single-bot line areas never become overlap clusters', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    // Six more threads, all coderabbit's own and each on its own file — no second bot, so the
    // count is still the one shared area from the base fixture.
    expect(resp.totals.overlapClusters).toBe(1);
  });
});
