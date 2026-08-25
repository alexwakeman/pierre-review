// getBotAnalytics under EXPLICIT bounds (the People report's completed period), on a THROWAWAY
// sqlite DB. Under the enum form `to` ≡ now, so a fold missing its upper bound was invisible —
// the widened `{kind, fromMs, toMs}` form is the first caller whose `to` sits in the past, and
// this fixture pins that every fold honours it: one bot with a thread / merged-PR-with-untouched
// / ML label INSIDE the period and a twin of each AFTER it (but before now). Pre-fix the
// after-period twins leaked into `threads`, `mergedPastPrs` and `mlFindings` while `comments` on
// the same row (already two-sided) counted only the period — one row mixing two populations.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-analytics-window-bounds-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let scope: any;
let botId = 0;

const DAY = 24 * 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
// The completed period: [now−30d, now−10d) — everything "after" sits in (to, now].
const fromMs = now - 30 * DAY;
const toMs = now - 10 * DAY;
const inPeriod = new Date(now - 20 * DAY);
const afterPeriod = new Date(now - 5 * DAY);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, mlCommentLabels } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_wb' })
    .returning()
    .execute();
  const [bot] = await db
    .insert(users)
    .values({ githubLogin: 'coderabbitai', githubNodeId: 'U_wb', isBot: true })
    .returning()
    .execute();
  botId = bot.id;

  // PR 1 merged INSIDE the period, PR 2 merged AFTER it — each carrying one untouched bot
  // thread (created at the PR's own era), so the pair splits every fold under test.
  const mkPr = async (n: number, mergedAt: Date) => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_wb${n}`,
        accountId: 1,
        repoId: repo.id,
        number: n,
        title: `window-bounds fixture ${n}`,
        state: 'merged',
        isDraft: false,
        openedAt: new Date(mergedAt.getTime() - 2 * DAY),
        updatedAt: mergedAt,
        mergedAt,
      })
      .returning()
      .execute();
    return pr.id;
  };
  const seed = async (n: number, at: Date) => {
    const prId = await mkPr(n, at);
    const [thread] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `WB_T${n}`,
        prId,
        path: 'src/x.ts',
        line: n,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: botId,
        createdAt: at,
      })
      .returning()
      .execute();
    const [rc] = await db
      .insert(reviewComments)
      .values({
        githubNodeId: `WB_RC${n}`,
        threadId: thread.id,
        prId,
        authorId: botId,
        body: `finding ${n}`,
        createdAt: at,
      })
      .returning()
      .execute();
    await db
      .insert(mlCommentLabels)
      .values({
        accountId: 1,
        repoId: repo.id,
        prId,
        targetKind: 'review_comment',
        targetId: rc.id,
        authorUserId: botId,
        severity: 'major',
        severityOrd: 2,
        severityProb: 0.9,
        categories: ['security'],
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: `h_wb${n}`,
        targetCreatedAt: at,
      })
      .execute();
  };
  await seed(1, inPeriod);
  await seed(2, afterPeriod);

  // Through the production resolver (ensureRepoMemberships) — see bot-analytics-dormant.test.ts.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

describe('getBotAnalytics explicit-bounds window', () => {
  it('every fold is two-sided: post-period activity reaches no column of the period row', async () => {
    expect(scope.repoIds).toHaveLength(1);
    const resp = await q.getBotAnalytics(1, { kind: 'sprint', fromMs, toMs }, scope);
    // The echo states the real bounds …
    expect(resp.window.from).toBe(new Date(fromMs).toISOString());
    expect(resp.window.to).toBe(new Date(toMs).toISOString());
    // … and the row's populations honour them: threads/untouched (the thread scan),
    // mergedPast (the mergedAt predicate), comments (already two-sided — the control),
    // and the ML columns (getMlWindowAggregates' new upper bound).
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit')!;
    expect(v).toBeDefined();
    expect(v.threads).toBe(1);
    expect(v.untouched).toBe(1);
    expect(v.comments).toBe(1);
    expect(v.mergedPastPrs).toBe(1);
    expect(v.mergedPastThreads).toBe(1);
    expect(v.mlFindings).toBe(1);
    expect(resp.ml.findings).toBe(1);
    expect(resp.totals.threads).toBe(1);
  });

  it('the enum form still counts everything up to now', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_30', scope);
    const v = resp.vendors.find((x: { kind: string }) => x.kind === 'coderabbit')!;
    expect(v.threads).toBe(2);
    expect(v.comments).toBe(2);
    expect(v.mergedPastPrs).toBe(2);
    expect(v.mlFindings).toBe(2);
  });
});
