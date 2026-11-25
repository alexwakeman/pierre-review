// THE AI ADOPTION REPORT FOLD (db/adoption-report.ts; docs/AI-ADOPTION-REPORT.md § The report) and
// HUMAN REVIEW COVERAGE (db/human-review-coverage.ts). Throwaway sqlite, no GitHub, no model.
//
// What this pins:
//   1. The ONE reporting window: after = the trailing window up to now, before = the equal span before
//      it, trend periods step back whole window lengths (the last one is the after window).
//   2. The adoption population: people's PRs (an Ensemble-opened PR is the person's), plus PRs an AI
//      coding agent opened; dependency bots are left out and counted.
//   3. Vendors and sources from the stored signals; Ensemble's own pushes count as Ensemble.
//   4. How widely AI is used: counts of people only, never a name; 1 or 2 people withheld 'few_people'.
//   5. Human review coverage: a person's approval before the merge counts; Ensemble's (`limn:`), a
//      bot's, a dismissed-before-merge and an after-merge approval do not; a manual "this is a
//      person" judgement does.
//   6. Detection below 90% withholds the AI figures and the per-tool people counts, never a zero.
//   7. AI off ⇒ the spend is withheld `ai_off`; the Ensemble review row is the 'pierre' rows summed.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_SIGNALS_VERSION, type AiAdoptionReport, type BotAnalyticsResponse, type BotVendorAnalytics } from '@pierre-review/shared';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-adoption-report-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let fold: typeof import('./adoption-report.js');
let ws = 0;
let repoId = 0;
const U: Record<string, number> = {};
const P: Record<string, number> = {};

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');
const v1 = { aiSignalsVersion: AI_SIGNALS_VERSION, aiSignalsCheckedAt: new Date(NOW - 30 * DAY) };
let n = 0;

async function mkPr(author: string, mergedDaysAgo: number, signals: unknown[] = [], over: Record<string, unknown> = {}): Promise<number> {
  n += 1;
  const mergedAt = new Date(NOW - mergedDaysAgo * DAY);
  const [pr] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_adopt_${n}`,
      accountId: 1,
      repoId,
      number: n,
      title: `pr ${n}`,
      state: 'merged',
      isDraft: false,
      authorId: U[author],
      openedAt: new Date(mergedAt.getTime() - DAY),
      updatedAt: mergedAt,
      mergedAt,
      additions: 40,
      deletions: 10,
      changedFiles: 2,
      ciStatus: 'success',
      aiSignals: JSON.stringify(signals),
      ...v1,
      ...over,
    })
    .returning()
    .execute();
  return pr.id;
}

async function approve(prId: number, by: string, submittedAt: Date, over: Record<string, unknown> = {}): Promise<void> {
  await db
    .insert(schema.reviews)
    .values({ githubNodeId: `RV_${prId}_${by}_${submittedAt.getTime()}`, prId, authorId: U[by], state: 'approved', submittedAt, ...over })
    .execute();
}

const mergedAtOf = async (prId: number): Promise<Date> =>
  (await db.select({ m: schema.pullRequests.mergedAt }).from(schema.pullRequests).where((await import('drizzle-orm')).eq(schema.pullRequests.id, prId)).execute())[0].m;

let report: AiAdoptionReport;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('./queries.js');
  const have = new Set((await db.select().from(schema.accounts).execute()).map((a: any) => a.id));
  if (!have.has(1)) await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_adopt', githubLogin: 'adopt', isLocal: true }).execute();
  ws = await q.ensureDefaultWorkspace(1);
  repoId = (
    await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_adopt_api', createdAt: new Date('2026-01-01T00:00:00Z') })
      .returning()
      .execute()
  )[0].id;
  const mkUser = async (key: string, login: string, isBot: boolean, displayName: string | null = null) => {
    U[key] = (await db.insert(schema.users).values({ githubLogin: login, isBot, displayName }).returning().execute())[0].id;
  };
  await mkUser('alice', 'alice', false, 'alice Smith');
  await mkUser('bob', 'bob', false, 'Bob');
  await mkUser('zed', 'zed', false, 'Aaron Zed');
  await mkUser('dep', 'dependabot[bot]', true);
  await mkUser('copilot', 'copilot-swe-agent[bot]', true);
  await mkUser('limnAlice', 'limn:alice', true);
  await mkUser('limnBob', 'limn:bob', true);
  await mkUser('rabbit', 'coderabbitai[bot]', true);
  await mkUser('vouched', 'buildmaster', true);
  await q.resolveWorkspaceScope(1, ws); // homes the repo
  await db
    .insert(schema.workspaceReviewers)
    .values({ accountId: 1, workspaceId: ws, authorUserId: U.vouched, automated: false, role: 'review', confidence: 'high', source: 'manual', identitySource: 'auto', kind: null })
    .execute();

  const claudePr = [{ vendor: 'claude', source: 'pr_body' }];
  // ── After window [NOW-14d, NOW) ──
  P.a1 = await mkPr('alice', 5, claudePr);
  P.a2 = await mkPr('alice', 5, claudePr);
  P.a3 = await mkPr('alice', 5);
  await db.insert(schema.commits).values({ prId: P.a3, sha: 'a3c', committedAt: new Date(NOW - 6 * DAY), aiSignals: JSON.stringify([{ vendor: 'cursor', source: 'commit_trailer' }]) }).execute();
  P.a4 = await mkPr('alice', 5);
  // Ensemble opened it for alice (Implement / AI Fix on a new branch): alice's PR, Ensemble's work.
  P.a5 = await mkPr('limnAlice', 4, [], { limnOpenedForUserId: U.alice });
  await db.insert(schema.aiFixes).values({ accountId: 1, repoId, prId: P.a5, baseSha: 'b', status: 'done', model: 'm', seed: 'review', pushedAt: new Date(NOW - 4 * DAY) }).execute();
  P.b1 = await mkPr('bob', 3, claudePr);
  P.b2 = await mkPr('bob', 3);
  P.b3 = await mkPr('bob', 3);
  P.z1 = await mkPr('zed', 2);
  P.agent = await mkPr('copilot', 2, [{ vendor: 'copilot', source: 'pr_author' }]);
  P.dep1 = await mkPr('dep', 1);
  P.dep2 = await mkPr('dep', 1);
  // ── Before window [NOW-28d, NOW-14d) ──
  for (let i = 0; i < 3; i++) await mkPr('alice', 20);
  await mkPr('bob', 20, claudePr);
  await mkPr('bob', 20);
  await mkPr('bob', 20);
  await mkPr('zed', 20);
  // ── Approvals (after window) ──
  const before = async (id: number, h = 2) => new Date((await mergedAtOf(id)).getTime() - h * 3_600_000);
  await approve(P.a1, 'bob', await before(P.a1)); // a person: counts
  await approve(P.a2, 'limnBob', await before(P.a2)); // Ensemble's approval: does not count
  await approve(P.a3, 'rabbit', await before(P.a3)); // a bot's: does not count
  await approve(P.a4, 'vouched', await before(P.a4)); // a manual "this is a person": counts
  await approve(P.b1, 'alice', await before(P.b1, 5), { dismissedAt: await before(P.b1, 1) }); // dismissed before the merge
  await approve(P.b2, 'alice', new Date((await mergedAtOf(P.b2)).getTime() + 3_600_000)); // after the merge
  // A setting change inside the trend range.
  await db.insert(schema.workspaceSettingEvents).values({ accountId: 1, workspaceId: ws, kind: 'auto_review', summary: 'Auto review switched on', occurredAt: new Date(NOW - 10 * DAY) }).execute();

  fold = await import('./adoption-report.js');
  report = await fold.buildAiAdoptionReport(1, ws, NOW, { aiEnabled: false });
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the windows', () => {
  it('after = the trailing window to now, before = the equal span before it', () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.workspaceId).toBe(ws);
    expect(report.generatedAt).toBe(new Date(NOW).toISOString());
    expect(report.after).toEqual({ from: new Date(NOW - 14 * DAY).toISOString(), to: new Date(NOW).toISOString(), days: 14 });
    expect(report.before).toEqual({ from: new Date(NOW - 28 * DAY).toISOString(), to: new Date(NOW - 14 * DAY).toISOString(), days: 14 });
    expect(report.repos).toEqual({ measured: 1, total: 1 });
  });

  it('trend periods step back whole window lengths, the last one the after window', () => {
    const ps = report.adoption.periods;
    expect(ps).toHaveLength(6); // 12 weeks / 14 days
    expect(ps.at(-1)!.from).toBe(report.after.from);
    expect(ps.at(-2)!.from).toBe(report.before.from);
    expect(ps[0]!.from).toBe(new Date(NOW - 6 * 14 * DAY).toISOString());
    const w = fold.trendWindows({ fromMs: 0, toMs: 7 * DAY, mode: 'rolling_7' }, 3 * DAY);
    expect(w).toHaveLength(12);
    expect(w.at(-1)).toEqual({ fromMs: 0, toMs: 3 * DAY, partial: true });
    expect(fold.trendWindows({ fromMs: 0, toMs: 60 * DAY, mode: 'sprint' }, 60 * DAY)).toHaveLength(2);
  });

  it('an unknown workspace resolves to Default, never a 404', async () => {
    const r = await fold.buildAiAdoptionReport(1, 'nope', NOW, { aiEnabled: false });
    expect(r.workspaceId).toBe(ws);
    expect((await fold.buildAiAdoptionReport(1, 99_999, NOW, { aiEnabled: false })).workspaceId).toBe(ws);
  });

  it('marks dated setting changes', () => {
    expect(report.markers).toEqual([{ at: new Date(NOW - 10 * DAY).toISOString(), kind: 'auto_review', summary: 'Auto review switched on' }]);
    expect(report.settingHistoryFrom).toBe(new Date(NOW - 10 * DAY).toISOString());
  });
});

describe('adoption', () => {
  it('counts people and agent PRs, leaves dependency bots out', () => {
    const last = report.adoption.periods.at(-1)!;
    expect(last.mergedPrs).toBe(10);
    expect(last.aiPrs).toBe(6);
    expect(last.share).toEqual({ available: true, value: 60, unit: 'pct', sampleSize: 10 });
    expect(last.byVendor).toEqual({ claude: 3, cursor: 1, copilot: 1, ensemble: 1 });
    expect(report.adoption.otherAutomationPrs).toBe(2);
    expect(report.adoption.aiShare.before).toMatchObject({ available: true, value: 14.29, sampleSize: 7 });
    expect(report.adoption.aiShare.significant).toBe(true);
  });

  it('per vendor: before / after / share / people, in vendor order', () => {
    expect(report.adoption.vendors.map((v) => v.vendor)).toEqual(['claude', 'copilot', 'cursor', 'ensemble']);
    const claude = report.adoption.vendors[0]!;
    expect(claude.before).toMatchObject({ available: true, value: 1 });
    expect(claude.after).toMatchObject({ available: true, value: 3 });
    expect(claude.afterShare).toMatchObject({ available: true, value: 30 });
  });

  it('says where adoption was seen', () => {
    const by = Object.fromEntries(report.adoption.sources.map((s) => [s.source, s.prs]));
    expect(by).toMatchObject({ pr_body: 3, commit_trailer: 1, pr_author: 1, ensemble: 1, pr_title: 0 });
  });

  it('states detection coverage and the backfill horizon', () => {
    expect(report.detection).toMatchObject({ scannedPrs: 17, totalPrs: 17, scannedPct: 100, complete: true, detectorVersion: AI_SIGNALS_VERSION });
    expect(report.detection.coversFrom).toBe(new Date(NOW - 30 * DAY - 90 * DAY).toISOString());
  });
});

describe('how widely AI is used', () => {
  it('names nobody: no name or login anywhere in the report', () => {
    const wire = JSON.stringify(report);
    for (const n of ['Aaron', 'alice', 'Smith', '"Bob"', '"bob"', 'zed', 'limn:']) expect(wire).not.toContain(n);
  });

  it('withholds a count of 1 or 2 people, and the share it could be worked back from', () => {
    // 3 people merged PRs this period; 2 of them used AI, 1 before: both under minPeople.
    expect(report.people.peopleWithMergedPrs).toBe(3);
    expect(report.people.peopleUsingAi.after).toEqual({ available: false, unit: 'count', sampleSize: 3, reason: 'few_people' });
    expect(report.people.peopleUsingAi.before).toMatchObject({ available: false, reason: 'few_people' });
    expect(report.people.peopleUsingAi.significant).toBe(false);
    expect(report.people.peopleShare).toMatchObject({ available: false, unit: 'pct', reason: 'few_people' });
    expect(report.people.periods.at(-1)).toMatchObject({ people: 3, usingAi: { available: false, reason: 'few_people' }, share: { available: false, reason: 'few_people' } });
  });

  it('per tool: people and share of merged PRs, in vendor order; agent PRs name nobody', () => {
    expect(report.people.vendors.map((v) => v.vendor)).toEqual(['claude', 'copilot', 'cursor', 'ensemble']);
    const claude = report.people.vendors[0]!;
    expect(claude.people).toMatchObject({ available: false, reason: 'few_people' });
    expect(claude.prShare).toMatchObject({ available: true, value: 30 });
    // The agent PR has no person: nobody used Copilot, and zero is stated.
    expect(report.people.vendors[1]!.people).toEqual({ available: true, value: 0, unit: 'count', sampleSize: 3 });
    expect(report.people.agentPrs).toEqual({ mergedPrs: 1, byVendor: { copilot: 1 } });
    expect(report.people.withheld).toBeNull();
  });

  it('states 0 and 3 or more people; withholds 1 and 2', () => {
    const { peopleCountFigure: c, peopleShareFigure: sh } = fold;
    expect(c(0, 5, true)).toMatchObject({ available: true, value: 0 });
    expect(c(1, 5, true)).toMatchObject({ available: false, reason: 'few_people', sampleSize: 5 });
    expect(c(2, 5, true)).toMatchObject({ available: false, reason: 'few_people' });
    expect(c(3, 5, true)).toMatchObject({ available: true, value: 3, sampleSize: 5 });
    expect(c(3, 5, false)).toMatchObject({ available: false, reason: 'detection_incomplete' });
    expect(c(0, 0, true)).toMatchObject({ available: false, reason: 'no_data' });
    expect(sh(3, 4, true)).toMatchObject({ available: true, value: 75, unit: 'pct' });
    expect(sh(2, 4, true)).toMatchObject({ available: false, reason: 'few_people', unit: 'pct' });
  });
});

describe('detection below the floor', () => {
  it('withholds the AI figures and the people table, never a zero', async () => {
    const { eq } = await import('drizzle-orm');
    for (const id of [P.a1, P.b2]) await db.update(schema.pullRequests).set({ aiSignalsVersion: null }).where(eq(schema.pullRequests.id, id)).execute();
    const r = await fold.buildAiAdoptionReport(1, ws, NOW, { aiEnabled: false });
    expect(r.detection.complete).toBe(false);
    expect(r.adoption.aiShare.after).toMatchObject({ available: false, reason: 'detection_incomplete', sampleSize: 10 });
    expect(r.adoption.periods.at(-1)!.share).toMatchObject({ available: false, reason: 'detection_incomplete' });
    expect(r.people.withheld).toBe('detection_incomplete');
    expect(r.people.vendors).toEqual([]);
    expect(r.delivery.aiVsOther).toBeNull();
    expect(r.guardrails.comparisons[3]!.after).toMatchObject({ available: false, reason: 'detection_incomplete' });
    // Figures that do not depend on detection are still shown.
    expect(r.guardrails.comparisons[2]!.after).toMatchObject({ available: true });
  });
});
