// CHRONOLOGY'S TWO VIEWS and LIMN IN THE REPORTS (docs/BOTTLENECKS.md § Two views;
// docs/PERIOD-REPORTING.md), on a THROWAWAY sqlite DB, with Limn's rows stored as sync leaves them
// once attributed: under the reader's `limn:<login>` bot (docs/CLAUDE-REVIEW.md § Limn's actions are bots).
//
// What this pins:
//   1. "People": only people's reviews and comments move the ball. A PR only Limn reviewed is
//      "merged without a human review"; Limn's approval before a person's does not end the wait.
//   2. "People + bots": Limn's and an AI review bot's reviews and comments move it too — the same PRs
//      measure shorter waits for a reviewer, and the Limn-only PR is measured.
//   3. In BOTH views a quality gate's comment never moves the ball, and a PR a bot (Limn) opened is
//      not measured.
//   4. The view is echoed, the stored per-workspace view is what an un-viewed read uses, and the
//      sentences name what counted.
//   5. Period reports: Limn's approvals and comments are in the `limn` lane, never the people's, and
//      the first-human-review time ignores Limn.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-flow-views-limn-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.WORK_TIMEZONE = 'UTC';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let flow: typeof import('./pr-intervals.js');
let period: typeof import('./period-metrics.js');
let scope: any;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const nowMs = Math.floor(Date.now() / 1000) * 1000;
const T0 = nowMs - 5 * DAY;
const at = (h: number) => new Date(T0 + h * HOUR);
const MARK = '\n\n<!-- pierre:claude-review v=2 -->';
const ids: Record<string, number> = {};

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  flow = await import('./pr-intervals.js');
  period = await import('./period-metrics.js');
  const { eq } = await import('drizzle-orm');
  const { accounts, users, repos, pullRequests, reviews, prComments } = schema;

  await db.update(accounts).set({ githubLogin: 'viewer-me' }).where(eq(accounts.id, 1)).execute();
  const user = async (login: string, o: Record<string, unknown> = {}): Promise<number> =>
    (await db.insert(users).values({ githubLogin: login, ...o }).returning().execute())[0].id;
  const viewer = await user('viewer-me', { githubNodeId: 'U_fv_viewer' });
  const limn = await user('limn:viewer-me', { isBot: true, isBotOverridden: true });
  const alice = await user('fv-alice', { githubNodeId: 'U_fv_alice' });
  const bob = await user('fv-bob', { githubNodeId: 'U_fv_bob' });
  const rabbit = await user('coderabbitai[bot]', { isBot: true, githubType: 'Bot' });
  const sonar = await user('sonarqubecloud[bot]', { isBot: true, githubType: 'Bot' });
  const repoId = (
    await db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'fv', githubNodeId: 'R_fv', createdAt: new Date(nowMs - 60 * DAY) })
      .returning()
      .execute()
  )[0].id;
  const ws = await q.ensureDefaultWorkspace(1);
  await q.assignReposToWorkspace(ws, 1, [repoId]);
  scope = await q.resolveWorkspaceScope(1, String(ws));

  let n = 0;
  const pr = async (key: string, mergedH: number, o: Record<string, unknown> = {}) => {
    n += 1;
    ids[key] = (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_fv_${n}`,
          accountId: 1,
          repoId,
          number: n,
          title: key,
          state: 'merged',
          isDraft: false,
          authorId: alice,
          openedAt: at(0),
          mergedAt: at(mergedH),
          updatedAt: at(mergedH),
          ...o,
        })
        .returning()
        .execute()
    )[0].id;
    return ids[key]!;
  };
  const review = (prId: number, authorId: number, state: string, h: number, body: string, postedFor: number | null = null) =>
    db
      .insert(reviews)
      .values({ githubNodeId: `RV_fv_${++n}`, prId, authorId, state, submittedAt: at(h), body, limnPostedByUserId: postedFor })
      .execute();
  const comment = (prId: number, authorId: number, h: number, body: string, postedFor: number | null = null) =>
    db
      .insert(prComments)
      .values({ githubNodeId: `IC_fv_${++n}`, prId, authorId, body, createdAt: at(h), limnPostedByUserId: postedFor })
      .execute();

  // A: Limn approves after 1h (for the viewer), bob after 5h; merged at 6h.
  const a = await pr('A', 6);
  await review(a, limn, 'approved', 1, `Looks right.${MARK}`, viewer);
  await review(a, bob, 'approved', 5, 'LGTM');
  // B: only Limn looked (a comment review at 1h); merged at 3h.
  const b = await pr('B', 3);
  await review(b, limn, 'commented', 1, `One finding.${MARK}`, viewer);
  // C: only a quality gate commented; merged at 3h.
  const c = await pr('C', 3);
  await comment(c, sonar, 1, 'Quality Gate passed');
  // D: CodeRabbit commented at 1h, bob approved at 2h; merged at 3h.
  const d = await pr('D', 3);
  await comment(d, rabbit, 1, 'Nitpick: rename this.');
  await review(d, bob, 'approved', 2, 'Fine');
  // E: Limn opened it (Implement) for alice; bob approved; merged at 3h.
  const e = await pr('E', 3, { authorId: limn, limnOpenedForUserId: alice });
  await review(e, bob, 'approved', 1, 'OK');
  // A Limn story check under the viewer's name, counted as Limn's comment.
  await comment(a, limn, 0.5, `**Story check** — fine.${MARK}`, viewer);
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const reviewerHours = (res: any): number => res.courts.find((x: any) => x.court === 'reviewer').hours;

describe('Chronology, two views', () => {
  it('"People": only people move the ball; the Limn-only PR is unreviewed', async () => {
    const res = await flow.getFlowCourts(1, scope, 30, { nowMs, view: 'people' });
    expect(res.view).toBe('people');
    expect(res.measuredPrs).toBe(2); // A and D
    expect(res.coverage.excludedNoHumanTouch).toBe(2); // B (Limn only) and C (quality gate only)
    expect(res.coverage.excludedBotAuthored).toBe(1); // E
    // A waited 5h for a person (Limn's approval at 1h does not count), D 2h.
    expect(reviewerHours(res)).toBeCloseTo(7, 5);
    expect(res.headline).toContain('a person actually worked on');
  });

  it('"People + bots": Limn and the AI review bot move the ball too; a quality gate still never does', async () => {
    const res = await flow.getFlowCourts(1, scope, 30, { nowMs, view: 'people_bots' });
    expect(res.view).toBe('people_bots');
    expect(res.measuredPrs).toBe(3); // A, B and D
    expect(res.coverage.excludedNoHumanTouch).toBe(1); // C
    expect(res.coverage.excludedBotAuthored).toBe(1); // E, in both views
    // A 0.5h (Limn's story check), B 1h (Limn's review), D 1h (CodeRabbit's comment).
    expect(reviewerHours(res)).toBeCloseTo(2.5, 5);
    expect(res.headline).toContain('a person or a review bot actually worked on');
  });

  it('an un-viewed read measures in the workspace’s stored view (default "People + bots")', async () => {
    const { setWorkspaceFlowView } = await import('./flow-settings.js');
    expect((await flow.getFlowCourts(1, scope, 30, { nowMs })).view).toBe('people_bots');
    await setWorkspaceFlowView(1, scope.workspaceId, 'people');
    const res = await flow.getFlowCourts(1, scope, 30, { nowMs });
    expect(res.view).toBe('people');
    expect(res.measuredPrs).toBe(2);
    await setWorkspaceFlowView(1, scope.workspaceId, null);
  });
});

describe('period reports: Limn is its own lane', () => {
  it('Limn’s approvals and comments are Limn’s, not the people’s, and never a first human review', async () => {
    const res = await period.getPeriodLanes(1, scope, { fromMs: T0 - DAY, toMs: nowMs });
    const lane = (l: string) => res.lanes.find((x) => x.lane === l)!;
    expect(lane('limn').approvals).toBe(1);
    // Limn's approval body, its comment review and its story check.
    expect(lane('limn').comments).toBe(3);
    expect(lane('human').approvals).toBe(3); // bob on A, D and E
    // E was opened by Limn: an automation-authored merge.
    expect(lane('limn').mergedPrs).toBe(1);
    expect(lane('human').mergedPrs).toBe(4);
    // A's first person was bob at 5h, D's at 2h, E's at 1h — Limn's 1h on A is not a person.
    expect(res.medianTimeToFirstHumanReviewHours).toBeCloseTo(2, 5);
  });
});
