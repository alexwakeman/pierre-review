// getBotFlaggingComments — the "What the bots are flagging" drill-down, on a THROWAWAY sqlite DB.
//
// THE CONTRACT THIS FILE EXISTS FOR: the drill-down's `total` IS the tile's number, not a second
// count that happens to agree. Both sides run the same windowed label scan and then the same
// `foldMlLabelRow`, so what has to be pinned is the equality itself — every assertion below that
// compares a selector's `total` to a field of `getBotAnalytics(...).ml` is checking that the two
// have not drifted, and would fail the moment either side re-spells the fold or the scan.
//
// The three things that break this feature, each pinned:
//  • THE VENDOR BADGE MOVING A SELECTOR. `vendorSeverity` is materially LESS accurate than ours
//    (0.474 exact vs 0.700 on the adjudicated gold-300) and may appear ONLY in the matrix, in
//    `refine`, and in display. A row we call `nit` that CodeRabbit called `critical` must stay in
//    the Nits tile, stay OUT of the High-severity tile, and show up in the matrix as an over-call.
//  • THE FOLD'S ORDER. `isSummary` is tested BEFORE praise, so a praise-flavoured walkthrough is a
//    SUMMARY here — the opposite of the client's `pillOf` display helper, deliberately. And
//    `bySeverity`/`byCategory` are incremented only inside the finding branch, so the severity and
//    category selectors must gate on `bucket === 'finding'` or they overshoot their tiles.
//  • PAGINATION. The offset is a JS slice over the folded population behind an opaque cursor, so a
//    cursor walk must be exhaustive and duplicate-free rather than merely terminate.
//
// ⚠ Its OWN database file, deliberately not an extension of bot-analytics-ml.test.ts: that
// fixture is order-dependent and its expected numbers are exact, so a row added there for this
// feature would silently move counts a dozen assertions away.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-flagging-test.sqlite';
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
let crId = 0;
let grId = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;

const NO_REFINE = { cell: null, disagree: null, authorUserIds: null };
const SEVERITY_KEYS = ['nit', 'minor', 'major', 'critical'];

// One fixture row = one real parent comment + its label. The parent is REAL (not an invented
// target id) because the page-hydration half of this getter is exactly where a drill-down stops
// matching its tile: an orphan label is counted in `total` but dropped from `items`, so a fixture
// of invented ids would make the pagination assertions below pass while hydrating nothing.
interface Spec {
  key: string;
  author: 'cr' | 'gr';
  // `string`, not MlSeverity: one row is deliberately OFF the enum (the column has no CHECK
  // constraint in either dialect — the drizzle `enum` is a compile-time nicety).
  severity: string;
  isSummary?: boolean;
  categories?: string[];
  /** The bot's OWN declared badge. Never an input to any selector — see the invariant test. */
  vendor?: 'nit' | 'minor' | 'major' | 'critical';
  /** `targetId` lives in three id spaces; two rows exercise the other two. */
  target?: 'review_comment' | 'pr_comment' | 'review';
  /** Days back. Default 0 = inside every window. */
  ageDays?: number;
}

// Newest first in this list — each row is seeded one hour older than the one above it, so the
// scan's `ORDER BY target_created_at DESC, id DESC` reproduces this order exactly and the
// pagination walk below has a total order to be exhaustive over.
const SPECS: Spec[] = [
  // ── coderabbit findings ──────────────────────────────────────────────────────────────────
  // THE INVARIANT ROW: we say nit, the bot's own badge says critical.
  { key: 'nit_vendor_critical', author: 'cr', severity: 'nit', vendor: 'critical' },
  { key: 'nit_2', author: 'cr', severity: 'nit' },
  { key: 'nit_3', author: 'cr', severity: 'nit' },
  { key: 'nit_4', author: 'cr', severity: 'nit' },
  { key: 'nit_5', author: 'cr', severity: 'nit' },
  { key: 'nit_6', author: 'cr', severity: 'nit' },
  // Multi-label: these count under BOTH categories, once each.
  { key: 'minor_1', author: 'cr', severity: 'minor', categories: ['style_readability', 'nitpick'] },
  { key: 'minor_2', author: 'cr', severity: 'minor', categories: ['style_readability', 'nitpick'] },
  { key: 'minor_3', author: 'cr', severity: 'minor', categories: ['style_readability', 'nitpick'] },
  { key: 'major_1', author: 'cr', severity: 'major', categories: ['correctness_bug'] },
  // A PR-level comment: no thread, so path/line/threadId/derivedState are all null on the card.
  {
    key: 'major_2_pr_comment',
    author: 'cr',
    severity: 'major',
    categories: ['correctness_bug'],
    target: 'pr_comment',
  },
  // A review BODY. Its hydration carries the `trim(body) <> ''` predicate the candidate query
  // applies, so the two corpora are provably the same rows.
  {
    key: 'critical_1_review',
    author: 'cr',
    severity: 'critical',
    categories: ['security'],
    target: 'review',
  },
  // ── coderabbit non-findings ──────────────────────────────────────────────────────────────
  // A praise-flavoured WALKTHROUGH. isSummary wins, so this is a summary and never a finding.
  {
    key: 'summary_praise',
    author: 'cr',
    severity: 'minor',
    isSummary: true,
    categories: ['praise'],
  },
  {
    key: 'summary_docs',
    author: 'cr',
    severity: 'major',
    isSummary: true,
    categories: ['documentation'],
  },
  { key: 'praise_1', author: 'cr', severity: 'nit', categories: ['praise'] },
  // ── the two rows that must be invisible ──────────────────────────────────────────────────
  // Severity off the enum: counted in `labelled` (the raw scan length) and in nothing else.
  { key: 'uncoercible', author: 'cr', severity: 'blocker' },
  // 20 days back: outside rolling_14, INSIDE rolling_30 — so the window is proved to be applied
  // rather than the row proved to be broken.
  { key: 'stale_nit', author: 'cr', severity: 'nit', ageDays: 20 },
  // ── greptile ─────────────────────────────────────────────────────────────────────────────
  { key: 'gr_nit_agree_1', author: 'gr', severity: 'nit', vendor: 'nit' },
  { key: 'gr_nit_agree_2', author: 'gr', severity: 'nit', vendor: 'nit' },
  // The bot called it MILDER than we did — the under-call direction.
  {
    key: 'gr_major_under',
    author: 'gr',
    severity: 'major',
    categories: ['correctness_bug'],
    vendor: 'minor',
  },
];

/** targetKind:targetId of every seeded row, by fixture key. */
const ids = new Map<string, { targetKind: string; targetId: number }>();
const idOf = (key: string) => ids.get(key)!;
const keyOf = (c: { targetKind: string; targetId: number }) => `${c.targetKind}:${c.targetId}`;

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

  const { repos, pullRequests, users, reviewThreads, reviewComments, prComments, reviews } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_flag' })
    .returning()
    .execute();
  repoId = repo.id;
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_flag',
      accountId: 1,
      repoId,
      number: 1,
      title: 'flagging fixture',
      state: 'open',
      isDraft: false,
      openedAt: new Date(now - 25 * DAY),
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
  // Both are KNOWN VENDOR LOGINS, so they are automated by the login seed alone — no
  // workspace_reviewers row (and therefore no footprint requirement) is involved.
  crId = await mkUser('coderabbitai', 'U_flag_cr');
  grId = await mkUser('greptile-apps', 'U_flag_gr');

  // Two threads so both a fresh and an addressed thread's context rides through onto the cards.
  const mkThread = async (
    nodeId: string,
    path: string,
    line: number,
    owner: number,
    derivedState: string,
  ) =>
    (
      await db
        .insert(reviewThreads)
        .values({
          githubNodeId: nodeId,
          prId,
          path,
          line,
          isResolved: false,
          isOutdated: false,
          derivedState,
          originalCommenterId: owner,
          createdAt: new Date(now - 3 * HOUR),
        })
        .returning()
        .execute()
    )[0].id;
  const threadCr = await mkThread('T_flag_cr', 'src/flag.ts', 7, crId, 'untouched');
  const threadGr = await mkThread('T_flag_gr', 'src/other.ts', 21, grId, 'likely_addressed');

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);

  const labelRows: any[] = [];
  for (const [i, spec] of SPECS.entries()) {
    const authorId = spec.author === 'cr' ? crId : grId;
    // One hour apart, newest first, so the scan order IS the SPECS order.
    const at = new Date(now - (spec.ageDays ?? 0) * DAY - (i + 1) * HOUR);
    const target = spec.target ?? 'review_comment';
    let targetId = 0;
    if (target === 'review_comment') {
      targetId = (
        await db
          .insert(reviewComments)
          .values({
            githubNodeId: `RC_${spec.key}`,
            threadId: spec.author === 'cr' ? threadCr : threadGr,
            prId,
            authorId,
            body: `inline finding: ${spec.key}`,
            createdAt: at,
          })
          .returning()
          .execute()
      )[0].id;
    } else if (target === 'pr_comment') {
      targetId = (
        await db
          .insert(prComments)
          .values({
            githubNodeId: `PC_${spec.key}`,
            prId,
            authorId,
            body: `pr-level remark: ${spec.key}`,
            createdAt: at,
          })
          .returning()
          .execute()
      )[0].id;
    } else {
      targetId = (
        await db
          .insert(reviews)
          .values({
            githubNodeId: `RV_${spec.key}`,
            prId,
            authorId,
            state: 'commented',
            body: `review body: ${spec.key}`,
            submittedAt: at,
          })
          .returning()
          .execute()
      )[0].id;
    }
    ids.set(spec.key, { targetKind: target, targetId });
    labelRows.push({
      accountId: 1,
      repoId,
      prId,
      targetKind: target,
      targetId,
      authorUserId: authorId,
      severity: spec.severity,
      severityOrd: Math.max(0, SEVERITY_KEYS.indexOf(spec.severity)),
      severityProb: 0.8,
      categories: spec.categories ?? ['nitpick'],
      categoryProbs: {},
      isSummary: spec.isSummary ?? false,
      ...(spec.vendor ? { vendorSeverity: spec.vendor, vendorSeverityConfidence: 'high' } : {}),
      backend: 'modernbert-onnx',
      modelVersion: 'test',
      bodyHash: `h_${spec.key}`,
      // The label's window column is a COPY of the parent's createdAt, exactly as the worker
      // stores it — so "ordered by target_created_at" and "ordered by the card's createdAt" are
      // the same order and the pagination assertion means something.
      targetCreatedAt: at,
    });
  }
  await db.insert(schema.mlCommentLabels).values(labelRows).execute();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

/** One page. The getter takes an offset because the route owns the opaque-cursor decoding. */
async function page(
  selector: any,
  opts: { window?: string; sc?: any; refine?: any; offset?: number; limit?: number } = {},
): Promise<any> {
  return ml.getBotFlaggingComments(
    1,
    selector,
    opts.refine ?? NO_REFINE,
    opts.window ?? 'rolling_14',
    opts.sc ?? scope,
    { offset: opts.offset ?? 0, limit: opts.limit ?? 50 },
  );
}

/** Walk `nextCursor` to exhaustion, decoding it the way the route does. */
async function walk(
  selector: any,
  opts: { window?: string; sc?: any; refine?: any; limit?: number } = {},
): Promise<any[]> {
  const pages: any[] = [];
  let offset = 0;
  for (;;) {
    const p = await page(selector, { ...opts, offset });
    pages.push(p);
    if (!p.nextCursor) break;
    const m = /^o:(\d+)$/.exec(p.nextCursor);
    // A cursor that does not advance is the failure mode a `while (nextCursor)` loop turns into a
    // hung test rather than a red one.
    expect(m).not.toBeNull();
    const next = Number(m![1]);
    expect(next).toBeGreaterThan(offset);
    offset = next;
    expect(pages.length).toBeLessThan(40);
  }
  return pages;
}

const cell = (matrix: any, vendor: string, ours: string) =>
  matrix.cells.find((c: any) => c.vendor === vendor && c.ours === ours)!.count;

describe('the selector populations ARE the strip tiles', () => {
  it('the four severity selectors partition the Findings tile exactly', async () => {
    const tiles = (await q.getBotAnalytics(1, 'rolling_14', scope)).ml;
    // The fixture, spelled out so a drift shows up as a number rather than as a tautology:
    // 12 coderabbit findings + 3 greptile ones. The two summaries, the praise row, the
    // uncoercible row and the 20-day-old nit are all outside this bucket.
    expect(tiles.findings).toBe(15);
    expect(tiles.bySeverity).toEqual({ nit: 8, minor: 3, major: 3, critical: 1 });

    const totals = await Promise.all(
      SEVERITY_KEYS.map(async (s) => (await page({ kind: 'severity', severities: [s] })).total),
    );
    expect(totals).toEqual([8, 3, 3, 1]);
    // THE PARTITION. A severity selector that forgot `bucket === 'finding'` would fold the
    // summaries and the praise row back in and this sum would overshoot the tile it opened from.
    expect(totals.reduce((a, b) => a + b, 0)).toBe(tiles.findings);
    // …and the Findings tile itself is the same population, not a fifth number.
    expect((await page({ kind: 'findings' })).total).toBe(tiles.findings);
    // The "High severity" tile is one selector over two classes, not the sum of two calls.
    expect((await page({ kind: 'severity', severities: ['major', 'critical'] })).total).toBe(4);
  });

  it('summaries are the tile sub-line exactly, and a praise-flavoured walkthrough is one', async () => {
    const tiles = (await q.getBotAnalytics(1, 'rolling_14', scope)).ml;
    expect(tiles.summaries).toBe(2);
    const summaries = await page({ kind: 'summaries' });
    expect(summaries.total).toBe(tiles.summaries);
    // ⚠ THE EXACT PLACE THE BACKEND AND THE CLIENT'S `pillOf` DISAGREE. `foldMlLabelRow` tests
    // isSummary BEFORE praise, so a walkthrough whose categories include 'praise' is a SUMMARY;
    // `pillOf` tests praise first and would pill it the other way. That is why no count on these
    // screens may be re-derived client-side.
    const walkthrough = idOf('summary_praise');
    expect(summaries.items.map(keyOf)).toContain(keyOf(walkthrough));

    // …and it is in NEITHER of the other two buckets, nor in any severity or category selector.
    const findings = await page({ kind: 'findings' });
    expect(findings.items.map(keyOf)).not.toContain(keyOf(walkthrough));
    for (const s of SEVERITY_KEYS) {
      const p = await page({ kind: 'severity', severities: [s] });
      expect(p.items.map(keyOf)).not.toContain(keyOf(walkthrough));
    }
    for (const c of ['praise', 'nitpick', 'documentation']) {
      const p = await page({ kind: 'category', category: c });
      expect(p.items.map(keyOf)).not.toContain(keyOf(walkthrough));
    }
  });

  it('praise is excluded from findings, but its OWN selector returns the praise bucket', async () => {
    const tiles = (await q.getBotAnalytics(1, 'rolling_14', scope)).ml;
    expect(tiles.praise).toBe(1);
    const praiseRow = idOf('praise_1');
    expect((await page({ kind: 'findings' })).items.map(keyOf)).not.toContain(keyOf(praiseRow));
    // `byCategory` is incremented only inside the finding branch, so 'praise' — the category that
    // DEFINES the excluded bucket — can never appear on the tile's topic list.
    expect(tiles.byCategory.find((c: any) => c.category === 'praise')).toBeUndefined();

    // ⚠ REGRESSION. `category:'praise'` used to answer 0 for every input, because the arm read
    // `bucket === 'finding' && categories.includes(...)` and a praise row folds to `bucket:
    // 'praise'`. It was unreachable while the strip's chips (which come from `byCategory`) were
    // the only source of category selectors; the drill-down's severity picker offers Praise
    // directly, which made the dead arm reachable — the option read "Praise · N" off `ml.praise`
    // while the list it opened was empty. The selector now answers the praise BUCKET, so the
    // picker's count and its list agree, and `ml.praise` is the number it must reproduce.
    const praise = await page({ kind: 'category', category: 'praise' });
    expect(praise.total).toBe(tiles.praise);
    expect(praise.items.map(keyOf)).toEqual([keyOf(praiseRow)]);

    // The walkthrough's own category behaves the other way and must keep doing so: a summary's
    // categories are an artefact of the marker parser reading a summary table, never a finding's
    // topic, and 'documentation' names no bucket — so it stays empty.
    expect(tiles.byCategory.find((c: any) => c.category === 'documentation')).toBeUndefined();
    expect((await page({ kind: 'category', category: 'documentation' })).total).toBe(0);
  });

  it('the category selector counts a multi-label row once per category, and ≡ the tile', async () => {
    const tiles = (await q.getBotAnalytics(1, 'rolling_14', scope)).ml;
    for (const category of ['nitpick', 'style_readability', 'correctness_bug', 'security']) {
      const tile = tiles.byCategory.find((c: any) => c.category === category);
      const drill = await page({ kind: 'category', category });
      expect([category, drill.total]).toEqual([category, tile?.count ?? 0]);
    }
    // Spelled out so the equality above cannot be satisfied by two zeros: the three `minor` rows
    // carry BOTH style_readability and nitpick, and are counted once under each.
    expect((await page({ kind: 'category', category: 'nitpick' })).total).toBe(11);
    expect((await page({ kind: 'category', category: 'style_readability' })).total).toBe(3);
  });

  it('a row whose severity cannot be coerced is counted in `labelled` and in nothing else', async () => {
    const tiles = (await q.getBotAnalytics(1, 'rolling_14', scope)).ml;
    // `labelled` is the RAW scan length, so the off-enum row is in it…
    expect(tiles.labelled).toBe(19);
    // …and in none of the three buckets, which is the whole meaning of the fold returning null.
    expect(tiles.findings + tiles.summaries + tiles.praise).toBe(18);
    const orphan = keyOf(idOf('uncoercible'));
    for (const selector of [
      { kind: 'findings' },
      { kind: 'summaries' },
      { kind: 'severity', severities: SEVERITY_KEYS },
      { kind: 'category', category: 'nitpick' },
    ]) {
      const p = await page(selector);
      expect(p.items.map(keyOf)).not.toContain(orphan);
    }
  });

  it('out-of-window labels are invisible — and reappear in the wider window', async () => {
    const stale = keyOf(idOf('stale_nit'));
    const nits14 = await page({ kind: 'severity', severities: ['nit'] });
    expect(nits14.total).toBe(8);
    expect(nits14.items.map(keyOf)).not.toContain(stale);
    expect(nits14.window.kind).toBe('rolling_14');

    // The same row, 20 days old, IS in rolling_30 — so the exclusion above is the window doing its
    // job, not a broken fixture row that could never appear anywhere.
    const nits30 = await page({ kind: 'severity', severities: ['nit'] }, { window: 'rolling_30' });
    expect(nits30.total).toBe(9);
    expect(nits30.items.map(keyOf)).toContain(stale);
    expect((await q.getBotAnalytics(1, 'rolling_30', scope)).ml.findings).toBe(16);
    expect((await page({ kind: 'findings' }, { window: 'rolling_30' })).total).toBe(16);
  });
});

describe('the vendor badge is displayed, never believed', () => {
  it('the vendor badge NEVER moves a selector — THE INVARIANT', async () => {
    const overCalled = idOf('nit_vendor_critical'); // ours: nit · the bot's own badge: critical

    // 1. It is in the Nits tile, where OUR label put it.
    const nits = await page({ kind: 'severity', severities: ['nit'] });
    expect(nits.items.map(keyOf)).toContain(keyOf(overCalled));

    // 2. It is NOT in the critical selector, nor in the "High severity" tile — a selector that
    //    read `vendorSeverity` (or fell back to it, or took the worse of the two) would put it
    //    there, and the less accurate of the two labels would be deciding what counts as high.
    const criticals = await page({ kind: 'severity', severities: ['critical'] });
    expect(criticals.total).toBe(1);
    expect(criticals.items.map(keyOf)).toEqual([keyOf(idOf('critical_1_review'))]);
    const high = await page({ kind: 'severity', severities: ['major', 'critical'] });
    expect(high.items.map(keyOf)).not.toContain(keyOf(overCalled));

    // 3. The disagreement is not lost — it is exactly what the matrix is for.
    const findings = await page({ kind: 'findings' });
    expect(cell(findings.matrix, 'critical', 'nit')).toBe(1);
    expect(findings.matrix.overCall).toBe(1);

    // 4. And OUR label on the card is untouched by theirs.
    const card = nits.items.find((c: any) => keyOf(c) === keyOf(overCalled))!;
    expect(card.mlLabel.severity).toBe('nit');
    expect(card.mlLabel.vendorSeverity).toBe('critical');
    expect(card.mlLabel.vendorSeverityConfidence).toBe('high');
  });

  it('a null vendor claim is undeclared, not a disagreement', async () => {
    const m = (await page({ kind: 'findings' })).matrix;
    expect(m.total).toBe(15);
    expect(m.declared).toBe(4); // 1 over-call + 2 agreements + 1 under-call
    expect(m.undeclared).toBe(11);
    // THE PROPERTY that keeps the caption honest: silence is neither agreement nor conflict.
    expect(m.agree + m.overCall + m.underCall).toBe(m.declared);
    expect([m.agree, m.overCall, m.underCall]).toEqual([2, 1, 1]);
    // The undeclared rows sit in the 'none' COLUMN, and the grid is dense — a zero cell is
    // present rather than omitted, or the UI would read it as "no data" instead of "never".
    expect(cell(m, 'none', 'nit')).toBe(5);
    expect(cell(m, 'critical', 'critical')).toBe(0);
    expect(m.cells).toHaveLength(20);
    expect(m.cells.reduce((s: number, c: any) => s + c.count, 0)).toBe(m.total);
  });

  it('the matrix is computed PRE-refine, so a clicked cell never zeroes itself out', async () => {
    const unrefined = await page({ kind: 'findings' });
    const refined = await page(
      { kind: 'findings' },
      { refine: { cell: { vendor: 'critical', ours: 'nit' }, disagree: null } },
    );
    // The facets describe the SELECTOR population, exactly as commentFacetCounts does…
    expect(refined.matrix).toEqual(unrefined.matrix);
    expect(refined.total).toBe(unrefined.total);
    // …while the LIST is the narrowed one.
    expect(refined.filteredTotal).toBe(1);
    expect(refined.items.map(keyOf)).toEqual([keyOf(idOf('nit_vendor_critical'))]);
  });

  it('the direction filters split the two disagreements and exclude the silent rows', async () => {
    const any = await page({ kind: 'findings' }, { refine: { cell: null, disagree: 'any' } });
    expect(any.filteredTotal).toBe(2);
    const over = await page({ kind: 'findings' }, { refine: { cell: null, disagree: 'over' } });
    expect(over.items.map(keyOf)).toEqual([keyOf(idOf('nit_vendor_critical'))]);
    const under = await page({ kind: 'findings' }, { refine: { cell: null, disagree: 'under' } });
    expect(under.items.map(keyOf)).toEqual([keyOf(idOf('gr_major_under'))]);
    // The two agreeing rows are a MATCH on their cell but not a disagreement — the same row
    // reached two ways, which is what proves the cell filter and the direction filter are
    // independent rather than one spelled twice.
    const agreeCell = await page(
      { kind: 'findings' },
      { refine: { cell: { vendor: 'nit', ours: 'nit' }, disagree: null } },
    );
    expect(agreeCell.filteredTotal).toBe(2);
    const agreeAndDisagree = await page(
      { kind: 'findings' },
      { refine: { cell: { vendor: 'nit', ours: 'nit' }, disagree: 'any' } },
    );
    expect(agreeAndDisagree.filteredTotal).toBe(0);
  });

  it('the per-bot narrowing lists one bot, composes, and leaves the facets alone', async () => {
    const unrefined = await page({ kind: 'findings' });
    const gr = await page({ kind: 'findings' }, { refine: { ...NO_REFINE, authorUserIds: [grId] } });
    // The same rule the cell and the direction follow: the matrix describes the SELECTOR
    // population, so drilling into one bot must not redraw the grid the click came from.
    expect(gr.matrix).toEqual(unrefined.matrix);
    expect(gr.total).toBe(unrefined.total);
    expect(gr.filteredTotal).toBe(3);
    expect(new Set(gr.items.map((c: any) => c.authorUserId))).toEqual(new Set([grId]));

    // It COMPOSES with the direction rather than replacing it — "this bot's over-calls" is the
    // number a bar on the Behaviour tab's inflation index carries, and the list behind the bar
    // has to be that same population or the two screens disagree.
    expect(
      (await page({ kind: 'findings' }, { refine: { ...NO_REFINE, authorUserIds: [grId], disagree: 'over' } }))
        .filteredTotal,
    ).toBe(0); // greptile only ever UNDER-called here
    const crOver = await page(
      { kind: 'findings' },
      { refine: { ...NO_REFINE, authorUserIds: [crId], disagree: 'over' } },
    );
    expect(crOver.items.map(keyOf)).toEqual([keyOf(idOf('nit_vendor_critical'))]);

    // An id this account cannot see narrows to nothing — never to a wider list, and never to an
    // error. The predicate rides an already accountId-scoped scan, so "not yours" and "no such
    // bot" are the same empty answer and neither is an existence oracle.
    const foreign = await page(
      { kind: 'findings' },
      { refine: { ...NO_REFINE, authorUserIds: [999_999] } },
    );
    expect(foreign.filteredTotal).toBe(0);
    expect(foreign.total).toBe(unrefined.total);
  });

  // ⚠ THE WHOLE REASON THIS REFINEMENT IS A LIST. The Behaviour tab's inflation card sums its
  // "View all N →" over the bots THAT PANEL resolves (role `'review'`), while this getter resolves
  // role `'all'` — both deliberate. Only the caller stating its exact id set can make the button's
  // number and the list's `filteredTotal` agree by construction rather than by the coincidence that
  // no shipped quality-check bot emits a vendor badge.
  it('a multi-bot set is the union of its members, and its ORDER is irrelevant', async () => {
    const unrefined = await page({ kind: 'findings' });
    const gr = await page({ kind: 'findings' }, { refine: { ...NO_REFINE, authorUserIds: [grId] } });
    const cr = await page({ kind: 'findings' }, { refine: { ...NO_REFINE, authorUserIds: [crId] } });
    const both = await page(
      { kind: 'findings' },
      { refine: { ...NO_REFINE, authorUserIds: [crId, grId] } },
    );
    expect(both.filteredTotal).toBe(gr.filteredTotal + cr.filteredTotal);
    // Every bot in this fixture is in the set, so the union IS the whole selector population —
    // which is what the card-level "view all" promises.
    expect(both.filteredTotal).toBe(unrefined.filteredTotal);
    expect(both.matrix).toEqual(unrefined.matrix);
    const reversed = await page(
      { kind: 'findings' },
      { refine: { ...NO_REFINE, authorUserIds: [grId, crId] } },
    );
    expect(reversed.items.map(keyOf)).toEqual(both.items.map(keyOf));

    // A set containing one real bot and one id this account cannot see is still just that bot —
    // an unknown member contributes nothing and widens nothing.
    const mixed = await page(
      { kind: 'findings' },
      { refine: { ...NO_REFINE, authorUserIds: [grId, 999_999] } },
    );
    expect(mixed.filteredTotal).toBe(gr.filteredTotal);
    expect(new Set(mixed.items.map((c: any) => c.authorUserId))).toEqual(new Set([grId]));
  });

  // ⚠ THE `repoIds` TRAP, on a different parameter. An EMPTY list means "no bots" and must answer
  // empty; only `null` widens. A gate spelled `authorUserIds?.length` (or a `.length > 0` guard on
  // the client) reads perfectly and hands back the WHOLE workspace under a caption promising a
  // subset — the exact failure the list shape was introduced to close.
  it('an EMPTY bot set means NO bots, never all of them', async () => {
    const unrefined = await page({ kind: 'findings' });
    const none = await page({ kind: 'findings' }, { refine: { ...NO_REFINE, authorUserIds: [] } });
    expect(none.filteredTotal).toBe(0);
    expect(none.items).toEqual([]);
    // …while `total` and the grid still describe the selector population, exactly as they do under
    // every other refinement.
    expect(none.total).toBe(unrefined.total);
    expect(none.matrix).toEqual(unrefined.matrix);
  });
});

describe('the page itself', () => {
  it('pagination is stable and exhaustive', async () => {
    const pages = await walk({ kind: 'findings' }, { limit: 4 });
    expect(pages).toHaveLength(4); // 4 + 4 + 4 + 3
    expect(pages.map((p) => p.nextCursor)).toEqual(['o:4', 'o:8', 'o:12', null]);

    const seen = pages.flatMap((p) => p.items.map(keyOf));
    // Every row of the population appears exactly once. An offset that double-counted or skipped
    // would still terminate — this is what makes the walk an assertion rather than a smoke test.
    expect(seen).toHaveLength(pages[0]!.filteredTotal);
    expect(new Set(seen).size).toBe(seen.length);
    // Newest first, the scan's own order, carried through the fold and the slice unchanged.
    const times = pages.flatMap((p) => p.items.map((c: any) => Date.parse(c.createdAt)));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeLessThanOrEqual(times[i - 1]!);

    // One page, no paging: the same rows in the same order.
    const whole = await page({ kind: 'findings' });
    expect(whole.items.map(keyOf)).toEqual(seen);
    expect(whole.nextCursor).toBeNull();
    // An offset past the end is an empty page, not an error and not a cursor pointing back at
    // the start.
    const past = await page({ kind: 'findings' }, { offset: 999, limit: 4 });
    expect(past.items).toEqual([]);
    expect(past.nextCursor).toBeNull();
    expect(past.total).toBe(whole.total);
  });

  // REGRESSION. The hydration used to mirror the candidate query's `isNotNull(body) + trim(body)
  // <> ''` on the `review` branch, justified as "the candidate query applies it, so a labelled
  // empty review body is impossible". That is false: bodies are RE-UPSERTED on every sync walk
  // while labels are never re-scored, so a review scored from real text can later come back empty
  // — and since `total` is counted from the labels alone, the predicate silently subtracted rows
  // the tile had counted. Measured on this repo's own dev DB before the fix: workspace 8 /
  // rolling_30 reported 792 and could only ever hydrate 782, with the first page rendering 19
  // cards. Only the `review` id space leaked (the other two branches carry no text predicate).
  it('a review whose body was later re-synced to empty still hydrates, so the list reaches its tile', async () => {
    const before = await page({ kind: 'findings' });
    // Blank the body of one already-labelled review, exactly as a later walk would.
    const victim = before.items.find((c: any) => c.targetKind === 'review');
    expect(victim).toBeDefined();
    // Captured so the fixture is put back BYTE-for-byte — a sibling assertion in this file checks
    // that each hydrated body still contains its fixture key.
    const originalBody = (victim as any).body as string;
    await db
      .update(schema.reviews)
      .set({ body: '' })
      .where(eq(schema.reviews.id, (victim as any).targetId))
      .execute();

    const after = await page({ kind: 'findings' });
    // The count is unmoved (it never read the body) — and the row is STILL delivered.
    expect(after.total).toBe(before.total);
    expect(after.items).toHaveLength(before.items.length);
    expect(after.items.map(keyOf)).toEqual(before.items.map(keyOf));
    // It arrives with a null body so the card can say the text is gone, rather than as a
    // blank-but-present string that would render as an empty box.
    const rehydrated: any = after.items.find((c: any) => keyOf(c) === keyOf(victim as any));
    expect(rehydrated.body).toBeNull();
    // Its severity — the reason it counts — survives intact.
    expect(rehydrated.mlLabel.severity).toBe((victim as any).mlLabel.severity);

    // And a full cursor walk still drains to exactly `filteredTotal`: the shortfall used to show
    // up only here, as a walk that terminated early with hasMore false.
    const pages = await walk({ kind: 'findings' }, { limit: 4 });
    expect(pages.flatMap((p) => p.items)).toHaveLength(pages[0]!.filteredTotal);

    await db
      .update(schema.reviews)
      .set({ body: originalBody })
      .where(eq(schema.reviews.id, (victim as any).targetId))
      .execute();
  });

  it('hydrates all three id spaces, with the label INLINE and no per-card fetch', async () => {
    const items = (await page({ kind: 'findings' })).items;
    const byKey = new Map<string, any>(items.map((c: any) => [keyOf(c), c]));

    // An inline review comment carries its thread's context…
    const inline: any = byKey.get(keyOf(idOf('nit_2')));
    expect(inline.path).toBe('src/flag.ts');
    expect(inline.line).toBe(7);
    expect(inline.derivedState).toBe('untouched');
    expect(inline.threadId).not.toBeNull();
    expect(inline.repoFullName).toBe('acme/api');
    expect(inline.prNumber).toBe(1);
    expect(inline.prUrl).toBe('https://github.com/acme/api/pull/1');
    expect(inline.authorUserId).toBe(crId);
    expect(inline.authorLogin).toBe('coderabbitai');
    expect(inline.authorKind).toBe('coderabbit');
    expect(inline.body).toBe('inline finding: nit_2');
    // The badge ships with the row: this list spans many PRs, so the per-PR ['ml-labels', prId]
    // index could not serve it and a per-card fetch would be one request per row.
    expect(inline.mlLabel.severity).toBe('nit');
    expect(inline.mlLabel.categories).toEqual(['nitpick']);
    expect(inline.mlLabel.vendorSeverity).toBeNull();

    // …while a PR comment and a review body have no thread at all. `targetId` lives in three id
    // spaces, so a hydration keyed on the bare id would cross-link these onto each other.
    for (const key of ['major_2_pr_comment', 'critical_1_review']) {
      const flat: any = byKey.get(keyOf(idOf(key)));
      expect([key, flat.path, flat.line, flat.threadId, flat.derivedState]).toEqual([
        key,
        null,
        null,
        null,
        null,
      ]);
      expect(flat.body).toContain(key);
      expect(flat.repoFullName).toBe('acme/api');
    }
    expect(byKey.get(keyOf(idOf('major_2_pr_comment')))!.targetKind).toBe('pr_comment');
    expect(byKey.get(keyOf(idOf('critical_1_review')))!.targetKind).toBe('review');

    // Greptile's rows carry the OTHER thread's context — identity and context are per row, not
    // per response.
    const gr: any = byKey.get(keyOf(idOf('gr_nit_agree_1')));
    expect(gr.path).toBe('src/other.ts');
    expect(gr.line).toBe(21);
    expect(gr.derivedState).toBe('likely_addressed');
    expect(gr.authorUserId).toBe(grId);
    expect(gr.authorKind).toBe('greptile');
  });

  it('an empty workspace answers empty, never the whole account', async () => {
    // A brand-new workspace has no repos, so `resolveWorkspaceScope` hands back `repoIds: []` —
    // a real empty-workspace state, never "widen to the account".
    const ws = await q.createWorkspace(1, 'Empty');
    const emptyScope = await q.resolveWorkspaceScope(1, ws.id);
    expect(emptyScope.repoIds).toEqual([]);
    expect(emptyScope.workspaceId).toBe(ws.id);

    const resp = await page({ kind: 'findings' }, { sc: emptyScope });
    expect(resp.total).toBe(0);
    expect(resp.filteredTotal).toBe(0);
    expect(resp.items).toEqual([]);
    expect(resp.nextCursor).toBeNull();
    // The resolved scope is echoed so a stale bookmark can correct itself, and the matrix is a
    // fully-formed dense grid of zeros rather than an absent field.
    expect(resp.workspaceId).toBe(ws.id);
    expect(resp.matrix.cells).toHaveLength(20);
    expect(resp.matrix.total).toBe(0);

    // The Default workspace is untouched by the existence of the empty one.
    expect((await page({ kind: 'findings' })).total).toBe(15);
  });
});
