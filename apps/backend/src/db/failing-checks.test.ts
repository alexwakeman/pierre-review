// WHICH CHECKS ARE FAILING — the names a red Pending card carries, on a THROWAWAY sqlite DB (the
// ci-failing-cards.test.ts pattern).
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. `ci_status_events` IS A TRANSITION LOG, NOT A SNAPSHOT. Only the NEWEST row for the PR's
//      CURRENT head is read, and only when THAT row is red: a row for an older head describes code
//      the PR no longer holds, and a newer non-red row means the red set it named is gone.
//   2. THE `prId IN × headSha IN` PREDICATE OVER-MATCHES, and so does the trunk reader's
//      `repoId IN × sha IN`. Both key on the PAIR in JS; a decoy row for a sha nobody asked about
//      in THAT repo/PR must never be named.
//   3. ANOTHER ACCOUNT'S ROWS NEVER LEAK — even a newer row for the same (PR, head) pair.
//   4. EVERY RED CARD KIND GETS THE NAMES, THROUGH TWO FOLDS. A my_turn seed on a DRAFT is not in the
//      open-PR select, so a names fold run only there would leave that card bare. Untouched threads
//      call `prRef` with `{...t, id: t.prId}`; the Dependencies cards and a `merge` card whose red is
//      non-required checks go through it too.
//   5. THE TRUNK ARM NAMES A DIRECT PUSH. No landing PR resolves, and the names still come from the
//      head's `branch_commits` row — bare names, never workflow-prefixed. The promoted `trunk_red`
//      card carries the same pair. ⚠ A red head with NO `branch_commits` row at all (outside the
//      stored window, or not walked yet) is a real state: its card still ships, naming nothing —
//      null, never [] or 0.
//   6. ONLY `GET /api/attention` PAYS. The default fold (the daily brief, the work plan, every Pro
//      payload) carries no names at all, and no card's `detail` ever names a check.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  BranchCheckRun,
  CiFailingCard,
  DependencyBumpCard,
  InsightCard,
  InsightPrRef,
  MyTurnSettings,
  MyTurnTrunkCard,
} from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-failing-checks-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let q: any;
let fc: typeof import('./failing-checks.js');
let bq: typeof import('./branch-queries.js');
let setMyTurnSettings: (id: number, s: MyTurnSettings | null) => Promise<unknown>;
let scope: any;

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;
const REPO_ADDED = now - 30 * DAY;
const VIEWER_LOGIN = 'viewer-me';
const LONG_NAME = 'y'.repeat(250);
const TRUNK_HEAD = 'trunkhead0000000000000000000000000000000';
const OTHER_HEAD = 'otherhead0000000000000000000000000000000';
const ROWLESS_HEAD = 'rowlesshead00000000000000000000000000000';

const prIdByKey = new Map<string, number>();
let appRepo = 0;
let otherRepo = 0;
let rowlessRepo = 0;
let account2 = 0;

const P = (key: string): number => prIdByKey.get(key)!;

/** The board's fold — the one `GET /api/attention` asks for. */
const boardFold = () =>
  q.getWorkspaceInsights(1, undefined, scope, { uncapped: true, withFailingChecks: true });
/** Every other consumer's fold (the daily brief's, the Pro payloads'). */
const defaultFold = () => q.getWorkspaceInsights(1, undefined, scope);

const prCardsFor = (cards: InsightCard[], prId: number): (InsightCard & InsightPrRef)[] =>
  cards.filter(
    (c): c is InsightCard & InsightPrRef =>
      c.kind !== 'ci_failing' &&
      !(c.kind === 'my_turn' && c.reason === 'trunk_red') &&
      'prId' in c &&
      c.prId === prId,
  );

const checkRun = (name: string, state: 'failure' | 'error' = 'failure'): BranchCheckRun => ({
  name,
  state,
  url: null,
  runId: 1,
  jobId: 2,
  workflowName: 'Journey Tests',
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  q = await import('./queries.js');
  fc = await import('./failing-checks.js');
  bq = await import('./branch-queries.js');
  ({ setMyTurnSettings } = await import('../auth/account.js'));

  const {
    accounts,
    branchCommits,
    ciStatusEvents,
    events,
    pullRequests,
    repos,
    reviewRequests,
    reviewThreads,
    users,
  } = schema;
  const { eq } = await import('drizzle-orm');

  // Migration 0008 seeds account 1 with an EMPTY github_login — getAccountUserId would return null
  // and the my_turn fold would match nobody.
  await db.update(accounts).set({ githubLogin: VIEWER_LOGIN }).where(eq(accounts.id, 1)).execute();
  const [a2] = await db
    .insert(accounts)
    .values({ githubUserId: 'U_theirs', githubLogin: 'theirs' })
    .returning()
    .execute();
  account2 = a2.id;

  const insertUser = async (login: string, isBot = false): Promise<number> => {
    const [u] = await db
      .insert(users)
      .values({ githubLogin: login, githubNodeId: `U_${login}`, isBot })
      .returning()
      .execute();
    return u.id;
  };
  const viewerId = await insertUser(VIEWER_LOGIN);
  const aliceId = await insertUser('alice-dev');
  const dependabotId = await insertUser('dependabot[bot]', true);

  const insertRepo = async (
    accountId: number,
    name: string,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId,
        owner: 'acme',
        name,
        githubNodeId: `R_fc_${accountId}_${name}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        createdAt: new Date(REPO_ADDED),
        ...values,
      })
      .returning()
      .execute();
    return r.id;
  };
  // The viewer MAINTAINS it (ADMIN), and its trunk is red at a DIRECT PUSH.
  appRepo = await insertRepo(1, 'app', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: TRUNK_HEAD,
    defaultBranchCiStatus: 'failure',
    defaultBranchUpdatedAt: new Date(now - HOUR),
  });
  // A second repo in the same account holding a DECOY row at the app repo's head sha: the trunk
  // reader's over-match. Green trunk, so it earns no card of its own.
  otherRepo = await insertRepo(1, 'other', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: OTHER_HEAD,
    defaultBranchCiStatus: 'success',
    defaultBranchUpdatedAt: new Date(now - HOUR),
  });
  // A maintained repo red at a head with NO `branch_commits` row — deliberately never inserted
  // below. Its trunk card must still ship, and must name nothing.
  rowlessRepo = await insertRepo(1, 'rowless', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: ROWLESS_HEAD,
    defaultBranchCiStatus: 'failure',
    defaultBranchUpdatedAt: new Date(now - HOUR),
  });
  const theirRepo = await insertRepo(account2, 'app', {
    viewerPermission: 'ADMIN',
    defaultBranchHeadSha: TRUNK_HEAD,
    defaultBranchCiStatus: 'failure',
  });

  // The red trunk head — a direct push (prNumber null), two failing jobs.
  await db
    .insert(branchCommits)
    .values({
      accountId: 1,
      repoId: appRepo,
      sha: TRUNK_HEAD,
      messageHeadline: 'pushed straight to main',
      committedAt: new Date(now - 2 * HOUR),
      ciStatus: 'failure',
      failingChecks: [checkRun('Run Journey Tests / Run Journey Tests'), checkRun('lint', 'error')],
      prNumber: null,
    })
    .execute();
  // The DECOY: same sha string, the other repo. Never asked about as (otherRepo, TRUNK_HEAD).
  await db
    .insert(branchCommits)
    .values({
      accountId: 1,
      repoId: otherRepo,
      sha: TRUNK_HEAD,
      messageHeadline: 'decoy',
      committedAt: new Date(now - 2 * HOUR),
      ciStatus: 'failure',
      failingChecks: [checkRun('decoy-check')],
    })
    .execute();
  // ANOTHER ACCOUNT's row for the same sha.
  await db
    .insert(branchCommits)
    .values({
      accountId: account2,
      repoId: theirRepo,
      sha: TRUNK_HEAD,
      messageHeadline: 'theirs',
      committedAt: new Date(now - 2 * HOUR),
      ciStatus: 'failure',
      failingChecks: [checkRun('their-trunk-check')],
    })
    .execute();

  let n = 1;
  let ev = 1;
  const insertPr = async (
    key: string,
    authorId: number,
    values: Record<string, unknown>,
    touch = true,
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        githubNodeId: `PR_fc_${key}`,
        accountId: 1,
        repoId: appRepo,
        number: n++,
        title: `${key} fixture`,
        state: 'open',
        isDraft: false,
        authorId,
        openedAt: new Date(now - 3 * DAY),
        updatedAt: new Date(now - DAY),
        lastCommitAt: new Date(now - DAY),
        mergeStateStatus: 'blocked',
        mergeable: 'mergeable',
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    if (touch) {
      await db
        .insert(events)
        .values({
          accountId: 1,
          repoId: appRepo,
          prId: pr.id,
          actorId: authorId,
          type: 'commit_pushed',
          occurredAt: new Date(now - DAY),
          dedupeKey: `ev_fc_${ev++}`,
        })
        .execute();
    }
    return pr.id;
  };
  const csEvent = async (
    prId: number,
    headSha: string,
    status: string,
    names: string[],
    at: number,
    accountId = 1,
  ): Promise<void> => {
    await db
      .insert(ciStatusEvents)
      .values({
        accountId,
        repoId: appRepo,
        prId,
        headSha,
        status,
        failingChecks: names,
        observedAt: new Date(at),
      })
      .execute();
  };

  // (1) red at its current head, with an OLDER head's row before it. Five distinct names (one
  // duplicated, one over 200 characters), so the cap and the total are both visible.
  const red = await insertPr('red-current', aliceId, { ciStatus: 'failure', headSha: 'h-red' });
  await csEvent(red, 'h-old', 'failure', ['old-only'], now - 3 * DAY);
  await csEvent(red, 'h-red', 'failure', ['zeta', 'alpha', 'beta', 'gamma', 'alpha', LONG_NAME], now - DAY);
  // …and an untouched review thread on it, so an untouched_thread card is built from this PR.
  await db
    .insert(reviewThreads)
    .values({
      githubNodeId: 'RT_fc_red',
      prId: red,
      path: 'src/app.ts',
      isResolved: false,
      derivedState: 'untouched',
      originalCommenterId: viewerId,
      createdAt: new Date(now - 2 * DAY),
    })
    .execute();

  // (2) red, but the only row is for the head BEFORE the current one.
  const oldHead = await insertPr('old-head-only', aliceId, { ciStatus: 'failure', headSha: 'h-new' });
  await csEvent(oldHead, 'h-prev', 'failure', ['stale-check'], now - DAY);

  // (3) red on the PR row, but the NEWEST row for the current head is not red.
  const notRed = await insertPr('newest-not-red', aliceId, { ciStatus: 'failure', headSha: 'h-n' });
  await csEvent(notRed, 'h-n', 'failure', ['was-red'], now - 2 * DAY);
  await csEvent(notRed, 'h-n', 'pending', [], now - DAY);

  // (4) green — never asked about, whatever a row says.
  const green = await insertPr('green', aliceId, { ciStatus: 'success', headSha: 'h-g' });
  await csEvent(green, 'h-g', 'failure', ['ignored'], now - DAY);

  // (5) two rows at the same instant: the later-inserted one (higher id) wins.
  const tie = await insertPr('tie', aliceId, { ciStatus: 'error', headSha: 'h-t' });
  await csEvent(tie, 'h-t', 'failure', ['first'], now - DAY);
  await csEvent(tie, 'h-t', 'error', ['second'], now - DAY);

  // (6) another account's NEWER row for the same (PR, head) pair.
  const leak = await insertPr('leak', aliceId, { ciStatus: 'failure', headSha: 'h-l' });
  await csEvent(leak, 'h-l', 'failure', ['mine-check'], now - 2 * DAY);
  await csEvent(leak, 'h-l', 'failure', ['theirs-check'], now - HOUR, account2);

  // (7) a DRAFT with a review requested of the viewer: a my_turn card, and NOT in the open-PR
  // select — so only the my_turn fold can give it names.
  const draft = await insertPr('draft-requested', aliceId, {
    ciStatus: 'failure',
    headSha: 'h-d',
    isDraft: true,
  });
  await db.insert(reviewRequests).values({ prId: draft, userId: viewerId }).execute();
  await csEvent(draft, 'h-d', 'failure', ['draft-check'], now - DAY);

  // (8) red only on NON-required checks: GitHub would merge it, so it is a `merge` card.
  const unstable = await insertPr('unstable', aliceId, {
    ciStatus: 'failure',
    headSha: 'h-u',
    mergeStateStatus: 'unstable',
  });
  await csEvent(unstable, 'h-u', 'failure', ['optional-check'], now - DAY);

  // (9) a Dependabot bump whose required CI is red: the Dependencies tab's `ci_red`.
  const dep = await insertPr('dep-red', dependabotId, {
    ciStatus: 'failure',
    headSha: 'h-dep',
    dependencyVendor: 'dependabot',
  });
  await csEvent(dep, 'h-dep', 'failure', ['dep-check'], now - DAY);

  // (10) THE PAIR. Asked together, cross-a (at h-xa) and cross-b (at h-xb) make the select return
  // every row whose PR is either and whose sha is either. cross-a's NEWEST such row is at h-xb —
  // cross-b's head, not its own — and cross-b's ONLY such row is at h-xa. Keyed on the PR alone,
  // the newest-wins rule would name cross-a from the wrong head and name cross-b at all.
  const crossA = await insertPr('cross-a', aliceId, { ciStatus: 'failure', headSha: 'h-xa' });
  const crossB = await insertPr('cross-b', aliceId, { ciStatus: 'failure', headSha: 'h-xb' });
  await csEvent(crossA, 'h-xa', 'failure', ['xa-check'], now - DAY);
  await csEvent(crossA, 'h-xb', 'failure', ['xa-row-at-xb'], now - HOUR);
  await csEvent(crossB, 'h-xa', 'failure', ['xb-row-at-xa'], now - DAY);

  scope =await q.resolveWorkspaceScope(1, null);
});

afterAll(async () => {
  await setMyTurnSettings?.(1, null);
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('summariseFailingChecks', () => {
  it('dedupes, sorts, caps at three and counts them all', () => {
    expect(fc.summariseFailingChecks(['zeta', 'alpha', 'beta', 'gamma', 'alpha'])).toEqual({
      failingChecks: ['alpha', 'beta', 'gamma'],
      failingCheckTotal: 4,
    });
  });

  it('slices a name to 200 characters and drops blanks', () => {
    const s = fc.summariseFailingChecks([LONG_NAME, ' ', '', null, undefined]);
    expect(s?.failingChecks).toEqual(['y'.repeat(200)]);
    expect(s?.failingCheckTotal).toBe(1);
  });

  it('is null when nothing remains — "no names", never a zero', () => {
    expect(fc.summariseFailingChecks([])).toBeNull();
    expect(fc.summariseFailingChecks(['  '])).toBeNull();
    expect(fc.failingChecksFields(undefined)).toEqual({ failingChecks: null, failingCheckTotal: null });
  });
});

describe('prFailingChecks — the newest row for the CURRENT head, only when red', () => {
  const read = async (key: string, headSha: string, ciStatus = 'failure') =>
    (await fc.prFailingChecks(1, [{ id: P(key), headSha, ciStatus }])).get(P(key));

  it('names the current head’s checks, capped, with the uncapped total', async () => {
    expect(await read('red-current', 'h-red')).toEqual({
      headSha: 'h-red',
      failingChecks: ['alpha', 'beta', 'gamma'],
      failingCheckTotal: 5,
    });
  });

  it('ignores a row for an older head', async () => {
    expect(await read('old-head-only', 'h-new')).toBeUndefined();
  });

  it('gives nothing when the newest row for the head is not red', async () => {
    expect(await read('newest-not-red', 'h-n')).toBeUndefined();
  });

  it('never asks about a green PR', async () => {
    expect(await read('green', 'h-g', 'success')).toBeUndefined();
  });

  it('breaks a same-instant tie on the row id', async () => {
    expect((await read('tie', 'h-t', 'error'))?.failingChecks).toEqual(['second']);
  });

  it('never reads another account’s rows, even a newer one for the same PR and head', async () => {
    expect((await read('leak', 'h-l'))?.failingChecks).toEqual(['mine-check']);
    // …and from the other side, account 2 sees only its own.
    const theirs = await fc.prFailingChecks(account2, [
      { id: P('leak'), headSha: 'h-l', ciStatus: 'failure' },
    ]);
    expect(theirs.get(P('leak'))?.failingChecks).toEqual(['theirs-check']);
  });

  it('keys on the (PR, head) PAIR — the IN × IN predicate over-matches', async () => {
    // ⚠ ANTI-VACUITY: the cross rows are what the select returns AND what the newest-wins rule
    // would pick — cross-a's h-xb row is NEWER than its own head's, and cross-b's h-xa row is its
    // only candidate. Delete the pair filter and both assertions below fail.
    const m = await fc.prFailingChecks(1, [
      { id: P('cross-a'), headSha: 'h-xa', ciStatus: 'failure' },
      { id: P('cross-b'), headSha: 'h-xb', ciStatus: 'failure' },
    ]);
    expect(m.get(P('cross-a'))).toEqual({
      headSha: 'h-xa',
      failingChecks: ['xa-check'],
      failingCheckTotal: 1,
    });
    expect(m.has(P('cross-b'))).toBe(false);
  });
});

describe('trunkHeadFailingChecks — the one reader /api/branch-status and the cards share', () => {
  it('reads the head’s row, keyed by the (repo, sha) pair, never the decoy', async () => {
    const m = await bq.trunkHeadFailingChecks(1, [
      { repoId: appRepo, sha: TRUNK_HEAD },
      { repoId: otherRepo, sha: OTHER_HEAD },
      // No row at all for this head: absent from the map, not an empty entry.
      { repoId: rowlessRepo, sha: ROWLESS_HEAD },
    ]);
    expect(m.get(bq.trunkHeadKey(appRepo, TRUNK_HEAD))?.map((c) => c.name)).toEqual([
      'Run Journey Tests / Run Journey Tests',
      'lint',
    ]);
    // (otherRepo, TRUNK_HEAD) matched the IN × IN predicate and was not asked for.
    expect(m.has(bq.trunkHeadKey(otherRepo, TRUNK_HEAD))).toBe(false);
    expect(m.size).toBe(1);
  });

  it('is account-scoped', async () => {
    const m = await bq.trunkHeadFailingChecks(account2, [{ repoId: appRepo, sha: TRUNK_HEAD }]);
    expect(m.size).toBe(0);
  });

  it('is what /api/branch-status reports for the head', async () => {
    const status = await bq.getBranchStatus(1, [appRepo]);
    expect(status.repos[0]?.failingChecks.map((c) => c.name)).toEqual([
      'Run Journey Tests / Run Journey Tests',
      'lint',
    ]);
  });

  it('maps to BARE names for a card — never workflow-prefixed', async () => {
    const m = await fc.trunkFailingChecks(1, [{ repoId: appRepo, sha: TRUNK_HEAD }]);
    expect(fc.trunkFailingFor(m, appRepo, TRUNK_HEAD)).toEqual({
      failingChecks: ['lint', 'Run Journey Tests / Run Journey Tests'],
      failingCheckTotal: 2,
    });
    expect(fc.trunkFailingFor(m, appRepo, null)).toBeUndefined();
  });
});

describe('the Pending board carries the names on every red card', () => {
  it('every card on a red PR names its current head’s checks — whatever its kind', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const onRed = prCardsFor(cards, P('red-current'));
    // ⚠ ANTI-VACUITY: the fixture emits these kinds for this PR, and the assertion below is a loop.
    expect(new Set(onRed.map((c) => c.kind))).toEqual(new Set(['untouched_thread', 'reviewer_routing']));
    for (const c of onRed) {
      expect(c.failingChecks, c.kind).toEqual(['alpha', 'beta', 'gamma']);
      expect(c.failingCheckTotal, c.kind).toBe(5);
    }
  });

  it('a my_turn card on a DRAFT gets them through the second fold', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const onDraft = prCardsFor(cards, P('draft-requested'));
    expect(onDraft.map((c) => c.kind)).toEqual(['my_turn']);
    expect(onDraft[0]?.failingChecks).toEqual(['draft-check']);
    expect(onDraft[0]?.failingCheckTotal).toBe(1);
  });

  it('a merge card whose red is non-required checks names them', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const merge = prCardsFor(cards, P('unstable')).find((c) => c.kind === 'merge');
    expect(merge?.failingChecks).toEqual(['optional-check']);
  });

  it('a Dependencies card whose CI is red names them', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const dep = prCardsFor(cards, P('dep-red')).find(
      (c): c is DependencyBumpCard & InsightPrRef => c.kind === 'dependency_bump',
    );
    expect(dep?.depState).toBe('ci_red');
    expect(dep?.failingChecks).toEqual(['dep-check']);
  });

  it('a red PR with no current-head names carries neither field', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    for (const key of ['old-head-only', 'newest-not-red']) {
      const list = prCardsFor(cards, P(key));
      expect(list.length, key).toBeGreaterThan(0);
      for (const c of list) {
        expect('failingChecks' in c, `${key} ${c.kind}`).toBe(false);
        expect('failingCheckTotal' in c, `${key} ${c.kind}`).toBe(false);
      }
    }
  });

  const trunkCardFor = (cards: InsightCard[], repoId: number): CiFailingCard | undefined =>
    cards.find(
      (c): c is CiFailingCard => c.kind === 'ci_failing' && c.arm === 'trunk' && c.repoId === repoId,
    );
  const promotedFor = (cards: InsightCard[], repoId: number): MyTurnTrunkCard | undefined =>
    cards.find(
      (c): c is MyTurnTrunkCard =>
        c.kind === 'my_turn' && c.reason === 'trunk_red' && c.repoId === repoId,
    );

  it('the trunk card names a DIRECT PUSH’s failing checks — no landing PR needed', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const trunk = trunkCardFor(cards, appRepo);
    expect(trunk?.prId).toBeNull();
    expect(trunk?.failingChecks).toEqual(['lint', 'Run Journey Tests / Run Journey Tests']);
    expect(trunk?.failingCheckTotal).toBe(2);
  });

  it('a red head with NO branch_commits row still ships its card, naming nothing', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const trunk = trunkCardFor(cards, rowlessRepo);
    expect(trunk).toBeDefined();
    expect(trunk?.headSha).toBe(ROWLESS_HEAD);
    // null for BOTH halves — never [] and never 0, which would print "0 failing".
    expect(trunk?.failingChecks).toBeNull();
    expect(trunk?.failingCheckTotal).toBeNull();
  });

  it('a promoted red trunk carries the same pair', async () => {
    await setMyTurnSettings(1, { trunkScope: 'maintained' });
    try {
      const cards = (await boardFold()).cards as InsightCard[];
      const promoted = promotedFor(cards, appRepo);
      expect(promoted?.repoId).toBe(appRepo);
      expect(promoted?.failingChecks).toEqual(['lint', 'Run Journey Tests / Run Journey Tests']);
      expect(promoted?.failingCheckTotal).toBe(2);
      // …and the row-less head is promoted too, naming nothing.
      const rowless = promotedFor(cards, rowlessRepo);
      expect(rowless).toBeDefined();
      expect(rowless?.failingChecks).toBeNull();
      expect(rowless?.failingCheckTotal).toBeNull();
      // They MOVED: no ci_failing trunk card beside them.
      expect(cards.some((c) => c.kind === 'ci_failing' && c.arm === 'trunk')).toBe(false);
    } finally {
      await setMyTurnSettings(1, null);
    }
  });

  it('no card’s sentence ever names a check', async () => {
    const cards = (await boardFold()).cards as InsightCard[];
    const names = [
      'alpha',
      'draft-check',
      'optional-check',
      'dep-check',
      'lint',
      'Run Journey Tests',
    ];
    for (const c of cards) {
      const detail = 'detail' in c && typeof c.detail === 'string' ? c.detail : '';
      for (const n of names) expect(detail, `${c.id}`).not.toContain(n);
    }
  });
});

describe('every other consumer pays nothing', () => {
  it('the default fold carries no names on any card', async () => {
    const cards = (await defaultFold()).cards as InsightCard[];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      if (c.kind === 'ci_failing' || (c.kind === 'my_turn' && c.reason === 'trunk_red')) {
        expect(c.failingChecks, c.id).toBeNull();
        expect(c.failingCheckTotal, c.id).toBeNull();
      } else {
        expect('failingChecks' in c, c.id).toBe(false);
      }
    }
  });

  it('…including the work plan’s uncapped fold', async () => {
    const cards = (await q.getWorkspaceInsights(1, undefined, scope, { uncapped: true }))
      .cards as InsightCard[];
    expect(cards.some((c) => 'failingChecks' in c && c.failingChecks != null)).toBe(false);
  });
});
