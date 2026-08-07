// getBotAnalytics — the response-time-gated "noisy" verdict AND the ML nit-ratio escalation, on
// a THROWAWAY sqlite DB.
//
// The point of the gate: an untouched thread only counts against a bot ("overdue", and only then
// feeding the noisy verdict) once its age exceeds a FIXED 36h grace window. So two bots with the
// SAME untouched count get OPPOSITE verdicts when one's backlog is young and the other's is aged.
//
// The verdict is NO LONGER ML-free. One label-derived input reaches it — a bot whose scored
// findings are overwhelmingly nits is ESCALATED 'keep' → 'tune', on the same gates as the nit
// tuning suggestion (findings ≥ 20 AND nit share ≥ 0.7) so the chip and the advisory beneath the
// table cannot contradict each other. The third suite below is that rule's matrix, and the
// properties it defends are the reason the input is narrow: escalation ONLY (a label may never
// soften a verdict the thread math already earned, and can never produce 'noisy'), the RAW share
// rather than the rounded display twin, and no reading of the vendor's own declared severity.
//
// Seed (account 1, one repo/PR, window rolling_14):
//  • Two REPLIED bot threads (coderabbit), each answered by a human ~1 day after opening → they
//    give coderabbit a ~1d MEDIAN reply (the info-only column) and count as acted-on.
//  • coderabbit also has 10 UNTOUCHED threads opened 2h ago (inside the 36h grace) →
//    overdue = 0 → NOT noisy (verdict 'tune').
//  • greptile has 10 UNTOUCHED threads opened 5 days ago (past 36h), nothing else →
//    overdue = 10 → 'noisy'. Same untouched count as coderabbit's untouched, opposite verdict.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-verdict-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
// BotScope { workspaceId, repoIds } — `workspaceId` decides who counts as a bot, `repoIds`
// narrows the measured data. Resolved through the production resolver in beforeAll.
let scope: any;
let greptileId = 0;
let coderabbitId = 0;
let repoId = 0;
let prId = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;

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
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_v' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_v',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'verdict fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  prId = pr.id;

  const [coderabbit] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_cr', isBot: true })
    .returning()
    .execute();
  const [greptile] = await db
    .insert(users)
    .values({ githubLogin: 'greptile-apps', githubNodeId: 'U_gr', isBot: true })
    .returning()
    .execute();
  const [alice] = await db
    .insert(users)
    .values({ githubLogin: 'alice-dev', githubNodeId: 'U_al', isBot: false })
    .returning()
    .execute();
  greptileId = greptile.id;
  coderabbitId = coderabbit.id;

  // Two REPLIED coderabbit threads — a human answers ~1 day after each opens. These are the
  // only response-time samples, so the account norm = 1 day. (No bot comment needed: the
  // thread's originalCommenterId already marks it a bot thread.)
  for (const [i, openedDaysAgo] of [12, 10].entries()) {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_R${i}`,
        prId: pr.id,
        path: `src/r${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'replied_unresolved',
        originalCommenterId: coderabbit.id,
        createdAt: new Date(now - openedDaysAgo * DAY),
      })
      .returning()
      .execute();
    await db
      .insert(reviewComments)
      .values({
        githubNodeId: `V_RC${i}`,
        threadId: t.id,
        prId: pr.id,
        authorId: alice.id,
        body: 'thanks, addressing',
        createdAt: new Date(now - (openedDaysAgo - 1) * DAY), // ~1 day after the thread opened
      })
      .execute();
  }

  // coderabbit: 10 UNTOUCHED threads opened 2h ago — younger than the 1-day norm → NOT overdue.
  for (let i = 0; i < 10; i++) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_CRU${i}`,
        prId: pr.id,
        path: `src/cr${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: coderabbit.id,
        createdAt: new Date(now - 2 * HOUR),
      })
      .execute();
  }

  // greptile: 10 UNTOUCHED threads opened 5 days ago — older than the 1-day norm → all overdue.
  for (let i = 0; i < 10; i++) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_GRU${i}`,
        prId: pr.id,
        path: `src/gr${i}.ts`,
        line: 1,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: greptile.id,
        createdAt: new Date(now - 5 * DAY),
      })
      .execute();
  }

  // ⚠ Resolve the scope through `resolveWorkspaceScope`, never by hand-building
  // `{workspaceId, repoIds}` — that call runs `ensureRepoMemberships`, which is what puts a repo
  // inserted straight into `repos` into the account's Default workspace. Hand-build it and the
  // getter short-circuits on an empty scope: `vendors` comes back empty and every `.find(...)!`
  // below throws for a reason that has nothing to do with the grace window.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('getBotAnalytics response-time-gated verdict', () => {
  it('the overdue gate is a fixed 36h grace window', async () => {
    expect(scope.repoIds).toHaveLength(1); // the fixture repo really is in the resolved scope
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    expect(resp.totals.overdueGraceMs).toBe(36 * HOUR);
  });

  it('young untouched backlog is NOT overdue → the bot escapes "noisy" (verdict tune)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const cr = resp.vendors.find((v: { kind: string }) => v.kind === 'coderabbit')!;
    expect(cr.untouched).toBe(10); // 10 not-addressed threads…
    expect(cr.overdueUntouched).toBe(0); // …but all 2h old, inside the 36h grace → none overdue
    expect(cr.medianAddressedMs).toBe(DAY); // its own two replies → median time-to-addressed ~1 day (info-only)
    expect(cr.verdict).toBe('tune'); // low acted-on, but NOT noisy — the grace spared it
  });

  it('aged untouched backlog IS overdue → same untouched count, verdict "noisy"', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const gr = resp.vendors.find((v: { kind: string }) => v.kind === 'greptile')!;
    expect(gr.untouched).toBe(10); // identical not-addressed count to coderabbit…
    expect(gr.overdueUntouched).toBe(10); // …but all 5d old, past the 36h grace → all overdue
    expect(gr.medianAddressedMs).toBeNull(); // no thread of its was ever addressed (no reply/resolve/commit)
    expect(gr.verdict).toBe('noisy'); // high volume, zero acted-on, all overdue
  });
});

// The ROLE SPLIT, asserted on the very fixture that motivates it: greptile's 10 aged untouched
// threads earn it 'noisy' as a REVIEW bot (above). A quality check doing exactly its job produces
// the same shape — a linter's findings sit unanswered — so the role must keep it out of the metric
// surface WITHOUT hiding it.
//
// ⚠ THE POINT IS THAT `getBotAnalytics` SPLITS, IT DOES NOT FILTER. It asks
// `automatedReviewerUserIds(..., 'all')` and routes `role:'quality_check'` rows into
// `qualityChecks[]` at the bottom, so the row is still COMPUTED — same counts, same trend — just
// kept out of `vendors`/`totals`/`suggestions`. Narrowing the id set to `'review'` instead would
// make a mis-roled bot vanish from the one screen where you'd fix the role, and that failure is
// invisible to any assertion that only checks `vendors`. Hence the three-way check: gone from
// `vendors`, PRESENT in `qualityChecks`, and carrying its real numbers.
describe('getBotAnalytics role split (quality_check is SPLIT OUT, not filtered away)', () => {
  const wsRow = (workspaceId: number, role: string) => ({
    accountId: 1,
    workspaceId,
    authorUserId: greptileId,
    automated: true,
    role,
    confidence: 'high',
    source: 'manual',
  });

  it('a quality_check row moves the bot to qualityChecks[] with its counts intact', async () => {
    const { workspaceReviewers } = schema;
    // The judgement is a WORKSPACE fact now: one row per (account, workspace, actor).
    await db.insert(workspaceReviewers).values(wsRow(scope.workspaceId, 'quality_check')).execute();
    try {
      const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
      expect(resp.vendors.some((v: { kind: string }) => v.kind === 'greptile')).toBe(false);
      const qc = resp.qualityChecks.find((v: { kind: string }) => v.kind === 'greptile');
      expect(qc).toBeDefined();
      // Computed identically to a vendor row — this is what "split, not filtered" means.
      expect(qc.untouched).toBe(10);
      expect(qc.overdueUntouched).toBe(10);
      // …and excluded from the headline numbers: only coderabbit's 12 threads remain.
      expect(resp.totals.threads).toBe(12);
      expect(resp.vendors).toHaveLength(1);
    } finally {
      await db.delete(workspaceReviewers).execute();
    }
  });

  it('the same row in ANOTHER workspace does not move it — the judgement is workspace-scoped', async () => {
    const { workspaceReviewers } = schema;
    const other = await q.createWorkspace(1, 'Other');
    await db.insert(workspaceReviewers).values(wsRow(other.id, 'quality_check')).execute();
    try {
      const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
      // Read at the DEFAULT workspace, so the row keyed to `other` is invisible: greptile is a
      // review bot here and keeps its 'noisy' verdict.
      expect(resp.qualityChecks).toHaveLength(0);
      const gr = resp.vendors.find((v: { kind: string }) => v.kind === 'greptile')!;
      expect(gr.verdict).toBe('noisy');
    } finally {
      await db.delete(workspaceReviewers).execute();
      await q.deleteWorkspace(other.id, 1); // (id, accountId) — not the (accountId, …) of its siblings
    }
  });
});

// ── The ML nit-ratio ESCALATION matrix ───────────────────────────────────────────────────────
// Seeded in this suite's own beforeAll, AFTER the two above have asserted on the shared fixture.
//
// Three fresh in-house bots share one shape — 6 threads, all resolved, so the thread math alone
// says 'keep' — and differ ONLY in their labels. That isolation is the point: any movement here
// is the label speaking, and nothing else.
//
//   nitbot   — 20 findings, 14 nits: BOTH gates exactly met (0.7)             → escalated 'tune'
//   fewbot   — 19 findings, ALL nits: one short of the volume gate            → stays    'keep'
//   sharebot — 23 findings, 16 nits = 0.6957: DISPLAYS as 70% but is under it → stays    'keep'
//
// plus the two bots from the fixture above, relabelled nit-heavy to pin the no-downgrade rule:
// greptile stays 'noisy' and coderabbit stays 'tune' — an ML input may only ever escalate
// 'keep', never soften a thread-math verdict and never manufacture 'noisy'.
describe('getBotAnalytics ML nit-ratio escalation', () => {
  const nits = (n: number) => Array.from({ length: n }, () => 'nit');

  beforeAll(async () => {
    const { users, reviewThreads, mlCommentLabels } = schema;
    let targetSeq = 5000;
    const label = (userId: number, severity: string) => {
      targetSeq += 1;
      return {
        accountId: 1,
        repoId,
        prId,
        targetKind: 'review_comment' as const,
        targetId: targetSeq,
        authorUserId: userId,
        severity,
        severityOrd: { nit: 0, minor: 1, major: 2, critical: 3 }[severity] ?? 0,
        severityProb: 0.8,
        categories: severity === 'nit' ? ['nitpick'] : ['correctness_bug'],
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: `hv${targetSeq}`,
        targetCreatedAt: new Date(now - 2 * HOUR),
      };
    };

    // (login, the bot's findings as a severity list)
    const bots: Array<[string, string[]]> = [
      ['nit-bot', [...nits(14), ...Array.from({ length: 6 }, () => 'minor')]],
      ['few-bot', nits(19)],
      ['share-bot', [...nits(16), ...Array.from({ length: 7 }, () => 'minor')]],
    ];
    for (const [login, severities] of bots) {
      const [u] = await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot: true })
        .returning()
        .execute();
      // 6 RESOLVED threads: acted-on 100% → the thread math says 'keep' on its own, which is the
      // only starting point from which an escalation is observable.
      for (let i = 0; i < 6; i++) {
        await db
          .insert(reviewThreads)
          .values({
            githubNodeId: `V_${login}_${i}`,
            prId,
            path: `src/${login}${i}.ts`,
            line: 1,
            isResolved: true,
            isOutdated: false,
            derivedState: 'resolved',
            originalCommenterId: u.id,
            createdAt: new Date(now - 2 * HOUR),
            resolvedAt: new Date(now - HOUR),
          })
          .execute();
      }
      // An in-house login is automated only once the workspace says so — and only with a
      // footprint, hence after the threads.
      await q.setWorkspaceReviewer(1, u.id, { workspaceId: scope.workspaceId, automated: true });
      await db.insert(mlCommentLabels).values(severities.map((s) => label(u.id, s))).execute();
    }

    // The no-downgrade fixtures: both already have a verdict from the thread math.
    for (const userId of [coderabbitId, greptileId]) {
      await db.insert(mlCommentLabels).values(nits(25).map((s) => label(userId, s))).execute();
    }
  });

  const rowFor = async (login: string) => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    return resp.vendors.find((v: { login: string | null }) => v.login === login)!;
  };

  it('escalates keep → tune at exactly the gates (20 findings, 70% nits)', async () => {
    const v = await rowFor('nit-bot');
    expect(v.threads).toBe(6);
    expect(v.actedOnPct).toBe(100); // the thread math has no complaint at all…
    expect(v.overdueUntouched).toBe(0);
    expect(v.mlFindings).toBe(20);
    expect(v.mlNitPct).toBe(70);
    expect(v.verdict).toBe('tune'); // …so this is the label, and only the label
  });

  it('the chip and the nit SUGGESTION agree by construction (one pair of gates)', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    const suggested = new Set(
      resp.suggestions
        .filter((s: { severity: string | null }) => s.severity === 'nit')
        .map((s: { label: string }) => s.label),
    );
    // Every bot the nit advisory names reads at least 'tune' — the failure this forbids is a row
    // chipped 'keep' sitting directly above a sentence telling you to tune it.
    for (const v of resp.vendors) {
      if (suggested.has(v.label)) expect(v.verdict).not.toBe('keep');
    }
    expect(suggested.has('nit-bot')).toBe(true);
    expect(suggested.has('few-bot')).toBe(false);
    expect(suggested.has('share-bot')).toBe(false);
  });

  it('19 findings is under the volume gate — 100% nits still reads keep', async () => {
    const v = await rowFor('few-bot');
    expect(v.mlFindings).toBe(19);
    expect(v.mlNitPct).toBe(100);
    expect(v.verdict).toBe('keep');
  });

  it('gates on the RAW share, not the rounded percentage the column shows', async () => {
    const v = await rowFor('share-bot');
    expect(v.mlFindings).toBe(23);
    // 16/23 = 0.6956… — the COLUMN rounds it to 70%, the gate does not. Reading the rounded
    // twin here would flip this row and make the boundary depend on a display decision.
    expect(v.mlNitPct).toBe(70);
    expect(v.verdict).toBe('keep');
  });

  it('never downgrades: a nit-heavy noisy bot stays noisy, a tune bot stays tune', async () => {
    const gr = await rowFor('greptile-apps');
    expect(gr.mlNitPct).toBe(100);
    expect(gr.overdueUntouched).toBe(10);
    expect(gr.verdict).toBe('noisy'); // the ML branch is never reached — thread math already spoke
    const cr = await rowFor('coderabbitai');
    expect(cr.mlNitPct).toBe(100);
    expect(cr.verdict).toBe('tune'); // and nothing about a label can push a row TO 'noisy'
  });

  it('a bot with no labels at all is judged exactly as before', async () => {
    // Same shape as nit-bot (6 resolved threads) but unscored: no ML input, no escalation.
    const { users, reviewThreads } = schema;
    const [u] = await db
      .insert(users)
      .values({ githubLogin: 'bare-bot', githubNodeId: 'U_bare', isBot: true })
      .returning()
      .execute();
    for (let i = 0; i < 6; i++) {
      await db
        .insert(reviewThreads)
        .values({
          githubNodeId: `V_bare_${i}`,
          prId,
          path: `src/bare${i}.ts`,
          line: 1,
          isResolved: true,
          isOutdated: false,
          derivedState: 'resolved',
          originalCommenterId: u.id,
          createdAt: new Date(now - 2 * HOUR),
          resolvedAt: new Date(now - HOUR),
        })
        .execute();
    }
    await q.setWorkspaceReviewer(1, u.id, { workspaceId: scope.workspaceId, automated: true });
    const v = await rowFor('bare-bot');
    expect(v.mlFindings).toBeUndefined();
    expect(v.notAddressedBySeverity).toBeUndefined();
    expect(v.verdict).toBe('keep');
  });
});
