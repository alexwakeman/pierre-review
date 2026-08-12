// getAdvisorFindings + getBotEffectPanel golden numbers on a THROWAWAY sqlite DB (the
// bot-analytics-verdict.test.ts pattern).
//
// Fixture (account 1, one repo/PR, window rolling_30):
//  • coderabbitai (review bot): 6 UNTOUCHED src/** threads aged 5d (origin comments labelled
//    3×minor + 3×major, category 'documentation'), 2 untouched docs/** threads (below the
//    5-thread cell floor → NO docs cell), 1 lib/** thread overlapping greptile, and 16
//    pr_comment-kind 'nit'/'documentation' labels (no thread → path-coverage disclosure), plus
//    ONE thread 40 days old that must fall outside the rolling_30 window.
//  • greptile-apps (review bot): 5 RESOLVED src/** threads with critical origin labels
//    (actedOnHigh — the retro-check numerator), 1 lib/** thread on the shared line.
//  • lint-bot (quality_check role, manual row): 6 untouched threads — appears in `bots` with
//    isQualityCheck, emits NO cells (a linter's untouched findings are its job).
//  • nested-bot (review bot): 6 untouched threads under apps/web/… (5 nit origins, 1 acted-on
//    nit) + 2 under apps/api/… — the depth-2 child apps/web/** meets the floor so IT is the
//    emitted cell and the coarse apps/** parent is NOT (the adaptive-depth rule), with
//    actedOnNits carried for the QUIET_PATH_NITS retro-check.
//  • effect-bot (in-house, setWorkspaceReviewer): 8 untouched threads/week in span weeks 0–4,
//    2 resolved threads/week in weeks 7–11 (two of them with major origin labels resolved in
//    4h) — the before/after split and the unattributed changepoint both read off this shape.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-advisor-findings-test.sqlite';
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
let crId = 0;
let grId = 0;
let lintId = 0;
let effectId = 0;
let nestedId = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * DAY;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;

let labelSeq = 9000;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, mlCommentLabels, workspaceReviewers } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_adv' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_adv',
      accountId: 1,
      repoId: repo.id,
      number: 1,
      title: 'advisor fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 100 * DAY),
      updatedAt: new Date(now - HOUR),
    })
    .returning()
    .execute();
  prId = pr.id;

  const mkUser = async (login: string, isBot: boolean) => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id as number;
  };
  crId = await mkUser('coderabbitai', true);
  grId = await mkUser('greptile-apps', true);
  lintId = await mkUser('lint-bot', true);
  effectId = await mkUser('effect-bot', true);
  nestedId = await mkUser('nested-bot', true);

  // A thread + its ORIGIN comment (the bot's own earliest comment — what ML labels attach to).
  const mkThread = async (
    userId: number,
    path: string,
    line: number,
    state: string,
    createdAt: Date,
    opts?: { resolvedAt?: Date; prId?: number },
  ): Promise<{ threadId: number; originCommentId: number }> => {
    const seq = (labelSeq += 1);
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `V_adv_${seq}`,
        prId: opts?.prId ?? prId,
        path,
        line,
        isResolved: state === 'resolved',
        isOutdated: false,
        derivedState: state,
        originalCommenterId: userId,
        createdAt,
        ...(opts?.resolvedAt ? { resolvedAt: opts.resolvedAt } : {}),
      })
      .returning()
      .execute();
    const [c] = await db
      .insert(reviewComments)
      .values({
        githubNodeId: `V_advC_${seq}`,
        threadId: t.id,
        prId: opts?.prId ?? prId,
        authorId: userId,
        body: 'finding',
        createdAt,
      })
      .returning()
      .execute();
    return { threadId: t.id, originCommentId: c.id };
  };

  const mkLabel = async (
    userId: number,
    targetKind: string,
    targetId: number,
    severity: string,
    categories: string[],
    targetCreatedAt: Date,
  ) => {
    labelSeq += 1;
    await db
      .insert(mlCommentLabels)
      .values({
        accountId: 1,
        repoId,
        prId,
        targetKind,
        targetId,
        authorUserId: userId,
        severity,
        severityOrd: { nit: 0, minor: 1, major: 2, critical: 3 }[severity] ?? 0,
        severityProb: 0.9,
        categories,
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: `h${labelSeq}`,
        targetCreatedAt,
      })
      .execute();
  };

  // coderabbit: 6 untouched src threads aged 5d, labelled 3×minor + 3×major ('documentation').
  for (let i = 0; i < 6; i++) {
    const at = new Date(now - 5 * DAY);
    const { originCommentId } = await mkThread(crId, `src/cr${i}.ts`, 1, 'untouched', at);
    await mkLabel(crId, 'review_comment', originCommentId, i < 3 ? 'minor' : 'major', ['documentation'], at);
  }
  // 2 docs threads — below the 5-thread cell floor.
  for (let i = 0; i < 2; i++) {
    await mkThread(crId, `docs/d${i}.md`, 1, 'untouched', new Date(now - 5 * DAY));
  }
  // 16 pr_comment-kind labels — no thread, no path (the coverage disclosure population).
  for (let i = 0; i < 16; i++) {
    await mkLabel(crId, 'pr_comment', 100_000 + i, 'nit', ['documentation'], new Date(now - 3 * DAY));
  }
  // The out-of-window thread: rolling_30 must exclude it.
  await mkThread(crId, 'src/old.ts', 1, 'untouched', new Date(now - 40 * DAY));

  // greptile: 5 resolved src threads with critical origin labels.
  for (let i = 0; i < 5; i++) {
    const at = new Date(now - 4 * DAY);
    const { originCommentId } = await mkThread(grId, `src/gr${i}.ts`, 1, 'resolved', at, {
      resolvedAt: new Date(now - 3 * DAY),
    });
    await mkLabel(grId, 'review_comment', originCommentId, 'critical', ['correctness_bug'], at);
  }

  // The overlap pair: one lib/** thread each, two lines apart (inside the ±3 window).
  await mkThread(crId, 'lib/utils.ts', 10, 'untouched', new Date(now - 2 * DAY));
  await mkThread(grId, 'lib/utils.ts', 11, 'resolved', new Date(now - 2 * DAY), {
    resolvedAt: new Date(now - DAY),
  });

  // lint-bot: 6 untouched threads; the manual quality_check judgement keeps it cell-less.
  for (let i = 0; i < 6; i++) {
    await mkThread(lintId, `src/lint${i}.ts`, 1, 'untouched', new Date(now - 5 * DAY));
  }

  // effect-bot: weeks 0–4 → 8 untouched/week; weeks 7–11 → 2 resolved/week (2 with major
  // origin labels resolved in exactly 4h). Span start is now − 12 weeks.
  const weekAt = (w: number): Date => new Date(now - 12 * WEEK + w * WEEK + DAY);
  for (let w = 0; w < 5; w++) {
    for (let i = 0; i < 8; i++) {
      await mkThread(effectId, `src/e${w}_${i}.ts`, 1, 'untouched', weekAt(w));
    }
  }
  let highSeeded = 0;
  for (let w = 7; w < 12; w++) {
    for (let i = 0; i < 2; i++) {
      const at = weekAt(w);
      const { originCommentId } = await mkThread(effectId, `src/e${w}_${i}.ts`, 1, 'resolved', at, {
        resolvedAt: new Date(at.getTime() + 4 * HOUR),
      });
      if (highSeeded < 2) {
        await mkLabel(effectId, 'review_comment', originCommentId, 'major', ['correctness_bug'], at);
        highSeeded += 1;
      }
    }
  }

  // A second, MERGED PR — the mergedUntouched population (an untouched thread here is one
  // the team shipped past; the main fixture PR stays open so its untouched threads count
  // toward `untouched` but NOT `mergedUntouched`).
  const [mergedPr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_adv_merged',
      accountId: 1,
      repoId: repo.id,
      number: 2,
      title: 'advisor merged fixture',
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - 20 * DAY),
      updatedAt: new Date(now - 2 * DAY),
      mergedAt: new Date(now - 2 * DAY),
    })
    .returning()
    .execute();
  const mergedPrId = mergedPr.id as number;

  // nested-bot: 6 untouched threads under apps/web/… — 5 nit-labelled origins plus ONE
  // resolved nit (the actedOnNits sample) — and 2 under apps/api/… (sub-floor). The depth-2
  // rule must emit apps/web/** and NOT the coarse apps/** parent. TWO of the untouched
  // threads live on the MERGED PR → the cell's mergedUntouched.
  for (let i = 0; i < 5; i++) {
    const at = new Date(now - 5 * DAY);
    const { originCommentId } = await mkThread(nestedId, `apps/web/src/n${i}.ts`, 1, 'untouched', at, i < 2 ? { prId: mergedPrId } : undefined);
    await mkLabel(nestedId, 'review_comment', originCommentId, 'nit', ['style'], at);
  }
  {
    const at = new Date(now - 5 * DAY);
    const { originCommentId } = await mkThread(nestedId, 'apps/web/src/acted.ts', 1, 'resolved', at, {
      resolvedAt: new Date(now - 4 * DAY),
    });
    await mkLabel(nestedId, 'review_comment', originCommentId, 'nit', ['style'], at);
  }
  for (let i = 0; i < 2; i++) {
    await mkThread(nestedId, `apps/api/src/n${i}.ts`, 1, 'untouched', new Date(now - 5 * DAY));
  }

  // ⚠ Resolve the scope through resolveWorkspaceScope, never by hand-building it — that call
  // runs ensureRepoMemberships, which puts the fixture repo into the Default workspace.
  scope = await q.resolveWorkspaceScope(1, null);

  // The judgements: lint-bot is a quality check; effect-bot is an in-house automated reviewer
  // (a bare in-house login is automated only once the workspace says so).
  await db
    .insert(workspaceReviewers)
    .values({
      accountId: 1,
      workspaceId: scope.workspaceId,
      authorUserId: lintId,
      automated: true,
      role: 'quality_check',
      confidence: 'high',
      source: 'manual',
    })
    .execute();
  await q.setWorkspaceReviewer(1, effectId, { workspaceId: scope.workspaceId, automated: true });
  await q.setWorkspaceReviewer(1, nestedId, { workspaceId: scope.workspaceId, automated: true });
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('getAdvisorFindings cells + floors', () => {
  it('emits the src/** path cell with severity mix from origin labels; the window excludes the 40d thread', async () => {
    expect(scope.repoIds).toHaveLength(1);
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    // 6 src + 2 docs + 1 lib = 9 window threads; src/old.ts (40d) is out of window.
    expect(cr.threads).toBe(9);
    expect(cr.untouched).toBe(9);
    expect(cr.overdueUntouched).toBe(9); // all older than the 36h grace
    const srcCell = resp.pathCells.find(
      (c: any) => c.botUserId === cr.botUserId && c.pathBucket === 'src/**',
    )!;
    expect(srcCell.volume).toBe(6);
    expect(srcCell.untouched).toBe(6);
    expect(srcCell.overdueUntouched).toBe(6);
    expect(srcCell.actedOn).toBe(0);
    expect(srcCell.bySeverity).toEqual({ nit: 0, minor: 3, major: 3, critical: 0 });
    expect(srcCell.samplePrIds).toEqual([prId]);
    expect(srcCell.sampleThreadIds.length).toBeGreaterThan(0);
  });

  it('a bucket under the 5-thread floor emits no cell', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    expect(resp.floors.minCellThreads).toBe(5);
    expect(resp.pathCells.some((c: any) => c.pathBucket === 'docs/**')).toBe(false);
    expect(resp.pathCells.some((c: any) => c.pathBucket === 'lib/**')).toBe(false);
  });

  it('adaptive depth: a qualifying depth-2 child is emitted INSTEAD of its coarse parent', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const nested = resp.bots.find((b: any) => b.login === 'nested-bot')!;
    const cells = resp.pathCells.filter((c: any) => c.botUserId === nested.botUserId);
    // apps/web/** (6 threads) meets the floor → emitted at depth 2; the parent apps/**
    // (8 threads, floor-met on its own) must NOT also be emitted — cells never overlap —
    // and the sub-floor sibling apps/api/** stays unreported.
    expect(cells.map((c: any) => c.pathBucket)).toEqual(['apps/web/**']);
    const web = cells[0]!;
    expect(web.volume).toBe(6);
    expect(web.untouched).toBe(5);
    expect(web.actedOn).toBe(1);
    // The QUIET_PATH_NITS retro numerators: 6 nit-labelled origins, 1 of them acted on.
    expect(web.bySeverity.nit).toBe(6);
    expect(web.actedOnNits).toBe(1);
    expect(web.actedOnHigh).toBe(0);
    // mergedUntouched: exactly the 2 untouched threads living on the MERGED PR; the bot
    // totals carry the same count.
    expect(web.mergedUntouched).toBe(2);
    expect(nested.mergedUntouched).toBe(2);
  });

  it('untouched threads on OPEN PRs never count toward mergedUntouched', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    // All of coderabbit's threads sit on the open fixture PR.
    expect(cr.untouched).toBe(9);
    expect(cr.mergedUntouched).toBe(0);
    const srcCell = resp.pathCells.find(
      (c: any) => c.botUserId === cr.botUserId && c.pathBucket === 'src/**',
    )!;
    expect(srcCell.mergedUntouched).toBe(0);
  });

  it("the ROI table's merged-past column counts window-merged PRs shipping past the bot", async () => {
    const roi = await q.getBotAnalytics(1, 'rolling_30', scope);
    const nested = roi.vendors.find((v: any) => v.login === 'nested-bot')!;
    // One PR merged inside the window, carrying 2 of nested-bot's untouched threads.
    expect(nested.mergedPastPrs).toBe(1);
    expect(nested.mergedPastThreads).toBe(2);
    // coderabbit's untouched threads are all on the OPEN PR → zero merged-past.
    const cr = roi.vendors.find((v: any) => v.login === 'coderabbitai')!;
    expect(cr.mergedPastPrs).toBe(0);
    expect(cr.mergedPastThreads).toBe(0);
  });

  it('adaptive depth: direct files with no qualifying children still emit the depth-1 parent', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    // coderabbit's 6 src threads are DIRECT files (src/cr0.ts…) — no depth-2 children exist,
    // so the parent src/** carries them (the pre-adaptive shape, unchanged).
    expect(
      resp.pathCells.some((c: any) => c.botUserId === cr.botUserId && c.pathBucket === 'src/**'),
    ).toBe(true);
  });

  it('acted-on high-severity threads feed actedOnHigh — the retro-check numerator', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const gr = resp.bots.find((b: any) => b.login === 'greptile-apps')!;
    const cell = resp.pathCells.find(
      (c: any) => c.botUserId === gr.botUserId && c.pathBucket === 'src/**',
    )!;
    expect(cell.volume).toBe(5);
    expect(cell.actedOn).toBe(5);
    expect(cell.actedOnHigh).toBe(5); // all five origins labelled critical, all resolved
    expect(cell.bySeverity.critical).toBe(5);
  });

  it('category cells respect the 20-finding floor and disclose thread linkage', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    const doc = resp.categoryCells.find(
      (c: any) => c.botUserId === cr.botUserId && c.category === 'documentation',
    )!;
    expect(doc.findings).toBe(22); // 6 thread-linked + 16 pr_comment labels
    expect(doc.threadLinked).toBe(6);
    expect(doc.untouched).toBe(6);
    expect(doc.bySeverity).toEqual({ nit: 16, minor: 3, major: 3, critical: 0 });
    // greptile has only 5 labelled findings — under the floor, no cell.
    const gr = resp.bots.find((b: any) => b.login === 'greptile-apps')!;
    expect(resp.categoryCells.some((c: any) => c.botUserId === gr.botUserId)).toBe(false);
  });

  it('path coverage is disclosed per bot and corpus-wide', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    // 6 of coderabbit's 22 labels are the review_comment kind → 27%.
    expect(cr.pathCoveragePct).toBe(27);
    const gr = resp.bots.find((b: any) => b.login === 'greptile-apps')!;
    expect(gr.pathCoveragePct).toBe(100);
    expect(resp.pathCoveragePct).not.toBeNull();
  });

  it('quality checks appear in bots but emit NO cells', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const lint = resp.bots.find((b: any) => b.login === 'lint-bot')!;
    expect(lint.isQualityCheck).toBe(true);
    expect(lint.threads).toBe(6);
    expect(resp.pathCells.some((c: any) => c.botUserId === lint.botUserId)).toBe(false);
    expect(resp.overlapCells.some((c: any) => c.botUserId === lint.botUserId)).toBe(false);
  });

  it('the overlap pair is emitted in both directions with the shared-cluster count', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', scope);
    const cr = resp.bots.find((b: any) => b.login === 'coderabbitai')!;
    const gr = resp.bots.find((b: any) => b.login === 'greptile-apps')!;
    const crCell = resp.overlapCells.find((c: any) => c.botUserId === cr.botUserId)!;
    expect(crCell.partnerUserId).toBe(gr.botUserId);
    expect(crCell.sharedClusters).toBe(1);
    expect(crCell.overlapThreads).toBe(1);
    expect(crCell.threads).toBe(9);
    expect(resp.overlapCells.some((c: any) => c.botUserId === gr.botUserId)).toBe(true);
  });

  it('an empty scope returns the empty payload, never a scan', async () => {
    const resp = await q.getAdvisorFindings(1, 'rolling_30', {
      workspaceId: scope.workspaceId,
      repoIds: [],
    });
    expect(resp.bots).toEqual([]);
    expect(resp.pathCells).toEqual([]);
  });
});

describe('getBotEffectPanel', () => {
  it('splits before/after around an anchor, excluding the transitional anchor week', async () => {
    // Anchor in week 6 (the quiet gap): before = weeks 0–5 (active 0–4), after = 7–11.
    const anchorMs = now - 12 * WEEK + 6 * WEEK + DAY;
    const panel = await q.getBotEffectPanel(1, scope, effectId, anchorMs);
    expect(panel.anchor.weekIndex).toBe(6);
    expect(panel.before.volumePerWeek).toBe(8);
    expect(panel.before.actedOnPct).toBe(0);
    expect(panel.after.volumePerWeek).toBe(2);
    expect(panel.after.actedOnPct).toBe(100);
    // The two high-severity findings resolved in exactly 4h.
    expect(panel.after.highSeverityMedianHours).toBe(4);
  });

  it('null anchor runs unattributed changepoint detection (volume drop found)', async () => {
    const panel = await q.getBotEffectPanel(1, scope, effectId, null);
    expect(panel.anchor).toBeNull();
    expect(panel.before).toBeNull();
    const vol = panel.changepoints.find((c: any) => c.series === 'volume');
    expect(vol).toBeDefined();
    expect(vol.direction).toBe('down');
  });

  it('zero-volume weeks are null in the volume series (null-vs-zero policy)', async () => {
    const panel = await q.getBotEffectPanel(1, scope, effectId, null);
    expect(panel.volume[5]).toBeNull();
    expect(panel.volume[0]).toBe(8);
    expect(panel.volume[11]).toBe(2);
  });

  it('a bot outside the workspace judgement earns an empty panel, never data', async () => {
    const { users } = schema;
    const [stranger] = await db
      .insert(users)
      .values({ githubLogin: 'stranger-bot', githubNodeId: 'U_stranger', isBot: true })
      .returning()
      .execute();
    const panel = await q.getBotEffectPanel(1, scope, stranger.id, null);
    expect(panel.volume.every((v: number | null) => v === null)).toBe(true);
    expect(panel.changepoints).toEqual([]);
  });
});
