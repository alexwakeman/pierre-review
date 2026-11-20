// BOTS MONITORING MEASURES REVIEW BOTS ONLY — the ML scoring scope and every Bots read, on a
// THROWAWAY sqlite DB.
//
// THE COMPLAINT THIS FILE EXISTS FOR: the category and severity drill-downs listed SonarCloud's
// "Quality Gate passed" summary comments. A quality check posts a verdict, not a review finding,
// so it must never be categorised or given a severity — and nothing about it may be measured or
// shown on Bots Monitoring. The rule is the reviewer cohort (`role === 'review'`, the STORED role
// beating the login seed), at the repo's home workspace.
//
// The fixture: one PR, CodeRabbit (a review vendor) and SonarCloud (stored automated row, role
// 'quality_check' — what the classifier writes). Each has one LABELLED comment (SonarCloud's label
// is an old one, scored before the rule) and one UNLABELLED comment. Then:
//   • only CodeRabbit's unlabelled comment is an ML candidate, and only it is pending;
//   • SonarCloud's STORED label is ignored by every read (drill-downs, rollup, badges, ROI);
//   • ROI, Behaviour and Volume carry no SonarCloud row;
//   • re-roling SonarCloud to 'review' makes its text a candidate again (and its label shows).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-ml-review-bots-only-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let ml: any;
let volume: any;
let scope: { workspaceId: number; repoIds: number[] };
let prId = 0;
let crId = 0;
let sqId = 0;
const ids: Record<string, number> = {};

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
const at = new Date(now - 2 * HOUR);
const NO_REFINE = { cell: null, disagree: null, authorUserIds: null };
const ALL_SEVERITIES = ['nit', 'minor', 'major', 'critical'];

function label(targetId: number, authorUserId: number, severity: string, categories: string[]) {
  return {
    accountId: 1,
    repoId: scope.repoIds[0],
    prId,
    targetKind: 'pr_comment' as const,
    targetId,
    authorUserId,
    severity,
    severityOrd: { nit: 0, minor: 1, major: 2, critical: 3 }[severity],
    severityProb: 0.9,
    categories,
    categoryProbs: {},
    isSummary: false,
    backend: 'modernbert-onnx',
    modelVersion: 'test',
    bodyHash: `h${targetId}`,
    targetCreatedAt: at,
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
  volume = await import('./bot-volume.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, prComments, reviews } = schema;
  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_rbo', botScoringEnabled: true })
    .returning()
    .execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_rbo',
      accountId: 1,
      repoId: repo.id,
      number: 7,
      title: 'review bots only',
      state: 'merged',
      isDraft: false,
      openedAt: new Date(now - 3 * DAY),
      mergedAt: new Date(now - HOUR),
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
  crId = await mkUser('coderabbitai', 'U_rbo_cr');
  sqId = await mkUser('sonarqubecloud', 'U_rbo_sq');

  // Footprints (setWorkspaceReviewer refuses an actor without one) + ROI/Behaviour activity.
  for (const [userId, nodeId, line] of [
    [crId, 'T_rbo_cr', 10],
    [sqId, 'T_rbo_sq', 10],
  ] as const) {
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: nodeId,
        prId,
        path: 'src/a.ts',
        line,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: userId,
        createdAt: at,
      })
      .execute();
  }
  for (const [userId, nodeId] of [
    [crId, 'RV_rbo_cr'],
    [sqId, 'RV_rbo_sq'],
  ] as const) {
    await db
      .insert(reviews)
      .values({ githubNodeId: nodeId, prId, authorId: userId, state: 'commented', body: '', submittedAt: at })
      .execute();
  }

  const comments: Array<[string, number, string]> = [
    ['cr_old', crId, 'Possible null dereference on `user.id` when the session expired.'],
    ['cr_new', crId, 'This loop re-reads the config on every iteration.'],
    ['sq_old', sqId, '## Quality Gate passed\n\nIssues: 0 New issues · 0 Accepted issues'],
    ['sq_new', sqId, '## Quality Gate passed\n\nCoverage 81.2% on New Code'],
  ];
  for (const [key, authorId, body] of comments) {
    const [row] = await db
      .insert(prComments)
      .values({ githubNodeId: `PC_rbo_${key}`, prId, authorId, body, createdAt: at })
      .returning()
      .execute();
    ids[key] = row.id;
  }

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
  // What the classifier writes for SonarCloud: automated, role 'quality_check'.
  await q.setWorkspaceReviewer(1, sqId, {
    workspaceId: scope.workspaceId,
    automated: true,
    role: 'quality_check',
  });

  // Labels on the two OLD comments — SonarCloud's was scored before the review-only rule.
  await db
    .insert(schema.mlCommentLabels)
    .values([
      label(ids.cr_old!, crId, 'major', ['correctness_bug']),
      label(ids.sq_old!, sqId, 'minor', ['maintainability_refactor']),
    ])
    .execute();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ML scoring scope: review bots only', () => {
  it('a quality check summary comment is NOT an ML candidate; a review bot comment is', async () => {
    const pool = await ml.listMlCandidates(1, scope, 50);
    const targets = pool.map((c: any) => c.targetId);
    expect(targets).toContain(ids.cr_new);
    expect(targets).not.toContain(ids.sq_new);
    expect(pool.every((c: any) => c.authorUserId === crId)).toBe(true);
  });

  it('pending counts only review-bot text (lockstep with the candidates)', async () => {
    const backlog = await ml.getMlBacklogForAccount(1);
    expect(backlog.pending).toBe(1);
    const repo = await ml.getMlBacklogForRepo(1, scope.repoIds[0], true);
    expect(repo.pending).toBe(1);
  });
});

describe('Bots Monitoring reads ignore a stored label for a non-review bot', () => {
  it('the SEVERITY drill-down lists only the review bot', async () => {
    const resp = await ml.getBotFlaggingComments(
      1,
      { kind: 'severity', severities: ALL_SEVERITIES },
      NO_REFINE,
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    expect(resp.total).toBe(1);
    expect(resp.items.map((i: any) => i.authorUserId)).toEqual([crId]);
  });

  it('the CATEGORY drill-down lists only the review bot', async () => {
    const cat = await ml.getBotFlaggingComments(
      1,
      { kind: 'category', category: 'maintainability_refactor' },
      NO_REFINE,
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    // SonarCloud's stored label is the only row in this category — and it is ignored.
    expect(cat.total).toBe(0);
    expect(cat.items).toEqual([]);
    const findings = await ml.getBotFlaggingComments(
      1,
      { kind: 'findings' },
      NO_REFINE,
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    expect(findings.items.map((i: any) => i.authorUserId)).toEqual([crId]);
  });

  it('a narrowing to the quality check by id matches nothing', async () => {
    const resp = await ml.getBotFlaggingComments(
      1,
      { kind: 'findings' },
      { ...NO_REFINE, authorUserIds: [sqId] },
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    expect(resp.filteredTotal).toBe(0);
  });

  it('the severity rollup and the per-PR badges carry only the review bot', async () => {
    const rollup = await ml.getBotSeverityRollup(1, scope, true);
    expect(rollup.rows.map((r: any) => r.userId)).toEqual([crId]);
    expect(rollup.labelled).toBe(1);
    const badges = await ml.getPrMlLabels(prId, 1);
    expect(badges.map((l: any) => l.targetId)).toEqual([ids.cr_old]);
  });

  it('ROI: no quality-check row, and the ML strip totals count the review bot only', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    expect(resp.vendors.map((v: any) => v.key)).toEqual([`u${crId}`]);
    expect('qualityChecks' in resp).toBe(false);
    expect(resp.totals.threads).toBe(1);
    expect(resp.ml.labelled).toBe(1);
    expect(resp.ml.bySeverity).toEqual({ nit: 0, minor: 0, major: 1, critical: 0 });
    expect(resp.ml.pending).toBe(1);
    // Two bots on one line, but one is a quality check: no shared area.
    expect(resp.totals.overlapClusters).toBe(0);
  });

  it('Behaviour and Volume carry no quality-check row', async () => {
    const beh = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    expect(beh.bots.map((b: any) => b.userId)).toEqual([crId]);
    const vol = await volume.getBotVolume(1, 'rolling_14', scope);
    expect(vol.bots.map((b: any) => b.authorUserId)).toEqual([crId]);
  });
});

describe('re-roling the bot to review brings it back', () => {
  it('its text becomes a candidate again and its stored label shows', async () => {
    await q.setWorkspaceReviewer(1, sqId, {
      workspaceId: scope.workspaceId,
      automated: true,
      role: 'review',
    });
    const pool = await ml.listMlCandidates(1, scope, 50);
    expect(pool.map((c: any) => c.targetId)).toContain(ids.sq_new);
    const resp = await ml.getBotFlaggingComments(
      1,
      { kind: 'category', category: 'maintainability_refactor' },
      NO_REFINE,
      'rolling_14',
      scope,
      { offset: 0, limit: 50 },
    );
    expect(resp.items.map((i: any) => i.authorUserId)).toEqual([sqId]);
  });
});
