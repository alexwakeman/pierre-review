// getBotOverlapClusters — the "Same-line overlap" drill-down, on a THROWAWAY sqlite DB.
//
// THE SINGLE MOST VALUABLE ASSERTION IN THIS FILE is the first one: `total` must equal
// `getBotAnalytics(...).totals.overlapClusters` for the same window and scope. The tile and this
// list are two separate walks of the same tables, and they agree only because this getter
// reproduces the tile's three exclusions IN THE TILE'S ORDER, hands the survivors to the SAME
// ±3-line arbiter, and keeps the same `userIds.size >= 2` gate. Get any one of those wrong and
// the tile says 34 while the list says 41 — silently, in production, on a screen whose whole
// purpose is that the number you clicked is the number you get.
//
// The fixture is built so each exclusion is separately falsifiable: a quality-check bot sitting on
// a review bot's exact line (would be a 5th cluster if the role filter were dropped), a pair of
// null-line threads (a 6th if `nullLineGroup` flipped), and a 20-day-old pair (a 7th if the window
// were not applied — and it IS counted under rolling_30, so its absence is the window working
// rather than the rows being broken).
//
// Also pinned: the collapse (a verbose bot's 23 threads are ONE member with a ×23 pill, not 23
// cards), the origin-comment pick (the thread's OWN bot's earliest comment, lower id breaking
// ties — a human's earlier reply must never become the "origin"), and that the page order is
// TOTAL, because a paged cross-PR list whose comparator leaves ties in DB order hands back
// different clusters for the same page on a second call.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-overlap-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let overlap: any;
let scope: any;
let repoId = 0;
let crId = 0;
let grId = 0;
let qbId = 0;
let humanId = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;
const LINE_OVERLAP_WINDOW = 3;

const NO_REFINE = { cell: null, disagree: null };

/** PR local ids by number, so every assertion keys on `prId` — never on a bare PR number. */
const prIdByNumber = new Map<number, number>();
/** Thread ids by fixture handle. */
const threadIds = new Map<string, number>();
/** The comment that must win the origin pick on PR#1's coderabbit thread. */
let originWinnerId = 0;
let originLoserId = 0;
let humanCommentId = 0;
let crOriginCommentId = 0;
let grOriginCommentId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  overlap = await import('./bot-overlap.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments } = schema;

  const [repo] = await db
    .insert(repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_overlap' })
    .returning()
    .execute();
  repoId = repo.id;

  const mkUser = async (login: string, nodeId: string, isBot: boolean) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: nodeId, isBot })
        .returning()
        .execute()
    )[0].id;
  // Two KNOWN VENDOR LOGINS (automated by the login seed alone) …
  crId = await mkUser('coderabbitai', 'U_ov_cr', true);
  grId = await mkUser('greptile-apps', 'U_ov_gr', true);
  // … one in-house bot that gets an explicit quality_check role below, and a human.
  qbId = await mkUser('quality-bot', 'U_ov_qb', true);
  humanId = await mkUser('a-human', 'U_ov_hu', false);

  for (const number of [1, 2, 3, 4, 5, 6, 7]) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_ov_${number}`,
        accountId: 1,
        repoId,
        number,
        title: `overlap fixture #${number}`,
        state: 'open',
        isDraft: false,
        authorId: humanId,
        openedAt: new Date(now - 25 * DAY),
        updatedAt: new Date(now - HOUR),
      })
      .returning()
      .execute();
    prIdByNumber.set(number, pr.id);
  }

  const mkThread = async (
    handle: string,
    prNumber: number,
    path: string,
    line: number | null,
    owner: number,
    opts: { ageDays?: number } = {},
  ): Promise<number> => {
    const [row] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_ov_${handle}`,
        prId: prIdByNumber.get(prNumber)!,
        path,
        line,
        isResolved: false,
        isOutdated: false,
        derivedState: 'untouched',
        originalCommenterId: owner,
        createdAt: new Date(now - (opts.ageDays ?? 0) * DAY - 2 * HOUR),
      })
      .returning()
      .execute();
    threadIds.set(handle, row.id);
    return row.id;
  };
  const mkComment = async (
    handle: string,
    threadId: number,
    prNumber: number,
    authorId: number,
    body: string,
    at: Date,
  ): Promise<number> =>
    (
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: `RC_ov_${handle}`,
          threadId,
          prId: prIdByNumber.get(prNumber)!,
          authorId,
          body,
          createdAt: at,
        })
        .returning()
        .execute()
    )[0].id;

  // ── PR#1 src/a.ts — a three-thread cluster spanning the ±3 window ────────────────────────
  // Lines 10, 11, 12: the arbiter ANCHORS at 10, so 11 and 12 both join (12 − 10 = 2 ≤ 3).
  // coderabbit owns two of the three, which is what the member collapse has to notice.
  const tA = await mkThread('a_cr_10', 1, 'src/a.ts', 10, crId);
  const tB = await mkThread('a_gr_11', 1, 'src/a.ts', 11, grId);
  const tC = await mkThread('a_cr_12', 1, 'src/a.ts', 12, crId);
  // THE ORIGIN PICK, on tA. A human's reply is the EARLIEST comment on the thread and must never
  // become its origin; of the two bot comments sharing a timestamp, the LOWER id wins (a `<=`
  // in the tiebreak would pick the other one).
  humanCommentId = await mkComment(
    'a_human',
    tA,
    1,
    humanId,
    'a human got here first',
    new Date(now - 5 * HOUR),
  );
  originWinnerId = await mkComment(
    'a_cr_win',
    tA,
    1,
    crId,
    'origin-winner',
    new Date(now - 3 * HOUR),
  );
  originLoserId = await mkComment(
    'a_cr_lose',
    tA,
    1,
    crId,
    'origin-loser',
    new Date(now - 3 * HOUR),
  );
  crOriginCommentId = originWinnerId;
  grOriginCommentId = await mkComment('a_gr', tB, 1, grId, 'greptile here', new Date(now - 3 * HOUR));
  await mkComment('a_cr_12c', tC, 1, crId, 'coderabbit again, two lines down', new Date(now - 3 * HOUR));

  // ── PR#2 src/verbose.ts — the collapse case ──────────────────────────────────────────────
  // 23 coderabbit threads on ONE line plus a single greptile thread one line down. Two members,
  // 24 threads: a verbose bot must render as one ×23 pill, not 23 identical cards.
  for (let i = 0; i < 23; i++) {
    const t = await mkThread(`v_cr_${i}`, 2, 'src/verbose.ts', 100, crId);
    await mkComment(`v_cr_${i}`, t, 2, crId, `verbose remark ${i}`, new Date(now - 3 * HOUR));
  }
  const tV = await mkThread('v_gr', 2, 'src/verbose.ts', 101, grId);
  await mkComment('v_gr', tV, 2, grId, 'greptile agrees', new Date(now - 3 * HOUR));

  // ── PR#3 src/q.ts — the quality-check exclusion ──────────────────────────────────────────
  // Same file, same LINE as a review bot. "SonarQube and CodeRabbit both hit line 5" is a rule
  // firing next to a judgement, not two reviewers agreeing — so this must not be a cluster.
  const tQ1 = await mkThread('q_cr', 3, 'src/q.ts', 5, crId);
  await mkComment('q_cr', tQ1, 3, crId, 'coderabbit on line 5', new Date(now - 3 * HOUR));
  const tQ2 = await mkThread('q_qb', 3, 'src/q.ts', 5, qbId);
  await mkComment('q_qb', tQ2, 3, qbId, 'the linter on line 5', new Date(now - 3 * HOUR));

  // ── PR#4 src/null.ts — outdated / file-level threads ─────────────────────────────────────
  // `line` goes NULL when a thread outdates. Two chatty bots eventually share a per-file null
  // lump, which is manufactured overlap rather than a redundancy signal.
  const tN1 = await mkThread('n_cr', 4, 'src/null.ts', null, crId);
  await mkComment('n_cr', tN1, 4, crId, 'outdated coderabbit thread', new Date(now - 3 * HOUR));
  const tN2 = await mkThread('n_gr', 4, 'src/null.ts', null, grId);
  await mkComment('n_gr', tN2, 4, grId, 'outdated greptile thread', new Date(now - 3 * HOUR));

  // ── PR#5 src/old.ts — outside rolling_14, inside rolling_30 ──────────────────────────────
  const tO1 = await mkThread('o_cr', 5, 'src/old.ts', 1, crId, { ageDays: 20 });
  await mkComment('o_cr', tO1, 5, crId, 'an old finding', new Date(now - 20 * DAY - 3 * HOUR));
  const tO2 = await mkThread('o_gr', 5, 'src/old.ts', 1, grId, { ageDays: 20 });
  await mkComment('o_gr', tO2, 5, grId, 'an old second opinion', new Date(now - 20 * DAY - 3 * HOUR));

  // ── PR#6 / PR#7 — two clusters IDENTICAL on every sort key but the PR ────────────────────
  // Same bot count, same thread count, so the comparator has to run down to its tail to order
  // them. ⚠ The PATHS ARE DELIBERATELY ANTI-SORTED against the PR ids ('zzz' on the lower prId,
  // 'aaa' on the higher): prId is compared BEFORE path, so the expected order is zzz-then-aaa —
  // a comparator that reached for the path first would produce the opposite, which is exactly
  // the drift a determinism-only assertion cannot see.
  for (const [n, handle, path] of [
    [6, 'tie1', 'src/zzz.ts'],
    [7, 'tie2', 'src/aaa.ts'],
  ] as Array<[number, string, string]>) {
    const tc = await mkThread(`${handle}_cr`, n, path, 1, crId);
    await mkComment(`${handle}_cr`, tc, n, crId, `coderabbit on ${handle}`, new Date(now - 3 * HOUR));
    const tg = await mkThread(`${handle}_gr`, n, path, 1, grId);
    await mkComment(`${handle}_gr`, tg, n, grId, `greptile on ${handle}`, new Date(now - 3 * HOUR));
  }

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
  // ⚠ AFTER the threads: setWorkspaceReviewer refuses an actor with no footprint. The row is what
  // makes the quality-check exclusion falsifiable — without it `quality-bot` would be dropped one
  // step EARLIER (unclassified), and the test would pass for the wrong reason.
  await q.setWorkspaceReviewer(1, qbId, {
    workspaceId: scope.workspaceId,
    automated: true,
    role: 'quality_check',
  });

  // Two ML labels on PR#1's origin comments, so the matrix and the refine path have something to
  // describe: we call coderabbit's finding `major` where its own badge says `minor` (an
  // under-call), and greptile's is a `nit` with no vendor claim at all.
  await db
    .insert(schema.mlCommentLabels)
    .values([
      {
        accountId: 1,
        repoId,
        prId: prIdByNumber.get(1)!,
        targetKind: 'review_comment',
        targetId: crOriginCommentId,
        authorUserId: crId,
        severity: 'major',
        severityOrd: 2,
        severityProb: 0.9,
        vendorSeverity: 'minor',
        vendorSeverityConfidence: 'high',
        categories: ['correctness_bug'],
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: 'h_ov_cr',
        targetCreatedAt: new Date(now - 3 * HOUR),
      },
      {
        accountId: 1,
        repoId,
        prId: prIdByNumber.get(1)!,
        targetKind: 'review_comment',
        targetId: grOriginCommentId,
        authorUserId: grId,
        severity: 'nit',
        severityOrd: 0,
        severityProb: 0.7,
        categories: ['nitpick'],
        categoryProbs: {},
        isSummary: false,
        backend: 'modernbert-onnx',
        modelVersion: 'test',
        bodyHash: 'h_ov_gr',
        targetCreatedAt: new Date(now - 3 * HOUR),
      },
    ])
    .execute();
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function clusters(
  opts: { window?: string; sc?: any; refine?: any; offset?: number; limit?: number } = {},
): Promise<any> {
  return overlap.getBotOverlapClusters(
    1,
    opts.refine ?? NO_REFINE,
    opts.window ?? 'rolling_14',
    opts.sc ?? scope,
    { offset: opts.offset ?? 0, limit: opts.limit ?? 20 },
  );
}

const pathsOf = (resp: any) => resp.items.map((c: any) => c.path);
const memberFor = (cluster: any, userId: number) =>
  cluster.members.find((m: any) => m.comment?.authorUserId === userId);

describe('the cluster list IS the Same-line overlap tile', () => {
  it('total ≡ totals.overlapClusters for the same window and scope', async () => {
    const tile = (await q.getBotAnalytics(1, 'rolling_14', scope)).totals.overlapClusters;
    const list = await clusters();
    // THE assertion. Both sides walked the window's automated-reviewer threads, dropped the same
    // three populations in the same order, ran the same ±3 arbiter and kept `userIds.size >= 2`.
    expect(list.total).toBe(tile);
    // Spelled out so the equality cannot be satisfied by two zeros — and so a NEW cluster leaking
    // in (a dropped exclusion) shows up as a number rather than as silence.
    expect(tile).toBe(4);
    expect(list.truncated).toBe(false);

    // The same equality one window wider, where the 20-day-old pair joins. The window is a
    // parameter of both walks, so a getter that hard-coded a span would pass above and fail here.
    const tile30 = (await q.getBotAnalytics(1, 'rolling_30', scope)).totals.overlapClusters;
    const list30 = await clusters({ window: 'rolling_30' });
    expect(list30.total).toBe(tile30);
    expect(tile30).toBe(5);
    expect(pathsOf(list30)).toContain('src/old.ts');
    expect(list30.window.kind).toBe('rolling_30');
  });

  it('a cluster credits every bot but is listed ONCE', async () => {
    const resp = await q.getBotAnalytics(1, 'rolling_14', scope);
    // ⚠ THE POINT OF THE SEPARATE COUNT: the per-bot `overlapThreads` column credits EVERY member
    // of a cluster, so summing it counts the 4 areas as 31. The tile — and this drill-down's
    // `total` — must not be derivable that way.
    const summed = [...resp.vendors, ...resp.qualityChecks].reduce(
      (s: number, v: any) => s + v.overlapThreads,
      0,
    );
    expect(summed).toBe(31);
    const list = await clusters();
    expect(list.total).toBe(4);
    expect(list.items.reduce((s: number, c: any) => s + c.threadCount, 0)).toBe(summed);
    // Every listed cluster is by definition a multi-bot one, collapsed to one member per bot.
    for (const c of list.items) {
      expect(c.members.length).toBeGreaterThanOrEqual(2);
      expect(c.threadCount).toBe(
        c.members.reduce((s: number, m: any) => s + m.threadIds.length, 0),
      );
    }
  });

  it('quality_check-roled bots never form a cluster', async () => {
    const list = await clusters();
    // coderabbit and quality-bot sit on the SAME line of src/q.ts. quality-bot is classified
    // automated (so it survives the kind gate) and is excluded purely on its ROLE — which is what
    // makes this fail rather than pass vacuously if the role filter is dropped.
    expect(pathsOf(list)).not.toContain('src/q.ts');
    const qb = (await q.getBotAnalytics(1, 'rolling_14', scope)).qualityChecks.find(
      (v: any) => v.login === 'quality-bot',
    );
    expect(qb).toBeDefined(); // it IS a classified automated reviewer …
    expect(qb.overlapThreads).toBe(0); // … it just never enters the overlap pass
  });

  it('null-line (outdated / file-level) threads are excluded', async () => {
    const list = await clusters();
    // Two bots, same file, both lines NULL: `nullLineGroup: false` keeps this out, because any
    // two chatty bots eventually share a per-file null lump.
    expect(pathsOf(list)).not.toContain('src/null.ts');
  });
});

describe('cluster assembly', () => {
  it("one verbose bot's 23 threads collapse to ONE member with threadIds ×23", async () => {
    const list = await clusters();
    const verbose = list.items.find((c: any) => c.path === 'src/verbose.ts')!;
    expect(verbose).toBeDefined();
    expect(verbose.members).toHaveLength(2);
    expect(verbose.threadCount).toBe(24);
    const cr = memberFor(verbose, crId)!;
    expect(cr.threadIds).toHaveLength(23);
    // The representative is ONE of the threads it collapses, not a synthetic id.
    expect(cr.threadIds).toContain(cr.threadId);
    expect(memberFor(verbose, grId)!.threadIds).toHaveLength(1);
    // The ±3 window bounds the span: the anchor is 100 and greptile's 101 joined it.
    expect(verbose.lineStart).toBe(100);
    expect(verbose.lineEnd).toBe(101);
  });

  it("the origin comment is the thread's OWN bot's earliest, lower-id-first", async () => {
    const list = await clusters();
    const a = list.items.find((c: any) => c.path === 'src/a.ts')!;
    const cr = memberFor(a, crId)!;
    // The setup that makes this discriminating, ASSERTED rather than assumed: the human's comment
    // is BOTH the earliest on the thread and the lowest id, so every pick that skips the author
    // filter — earliest-wins, lowest-id-wins, first-row-wins — lands on it. And the two bot
    // comments share a timestamp with the winner inserted first, so a `<=` in the id tiebreak
    // lands on the loser.
    expect(humanCommentId).toBeLessThan(originWinnerId);
    expect(originWinnerId).toBeLessThan(originLoserId);
    // Without the author filter the card attributes a human's words to a bot.
    expect(cr.comment.body).toBe('origin-winner');
    expect(cr.comment.targetId).toBe(originWinnerId);
    expect(cr.comment.targetId).not.toBe(originLoserId);
    expect(cr.comment.authorUserId).toBe(crId);
    expect(cr.comment.authorLogin).toBe('coderabbitai');
    expect(cr.comment.authorKind).toBe('coderabbit');
    // The member's own context, and the PR link (there is deliberately no per-comment permalink —
    // review_threads has no url column and the numeric REST comment id is not stored).
    expect(cr.line).toBe(10);
    expect(cr.derivedState).toBe('untouched');
    expect(cr.addressedConfidence).toBe('none');
    expect(cr.comment.prUrl).toBe('https://github.com/acme/api/pull/1');
    expect(cr.comment.repoFullName).toBe('acme/api');
    // The ML label rides INLINE on the card — a cross-PR list must never mount the per-PR
    // ['ml-labels', prId] index per row.
    expect(cr.comment.mlLabel.severity).toBe('major');
    expect(cr.comment.mlLabel.vendorSeverity).toBe('minor');
  });

  it('the cluster anchors on its lowest line and never spans more than the window', async () => {
    const list = await clusters({ window: 'rolling_30' });
    for (const c of list.items) {
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart);
      expect(c.lineEnd - c.lineStart).toBeLessThanOrEqual(LINE_OVERLAP_WINDOW);
      // Keyed on `prId`, never a bare PR number: numbers are unique per REPO, so a bare number
      // would cross-link one repo's #12 onto another's.
      expect(c.clusterId).toBe(`${c.prId}:${c.lineStart}:${c.path}`);
    }
    const a = list.items.find((c: any) => c.path === 'src/a.ts')!;
    expect([a.lineStart, a.lineEnd]).toEqual([10, 12]);
    expect(a.prId).toBe(prIdByNumber.get(1));
    expect(a.prNumber).toBe(1);
    expect(new Set(list.items.map((c: any) => c.clusterId)).size).toBe(list.items.length);
  });
});

describe('paging and refinement', () => {
  it('the page order is total', async () => {
    const first = await clusters();
    const second = await clusters();
    // Two calls, same arguments: identical sequence. The comparator sorts members desc, then
    // threads desc, then prId → path → lineStart — the last two clusters are equal on the first
    // two keys, so without the tail the DB's row order decides and this flaps.
    expect(second.items.map((c: any) => c.clusterId)).toEqual(
      first.items.map((c: any) => c.clusterId),
    );
    expect(pathsOf(first)).toEqual([
      'src/verbose.ts', // 24 threads
      'src/a.ts', // 3 threads
      // ⚠ Anti-sorted on purpose: 'zzz' sits on the LOWER prId. prId is compared before path, so
      // this order is only produced by the real key order — sorting on path first inverts it.
      'src/zzz.ts',
      'src/aaa.ts',
    ]);
  });

  it('paging is exhaustive, duplicate-free and terminates', async () => {
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const p = await clusters({ offset, limit: 2 });
      pages += 1;
      seen.push(...p.items.map((c: any) => c.clusterId));
      expect(p.total).toBe(4);
      expect(p.filteredTotal).toBe(4);
      if (!p.nextCursor) break;
      const m = /^o:(\d+)$/.exec(p.nextCursor);
      expect(m).not.toBeNull();
      const next = Number(m![1]);
      // A cursor that does not advance turns a `while (nextCursor)` walk into a hung test.
      expect(next).toBeGreaterThan(offset);
      offset = next;
      expect(pages).toBeLessThan(20);
    }
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual((await clusters()).items.map((c: any) => c.clusterId));

    // An offset past the end is an empty page with NO cursor — `offset + 0 < filteredTotal` would
    // hand back a cursor pointing at the start again and loop forever.
    const past = await clusters({ offset: 99, limit: 2 });
    expect(past.items).toEqual([]);
    expect(past.nextCursor).toBeNull();
    expect(past.total).toBe(4);
  });

  it('the matrix describes the LABELLED origin comments, and refine narrows the list only', async () => {
    const unrefined = await clusters();
    // ⚠ `matrix.total` counts labelled ORIGIN COMMENTS, not clusters — a cluster is not an ML row.
    // Two of this fixture's origin comments carry a label; one of them carries a vendor badge.
    expect(unrefined.matrix.total).toBe(2);
    expect(unrefined.matrix.declared).toBe(1);
    expect(unrefined.matrix.undeclared).toBe(1);
    expect([
      unrefined.matrix.agree,
      unrefined.matrix.overCall,
      unrefined.matrix.underCall,
    ]).toEqual([0, 0, 1]);
    expect(unrefined.matrix.cells).toHaveLength(20);

    // A cell filter keeps the clusters with ≥1 matching member and leaves the facets alone.
    const refined = await clusters({
      refine: { cell: { vendor: 'minor', ours: 'major' }, disagree: null },
    });
    expect(refined.matrix).toEqual(unrefined.matrix);
    expect(refined.total).toBe(4);
    expect(refined.filteredTotal).toBe(1);
    expect(pathsOf(refined)).toEqual(['src/a.ts']);

    // The same cluster reached the other way — the bot called it MILDER than we did.
    const under = await clusters({ refine: { cell: null, disagree: 'under' } });
    expect(pathsOf(under)).toEqual(['src/a.ts']);
    // …and not the other way. An undeclared claim is silence, not a disagreement, so the three
    // unlabelled clusters never match a direction filter either.
    expect((await clusters({ refine: { cell: null, disagree: 'over' } })).filteredTotal).toBe(0);
  });

  it('an empty workspace answers empty, never the whole account', async () => {
    const ws = await q.createWorkspace(1, 'Empty');
    const emptyScope = await q.resolveWorkspaceScope(1, ws.id);
    expect(emptyScope.repoIds).toEqual([]);

    const resp = await clusters({ sc: emptyScope });
    expect(resp.total).toBe(0);
    expect(resp.items).toEqual([]);
    expect(resp.nextCursor).toBeNull();
    // The resolved scope is echoed so a stale bookmark can correct itself, and the matrix is a
    // dense grid of zeros rather than an absent field.
    expect(resp.workspaceId).toBe(ws.id);
    expect(resp.matrix.cells).toHaveLength(20);
    expect(resp.matrix.total).toBe(0);

    // The Default workspace is untouched by the existence of the empty one.
    expect((await clusters()).total).toBe(4);
  });
});
