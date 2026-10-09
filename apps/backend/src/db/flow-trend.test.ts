// CHRONOLOGY OVER TIME (db/flow-trend.ts) — on a THROWAWAY sqlite DB. docs/BOTTLENECKS.md § Over time.
//
// What this pins:
//   1. WEEKLY BUCKETING by MERGE week in the working time zone, half-open; a week under
//      `FLOW_TREND.thinWeekPrs` is THIN, and thin weeks never enter the lens maths.
//   2. THE BEFORE/AFTER LENS: medians of up to eight usable weeks each side (event week = after),
//      `shift` for a real step, `normal` for noise, `too_few` under four weeks a side.
//   3. FIRST APPEARANCES: the earliest across repos wins; outside the span or at the edge of the
//      stored history is not an arrival.
//   4. THE FOLD, END TO END: a bot first seen, a person first contributing, a repo joining and a
//      setting change all become markers — and ANOTHER ACCOUNT'S identical activity never does.
//   5. Settings history is recorded only on a REAL change.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load),
// and every value import below is dynamic for the same reason.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowTrendWeek } from '@pierre-review/shared';

const DB_PATH = `/tmp/pierre-flow-trend-test-${process.pid}.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
process.env.WORK_TIMEZONE = 'UTC';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DAY = 86_400_000;
const HOUR = 3_600_000;
let ft: typeof import('./flow-trend.js');
let closeDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  closeDb = client.closeDb;
  await runMigrations();
  ft = await import('./flow-trend.js');
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

/** A synthetic week whose four p75s and three shares all carry `v` (shares: v / 100). */
function week(i: number, v: number | null, prs = 10, partial = false): FlowTrendWeek {
  return {
    weekStart: `w${i}`,
    from: new Date(i * 7 * DAY).toISOString(),
    to: new Date((i + 1) * 7 * DAY).toISOString(),
    partial,
    measuredPrs: v == null ? 0 : prs,
    thin: (v == null ? 0 : prs) < 5,
    reposWithData: 1,
    reposInWorkspace: 1,
    courtsWork: (['reviewer', 'author', 'landing'] as const).map((court) => ({
      court,
      hours: 0,
      share: v == null ? 0 : v / 100,
    })),
    medianLeadWorkHours: v,
    budgets: (['firstLook', 'reply', 'land', 'lead'] as const).map((measure) => ({
      measure,
      prs: v == null ? 0 : prs,
      p50: v,
      p75: v,
      verdict: null,
    })),
  };
}

describe('the before/after lens', () => {
  it('calls a clean step a shift, and states both medians', () => {
    const weeks = [...Array.from({ length: 8 }, (_, i) => week(i, 10 + (i % 2))), ...Array.from({ length: 8 }, (_, i) => week(8 + i, 4 + (i % 2)))];
    const lens = ft.lensFor(weeks, 8);
    const lead = lens.rows.find((r) => r.measure === 'lead')!;
    expect(lead.before).toBe(10.5);
    expect(lead.after).toBe(4.5);
    expect(lead.beforeWeeks).toBe(8);
    expect(lead.afterWeeks).toBe(8);
    expect(lead.verdict).toBe('shift');
  });

  it('calls noise "normal"', () => {
    const noisy = [9, 3, 12, 5, 10, 4, 11, 6, 3, 12, 5, 9, 4, 11, 6, 10];
    const lens = ft.lensFor(noisy.map((v, i) => week(i, v)), 8);
    expect(lens.rows.find((r) => r.measure === 'lead')!.verdict).toBe('normal');
  });

  it('leaves THIN and PARTIAL weeks out, and refuses under four usable weeks a side', () => {
    const weeks = [
      week(0, 10),
      week(1, 10, 2), // thin
      week(2, 10),
      week(3, 10),
      week(4, 2),
      week(5, 2),
      week(6, 2),
      week(7, 2, 10, true), // the unfinished current week
    ];
    const row = ft.lensFor(weeks, 4).rows.find((r) => r.measure === 'firstLook')!;
    expect(row.beforeWeeks).toBe(3);
    expect(row.afterWeeks).toBe(3);
    expect(row.verdict).toBe('too_few');
  });

  it('takes at most eight usable weeks each side, nearest first', () => {
    const weeks = Array.from({ length: 26 }, (_, i) => week(i, i < 13 ? 100 + i : 1));
    const row = ft.lensFor(weeks, 13).rows.find((r) => r.measure === 'reply')!;
    expect(row.beforeWeeks).toBe(8);
    // Weeks 5..12 → 105..112, median 108.5.
    expect(row.before).toBe(108.5);
  });
});

describe('auto-detected shifts', () => {
  it('finds one step per series and labels it in plain words', () => {
    const weeks = Array.from({ length: 16 }, (_, i) => week(i, i < 8 ? 12 + (i % 2) : 3 + (i % 2)));
    const shifts = ft.shiftEvents(weeks);
    const lead = shifts.find((e) => e.measure === 'lead')!;
    expect(lead.week).toBe(8);
    expect(lead.direction).toBe('down');
    expect(lead.label).toBe('Opened to merged: three in four within 13 → 3.5 working hours');
    // Exactly one per measure.
    expect(shifts.filter((e) => e.measure === 'lead')).toHaveLength(1);
  });

  it('claims nothing on a flat series', () => {
    expect(ft.shiftEvents(Array.from({ length: 16 }, (_, i) => week(i, 5)))).toEqual([]);
  });
});

describe('first appearances', () => {
  const floors = new Map([
    [1, 0],
    [2, 50 * DAY],
  ]);
  it('keeps the earliest across repos, inside the span, past the history edge', () => {
    const out = ft.firstAppearances(
      [
        { userId: 7, repoId: 1, atMs: 100 * DAY },
        { userId: 7, repoId: 2, atMs: 90 * DAY }, // earlier, in repo 2 — wins
        { userId: 8, repoId: 2, atMs: 55 * DAY }, // 5 days after repo 2's floor: our records starting
        { userId: 9, repoId: 1, atMs: 10 * DAY }, // before the span
        { userId: 10, repoId: 1, atMs: 120 * DAY },
      ],
      floors,
      14 * DAY,
      30 * DAY,
      200 * DAY,
    );
    expect(out.map((a) => [a.userId, a.repoId, a.atMs / DAY])).toEqual([
      [7, 2, 90],
      [10, 1, 120],
    ]);
  });
  it('an actor whose first-ever appearance predates the span is never new, however active later', () => {
    const out = ft.firstAppearances(
      [
        { userId: 9, repoId: 1, atMs: 10 * DAY },
        { userId: 9, repoId: 1, atMs: 150 * DAY },
      ],
      floors,
      0,
      30 * DAY,
      200 * DAY,
    );
    expect(out).toEqual([]);
  });
});

describe('weekly bucketing', () => {
  it('buckets by MERGE week, half-open', () => {
    const weeks = [
      { startMs: 0, endMs: 7 * DAY },
      { startMs: 7 * DAY, endMs: 14 * DAY },
    ];
    const rows = [0, 7 * DAY - 1, 7 * DAY, 14 * DAY].map((m) => ({ pr: { mergedMs: m } }));
    const b = ft.bucketByMergeWeek(weeks, rows);
    expect(b[0]).toHaveLength(2);
    expect(b[1]).toHaveLength(1); // 14 days is the NEXT week, outside the span
  });
});

describe('getFlowTrend, end to end', () => {
  it('derives bucketed weeks, markers, a lens per marked week, and keeps tenants apart', async () => {
    const client = await import('./client.js');
    const { db, schema } = client;
    const q: any = await import('./queries.js');
    const { setWorkspaceFlowSettings } = await import('./flow-settings.js');
    const { localWeeksEndingAt } = await import('./working-hours.js');
    const nowMs = Date.now();
    const weeks = localWeeksEndingAt(nowMs, 'UTC', 26);

    await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_ft_b', githubLogin: 'ft-b', isLocal: false }).execute();
    const ws1 = await q.ensureDefaultWorkspace(1);
    const ws2 = await q.ensureDefaultWorkspace(2);

    const [alice0] = await db.insert(schema.users).values({ githubLogin: 'ft-alice' }).returning().execute();
    const alice = alice0!;
    const [bob0] = await db.insert(schema.users).values({ githubLogin: 'ft-bob' }).returning().execute();
    const bob = bob0!;
    const [carol0] = await db.insert(schema.users).values({ githubLogin: 'ft-carol' }).returning().execute();
    const carol = carol0!;
    const [rabbit0] = await db
      .insert(schema.users)
      .values({ githubLogin: 'coderabbitai[bot]', isBot: true })
      .returning()
      .execute();
    const rabbit = rabbit0!;

    const addedAt = new Date(nowMs - 400 * DAY);
    const [r10] = await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'one', githubNodeId: 'R_ft_1', createdAt: addedAt })
      .returning()
      .execute();
    const r1 = r10!;
    const [r20] = await db
      .insert(schema.repos)
      .values({ accountId: 2, owner: 'other', name: 'two', githubNodeId: 'R_ft_2', createdAt: addedAt })
      .returning()
      .execute();
    const r2 = r20!;
    await q.assignReposToWorkspace(ws1, 1, [r1.id]);
    await q.assignReposToWorkspace(ws2, 2, [r2.id]);
    // Repo one joined workspace 1 forty days ago; repo two long before the span.
    const joined = nowMs - 40 * DAY;
    const { eq } = await import('drizzle-orm');
    await db.update(schema.workspaceRepos).set({ createdAt: new Date(joined) }).where(eq(schema.workspaceRepos.repoId, r1.id)).execute();
    await db.update(schema.workspaceRepos).set({ createdAt: addedAt }).where(eq(schema.workspaceRepos.repoId, r2.id)).execute();

    // Six merged PRs in week 20 (by alice, reviewed by bob), two in week 22 (thin).
    let n = 0;
    const mergedPr = async (accountId: number, repoId: number, openedMs: number, reviewer: number) => {
      n += 1;
      const [pr0] = await db
        .insert(schema.pullRequests)
        .values({
          githubNodeId: `PR_ft_${n}`,
          accountId,
          repoId,
          number: n,
          title: `PR ${n}`,
          state: 'merged',
          isDraft: false,
          authorId: alice.id,
          openedAt: new Date(openedMs),
          mergedAt: new Date(openedMs + 4 * HOUR),
          updatedAt: new Date(openedMs + 4 * HOUR),
        })
        .returning()
        .execute();
    const pr = pr0!;
      await db
        .insert(schema.reviews)
        .values({
          githubNodeId: `RV_ft_${n}`,
          prId: pr.id,
          authorId: reviewer,
          state: 'approved',
          submittedAt: new Date(openedMs + 2 * HOUR),
        })
        .execute();
      return pr.id as number;
    };
    // Tuesday 10:00 UTC of the given week.
    const tue = (w: number) => (weeks[w] as { startMs: number }).startMs + DAY + 10 * HOUR;
    const prIds: number[] = [];
    for (let i = 0; i < 6; i += 1) prIds.push(await mergedPr(1, r1.id, tue(20) + i * 60_000, bob.id));
    for (let i = 0; i < 2; i += 1) await mergedPr(1, r1.id, tue(22) + i * 60_000, bob.id);
    // Alice authored long before the span — she is not new. Bob's first review is in week 20.
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_ft_old',
        accountId: 1,
        repoId: r1.id,
        number: 999,
        title: 'old',
        state: 'merged',
        isDraft: false,
        authorId: alice.id,
        openedAt: new Date(nowMs - 380 * DAY),
        mergedAt: new Date(nowMs - 379 * DAY),
        updatedAt: new Date(nowMs - 1 * DAY),
      })
      .execute();
    // Dave only OPENED a pull request (never merged): a drive-by, not a contributor.
    const [dave0] = await db.insert(schema.users).values({ githubLogin: 'ft-dave' }).returning().execute();
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_ft_dave',
        accountId: 1,
        repoId: r1.id,
        number: 998,
        title: 'drive-by',
        state: 'open',
        isDraft: false,
        authorId: dave0!.id,
        openedAt: new Date(tue(21)),
        updatedAt: new Date(tue(21)),
      })
      .execute();
    // The bot first comments in week 21 in account 1; account 2 saw it, and carol, in week 18.
    await db
      .insert(schema.events)
      .values({
        accountId: 1,
        repoId: r1.id,
        actorId: rabbit.id,
        prId: prIds[0],
        type: 'review_comment',
        occurredAt: new Date(tue(21)),
        dedupeKey: 'ft:rabbit:1',
      })
      .execute();
    const otherPr = await mergedPr(2, r2.id, tue(18), carol.id);
    await db
      .insert(schema.events)
      .values({
        accountId: 2,
        repoId: r2.id,
        actorId: rabbit.id,
        prId: otherPr,
        type: 'review_comment',
        occurredAt: new Date(tue(18)),
        dedupeKey: 'ft:rabbit:2',
      })
      .execute();

    // A real settings change is recorded once; saving the same again records nothing.
    await setWorkspaceFlowSettings(1, ws1, { budgets: { firstLook: { good: 2 } } });
    await setWorkspaceFlowSettings(1, ws1, { budgets: { firstLook: { good: 2 } } });
    await setWorkspaceFlowSettings(2, ws2, { days: [1, 2, 3, 4] });

    const scope = await q.resolveWorkspaceScope(1, String(ws1));
    const res = await ft.getFlowTrend(1, scope, { nowMs });

    expect(res.workspaceId).toBe(ws1);
    expect(res.weeks).toHaveLength(26);
    expect(res.weeks[25]!.partial).toBe(true);
    expect(res.weeks[20]!.measuredPrs).toBe(6);
    expect(res.weeks[20]!.thin).toBe(false);
    expect(res.weeks[20]!.reposWithData).toBe(1);
    expect(res.weeks[22]!.measuredPrs).toBe(2);
    expect(res.weeks[22]!.thin).toBe(true);
    // The reviewer looked after 2h and approved: two working hours in reviewer court, then landing.
    const lead = res.weeks[20]!.budgets.find((b) => b.measure === 'lead')!;
    expect(lead.p75).toBe(4);
    expect(res.weeks[20]!.courtsWork.find((c) => c.court === 'reviewer')!.share).toBe(0.5);
    // Membership by week's end: before the join, nothing; after, one.
    expect(res.weeks[10]!.reposInWorkspace).toBe(0);
    expect(res.weeks[25]!.reposInWorkspace).toBe(1);

    const kinds = (k: string) => res.events.filter((e) => e.kind === k);
    expect(kinds('bot').map((e) => [e.login, e.week, e.vendorKind])).toEqual([['coderabbitai', 21, 'coderabbit']]);
    expect(kinds('contributor').map((e) => [e.login, e.week])).toEqual([['ft-bob', 20]]);
    expect(kinds('repo').map((e) => e.repoFullName)).toEqual(['acme/one']);
    expect(kinds('setting').map((e) => [e.settingKind, e.label])).toEqual([['flow_settings', 'Wait budgets changed']]);
    expect(res.settingsHistoryFrom).not.toBeNull();
    // Nothing of account 2's leaks in: carol, its repo, its settings change.
    expect(JSON.stringify(res)).not.toContain('ft-carol');
    expect(JSON.stringify(res)).not.toContain('other/two');
    expect(kinds('setting')).toHaveLength(1);
    // A lens for every marked week.
    for (const e of res.events) expect(res.lenses.some((l) => l.week === e.week)).toBe(true);
    // Current budgets echoed — the change above is in force.
    expect(res.budgets.firstLook.good).toBe(2);

    // The cache serves completed weeks identically.
    const again = await ft.getFlowTrend(1, scope, { nowMs });
    expect(again.weeks.slice(0, 25)).toEqual(res.weeks.slice(0, 25));
  });
});
