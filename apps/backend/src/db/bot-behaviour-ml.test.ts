// The ML severity/category block of getBotBehaviourAnalytics, on a THROWAWAY sqlite DB.
//
// Two review bots touch one PR each; `ml_comment_labels` rows are seeded across two trend weeks
// with the awkward cases mixed in. What this file pins:
//   • the flat counts describe the SELECTED WINDOW while `weekly` covers the 84-day trend span —
//     a label 20 days old is invisible to the first at rolling_14 and present in the second;
//   • a label older than the span is invisible to BOTH;
//   • summaries and praise are excluded from severity (the phantom-gap rule), while categories
//     cover every non-summary row so `praise` appears as a category in its own right;
//   • the vendor's own badge is counted on its OWN denominator (`vendorDeclared`), never folded
//     into ours — most findings carry no badge and the two mixes are not comparable;
//   • ⚠ WEEK ALIGNMENT: `weekly[i].weekStart` is IDENTICAL to `trend[i].weekStart`, so the new
//     charts sit on the same x-axis as the density chart. This is the assertion that fails if
//     anyone re-derives the week arithmetic in a second place;
//   • a bot whose only label is a summary gets NO row at all (nothing to draw).
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-behaviour-ml-test.sqlite';
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
let rabbitId = 0;
let greptileId = 0;
let sourceryId = 0;
let cursorId = 0;

const DAY = 24 * 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS, so a millisecond-bearing date
// would not round-trip. Day offsets sit well inside their week so the bucket index is stable
// regardless of the tiny test→call clock drift.
const now = Math.floor(Date.now() / 1000) * 1000;
// Week index = floor((84 − daysAgo) / 7): 5 → week 11, 20 → week 9. Offsets sit MID-window on
// purpose — a label exactly `windowDays` old lands a few hundred ms outside the window the call
// computes from its own Date.now(), which is a coin-flip, not a fixture.
const IN_WINDOW = new Date(now - 5 * DAY); // inside rolling_14 AND the span
const IN_SPAN_ONLY = new Date(now - 20 * DAY); // outside rolling_14, inside rolling_30 + the span
const OUT_OF_SPAN = new Date(now - 100 * DAY); // outside both

let targetSeq = 1000; // invented target ids — nothing joins them, the unique is (account,kind,id)
function mlRow(
  userId: number,
  severity: 'nit' | 'minor' | 'major' | 'critical',
  opts: {
    at?: Date;
    isSummary?: boolean;
    categories?: string[];
    vendorSeverity?: 'nit' | 'minor' | 'major' | 'critical';
  } = {},
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
    severityProb: 0.9,
    vendorSeverity: opts.vendorSeverity ?? null,
    vendorSeverityConfidence: opts.vendorSeverity ? ('high' as const) : null,
    categories: opts.categories ?? ['correctness_bug'],
    categoryProbs: {},
    isSummary: opts.isSummary ?? false,
    backend: 'modernbert-onnx',
    modelVersion: 'test',
    bodyHash: `h${targetSeq}`,
    targetCreatedAt: opts.at ?? IN_WINDOW,
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
  await runMigrations();

  const { repos, pullRequests, users, reviews, mlCommentLabels } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_ml_beh' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_ml_beh',
      accountId: 1,
      repoId,
      number: 1,
      title: 'ml behaviour fixture',
      state: 'open',
      isDraft: false,
      additions: 100,
      deletions: 0,
      openedAt: new Date(now - 6 * DAY),
      updatedAt: new Date(now - 5 * DAY),
    })
    .returning()
    .execute();
  prId = pr.id;

  const mkBot = async (login: string, nodeId: string): Promise<number> =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: nodeId, isBot: true })
        .returning()
        .execute()
    )[0].id;
  // Three KNOWN review-bot logins (REVIEW_BOTS in sync/bot-detection.ts) — so they resolve as
  // automated reviewers with role 'review' with no workspace_reviewers rows written by hand.
  rabbitId = await mkBot('coderabbitai', 'U_ml_beh_rabbit');
  greptileId = await mkBot('greptile-apps', 'U_ml_beh_greptile');
  sourceryId = await mkBot('sourcery-ai', 'U_ml_beh_sourcery');
  // A FOURTH bot exists purely so the inflation index has a bot that declares a badge in all
  // three directions. Added as its own login rather than by badging the other fixtures, so every
  // assertion above it (greptile's "no badge at all" zero denominator in particular) still
  // describes the population it was written for.
  cursorId = await mkBot('cursor', 'U_ml_beh_cursor');

  // Each bot needs a TOUCH to appear in `bots` at all — the ML block only emits rows for bots the
  // panel already draws, because the `key` is the join.
  let rv = 0;
  for (const botId of [rabbitId, greptileId, sourceryId, cursorId])
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_ml_beh_${(rv += 1)}`,
        prId,
        authorId: botId,
        state: 'commented',
        submittedAt: new Date(now - 5 * DAY),
      })
      .execute();

  await db
    .insert(mlCommentLabels)
    .values([
      // ── coderabbitai, in-window (week 11) ──
      // A finding carrying the vendor's OWN badge, and the badge deliberately DISAGREES with ours.
      mlRow(rabbitId, 'major', { vendorSeverity: 'critical', categories: ['correctness_bug'] }),
      mlRow(rabbitId, 'nit', { categories: ['nitpick', 'style_readability'] }),
      // Praise: labelled work, NOT a finding — its severity must not be counted, its category must.
      mlRow(rabbitId, 'minor', { categories: ['praise'] }),
      // A walkthrough summary: excluded from BOTH (its categories are a read of the template).
      mlRow(rabbitId, 'critical', { isSummary: true, categories: ['security'] }),
      // ── coderabbitai, in-span but OUTSIDE rolling_14 (week 9) ──
      mlRow(rabbitId, 'minor', { at: IN_SPAN_ONLY, categories: ['testing'] }),
      // ── coderabbitai, older than the 84-day span: invisible everywhere ──
      mlRow(rabbitId, 'critical', { at: OUT_OF_SPAN, categories: ['security'] }),
      // ── greptile, in-window: two nits, no vendor badge at all ──
      mlRow(greptileId, 'nit', { categories: ['nitpick'] }),
      mlRow(greptileId, 'nit', { categories: ['documentation'] }),
      // ── sourcery: ONLY a summary — nothing to draw, so no row at all ──
      mlRow(sourceryId, 'major', { isSummary: true, categories: ['maintainability_refactor'] }),
      // ── cursor: one badged finding in EACH direction, plus the two rows that must not count ──
      mlRow(cursorId, 'minor', { vendorSeverity: 'critical' }), // the bot inflated: OVER
      mlRow(cursorId, 'major', { vendorSeverity: 'major' }), // the two agree
      mlRow(cursorId, 'major', { vendorSeverity: 'nit' }), // WE raised it: UNDER
      mlRow(cursorId, 'minor'), // badged by nobody — silence, in none of the three
      // A badged PRAISE row: a finding-only counter must not see it, so the invariant
      // `agree + over + under === vendorDeclared` is not satisfiable by counting everything.
      mlRow(cursorId, 'critical', { vendorSeverity: 'critical', categories: ['praise'] }),
    ])
    .execute();

  // ⚠ Resolve the scope through `resolveWorkspaceScope`, never by hand — that call runs
  // `ensureRepoMemberships`, which is what puts a repo inserted straight into `repos` into the
  // account's Default workspace. Without it the whole response is empty.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => closeDb?.());

const rowFor = (resp: any, key: string) =>
  resp.ml.perBot.find((r: { key: string }) => r.key === key);

describe('getBotBehaviourAnalytics — ML severity/category block', () => {
  it('counts findings-only severity over the SELECTED window', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const rabbit = rowFor(resp, `u${rabbitId}`);
    expect(rabbit).toBeDefined();
    // major + nit. The praise minor, the summary critical, the week-7 minor and the 100-day-old
    // critical are all out — for four different reasons.
    expect(rabbit.bySeverity).toEqual({ nit: 1, minor: 0, major: 1, critical: 0 });
    expect(rabbit.findings).toBe(2);
  });

  it('counts categories over every NON-SUMMARY row, so praise is a category of its own', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const counts = new Map<string, number>(
      rowFor(resp, `u${rabbitId}`).byCategory.map((c: { category: string; count: number }) => [
        c.category,
        c.count,
      ]),
    );
    expect(counts.get('praise')).toBe(1); // the praise row IS counted here, unlike in severity
    expect(counts.get('correctness_bug')).toBe(1);
    expect(counts.get('nitpick')).toBe(1);
    expect(counts.get('style_readability')).toBe(1); // multi-label: one comment, two categories
    expect(counts.has('security')).toBe(false); // the summary's category, excluded
    expect(counts.has('testing')).toBe(false); // week 9 — in the span, outside the window
  });

  it('keeps the vendor’s own badge on its own denominator, never folded into ours', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const rabbit = rowFor(resp, `u${rabbitId}`);
    // The badge says critical where our model said major. Both survive, separately.
    expect(rabbit.byVendorSeverity).toEqual({ nit: 0, minor: 0, major: 0, critical: 1 });
    expect(rabbit.vendorDeclared).toBe(1);
    expect(rabbit.bySeverity.major).toBe(1);
    expect(rabbit.bySeverity.critical).toBe(0);

    const greptile = rowFor(resp, `u${greptileId}`);
    expect(greptile.bySeverity).toEqual({ nit: 2, minor: 0, major: 0, critical: 0 });
    expect(greptile.vendorDeclared).toBe(0);
    expect(greptile.byVendorSeverity).toEqual({ nit: 0, minor: 0, major: 0, critical: 0 });
  });

  it('splits the badged findings three ways, and they PARTITION vendorDeclared', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const cursor = rowFor(resp, `u${cursorId}`);
    // One row each way. The unbadged finding is SILENCE — in `findings`, in none of the three —
    // and the badged PRAISE row is not a finding at all, so it reaches neither counter.
    expect(cursor.vendorOverCall).toBe(1); // vendor critical vs our minor — inflation
    expect(cursor.vendorAgree).toBe(1);
    expect(cursor.vendorUnderCall).toBe(1); // vendor nit vs our major — we raised it
    expect(cursor.vendorDeclared).toBe(3);
    expect(cursor.findings).toBe(4); // the three badged + the silent one; praise excluded

    // THE INVARIANT, over every row in the block — the same one SeverityAgreementMatrix keeps.
    // It is what lets a caption divide by `vendorDeclared` and be honest about the rest.
    for (const b of resp.ml.perBot) {
      expect(b.vendorAgree + b.vendorOverCall + b.vendorUnderCall).toBe(b.vendorDeclared);
      expect(b.vendorDeclared).toBeLessThanOrEqual(b.findings);
    }

    // Direction is ORDINAL, and the disagreement is the product: nothing here corrected our
    // severity towards the badge.
    expect(cursor.bySeverity).toEqual({ nit: 0, minor: 2, major: 2, critical: 0 });
    expect(cursor.byVendorSeverity).toEqual({ nit: 1, minor: 0, major: 1, critical: 1 });
  });

  it('buckets `weekly` over the whole 84-day span, on the density chart’s own weeks', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    const rabbit = rowFor(resp, `u${rabbitId}`);
    const bot = resp.bots.find((b: { key: string }) => b.key === `u${rabbitId}`);

    // ⚠ THE ALIGNMENT PIN: same length, same boundaries, same strings as the trend the density
    // chart is drawn on. A second copy of the week arithmetic breaks exactly this.
    expect(rabbit.weekly).toHaveLength(bot.trend.length);
    expect(rabbit.weekly.map((w: { weekStart: string }) => w.weekStart)).toEqual(
      bot.trend.map((p: { weekStart: string }) => p.weekStart),
    );

    // Week 11 (5 days ago): the two findings; the praise + summary still excluded.
    expect(rabbit.weekly[11].bySeverity).toEqual({ nit: 1, minor: 0, major: 1, critical: 0 });
    // Week 9 (20 days ago): present here though it is outside the selected window.
    expect(rabbit.weekly[9].bySeverity).toEqual({ nit: 0, minor: 1, major: 0, critical: 0 });
    const w9 = new Map<string, number>(
      rabbit.weekly[9].byCategory.map((c: { category: string; count: number }) => [
        c.category,
        c.count,
      ]),
    );
    expect(w9.get('testing')).toBe(1);

    // The 100-day-old critical is outside the span: 3 severity-counted rows in total, no more.
    type Counts = { nit: number; minor: number; major: number; critical: number };
    const spanTotal = rabbit.weekly.reduce(
      (n: number, w: { bySeverity: Counts }) =>
        n + w.bySeverity.nit + w.bySeverity.minor + w.bySeverity.major + w.bySeverity.critical,
      0,
    );
    expect(spanTotal).toBe(3);
  });

  it('emits no row for a bot whose only label is a summary, and reports an uncapped scan', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_14', scope);
    expect(resp.bots.some((b: { key: string }) => b.key === `u${sourceryId}`)).toBe(true);
    expect(rowFor(resp, `u${sourceryId}`)).toBeUndefined();
    // rabbit + greptile + cursor. Sourcery has a label and is still absent — that is the point.
    expect(resp.ml.perBot).toHaveLength(3);
    expect(resp.ml.truncated).toBe(false);
  });

  it('widens with the window: the 20-day-old label joins the flat counts at rolling_30', async () => {
    const resp = await q.getBotBehaviourAnalytics(1, 'rolling_30', scope);
    const rabbit = rowFor(resp, `u${rabbitId}`);
    expect(rabbit.bySeverity).toEqual({ nit: 1, minor: 1, major: 1, critical: 0 });
    expect(rabbit.findings).toBe(3);
  });
});
