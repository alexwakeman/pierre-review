// db/bot-volume.ts — the bot-comment-volume column, its PR drill-down and the LOC chart, on a
// THROWAWAY sqlite DB.
//
// THE CONTRACTS THIS FILE EXISTS FOR, each of which shipped as a real bug somewhere on this
// surface or was one edit away from it:
//  • ALL THREE TEXT KINDS COUNT. `review_comments`, `pr_comments` and submitted `reviews` bodies.
//    Drop one and every average silently falls by a repo-dependent fraction — nothing errors, and
//    the number still looks plausible. (This definition is WIDER than
//    `BotAnalyticsResponse.totals.comments`, which counts only the first two.)
//  • THE DENOMINATOR. `avgCommentsPerCommentedPr` divides by the PRs a bot touched;
//    `avgCommentsPerScopePr` by every merged PR in scope. On the real corpus those differ ~6×
//    (three.js: 656 of 796 merged PRs draw nothing), so the two are pinned against a fixture with
//    deliberate zero-comment PRs — a fixture where every PR has a bot comment would let the two
//    fields be swapped and still pass.
//  • THE SMALL-SAMPLE GUARD. A bucket under the floor must NOT answer a ratio off two PRs. It
//    degrades to the repo mean, and a repo under the floor answers `baseline: 'none'` with BOTH
//    `expected` and `ratio` null — so the wire can always tell "no baseline" from "ratio 1.0".
//  • THE EMPTY SCOPE. `repoIds: []` is a real empty workspace and must early-return, never widen.
//  • BOTH SORTS, INCLUDING THE TIEBREAK. The page offset is a slice over a JS fold, so a
//    comparator that is not TOTAL makes a cursor walk duplicate and drop rows.
//
// ⚠ Its OWN database file. The bot fixtures in this directory are order-dependent with exact
// expected counts, so a row added to one of them for this feature would move assertions elsewhere.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_PATH = '/tmp/pierre-bot-volume-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let q: any;
let vol: any;
let scope: any;
let repoA = 0; // the bot-active repo — carries every baseline assertion
let repoB = 0; // the thin repo — one PR per bucket, so every bucket is UNDER the floor
let botCr = 0;
let botGr = 0;
let human = 0;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Second-aligned: sqlite stores mode:'timestamp' as epoch SECONDS.
const now = Math.floor(Date.now() / 1000) * 1000;

const NO_REFINE = { authorUserIds: null };

/** One fixture PR. `rc`/`pc`/`rv` are per-bot comment counts of each of the three text kinds. */
interface PrSpec {
  key: string;
  repo: 'A' | 'B';
  /** additions; deletions is always 0 so `loc` reads straight off this. */
  loc: number;
  changedFiles: number;
  /** Days back from `now` that the PR MERGED — the window anchor. */
  mergedDaysAgo?: number;
  /** Not merged at all: must be invisible to every getter (the population is merged PRs). */
  open?: boolean;
  /** Size never observed — additions/deletions/changedFiles all 0. */
  unsized?: boolean;
  cr?: { rc?: number; pc?: number; rv?: number };
  gr?: { rc?: number; pc?: number; rv?: number };
  /** Human comments — must never be counted. */
  humanRc?: number;
}

// repo A, bucket `xs` (<50 LOC): SIX merged PRs, so the bucket clears BASELINE_MIN_PRS (5).
// Comment counts 15,1,1,1,1,0 → sum 19, mean 3.1667 → 3.17.
// repo A, bucket `m` (200-600): TWO merged PRs — UNDER the floor, so they must fall back to the
// repo mean rather than answering off a two-PR sample.
// repo B: one PR, so both its bucket and the repo itself are under the floor → baseline 'none'.
const PRS: PrSpec[] = [
  // ── repo A / xs ────────────────────────────────────────────────────────────────────────────
  // THE THREE-KINDS ROW: 3 inline + 2 PR-level + 1 review body = 6 from CodeRabbit, plus 9 from
  // Greptile = 15. Drop any kind and this PR (and every aggregate) moves.
  {
    key: 'xs_loud',
    repo: 'A',
    loc: 20,
    changedFiles: 1,
    cr: { rc: 3, pc: 2, rv: 1 },
    gr: { rc: 9 },
    humanRc: 4,
  },
  { key: 'xs_1', repo: 'A', loc: 10, changedFiles: 1, cr: { rc: 1 } },
  { key: 'xs_2', repo: 'A', loc: 10, changedFiles: 1, cr: { rc: 1 } },
  { key: 'xs_3', repo: 'A', loc: 10, changedFiles: 1, cr: { rc: 1 } },
  { key: 'xs_4', repo: 'A', loc: 10, changedFiles: 1, gr: { rc: 1 } },
  // Zero bot comments — the row that makes the two denominators differ.
  { key: 'xs_quiet', repo: 'A', loc: 10, changedFiles: 1, humanRc: 3 },
  // ── repo A / m (200-600): two PRs only ─────────────────────────────────────────────────────
  { key: 'm_1', repo: 'A', loc: 300, changedFiles: 5, cr: { rc: 4 } },
  { key: 'm_2', repo: 'A', loc: 400, changedFiles: 6, cr: { rc: 2 } },
  // ── repo A: the two rows that must be INVISIBLE ────────────────────────────────────────────
  // Merged 40 days ago: outside rolling_30, INSIDE rolling_90 — so the window is proved to be
  // applied rather than the row proved to be broken.
  { key: 'stale', repo: 'A', loc: 15, changedFiles: 1, mergedDaysAgo: 40, cr: { rc: 50 } },
  // Never merged. Loud, so its absence is unmistakable.
  { key: 'open_loud', repo: 'A', loc: 15, changedFiles: 1, open: true, cr: { rc: 60 } },
  // Size never observed: counted in `prs`/`comments`, absent from every bucket and the scatter,
  // and it must answer `expected: null` rather than being dropped into `xs`.
  { key: 'unsized', repo: 'A', loc: 0, changedFiles: 0, unsized: true, cr: { rc: 7 } },
  // ── repo B: one PR, everything under the floor ─────────────────────────────────────────────
  { key: 'b_only', repo: 'B', loc: 25, changedFiles: 1, cr: { rc: 9 } },
];

const prIdOf = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  q = await import('./queries.js');
  vol = await import('./bot-volume.js');
  await runMigrations();

  const { repos, pullRequests, users, reviewThreads, reviewComments, prComments, reviews } = schema;

  const mkRepo = async (name: string, node: string) =>
    (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name, githubNodeId: node })
        .returning()
        .execute()
    )[0].id;
  repoA = await mkRepo('loud', 'R_vol_a');
  repoB = await mkRepo('thin', 'R_vol_b');

  const mkUser = async (login: string, node: string, isBot: boolean) =>
    (
      await db
        .insert(users)
        .values({ githubLogin: login, githubNodeId: node, isBot })
        .returning()
        .execute()
    )[0].id;
  // Both are KNOWN VENDOR LOGINS, so they are automated by the login seed alone — no
  // workspace_reviewers row (and therefore no footprint requirement) is involved.
  botCr = await mkUser('coderabbitai', 'U_vol_cr', true);
  botGr = await mkUser('greptile-apps', 'U_vol_gr', true);
  human = await mkUser('alice', 'U_vol_human', false);

  for (const [i, spec] of PRS.entries()) {
    const repoId = spec.repo === 'A' ? repoA : repoB;
    const mergedAt = spec.open
      ? null
      : new Date(now - (spec.mergedDaysAgo ?? 0) * DAY - (i + 1) * HOUR);
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_vol_${spec.key}`,
        accountId: 1,
        repoId,
        number: i + 1,
        title: `fixture ${spec.key}`,
        state: spec.open ? 'open' : 'merged',
        isDraft: false,
        openedAt: new Date(now - 60 * DAY),
        updatedAt: new Date(now - HOUR),
        mergedAt,
        additions: spec.unsized ? 0 : spec.loc,
        deletions: 0,
        changedFiles: spec.unsized ? 0 : spec.changedFiles,
      })
      .returning()
      .execute();
    prIdOf.set(spec.key, pr.id);

    const at = new Date(now - (spec.mergedDaysAgo ?? 0) * DAY - (i + 1) * HOUR - 30 * 60 * 1000);
    // One thread per (PR, author) — review comments hang off it, which is also how sync writes
    // them. The getter reads `review_comments.pr_id` directly, and this keeps the two consistent.
    const mkThread = async (owner: number, tag: string) =>
      (
        await db
          .insert(reviewThreads)
          .values({
            githubNodeId: `T_vol_${spec.key}_${tag}`,
            prId: pr.id,
            path: 'src/a.ts',
            line: 1,
            isResolved: false,
            isOutdated: false,
            derivedState: 'untouched',
            originalCommenterId: owner,
            createdAt: at,
          })
          .returning()
          .execute()
      )[0].id;

    const seedFor = async (
      authorId: number,
      tag: string,
      counts: { rc?: number; pc?: number; rv?: number } | undefined,
    ) => {
      if (!counts) return;
      if (counts.rc) {
        const threadId = await mkThread(authorId, tag);
        for (let n = 0; n < counts.rc; n++) {
          await db
            .insert(reviewComments)
            .values({
              githubNodeId: `RC_vol_${spec.key}_${tag}_${n}`,
              threadId,
              prId: pr.id,
              authorId,
              body: `inline ${n}`,
              createdAt: at,
            })
            .execute();
        }
      }
      for (let n = 0; n < (counts.pc ?? 0); n++) {
        await db
          .insert(prComments)
          .values({
            githubNodeId: `PC_vol_${spec.key}_${tag}_${n}`,
            prId: pr.id,
            authorId,
            body: `pr-level ${n}`,
            createdAt: at,
          })
          .execute();
      }
      for (let n = 0; n < (counts.rv ?? 0); n++) {
        await db
          .insert(reviews)
          .values({
            githubNodeId: `RV_vol_${spec.key}_${tag}_${n}`,
            prId: pr.id,
            authorId,
            state: 'commented',
            body: `review body ${n}`,
            submittedAt: at,
          })
          .execute();
      }
    };
    await seedFor(botCr, 'cr', spec.cr);
    await seedFor(botGr, 'gr', spec.gr);
    await seedFor(human, 'hu', spec.humanRc ? { rc: spec.humanRc } : undefined);
  }

  // A DRAFT review by a bot on the loudest PR: `state: 'pending'` is invisible on GitHub and must
  // be excluded, so this row proves the predicate rather than merely not breaking it.
  await db
    .insert(reviews)
    .values({
      githubNodeId: 'RV_vol_pending',
      prId: prIdOf.get('xs_loud'),
      authorId: botCr,
      state: 'pending',
      body: 'draft, never submitted',
      submittedAt: new Date(now - HOUR),
    })
    .execute();

  // ⚠ Through the production resolver (ensureRepoMemberships), never hand-built.
  scope = await q.resolveWorkspaceScope(1, null);
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const volume = (opts: { window?: string; sc?: any } = {}) =>
  vol.getBotVolume(1, opts.window ?? 'rolling_30', opts.sc ?? scope);

const prPage = (
  opts: { window?: string; sc?: any; refine?: any; offset?: number; limit?: number; sort?: string } = {},
) =>
  vol.getPrBotVolume(1, opts.window ?? 'rolling_30', opts.sc ?? scope, opts.refine ?? NO_REFINE, {
    offset: opts.offset ?? 0,
    limit: opts.limit ?? 50,
    sort: opts.sort ?? 'comments',
  });

const scatter = (opts: { window?: string; sc?: any } = {}) =>
  vol.getBotVolumeScatter(1, opts.window ?? 'rolling_30', opts.sc ?? scope);

// The in-window merged population: every PR except `stale` (40d back) and `open_loud`.
const IN_WINDOW = PRS.filter((p) => !p.open && (p.mergedDaysAgo ?? 0) < 30);
const TOTAL_PRS = IN_WINDOW.length; // 10
const TOTAL_COMMENTS = IN_WINDOW.reduce(
  (n, p) =>
    n +
    (p.cr?.rc ?? 0) + (p.cr?.pc ?? 0) + (p.cr?.rv ?? 0) +
    (p.gr?.rc ?? 0) + (p.gr?.pc ?? 0) + (p.gr?.rv ?? 0),
  0,
); // 15 + 1+1+1+1 + 0 + 4+2 + 7 + 9 = 41

describe('getBotVolume — the per-bot column', () => {
  it('counts ALL THREE bot text kinds and no human text', async () => {
    const r = await volume();
    // 3 inline + 2 PR-level + 1 review body from CodeRabbit, + 9 inline from Greptile, on the one
    // PR. The 4 human inline comments and the pending draft review are both invisible.
    const loudId = prIdOf.get('xs_loud');
    const page = await prPage({ limit: 50 });
    const loud = page.items.find((i: any) => i.prId === loudId);
    expect(loud.botComments).toBe(15);
    expect(loud.byBot.find((b: any) => b.authorUserId === botCr).comments).toBe(6);
    expect(loud.byBot.find((b: any) => b.authorUserId === botGr).comments).toBe(9);
    expect(r.totals.comments).toBe(TOTAL_COMMENTS);
    expect(r.totals.comments).toBe(41);
    // A human is never a bot here no matter how much they say.
    expect(r.bots.some((b: any) => b.authorUserId === human)).toBe(false);
  });

  it('excludes open PRs and PRs merged outside the window (the population is MERGED PRs)', async () => {
    const r = await volume();
    expect(r.totals.prs).toBe(TOTAL_PRS);
    expect(r.totals.prs).toBe(10);
    // `stale` alone carries 50 comments and `open_loud` 60 — either leaking would be unmissable.
    expect(r.totals.comments).toBe(41);
    // Widening the window to 90 days pulls `stale` in and leaves `open_loud` out forever.
    const wide = await volume({ window: 'rolling_90' });
    expect(wide.totals.prs).toBe(11);
    expect(wide.totals.comments).toBe(91);
  });

  it('names its two denominators apart and computes each over its own population', async () => {
    const r = await volume();
    // 10 merged PRs in scope; `xs_quiet` has no bot comment at all, so the two differ.
    expect(r.totals.prs).toBe(10);
    expect(r.totals.prsWithBotComments).toBe(9);
    expect(r.totals.prsWithNoBotComments).toBe(1);
    expect(r.totals.avgCommentsPerScopePr).toBe(4.1); // 41 / 10
    expect(r.totals.avgCommentsPerCommentedPr).toBe(4.56); // 41 / 9
    // Per bot: Greptile said 9 + 1 = 10 across 2 PRs, out of 10 merged PRs in scope.
    const gr = r.bots.find((b: any) => b.authorUserId === botGr);
    expect(gr.comments).toBe(10);
    expect(gr.prsCommentedOn).toBe(2);
    expect(gr.avgCommentsPerCommentedPr).toBe(5); // 10 / 2
    expect(gr.avgCommentsPerScopePr).toBe(1); // 10 / 10
    // ⚠ The whole point: 5× apart on the same bot. A surface that shows one under the other's
    // caption is off by that factor with nothing on screen to reveal it.
    expect(gr.avgCommentsPerCommentedPr).not.toBe(gr.avgCommentsPerScopePr);
    expect(gr.maxCommentsOnOnePr).toBe(9);
  });

  it('returns rows most-comments-first and carries per-bot identity', async () => {
    const r = await volume();
    expect(r.bots.map((b: any) => b.authorUserId)).toEqual([botCr, botGr]);
    expect(r.bots[0].key).toBe(`u${botCr}`);
    expect(r.bots[0].login).toBe('coderabbitai');
    expect(r.bots[0].kind).toBe('coderabbit');
    expect(r.bots[0].role).toBe('review');
  });

  it('early-returns on an EMPTY scope rather than widening to the account', async () => {
    const empty = await volume({ sc: { workspaceId: scope.workspaceId, repoIds: [] } });
    expect(empty.totals.prs).toBe(0);
    expect(empty.totals.comments).toBe(0);
    expect(empty.bots).toEqual([]);
    expect(empty.workspaceId).toBe(scope.workspaceId);
    // The same rule on both of its siblings.
    const p = await prPage({ sc: { workspaceId: scope.workspaceId, repoIds: [] } });
    expect(p.total).toBe(0);
    expect(p.filteredTotal).toBe(0);
    expect(p.items).toEqual([]);
    const s = await scatter({ sc: { workspaceId: scope.workspaceId, repoIds: [] } });
    expect(s.points).toEqual([]);
    expect(s.sizedPrs).toBe(0);
    expect(s.buckets).toHaveLength(5); // still dense — an empty scope is a shape, not a gap
  });
});

describe('getPrBotVolume — the drill-down, its baseline and its sorts', () => {
  it('lists only PRs the bot set touched, but reports the whole population as `total`', async () => {
    const r = await prPage();
    expect(r.total).toBe(10); // every merged PR in the window
    expect(r.filteredTotal).toBe(9); // `xs_quiet` drew nothing and is not a row
    expect(r.items.some((i: any) => i.prId === prIdOf.get('xs_quiet'))).toBe(false);
  });

  it('uses the repo × size-bucket mean when the bucket clears the floor', async () => {
    const r = await prPage();
    const loud = r.items.find((i: any) => i.prId === prIdOf.get('xs_loud'));
    // ⚠ THE BASELINE SPANS 90 DAYS, NOT THE 30-DAY DISPLAY WINDOW. repo A / xs holds SIX PRs
    // inside the window (15,1,1,1,1,0) plus `stale` (50, merged 40 days ago) → SEVEN PRs,
    // 69/7 = 9.857 → 9.86. `stale` conditions the expectation without ever appearing as a row —
    // which is the whole point of the wider span, and is pinned below by `filteredTotal`.
    expect(loud.sizeBucket).toBe('xs');
    expect(loud.baseline).toBe('bucket');
    expect(loud.baselinePrs).toBe(7);
    expect(loud.expected).toBe(9.86);
    expect(loud.ratio).toBe(1.52); // 15 / 9.86
    expect(loud.loc).toBe(20);
    expect(loud.changedFiles).toBe(1);
    expect(loud.commentsPer100Loc).toBe(75); // 15 / 20 × 100 — shipped, never the sort
  });

  it('THE SMALL-SAMPLE GUARD: a bucket under the floor falls back to the repo mean, and says so', async () => {
    const r = await prPage();
    const m1 = r.items.find((i: any) => i.prId === prIdOf.get('m_1'));
    // repo A / m holds TWO PRs. Their own mean would be 3.0 and would put `m_1` at a tidy 1.33×
    // — computed off a two-PR sample, which is noise dressed as a finding.
    expect(m1.sizeBucket).toBe('m');
    expect(m1.baseline).toBe('repo');
    // The repo fallback averages EVERY merged PR of repo A over the BASELINE SPAN (10 of them,
    // 82 comments — the 9 in-window PRs plus `stale`), deliberately including the unsized one:
    // it is explicitly not size-conditioned.
    expect(m1.baselinePrs).toBe(10);
    expect(m1.expected).toBe(8.2); // 82 / 10
    expect(m1.ratio).toBe(0.49); // 4 / 8.2
    // ⚠ The disclosure is what makes it usable: a UI can only caption "vs this repo's average"
    // instead of "vs PRs this size" because `baseline` says which one it got.
    expect(m1.baseline).not.toBe('bucket');
  });

  it('answers NO BASELINE rather than a ratio when even the repo is under the floor', async () => {
    const r = await prPage();
    const b = r.items.find((i: any) => i.prId === prIdOf.get('b_only'));
    // repo B has ONE merged PR. Its bucket mean and its repo mean would both be 9 — i.e. exactly
    // 1.00×, the most misleading possible answer, since it is the PR comparing to itself.
    expect(b.baseline).toBe('none');
    expect(b.expected).toBeNull();
    expect(b.ratio).toBeNull();
    expect(b.baselinePrs).toBe(0);
    // The wire can tell this apart from a genuine 1.0 — which is the whole requirement.
    expect(b.ratio).not.toBe(1);
  });

  it('gives an UNSIZED PR no bucket and no baseline — never a fabricated 0 LOC', async () => {
    const r = await prPage();
    const u = r.items.find((i: any) => i.prId === prIdOf.get('unsized'));
    expect(u.loc).toBeNull();
    expect(u.changedFiles).toBeNull();
    expect(u.sizeBucket).toBeNull();
    expect(u.baseline).toBe('none');
    expect(u.expected).toBeNull();
    expect(u.ratio).toBeNull();
    expect(u.commentsPer100Loc).toBeNull();
    // Its comments still count towards the totals — it is unmeasurable, not absent.
    expect(u.botComments).toBe(7);
  });

  it('sorts by raw comments DESC by default, and by ratio DESC on request', async () => {
    const byComments = await prPage({ sort: 'comments' });
    expect(byComments.sort).toBe('comments');
    expect(byComments.items[0].prId).toBe(prIdOf.get('xs_loud')); // 15
    expect(byComments.items.map((i: any) => i.botComments)).toEqual([15, 9, 7, 4, 2, 1, 1, 1, 1]);

    const byRatio = await prPage({ sort: 'ratio' });
    expect(byRatio.sort).toBe('ratio');
    // `xs_loud` leads both here (4.5×), but the ORDER BELOW IT DIFFERS: `b_only` has 9 comments
    // and is second by count, while its missing baseline drops it to LAST by ratio.
    expect(byRatio.items[0].prId).toBe(prIdOf.get('xs_loud'));
    expect(byRatio.items[1].prId).not.toBe(prIdOf.get('b_only'));
    // Rows with NO ratio sort LAST — an unmeasurable PR is not a below-average one.
    const tail = byRatio.items.slice(-2).map((i: any) => i.ratio);
    expect(tail.every((x: number | null) => x === null)).toBe(true);
    expect(byRatio.items.filter((i: any) => i.ratio != null).map((i: any) => i.ratio)).toEqual(
      [...byRatio.items.filter((i: any) => i.ratio != null).map((i: any) => i.ratio)].sort(
        (a: number, b: number) => b - a,
      ),
    );
  });

  it('pages with a TOTAL comparator: a cursor walk is exhaustive and duplicate-free', async () => {
    // Four of the fixture rows tie at 1 comment, so an unstable comparator shows up here.
    for (const sort of ['comments', 'ratio']) {
      const seen: number[] = [];
      let offset = 0;
      for (;;) {
        const p = await prPage({ sort, offset, limit: 2 });
        seen.push(...p.items.map((i: any) => i.prId));
        if (!p.nextCursor) break;
        const m = /^o:(\d+)$/.exec(p.nextCursor);
        expect(m).not.toBeNull();
        const next = Number(m![1]);
        // A cursor that does not advance is what a `while (nextCursor)` loop turns into a hang.
        expect(next).toBeGreaterThan(offset);
        offset = next;
      }
      expect(seen).toHaveLength(9);
      expect(new Set(seen).size).toBe(9);
    }
  });

  it('refine.authorUserIds narrows the count AND moves the baseline with it', async () => {
    const r = await prPage({ refine: { authorUserIds: [botGr] } });
    // Only the two PRs Greptile touched are rows now.
    expect(r.total).toBe(10); // the population is unchanged
    expect(r.filteredTotal).toBe(2);
    const loud = r.items.find((i: any) => i.prId === prIdOf.get('xs_loud'));
    expect(loud.botComments).toBe(9); // Greptile's 9, not the PR's 15
    expect(loud.byBot).toHaveLength(1);
    // ⚠ THE BASELINE MOVED WITH IT. repo A / xs under Greptile alone is (9,0,0,0,1,0) plus
    // `stale` (Greptile wrote none of its 50) → 10/7 = 1.4286 → 1.43, not the all-bots 9.86.
    // Comparing one bot's count against every bot's expectation would read 0.91× here.
    expect(loud.expected).toBe(1.43);
    // …AND THE EXPECTATION FLOOR THEN SUPPRESSES THE MULTIPLIER. 1.43 is under
    // BASELINE_MIN_EXPECTED, so dividing by it would turn Greptile's 9 comments into a 6.3×
    // "finding" off an expectation of one-and-a-bit. The row still reports what it was measured
    // against; it just declines to make a claim.
    expect(loud.baseline).toBe('low_expectation');
    expect(loud.ratio).toBeNull();
    expect(loud.baselinePrs).toBe(7);
  });

  it('THE EXPECTATION FLOOR: a well-sampled but near-silent cell yields no ratio, and says which', async () => {
    // The floor is on the EXPECTED COUNT, not the sample size — the two failure modes are
    // different facts and the wire keeps them apart. Measured motivation (erxes/30d): a `<50`
    // cell held 43 merged PRs at a mean of 0.9, where a single PR drawing 4 comments read 4.4×;
    // across 43 PRs you expect about one such row from Poisson noise alone.
    const r = await prPage({ refine: { authorUserIds: [botGr] } });
    const loud = r.items.find((i: any) => i.prId === prIdOf.get('xs_loud'));
    // Well sampled — this is NOT the small-sample guard firing.
    expect(loud.baselinePrs).toBeGreaterThanOrEqual(5);
    expect(loud.baseline).toBe('low_expectation');
    expect(loud.baseline).not.toBe('none'); // "plenty of peers, all quiet" ≠ "no peers"
    // `expected` SURVIVES so the UI can show what it was compared against; only the multiplier
    // is withheld. Withholding both would read as missing data rather than a measured fact.
    expect(loud.expected).toBe(1.43);
    expect(loud.ratio).toBeNull();
  });

  it('THE BASELINE SPAN IS 90 DAYS WHILE THE LIST STAYS IN-WINDOW', async () => {
    // The one property the whole widening exists for: `stale` (merged 40 days ago) must condition
    // every expectation without ever being listed, counted or totalled under a 30-day heading.
    const r = await prPage();
    expect(r.total).toBe(10); // the WINDOW's merged population, unchanged by the wider scan
    expect(r.items.some((i: any) => i.prId === prIdOf.get('stale'))).toBe(false);
    const loud = r.items.find((i: any) => i.prId === prIdOf.get('xs_loud'));
    expect(loud.baselinePrs).toBe(7); // 6 in-window + `stale`
    // And the aggregate half agrees: totals stay in-window even though the scan reached past it.
    const v = await volume();
    expect(v.totals.prs).toBe(10);
    expect(v.totals.comments).toBe(41); // `stale`'s 50 would be unmissable
  });

  it('an EMPTY authorUserIds list means NO bots, never every bot', async () => {
    const r = await prPage({ refine: { authorUserIds: [] } });
    expect(r.total).toBe(10);
    expect(r.filteredTotal).toBe(0);
    expect(r.items).toEqual([]);
    // Only `null` widens.
    const wide = await prPage({ refine: { authorUserIds: null } });
    expect(wide.filteredTotal).toBe(9);
  });
});

describe('getBotVolumeScatter — the LOC chart series', () => {
  it('emits one point per SIZED merged PR and discloses the unsized ones', async () => {
    const s = await scatter();
    expect(s.sizedPrs).toBe(9);
    expect(s.unsizedPrs).toBe(1);
    expect(s.points).toHaveLength(9);
    expect(s.truncated).toBe(false);
    expect(s.points.some((p: any) => p.prId === prIdOf.get('unsized'))).toBe(false);
    const loud = s.points.find((p: any) => p.prId === prIdOf.get('xs_loud'));
    expect(loud).toEqual({
      prId: prIdOf.get('xs_loud'),
      repoId: repoA,
      loc: 20,
      changedFiles: 1,
      botComments: 15,
    });
  });

  it('returns a DENSE bucket table whose means fold the same counts as the column', async () => {
    const s = await scatter();
    expect(s.buckets.map((b: any) => b.bucket)).toEqual(['xs', 's', 'm', 'l', 'xl']);
    const xs = s.buckets.find((b: any) => b.bucket === 'xs');
    // repo A's six xs PRs + repo B's one = 7 PRs, 19 + 9 = 28 comments.
    expect(xs.prs).toBe(7);
    expect(xs.comments).toBe(28);
    expect(xs.avgComments).toBe(4);
    expect(xs.minLoc).toBe(0);
    expect(xs.maxLoc).toBe(50);
    expect(xs.label).toBe('<50');
    // An empty bucket is PRESENT with null means — a gap in the curve must be a gap in the data,
    // never an omitted key the chart has to guess about.
    const l = s.buckets.find((b: any) => b.bucket === 'l');
    expect(l.prs).toBe(0);
    expect(l.avgComments).toBeNull();
    expect(l.commentsPer100Loc).toBeNull();
    const xl = s.buckets.find((b: any) => b.bucket === 'xl');
    expect(xl.maxLoc).toBeNull(); // open-ended top
    // The bucket totals must reconcile with the column's, or the chart and the table disagree.
    const col = await volume();
    const bucketed = s.buckets.reduce((n: number, b: any) => n + b.comments, 0);
    expect(bucketed + 7).toBe(col.totals.comments); // +7 = the unsized PR, absent from every bucket
  });
});
