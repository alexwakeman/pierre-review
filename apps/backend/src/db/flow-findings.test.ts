// The Bottlenecks engine's CODE-DERIVED EVIDENCE, on a THROWAWAY sqlite DB (the
// work-plan.test.ts / ci-failing-cards.test.ts pattern).
//
// WHAT THIS PINS, and why each one is worth a fixture rather than a comment:
//
//   1. ⚠ THE CALIBRATION TRAP — THE LOAD-BEARING ONE. A pull request whose `mergeStateStatus` is
//      'blocked' is waiting on REQUIRED CHECKS, not on people; counting it turns `approval_parked`
//      into a CI finding wearing a review-flow costume, on exactly the pull requests an EM would
//      most want to trust. The 'Parked' workspace is built so the exclusion is visible in the
//      NUMBER: with it, the slow repo's median is 40h against a 21h workspace baseline; without
//      it, 220h against 40h. Both figures are asserted, so deleting the predicate fails loudly
//      rather than shifting a number nobody re-derives. The OPEN half is pinned the same way —
//      READY_MERGE_STATES says 'unstable' IS mergeable and 'behind' is NOT, and a 'conflicting'
//      pull request is waiting on its author, so the fixture seats one of each and asserts the
//      templated detail counts EXACTLY ONE.
//   1b. ⚠ AND ITS HONEST LIMIT, WHICH IS WHY 'Parked' IS NOT THE ONLY PARKED FIXTURE. GITHUB STOPS
//      COMPUTING `mergeStateStatus` ONCE A PULL REQUEST MERGES: of this install's 5,507 merged
//      rows, 5,478 read 'unknown', 27 'dirty', 2 'clean' and ZERO 'blocked' — while 553 OPEN ones
//      do carry it. So on real data the MERGED half's exclusion fires on nothing, and the row's
//      detail and both refusals used to tell the reader it had applied. The 'PostMerge' workspace
//      is every merged row at 'unknown' — nothing excluded, the normal case — and asserts the
//      sentences make no exclusion claim while the 40h wait is plainly still inside the figure.
//      (CI history is not a usable substitute and was measured before the claim was dropped: as a
//      predictor of live 'blocked' it is 41% precise and 29% recall, and its coverage inside the
//      approve→merge gap ranges 0%–66% BY REPO — the very axis this finding compares.)
//   2. TWO REFUSAL PATHS, BY NAME. An absent section reads as "we checked and there's nothing
//      here", which is a much stronger claim than "not enough data to say" — so a kind that
//      cannot clear its floor must produce a `FlowFindingRefusal`, never an empty list and never
//      a zero row. 'Thin' misses every floor with real data in it; 'Empty' has no repos at all.
//   3. VALUE AND BASELINE SHARE A UNIT. Asserted structurally for every emitted row (declared
//      unit per kind, and `value > baseline` — the emission predicate guarantees it), and then
//      numerically: `round_trips` reports 4 comments against 1 comment, `size_latency` reports
//      24h against 4h. An hours-vs-comments mixup shows up in the numbers, not just the types.
//   4. THE SUBJECT IS THE FLOW, NEVER A PERSON. Every row's `subjectKind` is path/repo/size_band,
//      `size_latency` carries its big-PR authors as `actorIds` only, and `round_trips` carries
//      none at all.
//   5. THE HUMAN LANE IS THE LANE RESOLVER'S, ON BOTH SIDES OF EVERY RATIO. Every hot thread
//      carries a BOT comment on top of its four human ones; if the lane filter were dropped the
//      round-trip median would read 5. And the 'Sizes' workspace pins the same rule on the size
//      row's AUTHOR EVIDENCE: 30 Dependabot bumps sit under the same first-read latency as the
//      humans, so a workspace size median taken over every pull request reads 15 lines where the
//      human one reads 220 — halving the FLOW_BIG_AUTHOR_RATIO bar and naming two engineers whose
//      changes are ordinary here. Naming a person is the one thing this file is least allowed to
//      get wrong.
//   6. TWO DIFFERENT TRUNCATIONS, TWO DIFFERENT FIELDS. `filesTruncatedPrs` is a claim about PATH
//      ATTRIBUTION on individual pull requests (one 'Flow' row stores fewer files than it
//      changed); `truncated` is the much stronger claim that A ROW SCAN STOPPED EARLY, so every
//      median covers only part of the window. Folding the first into the second made a 262-PR
//      workspace announce a window problem it did not have.
//   7. A CAP INSIDE A SHARED FOLD IS STILL THIS FILE'S TRUNCATION. `loadFirstHumanReviewHours`
//      breaks at PERIOD_FIRST_REVIEW_PR_CAP (5,000 candidate pull requests) and returns a bare
//      array, so nothing here could tell a cut fold from a complete one and `coverage.truncated`
//      read false on a fold that had covered a prefix of the window. The 'FoldCap' workspace seats
//      exactly that many, in a shape that trips NO other cap — so the flag can only come from the
//      fold's own report.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load) —
// a STATIC import of any module that reaches db/client.ts, placed above these lines, connects too
// early and every query lands on the real database.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlowFinding, FlowFindingKind, FlowFindingsResponse } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-flow-findings-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let flow: any;

/** The rich fixture: two repos, one concentrated + slow, one shared + fast. */
let flowScope: any;
/** The approve→merge fixture, including the CI-blocked rows that must never count. */
let parkedScope: any;
/** The approve→merge fixture as GitHub ACTUALLY leaves it after a merge: every row 'unknown', so
 *  the merged half's exclusion filters exactly nothing and the copy may not claim it did. */
let postMergeScope: any;
/** The same, below FLOW_MIN_REPO_APPROVED — the only route to this kind's floor-miss refusal. */
let postMergeThinScope: any;
/** The size row's author evidence, with a dependency bot's bumps sitting in the same window. */
let sizeScope: any;
/** PERIOD_FIRST_REVIEW_PR_CAP's worth of reviewed pull requests and nothing else — the ONE fold's
 *  own truncation, in a shape that trips no other cap. */
let foldCapScope: any;
/** The 'calm' repo ALONE: every floor CLEARED, no emit bar crossed. The distinct second refusal
 *  state, and the one that shipped silent. */
let calmScope: any;
/** Real data, every floor missed — the refusal fixture. */
let thinScope: any;
/** No repos at all. */
let emptyScope: any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Whole seconds: sqlite stores these as unix-epoch INTEGERS, so a sub-second component would be
// truncated on write and could turn an intended "exactly 24h" into 23.9997h.
const now = Math.floor(Date.now() / 1000) * 1000;

const HOT_PRS = 12;
const CALM_PRS = 24;
const SHARED_PRS = 12;
const PARKED_PER_REPO = 6;
/** The 'Sizes' population. The bumps outnumber every human cohort, which is what a real bot-heavy
 *  workspace looks like and what makes an all-pull-request median describe nobody. */
const BUMP_PRS = 30;
const HARRY_PRS = 12;
const FRANK_PRS = 8;
const GRACE_PRS = 8;
/** = `PERIOD_FIRST_REVIEW_PR_CAP` in db/period-metrics.ts (file-private there). The fold breaks at
 *  exactly this many candidate pull requests, so this many is what the fixture seats. */
const FIRST_REVIEW_PR_CAP = 5_000;

const prIdByKey = new Map<string, number>();
const repoIdByKey = new Map<string, number>();
const pr = (key: string): number => prIdByKey.get(key)!;

let aliceId = 0;
let bobId = 0;
let carolId = 0;
let daveId = 0;
let erinId = 0;
let botId = 0;
let frankId = 0;
let graceId = 0;
let harryId = 0;
/** A DEPENDENCY bot specifically: `roleForBotLogin('dependabot[bot]')` files it in the
 *  `dependency` lane, which is the real actor the size row's comment names. */
let depBotId = 0;

async function findings(scope: any, days = 30): Promise<FlowFindingsResponse> {
  return flow.getFlowFindings(1, scope, days);
}
const ALL_KINDS = [
  'single_reviewer_path',
  'approval_parked',
  'size_latency',
  'round_trips',
] as const satisfies readonly FlowFindingKind[];

const of = (resp: FlowFindingsResponse, kind: FlowFindingKind): FlowFinding[] =>
  resp.findings.filter((f) => f.kind === kind);
const refusalFor = (resp: FlowFindingsResponse, kind: FlowFindingKind): string | undefined =>
  resp.refusals.find((r) => r.kind === kind)?.reason;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  flow = await import('./flow-findings.js');

  const { pullRequests, repos, reviewComments, reviewThreads, reviews, users } = schema;

  const insertUser = async (login: string, isBot: boolean): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_flow_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  // Plain human logins: `roleForBotLogin` must not recognise any of them, or the lane resolver
  // would file a reviewer as automation and every human-only fold would silently empty.
  aliceId = await insertUser('alice-dev', false);
  bobId = await insertUser('bob-dev', false);
  carolId = await insertUser('carol-dev', false);
  daveId = await insertUser('dave-dev', false);
  erinId = await insertUser('erin-dev', false);
  frankId = await insertUser('frank-dev', false);
  graceId = await insertUser('grace-dev', false);
  harryId = await insertUser('harry-dev', false);
  botId = await insertUser('flowbot[bot]', true);
  depBotId = await insertUser('dependabot[bot]', true);

  const insertRepo = async (key: string): Promise<number> => {
    const [row] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name: key,
        githubNodeId: `R_flow_${key}`,
        defaultBranch: 'main',
        createdAt: new Date(now - 200 * DAY),
      })
      .returning()
      .execute();
    repoIdByKey.set(key, row.id);
    return row.id;
  };

  let n = 1;
  const insertPr = async (
    repoId: number,
    key: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [row] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_flow_${key}`,
        accountId: 1,
        repoId,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 60 * HOUR),
        updatedAt: new Date(now - HOUR),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, row.id);
    return row.id;
  };

  let rv = 1;
  const review = async (
    prId: number,
    authorId: number,
    state: 'approved' | 'commented',
    submittedAt: number,
  ): Promise<void> => {
    await db
      .insert(reviews)
      .values({
        githubNodeId: `RV_flow_${rv++}`,
        prId,
        authorId,
        state,
        submittedAt: new Date(submittedAt),
      })
      .execute();
  };

  let th = 1;
  let rc = 1;
  /** One thread with `humanComments` human comments plus, optionally, a BOT comment on top. */
  const thread = async (
    prId: number,
    path: string,
    humanComments: number,
    withBot: boolean,
  ): Promise<void> => {
    const [t] = await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `TH_flow_${th++}`,
        prId,
        path,
        isResolved: false,
        derivedState: 'replied_unresolved',
        originalCommenterId: aliceId,
        createdAt: new Date(now - 10 * DAY),
      })
      .returning()
      .execute();
    const humans = [aliceId, bobId, carolId, daveId];
    for (let i = 0; i < humanComments; i++) {
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: `RC_flow_${rc++}`,
          threadId: t.id,
          prId,
          authorId: humans[i % humans.length],
          body: 'x',
          createdAt: new Date(now - 10 * DAY + i * HOUR),
        })
        .execute();
    }
    if (withBot) {
      await db
        .insert(reviewComments)
        .values({
          githubNodeId: `RC_flow_${rc++}`,
          threadId: t.id,
          prId,
          authorId: botId,
          body: 'automated',
          createdAt: new Date(now - 10 * DAY + 12 * HOUR),
        })
        .execute();
    }
  };

  // ══ 'Flow': single_reviewer_path + size_latency + round_trips ═══════════════════════════════
  //
  // `hot`    — 12 large (800-line) PRs under src/**, first human read at 24h, alice takes 10 of
  //            the 12 reviews. THE POSITIVE for all three kinds.
  // `calm`   — 24 tiny (20-line) PRs under docs/**, read in 4h, bob and carol split the reviews
  //            50/50. The LATENCY control: concentrated enough to matter? no — and fast anyway.
  // `shared` — 12 medium (300-line) PRs under pkg/**, read in 20h, reviews split THREE ways.
  //            ⚠ THE CONCENTRATION CONTROL, and the reason it exists: `calm` is excluded by the
  //            latency bar alone, so with only two repos the concentration bar could be deleted
  //            and every assertion here would still pass. `pkg/**` is materially slower than the
  //            workspace (20h against 12h) and clears every floor — the ONLY thing keeping it out
  //            of the findings is the 60% share test.
  //
  // The sizes are chosen so the workspace medians (12h first read, 160 lines, 1 comment/thread)
  // sit where no single repo sets them, and so the largest band is also strictly the slowest.
  const hot = await insertRepo('hot');
  const calm = await insertRepo('calm');
  const shared = await insertRepo('shared');
  for (let i = 0; i < HOT_PRS; i++) {
    const key = `h${i}`;
    // ONE pull request stores fewer files than it changed — the sync query's `files(first: 100)`
    // cap, which lands hardest on exactly the big pull requests this feature cares about.
    const truncated = i === 0;
    await insertPr(hot, key, {
      authorId: daveId,
      additions: 500,
      deletions: 300,
      changedFiles: truncated ? 250 : 1,
      files: [{ path: 'src/api/handler.ts', additions: 500, deletions: 300 }],
    });
    // alice reviews ten, bob two → 10/12 = 83% concentration.
    await review(pr(key), i < 10 ? aliceId : bobId, 'commented', now - 36 * HOUR);
    // Four human comments, plus a bot one that must NOT enter the round-trip median.
    await thread(pr(key), 'src/api/handler.ts', 4, true);
  }
  for (let i = 0; i < CALM_PRS; i++) {
    const key = `c${i}`;
    await insertPr(calm, key, {
      authorId: aliceId,
      additions: 10,
      deletions: 10,
      changedFiles: 1,
      files: [{ path: 'docs/guide.md', additions: 10, deletions: 10 }],
      openedAt: new Date(now - 20 * HOUR),
    });
    // bob and carol split them 12/12 → 50%, under the concentration bar. The NEGATIVE control:
    // docs/** clears every floor and is deliberately not a finding.
    await review(pr(key), i % 2 === 0 ? bobId : carolId, 'commented', now - 16 * HOUR);
    await thread(pr(key), 'docs/guide.md', 1, false);
  }
  for (let i = 0; i < SHARED_PRS; i++) {
    const key = `s${i}`;
    await insertPr(shared, key, {
      authorId: erinId,
      additions: 200,
      deletions: 100,
      changedFiles: 1,
      files: [{ path: 'pkg/core/index.ts', additions: 200, deletions: 100 }],
      openedAt: new Date(now - 40 * HOUR),
    });
    // Three reviewers, four each → a 33% top share. SLOW (20h) but not owned by anybody.
    await review(pr(key), [bobId, carolId, daveId][i % 3]!, 'commented', now - 20 * HOUR);
    await thread(pr(key), 'pkg/core/index.ts', 1, false);
  }

  // ══ 'Parked': approve → merge, and the CI-blocked rows that must never count ════════════════
  const pFast = await insertRepo('parked-fast');
  const pSlow = await insertRepo('parked-slow');
  /** A merged pull request approved `waitHours` before it landed. */
  const merged = async (
    repoId: number,
    key: string,
    waitHours: number,
    mergeStateStatus: string | null,
  ): Promise<void> => {
    const mergedAt = now - 5 * DAY;
    await insertPr(repoId, key, {
      authorId: daveId,
      state: 'merged',
      mergedAt: new Date(mergedAt),
      openedAt: new Date(mergedAt - 30 * DAY),
      mergeStateStatus,
    });
    await review(pr(key), aliceId, 'approved', mergedAt - waitHours * HOUR);
  };
  for (let i = 0; i < PARKED_PER_REPO; i++) await merged(pFast, `pf${i}`, 2, 'clean');
  for (let i = 0; i < PARKED_PER_REPO; i++) await merged(pSlow, `ps${i}`, 40, null);
  // ⚠ THE TRAP. Six more merged pull requests in the SAME repo, each with a far longer
  // approve→merge gap, whose last observed merge state was 'blocked' — i.e. required checks, not
  // people. Including them would move the repo median 40h → 220h and the workspace baseline
  // 21h → 40h, which is precisely the wrong number in precisely the most convincing place.
  for (let i = 0; i < PARKED_PER_REPO; i++) await merged(pSlow, `pb${i}`, 400, 'blocked');

  // The OPEN snapshot: exactly ONE of these five is "approved and landable right now".
  const openPr = async (key: string, values: Record<string, unknown>, approved: boolean) => {
    await insertPr(pSlow, key, { authorId: daveId, state: 'open', ...values });
    if (approved) await review(pr(key), aliceId, 'approved', now - 3 * DAY);
  };
  // POSITIVE: 'unstable' IS mergeable — only NON-required checks are red.
  await openPr('po-unstable', { mergeStateStatus: 'unstable', mergeable: 'mergeable' }, true);
  // NEGATIVE: waiting on required checks — the whole point of this finding's calibration.
  await openPr('po-blocked', { mergeStateStatus: 'blocked', mergeable: 'mergeable' }, true);
  // NEGATIVE: GitHub 405s a merge from 'behind'.
  await openPr('po-behind', { mergeStateStatus: 'behind', mergeable: 'mergeable' }, true);
  // NEGATIVE, and the sharpest: a READY merge state with `mergeable: 'conflicting'`. Only the
  // conflicting guard excludes it; without this row the guard could be deleted unnoticed.
  await openPr('po-conflicting', { mergeStateStatus: 'clean', mergeable: 'conflicting' }, true);
  // NEGATIVE: landable, but nobody approved it — it is not "parked after review".
  await openPr('po-unapproved', { mergeStateStatus: 'clean', mergeable: 'mergeable' }, false);

  // ══ 'PostMerge': the merge state GitHub ACTUALLY leaves behind ══════════════════════════════
  //
  // The same arithmetic as 'Parked' (six 2h waits against six 40h ones → a 40h row on a 21h
  // baseline) with ONE difference: every merged row carries 'unknown' rather than a live state.
  // That is not a contrived value — it is what 5,478 of this install's 5,507 merged pull requests
  // carry, because GitHub stops computing `mergeStateStatus` on merge. So the merged half's
  // `!== 'blocked'` filter excludes EXACTLY NOTHING here, which is the ordinary case, and any
  // sentence telling the reader that check-held work was excluded is unearned on every one of
  // those 5,478 rows.
  const uFast = await insertRepo('post-merge-fast');
  const uSlow = await insertRepo('post-merge-slow');
  for (let i = 0; i < PARKED_PER_REPO; i++) await merged(uFast, `uf${i}`, 2, 'unknown');
  for (let i = 0; i < PARKED_PER_REPO; i++) await merged(uSlow, `us${i}`, 40, 'unknown');
  // Two repos with approve→merge data but neither at FLOW_MIN_REPO_APPROVED — the ONLY way to
  // reach `settle`'s floor-miss refusal for this kind, which carried the exclusion clause too.
  const uThinA = await insertRepo('post-merge-thin-a');
  const uThinB = await insertRepo('post-merge-thin-b');
  for (let i = 0; i < 3; i++) await merged(uThinA, `uta${i}`, 2, 'unknown');
  for (let i = 0; i < 3; i++) await merged(uThinB, `utb${i}`, 40, 'unknown');

  // ══ 'Sizes': the size row's AUTHOR EVIDENCE, and the population its bar is measured against ══
  //
  // Deliberately its own workspace rather than more rows in 'Flow': that fixture's medians (12h
  // first read, 160 lines, 1 comment/thread) are load-bearing for four other assertions, and any
  // pull request added there has to be reviewed in-window to reach the size fold — which moves
  // them all.
  //
  // Four cohorts, one first-read latency per size band so the LATENCY half of the row is fixed and
  // only the author half varies:
  //   depbot 30 × 15 lines @ 2h   — the bumps. Automation, so never an actor itself.
  //   harry  12 × 40 lines  @ 2h  — small human work; the same band as the bumps.
  //   frank   8 × 220 lines @ 2h  — ORDINARY for a human here. THE CONTROL.
  //   grace   8 × 900 lines @ 30h — the big-change author, and the row's subject band.
  //
  // human-only median = 220 → bar 440 → grace alone.
  // all-pull-request median = 15 → bar 30 → grace AND frank AND harry, i.e. two engineers named
  // for writing what everyone here writes, because 30 dependency bumps anchored the median.
  const sizeRepo = await insertRepo('sizes');
  let sz = 0;
  const sizedPr = async (authorId: number, loc: number, readHours: number): Promise<void> => {
    const key = `sz${sz++}`;
    const openedAt = now - 5 * DAY;
    await insertPr(sizeRepo, key, {
      authorId,
      // CLOSED (not merged, not open) so this repo contributes to the size fold and to NOTHING
      // else — no approve→merge population, no open snapshot.
      state: 'closed',
      openedAt: new Date(openedAt),
      additions: loc,
      deletions: 0,
      changedFiles: 1,
    });
    await review(pr(key), bobId, 'commented', openedAt + readHours * HOUR);
  };
  for (let i = 0; i < BUMP_PRS; i++) await sizedPr(depBotId, 15, 2);
  for (let i = 0; i < HARRY_PRS; i++) await sizedPr(harryId, 40, 2);
  for (let i = 0; i < FRANK_PRS; i++) await sizedPr(frankId, 220, 2);
  for (let i = 0; i < GRACE_PRS; i++) await sizedPr(graceId, 900, 30);

  // ══ 'FoldCap': PERIOD_FIRST_REVIEW_PR_CAP, and nothing else ═════════════════════════════════
  //
  // Exactly FIRST_REVIEW_PR_CAP pull requests, each with one in-window human review, so the ONE
  // first-review fold hits its candidate break — the cap a caller can never infer from the return
  // value, because the ids dropped there never reach the fold's second query.
  //
  // ⚠ THE SHAPE IS THE TEST. They are CLOSED and unsized and carry no threads and no files, so
  // FLOW_MERGED_PR_CAP (3,000), FLOW_OPEN_PR_CAP (3,000), FLOW_THREAD_PATH_CAP, FLOW_REVIEW_SCAN_CAP
  // (both 40,000 per chunk of 900) and FLOW_THREAD_COMMENT_CAP (60,000) are all untouched. A
  // `coverage.truncated` on this workspace can have come from ONE place.
  const capRepo = await insertRepo('fold-cap');
  {
    const openedAt = new Date(now - 5 * DAY);
    const submittedAt = new Date(now - 5 * DAY + 2 * HOUR);
    // Bulk-inserted in chunks: 5,000 single-row inserts is a minute of test time, and a chunk of
    // 400 × 10 columns is 4,000 bind parameters — far inside SQLite's 32,766.
    const CHUNK = 400;
    const prIds: number[] = [];
    for (let i = 0; i < FIRST_REVIEW_PR_CAP; i += CHUNK) {
      const batch = [];
      for (let j = i; j < Math.min(i + CHUNK, FIRST_REVIEW_PR_CAP); j++) {
        batch.push({
          githubNodeId: `PR_flowcap_${j}`,
          accountId: 1,
          repoId: capRepo,
          number: n++,
          title: `cap fixture ${j}`,
          state: 'closed',
          isDraft: false,
          authorId: aliceId,
          openedAt,
          updatedAt: openedAt,
        });
      }
      const rows = await db.insert(pullRequests).values(batch).returning().execute();
      for (const r of rows) prIds.push(r.id);
    }
    for (let i = 0; i < prIds.length; i += CHUNK) {
      const batch = prIds.slice(i, i + CHUNK).map((prId, k) => ({
        githubNodeId: `RV_flowcap_${i + k}`,
        prId,
        authorId: bobId,
        state: 'commented',
        submittedAt,
      }));
      await db.insert(reviews).values(batch).execute();
    }
  }

  // ══ 'Thin': real data, every floor missed ══════════════════════════════════════════════════
  const thin = await insertRepo('thin');
  for (let i = 0; i < 2; i++) {
    const key = `t${i}`;
    await insertPr(thin, key, {
      authorId: aliceId,
      additions: 30,
      deletions: 10,
      changedFiles: 1,
      files: [{ path: 'lib/util.ts', additions: 30, deletions: 10 }],
    });
    await review(pr(key), bobId, 'commented', now - 36 * HOUR);
    await thread(pr(key), 'lib/util.ts', 2, false);
  }

  // ⚠ Through the production resolver, never a hand-built {workspaceId, repoIds}: it is
  // `ensureRepoMemberships` that puts a repo inserted straight into `repos` into the account's
  // Default workspace. Hand-build it and every scan is empty and the fixture asserts nothing.
  const flowWs = await q.createWorkspace(1, 'Flow');
  await q.assignReposToWorkspace(flowWs.id, 1, [hot, calm, shared]);
  flowScope = await q.resolveWorkspaceScope(1, flowWs.id);
  const parkedWs = await q.createWorkspace(1, 'Parked');
  await q.assignReposToWorkspace(parkedWs.id, 1, [pFast, pSlow]);
  parkedScope = await q.resolveWorkspaceScope(1, parkedWs.id);
  const postMergeWs = await q.createWorkspace(1, 'PostMerge');
  await q.assignReposToWorkspace(postMergeWs.id, 1, [uFast, uSlow]);
  postMergeScope = await q.resolveWorkspaceScope(1, postMergeWs.id);
  const postMergeThinWs = await q.createWorkspace(1, 'PostMergeThin');
  await q.assignReposToWorkspace(postMergeThinWs.id, 1, [uThinA, uThinB]);
  postMergeThinScope = await q.resolveWorkspaceScope(1, postMergeThinWs.id);
  const sizeWs = await q.createWorkspace(1, 'Sizes');
  await q.assignReposToWorkspace(sizeWs.id, 1, [sizeRepo]);
  sizeScope = await q.resolveWorkspaceScope(1, sizeWs.id);
  const capWs = await q.createWorkspace(1, 'FoldCap');
  await q.assignReposToWorkspace(capWs.id, 1, [capRepo]);
  foldCapScope = await q.resolveWorkspaceScope(1, capWs.id);
  // ⚠ 'Calm' ALONE, and it exists for exactly one state: cells that CLEAR every sample floor and
  // then cross no emit bar. In `flowScope` this repo is invisible because `hot` wins the kind; on
  // its own it is 24 reviewed pull requests, three reviewers at a 33% top share — measurable, and
  // healthy. That is the state that shipped returning `findings: []` with `refusals: []`.
  const calmWs = await q.createWorkspace(1, 'Calm');
  await q.assignReposToWorkspace(calmWs.id, 1, [calm]);
  calmScope = await q.resolveWorkspaceScope(1, calmWs.id);
  const thinWs = await q.createWorkspace(1, 'Thin');
  await q.assignReposToWorkspace(thinWs.id, 1, [thin]);
  thinScope = await q.resolveWorkspaceScope(1, thinWs.id);
  const emptyWs = await q.createWorkspace(1, 'Empty');
  emptyScope = await q.resolveWorkspaceScope(1, emptyWs.id);
}, 120_000);

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('the fixture really is split the way the assertions assume', () => {
  it('puts each repo in exactly the workspace its assertions read', () => {
    expect([...flowScope.repoIds].sort()).toEqual(
      [repoIdByKey.get('hot')!, repoIdByKey.get('calm')!, repoIdByKey.get('shared')!].sort(),
    );
    expect([...parkedScope.repoIds].sort()).toEqual(
      [repoIdByKey.get('parked-fast')!, repoIdByKey.get('parked-slow')!].sort(),
    );
    expect([...postMergeScope.repoIds].sort()).toEqual(
      [repoIdByKey.get('post-merge-fast')!, repoIdByKey.get('post-merge-slow')!].sort(),
    );
    expect(sizeScope.repoIds).toEqual([repoIdByKey.get('sizes')!]);
    expect(foldCapScope.repoIds).toEqual([repoIdByKey.get('fold-cap')!]);
    expect(thinScope.repoIds).toEqual([repoIdByKey.get('thin')!]);
    expect(emptyScope.repoIds).toHaveLength(0);
  });

  it('really does file the size fixture’s bumps as automation, not as a small human', async () => {
    // ⚠ THE VACUOUS-FIXTURE GUARD. If `dependabot[bot]` resolved to the HUMAN lane, the two size
    // populations would coincide, the bar would be identical either way, and the regression test
    // below would pass against the bug. The lane is what makes that test mean anything.
    const lanes = await (await import('./actor-lanes.js')).resolveActorLanes(1, sizeScope);
    expect(lanes.laneOf(depBotId)).not.toBe('human');
    for (const id of [frankId, graceId, harryId]) expect(lanes.laneOf(id)).toBe('human');
  });
});

// ═══ 1. THE CALIBRATION TRAP ═══════════════════════════════════════════════════════════════════
describe('approval_parked excludes pull requests that were waiting on CHECKS, not on people', () => {
  it('measures the approve→merge wait from the rows people actually held', async () => {
    const resp = await findings(parkedScope);
    const rows = of(resp, 'approval_parked');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.subject).toBe('acme/parked-slow');
    expect(row.subjectKind).toBe('repo');

    // ⚠ THE NUMBERS ARE THE ASSERTION. With the exclusion: the slow repo's six unblocked rows
    // give a 40h median, and the workspace baseline is the median of six 2h waits and six 40h
    // ones = 21h. WITHOUT it the same call would report 220h against a 40h baseline — so this
    // pair fails, loudly and in both figures, if the predicate is deleted.
    expect(row.value).toBeCloseTo(40, 5);
    expect(row.baseline).toBeCloseTo(21, 5);
    expect(row.value).not.toBeCloseTo(220, 0);
    expect(row.baseline).not.toBeCloseTo(40, 0);
    expect(row.sampleSize).toBe(PARKED_PER_REPO);
  });

  it('keeps the check-blocked pull requests out of the evidence as well as the median', async () => {
    const resp = await findings(parkedScope);
    const row = of(resp, 'approval_parked')[0]!;
    const blocked = new Set(
      Array.from({ length: PARKED_PER_REPO }, (_, i) => pr(`pb${i}`)),
    );
    // They are the six LONGEST waits in the repo, so they would top an unfiltered evidence list —
    // which makes their absence a real test rather than an incidental one.
    for (const ref of row.evidence) expect(blocked.has(ref.prId)).toBe(false);
    expect(row.evidence.length).toBeGreaterThan(0);
  });

  it('counts only the approved pull requests a human could land RIGHT NOW as still parked', async () => {
    const resp = await findings(parkedScope);
    const row = of(resp, 'approval_parked')[0]!;
    // Five open, approved-or-not pull requests sit in that repo; exactly ONE is approved AND in a
    // ready merge state AND not conflicting. 'unstable' IS mergeable; 'behind' is not; a
    // conflicting 'clean' one is waiting on its author; an unapproved one was never reviewed.
    expect(row.detail).toContain('1 approved pull request is open and mergeable there right now');
    // The landable one leads the evidence: it is the row somebody can act on today.
    expect(row.evidence[0]?.prId).toBe(pr('po-unstable'));
  });
});

// ═══ 1b. THE CLAIM THE MERGED HALF CANNOT MAKE ═════════════════════════════════════════════════
//
// GitHub stops computing `mergeStateStatus` once a pull request merges. Measured on this install's
// own synced database:
//
//   select merge_state_status, count(*) from pull_requests where state='merged' group by 1
//     → unknown 5478 · dirty 27 · clean 2 · BLOCKED 0        (open pull requests: blocked 553)
//
// So the merged half's `!== 'blocked'` filter is very nearly inert on real data, while the row's
// detail sentence and both refusals told the reader it had applied — on the ONE figure an EM
// staffs from. A pull request approved at T0, held by a red required check until T0+40h and merged
// at T0+41h contributes all 41h, and the sentence called that "excluded".
//
// The filter itself stays (a positively-observed blocked row is still dropped). What may not stay
// is a reassurance it has not earned.
describe('approval_parked never claims an exclusion GitHub stopped letting it make', () => {
  it('counts a post-merge `unknown` row in full and says nothing about it being excluded', async () => {
    const resp = await findings(postMergeScope);
    const rows = of(resp, 'approval_parked');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.subject).toBe('acme/post-merge-slow');

    // Nothing at all was excluded here — every merged row reads 'unknown' — and the 40h waits are
    // plainly inside the figure. That is what makes an exclusion sentence on this row a false
    // statement rather than merely an imprecise one.
    expect(row.value).toBeCloseTo(40, 5);
    expect(row.baseline).toBeCloseTo(21, 5);
    expect(row.sampleSize).toBe(PARKED_PER_REPO);

    // ⚠ THE REGRESSION. The detail used to end "— pull requests held by required checks are
    // excluded from this figure", on a population from which none had been.
    expect(row.detail).not.toMatch(/excluded/i);
    expect(row.detail).not.toMatch(/held by required checks are excluded/i);
  });

  it('says the same on the workspace where the filter DID fire', async () => {
    // 'Parked' is the artificial case: six merged rows really did retain 'blocked' and really were
    // dropped. The sentence still may not advertise it — a reader cannot tell which workspace they
    // are looking at, and on every real one the answer is "none were".
    const row = of(await findings(parkedScope), 'approval_parked')[0]!;
    expect(row.detail).not.toMatch(/excluded/i);
  });

  it('drops the clause from BOTH refusal sentences too', async () => {
    // TWO refusal paths carried it, and both are exercised here:
    //   • the no-data one — "…that was not held by required checks (N excluded)", where N is 0 on
    //     every real workspace, so the whole sentence turned on a count that never moves;
    //   • the floor miss — "…(pull requests held by required checks are excluded)", which needs
    //     two repos with approve→merge data and neither above FLOW_MIN_REPO_APPROVED.
    const noData = refusalFor(await findings(thinScope), 'approval_parked')!;
    expect(noData).toBeTruthy();
    expect(noData).toContain('merged an approved pull request');
    expect(noData).not.toMatch(/excluded/i);
    expect(noData).not.toMatch(/required checks/i);

    const floorMiss = refusalFor(await findings(postMergeThinScope), 'approval_parked')!;
    expect(floorMiss).toBeTruthy();
    expect(floorMiss).toContain('reached the floor');
    expect(floorMiss).not.toMatch(/excluded/i);
    expect(floorMiss).not.toMatch(/required checks/i);
  });

  it('replaces the reassurance with the true caveat rather than dropping it silently', async () => {
    // An absent caveat is better than an unearned one, but the honest version is better than
    // either: the reader's whole defence against mistaking a CI queue for a merge queue is knowing
    // which one the number contains.
    const row = of(await findings(postMergeScope), 'approval_parked')[0]!;
    expect(row.detail).toContain('inside this figure');
    expect(row.detail).toMatch(/required check/i);
  });
});

// ═══ 2. REFUSALS ═══════════════════════════════════════════════════════════════════════════════
describe('a kind that cannot clear its floor is REFUSED BY NAME, never drawn as nothing', () => {
  it('refuses every kind on a workspace with real data but no cell above its floor', async () => {
    const resp = await findings(thinScope);
    expect(resp.findings).toEqual([]);
    // All four, each with a reason a person can read — an absent section would instead assert
    // "we checked and there is nothing here", which is a much stronger claim.
    for (const kind of [
      'single_reviewer_path',
      'approval_parked',
      'size_latency',
      'round_trips',
    ] as const) {
      const reason = refusalFor(resp, kind);
      expect(reason, kind).toBeTruthy();
      expect(reason!.length, kind).toBeGreaterThan(20);
    }
    expect(refusalFor(resp, 'single_reviewer_path')).toContain('reviewed pull requests');
    expect(refusalFor(resp, 'approval_parked')).toContain('merged an approved pull request');
    expect(refusalFor(resp, 'size_latency')).toContain('size bands');
    expect(refusalFor(resp, 'round_trips')).toContain('review threads');
  });

  // ⚠ THE INVARIANT THE TWO TESTS ABOVE DO NOT COVER, AND THE ONE THAT SHIPPED BROKEN.
  //
  // Both of them exercise a workspace where NOTHING cleared the sample floor. The emit path used
  // to refuse only in that case — so a cell that cleared the floor and then failed the emit
  // predicate fell through in complete silence. A real workspace (3 repos, 261 pull requests) came
  // back `findings: []` with `refusals: []`, and the panel rendered an empty pane that read as
  // "we looked and your review flow is fine" when the truth was "measured, and nothing crossed
  // the bar" — a different, weaker, and much more useful statement.
  //
  // It is asserted over EVERY scope the fixture has, because the bug lived in the gap BETWEEN the
  // two populations each individual test was built around.
  it('has every kind account for itself on every workspace — a finding OR a named refusal', async () => {
    for (const [label, scope] of [
      ['flow', flowScope],
      ['parked', parkedScope],
      ['postMerge', postMergeScope],
      ['postMergeThin', postMergeThinScope],
      ['sizes', sizeScope],
      ['calm', calmScope],
      ['thin', thinScope],
      ['empty', emptyScope],
    ] as const) {
      const resp = await findings(scope);
      for (const kind of ALL_KINDS) {
        const spokeFor =
          resp.findings.some((f) => f.kind === kind) || resp.refusals.some((r) => r.kind === kind);
        expect(spokeFor, `${label}/${kind} said nothing at all`).toBe(true);
      }
      // And never BOTH — a kind that emitted a finding has nothing to refuse, and a reader shown
      // "packages/api/** waits on one reviewer" beside "not enough data about directories" cannot
      // tell which half to believe.
      for (const kind of ALL_KINDS) {
        const both =
          resp.findings.some((f) => f.kind === kind) && resp.refusals.some((r) => r.kind === kind);
        expect(both, `${label}/${kind} both reported and refused`).toBe(false);
      }
    }
  });

  it('distinguishes "could not measure" from "measured, nothing stood out"', async () => {
    // The two sentences must NOT collapse into one. The first is an apology for missing data; the
    // second is a clean bill of health on data we do have, and it is the more useful answer — an
    // EM reading "not enough data about directories" on a workspace we measured 24 pull requests
    // in would go looking for a sync problem that does not exist.
    const thin = refusalFor(await findings(thinScope), 'single_reviewer_path');
    const clean = refusalFor(await findings(calmScope), 'single_reviewer_path');

    expect(thin, 'the thin workspace could not measure').toBeTruthy();
    expect(thin).toContain('reached the floor');

    // ⚠ NOT `if (clean != null)`. The whole point is that this state produces a sentence; a
    // conditional here would make the test pass again the moment the silence came back.
    expect(clean, 'the calm workspace measured and found nothing').toBeTruthy();
    expect(clean).toContain('Measured');
    // Singular: this fixture clears the floor in exactly ONE directory, which also pins the
    // pluralisation — "Measured 1 directories" is the kind of thing nobody reports and everybody
    // notices.
    expect(clean).toContain('1 directory');
    expect(clean).not.toContain('1 directories');
    expect(clean).not.toBe(thin);
    // And it says so without a finding — measured-and-clean is not a finding.
    expect(of(await findings(calmScope), 'single_reviewer_path')).toEqual([]);
  });

  it('refuses all four on an empty workspace rather than widening to the account', async () => {
    const resp = await findings(emptyScope);
    expect(resp.findings).toEqual([]);
    expect(resp.refusals).toHaveLength(4);
    for (const r of resp.refusals) expect(r.reason).toBe('This workspace has no repositories yet.');
    expect(resp.coverage).toEqual({
      reposInWorkspace: 0,
      reposWithData: 0,
      prsScanned: 0,
      truncated: false,
      filesTruncatedPrs: 0,
    });
    expect(resp.workspaceId).toBe(emptyScope.workspaceId);
  });
});

// ═══ 3. VALUE AND BASELINE SHARE A UNIT ════════════════════════════════════════════════════════
describe('value and baseline are always the same unit', () => {
  const UNIT_BY_KIND: Record<FlowFindingKind, string> = {
    single_reviewer_path: 'hours',
    approval_parked: 'hours',
    size_latency: 'hours',
    round_trips: 'comments',
  };

  it('declares one unit per row, and every row really is worse than the thing it names', async () => {
    for (const scope of [flowScope, parkedScope]) {
      const resp = await findings(scope);
      expect(resp.findings.length).toBeGreaterThan(0);
      for (const f of resp.findings) {
        expect(f.unit, f.id).toBe(UNIT_BY_KIND[f.kind]);
        expect(Number.isFinite(f.value), f.id).toBe(true);
        expect(Number.isFinite(f.baseline), f.id).toBe(true);
        // The emission predicate is "materially worse", so a row whose value is not above its
        // baseline is either a unit mixup or a comparison drawn against the wrong population.
        expect(f.value, f.id).toBeGreaterThan(f.baseline);
        expect(f.sampleSize, f.id).toBeGreaterThan(0);
      }
    }
  });

  it('reports round trips in COMMENTS on both sides, not hours', async () => {
    const resp = await findings(flowScope);
    const rows = of(resp, 'round_trips');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.unit).toBe('comments');
    // Four human comments per hot thread against one per calm thread. ⚠ Each hot thread ALSO
    // carries a bot comment: a 5 here means the human-lane filter was dropped, and the whole
    // finding would then be measuring automation volume.
    expect(row.value).toBe(4);
    expect(row.baseline).toBe(1);
    expect(row.sampleSize).toBe(HOT_PRS);
  });

  it('reports both size-band figures in HOURS, measured off the same fold', async () => {
    const resp = await findings(flowScope);
    const rows = of(resp, 'size_latency');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.unit).toBe('hours');
    expect(row.subject).toBe('500-999 lines');
    expect(row.value).toBeCloseTo(24, 5); // the 800-line band's first human read
    expect(row.baseline).toBeCloseTo(4, 5); // the 20-line band's
    // Workspace-wide is the ONE kind that may carry a null repoId (the shared contract says so).
    expect(row.repoId).toBeNull();
    expect(row.id).toBe('size_latency:ws:500-999 lines');
  });
});

// ═══ 4. THE SUBJECT IS THE FLOW, NEVER A PERSON ════════════════════════════════════════════════
describe('the subject of a finding is the flow; people are evidence inside the row', () => {
  it('names a directory, a repo or a size band — never an engineer', async () => {
    for (const scope of [flowScope, parkedScope]) {
      const resp = await findings(scope);
      for (const f of resp.findings) {
        expect(['path', 'repo', 'size_band'], f.id).toContain(f.subjectKind);
        expect(f.subject.length, f.id).toBeGreaterThan(0);
        // Every headline and detail is TEMPLATED here — no model, no plugin. A leftover
        // placeholder is the cheapest possible sign that stopped being true.
        expect(f.headline, f.id).not.toMatch(/[{}]|undefined|NaN/);
        expect(f.detail, f.id).not.toMatch(/[{}]|undefined|NaN/);
        expect(f.headline.length, f.id).toBeGreaterThan(20);
        expect(f.detail.length, f.id).toBeGreaterThan(20);
      }
    }
  });

  it('carries the concentrated reviewer as row evidence, and resolves them in `users`', async () => {
    const resp = await findings(flowScope);
    const rows = of(resp, 'single_reviewer_path');
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.subjectKind).toBe('path');
    expect(row.subject).toBe('src/**');
    expect(row.repoId).toBe(repoIdByKey.get('hot'));
    expect(row.actorIds).toEqual([aliceId]);
    expect(row.headline).toContain('83%');
    // Both figures in HOURS, off the one shared first-human-review fold: 24h in src/** against a
    // 12h workspace median that the calm and shared repos set between them.
    expect(row.value).toBeCloseTo(24, 5);
    expect(row.baseline).toBeCloseTo(12, 5);
    expect(row.sampleSize).toBe(HOT_PRS);
    // ⚠ THE TWO CONTROLS, and they fail for DIFFERENT reasons — which is the point.
    //   docs/** clears every floor but is FAST (4h against 12h): the latency bar excludes it.
    //   pkg/** clears every floor AND is materially slow (20h against 12h): only the 60%
    //     concentration bar excludes it. Delete that bar and this line fails.
    expect(rows.some((f) => f.subject === 'docs/**')).toBe(false);
    expect(rows.some((f) => f.subject === 'pkg/**')).toBe(false);
    // `actorIds` resolve through the response's own table, exactly as AttentionCardsResponse does.
    expect(resp.users.map((u) => u.id)).toContain(aliceId);
  });

  it('gives round_trips no actorIds at all', async () => {
    const resp = await findings(flowScope);
    expect(of(resp, 'round_trips')[0]!.actorIds).toEqual([]);
  });

  // ⚠ THE BAR AND THE PEOPLE IT JUDGES MUST COME FROM ONE POPULATION.
  //
  // `size_latency` names authors whose changes "run large" — a person's median PR size against the
  // workspace's, times FLOW_BIG_AUTHOR_RATIO. The per-author side was filtered to the lane
  // resolver's human union; the WORKSPACE MEDIAN was not, so the bar was set by every sized pull
  // request in the window, dependency bumps included. The comment two lines above it said the
  // opposite in so many words ("a dependency bot's bumps would otherwise anchor the workspace
  // median at 14 lines and make every person far above it"), which is exactly what happened.
  //
  // 'Flow' cannot show this — every author there is human, so the two populations coincide. The
  // 'Sizes' workspace is 30 Dependabot bumps beside three human cohorts, which is what a real
  // bot-heavy workspace looks like: the all-pull-request median reads 15 lines where the human one
  // reads 220.
  describe('the size row measures its author bar against the HUMAN population', () => {
    it('names only the author who is large FOR A HUMAN HERE', async () => {
      const resp = await findings(sizeScope);
      const rows = of(resp, 'size_latency');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // The latency half is fixed by construction, so any movement below is the author half.
      expect(row.subject).toBe('500-999 lines');
      expect(row.value).toBeCloseTo(30, 5);
      expect(row.baseline).toBeCloseTo(2, 5);

      // ⚠ THE REGRESSION, and it is a claim about named people. Human-only median 220 → bar 440,
      // and grace (900) is the only author over it. All-pull-request median 15 → bar 30, and the
      // row instead names grace, frank (220 — ordinary here) and harry (40 — small here).
      expect(row.actorIds).toEqual([graceId]);
      expect(row.actorIds).not.toContain(frankId);
      expect(row.actorIds).not.toContain(harryId);
      // And never the bot itself: automation is excluded from the author side in both versions,
      // which is why the defect was invisible to a test that only checked who was NOT named.
      expect(row.actorIds).not.toContain(depBotId);
      expect(resp.users.map((u: { id: number }) => u.id)).toEqual([graceId]);
    });

    it('keeps the bumps out of the sentences as well as out of the bar', async () => {
      const row = of(await findings(sizeScope), 'size_latency')[0]!;
      expect(row.headline).not.toMatch(/dependabot/i);
      expect(row.detail).not.toMatch(/dependabot/i);
    });
  });

  it('carries the large-change authors on the size row as evidence only', async () => {
    const resp = await findings(flowScope);
    const row = of(resp, 'size_latency')[0]!;
    // dave authors the 800-line pull requests; the workspace median is 20 lines.
    // dave authors the 800-line pull requests; the workspace median is 160 lines, so the bar is
    // 320. erin's 300-line ones are BIGGER THAN THE MEDIAN AND STILL NOT EVIDENCE — the control
    // that keeps "far above" from degenerating into "above".
    expect(row.actorIds).toEqual([daveId]);
    expect(row.actorIds).not.toContain(erinId);
    // …and he is nowhere in the sentences. The row is about the size band.
    expect(row.headline).not.toContain('dave');
    expect(row.detail).not.toContain('dave');
  });
});

// ═══ 5/6. COVERAGE ═════════════════════════════════════════════════════════════════════════════
describe('coverage tells the reader what the figures rest on', () => {
  it('counts the 100-file storage cap as PATH ATTRIBUTION, not as a capped window', async () => {
    const resp = await findings(flowScope);
    // One hot pull request changed 250 files and stores one. A silent truncation would read as
    // "we covered everything", which is a stronger claim than any figure here supports — but the
    // honest caveat is about that pull request's DIRECTORY SPLIT, not about the period. Folding it
    // into `truncated` made a 262-PR workspace announce a window problem it did not have, and a
    // caveat the reader cannot act on teaches them to ignore the one that matters.
    expect(resp.coverage.filesTruncatedPrs).toBe(1);
    expect(resp.coverage.truncated).toBe(false);
    expect(resp.coverage.reposInWorkspace).toBe(3);
    expect(resp.coverage.reposWithData).toBe(3);
    expect(resp.coverage.prsScanned).toBe(HOT_PRS + CALM_PRS + SHARED_PRS);
  });

  // ⚠ A CAP INSIDE A SHARED FOLD IS STILL THIS FILE'S TRUNCATION.
  //
  // `loadFirstHumanReviewHours` is THE ONE fold for "time until a person reviewed it" and it
  // truncates internally — PERIOD_FIRST_REVIEW_PR_CAP (5,000 candidate pull requests, a hard
  // break) plus two PERIOD_COMMENT_SCAN_CAP row limits. It returned a bare `number[]` and a
  // positional samples sink, so `getFlowFindings` could not tell a complete fold from a cut one
  // and never raised `coverage.truncated` for it: at ?days=90 on a busy workspace the medians
  // rested on a prefix of the window while the response said the window was covered in full.
  //
  // A call-site heuristic is not a substitute and was explicitly rejected: `hours.length >= CAP`
  // UNDER-FIRES, because the caps sit on the candidate and review-row scans and `hours` is that
  // population after two further narrowings. The fold reports it or nobody does.
  it('inherits the shared first-review fold’s own truncation', async () => {
    const resp = await findings(foldCapScope);
    expect(resp.coverage.truncated).toBe(true);
    // ⚠ AND ONLY THAT ONE. The fixture is CLOSED, unsized, thread-less and file-less precisely so
    // no scan in getFlowFindings can reach a cap of its own — if this ever stops being true the
    // assertion above goes vacuous and stops proving anything about the fold.
    expect(resp.coverage.filesTruncatedPrs).toBe(0);
    expect(resp.coverage.prsScanned).toBe(FIRST_REVIEW_PR_CAP);
    // A truncated fold is still a fold: the window's kinds account for themselves as ever.
    for (const kind of ALL_KINDS) {
      const spokeFor =
        resp.findings.some((f) => f.kind === kind) || resp.refusals.some((r) => r.kind === kind);
      expect(spokeFor, kind).toBe(true);
    }
  });

  it('leaves `truncated` false on a workspace no scan cut', async () => {
    // The control for the two above: 'Sizes' is 58 reviewed pull requests, far under every cap,
    // so a flag here would mean something is reporting truncation unconditionally.
    const resp = await findings(sizeScope);
    expect(resp.coverage.truncated).toBe(false);
    expect(resp.coverage.filesTruncatedPrs).toBe(0);
  });

  it('echoes the resolved workspace and the clamped window on every response', async () => {
    expect((await findings(flowScope)).workspaceId).toBe(flowScope.workspaceId);
    // The window is CLAMPED, not trusted: below 7 days a median rests on three observations and
    // above 90 the retroactive coverage bias dominates.
    expect((await findings(flowScope, 1)).windowDays).toBe(7);
    expect((await findings(flowScope, 3650)).windowDays).toBe(90);
    expect((await findings(flowScope, 30)).windowDays).toBe(30);
  });
});
