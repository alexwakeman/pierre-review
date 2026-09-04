// THE PENDING BOARD'S LIVENESS SWEEP — the two folds that decide what GitHub is asked and what is
// written back, on a THROWAWAY sqlite DB (the pending-card-source.test.ts pattern).
//
// WHAT THIS PINS, and why each is a fixture rather than a comment:
//
//   1. ⚠ THE EXPENSIVE PASS IS A RANKED SUBSET, NOT A SLICE. `mergeable`/`mergeStateStatus` are
//      computed by GitHub on demand and MEASURED to 502 the gateway at 50 ids while 90 ids
//      without them answer in ~1.4s. So only ~25 PRs per sweep can carry them, and which 25 is
//      the design: the rows already offering a Merge / Update-branch button go first, because a
//      stale merge state THERE is a button that 405s. A plain `slice()` would order by whatever
//      the id list happened to be.
//   2. ⚠ A PR THAT ALREADY LEFT THE OPEN SET MUST NOT SPEND ONE OF THOSE SLOTS. GitHub is not
//      recomputing mergeability for a merged PR, and its card is leaving on this very refetch.
//   3. ⚠ `undefined` (the cheap pass never asked) IS NOT GitHub's `'unknown'`. Conflating them
//      would let the cheap pass CLEAR a real merge state on every tick — the "a column may be
//      cleared only on a positive statement from GitHub" rule, at the exact place it would break.
//   4. ⚠ "THE ROW WAS WRITTEN" IS NOT "A CARD MOVED". A `reviewDecision` GitHub merely restates
//      changes no card, and on real data most open PRs carry a null decision it restates every
//      time — counting that as movement would make the SPA refetch the board on a fixed timer
//      while pretending the timer was evidence.
//   5. A sweep that finds nothing writes nothing and reports nothing.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at module load).
//
// ⚠ EVERY VALUE IMPORT IS DYNAMIC, INSIDE beforeAll. `import` statements are HOISTED, so a static
// one — even of a pure helper like `foldLivenessNode` — runs its whole module graph BEFORE the
// `process.env.DATABASE_URL` assignment below, config caches the real path, and the fixture writes
// itself into the developer's actual database. That happened once while this file was being
// written; the `repos must be empty` guard in beforeAll is there so it can only ever happen once.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrLivenessObservation } from '../github/pr-liveness.js';

const DB_PATH = '/tmp/pierre-pr-liveness-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void>) | undefined;
let mod: typeof import('./pr-liveness.js');
let foldLivenessNode: typeof import('../github/pr-liveness.js')['foldLivenessNode'];

const DAY = 24 * 60 * 60 * 1000;
const now = Math.floor(Date.now() / 1000) * 1000;

let repoId = 0;
let otherRepoId = 0;
const prIdByKey = new Map<string, number>();

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mod = await import('./pr-liveness.js');
  ({ foldLivenessNode } = await import('../github/pr-liveness.js'));

  const { repos, pullRequests } = schema;
  // ⚠ THE THROWAWAY-DB GUARD. A migrated-from-scratch database has no repos; the developer's real
  // one has dozens. If a future static import ever re-pins config to the real path, this fails
  // here instead of seeding fixture repos into it (which then get a sync_state row and become
  // phantom repos burning GitHub quota — a real incident in this project's history).
  const existingRepos = await db.select({ id: repos.id }).from(repos).execute();
  if (existingRepos.length > 0) {
    throw new Error(
      `pr-liveness.test.ts refuses to run: expected a throwaway DB, found ${existingRepos.length} repos. DATABASE_URL did not take effect — check for a hoisted value import.`,
    );
  }
  const insertRepo = async (name: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({
        accountId: 1,
        owner: 'acme',
        name,
        githubNodeId: `R_live_${name}`,
        defaultBranch: 'main',
        defaultBranchName: 'main',
        viewerPermission: 'WRITE',
        createdAt: new Date(now - 30 * DAY),
      })
      .returning()
      .execute();
    return r.id;
  };
  repoId = await insertRepo('board');
  otherRepoId = await insertRepo('elsewhere');

  let n = 1;
  const insertPr = async (
    key: string,
    inRepo: number,
    values: Record<string, unknown>,
  ): Promise<number> => {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        accountId: 1,
        repoId: inRepo,
        githubNodeId: `PR_live_${key}`,
        number: n++,
        title: key,
        state: 'open',
        isDraft: false,
        openedAt: new Date(now - 5 * DAY),
        updatedAt: new Date(now - 5 * DAY),
        ...values,
      })
      .returning()
      .execute();
    prIdByKey.set(key, pr.id);
    return pr.id;
  };

  // The two FORWARD states — the rows carrying a Merge / Update-branch button.
  await insertPr('clean', repoId, { mergeStateStatus: 'clean', mergeable: 'mergeable' });
  await insertPr('behind', repoId, { mergeStateStatus: 'behind', mergeable: 'mergeable' });
  // A far more RECENTLY updated non-forward row — the one a plain "newest first" ordering would
  // put ahead of both of the above.
  await insertPr('blocked-fresh', repoId, {
    mergeStateStatus: 'blocked',
    updatedAt: new Date(now - 60_000),
  });
  await insertPr('unknown-state', repoId, { mergeStateStatus: null });
  // Already gone: no slot for it, and no card either.
  await insertPr('merged', repoId, { state: 'merged', mergeStateStatus: 'clean' });
  // Another workspace's repo — the scope predicate's target.
  await insertPr('outside', otherRepoId, { mergeStateStatus: 'clean' });
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

const targetsFor = async (keys: string[], repos = [repoId]) =>
  mod.getPrLivenessTargets(
    1,
    repos,
    keys.map((k) => prIdByKey.get(k)!),
  );

const obs = (over: Partial<PrLivenessObservation> = {}): PrLivenessObservation => ({
  nodeId: 'PR_x',
  state: 'open',
  isDraft: false,
  updatedAt: null,
  mergedAt: null,
  closedAt: null,
  reviewDecision: null,
  ...over,
});

describe('getPrLivenessTargets', () => {
  it('resolves only ids inside the account AND the workspace scope', async () => {
    const rows = await targetsFor(['clean', 'outside']);
    expect(rows.map((r) => r.githubNodeId)).toEqual(['PR_live_clean']);
  });

  it('an EMPTY scope resolves nothing — it never widens to the account', async () => {
    expect(await targetsFor(['clean'], [])).toEqual([]);
  });

  it('carries the stored merge facts the write-back compares against', async () => {
    const [row] = await targetsFor(['clean']);
    expect(row?.mergeStateStatus).toBe('clean');
    expect(row?.mergeable).toBe('mergeable');
    expect(row?.state).toBe('open');
  });
});

describe('rankForMergeStatePass', () => {
  it('puts the FORWARD rows first, ahead of a much more recently updated blocked one', async () => {
    const targets = await targetsFor(['blocked-fresh', 'unknown-state', 'clean', 'behind']);
    const ranked = mod.rankForMergeStatePass(targets, 2);
    // ⚠ The 'blocked-fresh' row was updated a minute ago and both forward rows five days ago; an
    // ordering by recency alone would seat it first and spend a scarce slot on a card with no
    // button on it.
    expect(ranked.map((t) => t.githubNodeId).sort()).toEqual([
      'PR_live_behind',
      'PR_live_clean',
    ]);
  });

  it('never seats a PR that has already left the open set', async () => {
    const targets = await targetsFor(['merged', 'clean']);
    expect(mod.rankForMergeStatePass(targets, 10).map((t) => t.githubNodeId)).toEqual([
      'PR_live_clean',
    ]);
  });

  it('honours the cap — the whole reason this fold exists', async () => {
    const targets = await targetsFor(['clean', 'behind', 'blocked-fresh', 'unknown-state']);
    expect(mod.rankForMergeStatePass(targets, 1)).toHaveLength(1);
  });
});

describe('applyPrLiveness', () => {
  it('reports nothing and writes nothing when GitHub restates what we already hold', async () => {
    const [t] = await targetsFor(['clean']);
    const diff = await mod.applyPrLiveness(1, t!, obs({ nodeId: t!.githubNodeId }));
    expect(diff).toBeNull();
  });

  it('a merge elsewhere moves the board AND leaves the open set', async () => {
    const [t] = await targetsFor(['behind']);
    const diff = await mod.applyPrLiveness(
      1,
      t!,
      obs({
        nodeId: t!.githubNodeId,
        state: 'merged',
        mergedAt: new Date(now).toISOString(),
      }),
    );
    expect(diff).toEqual({ prId: t!.prId, movedOnBoard: true, leftOpenSet: true });
    const [after] = await targetsFor(['behind']);
    expect(after?.state).toBe('merged');
  });

  it('an UNASKED merge state (the cheap pass) never clears the stored one', async () => {
    const before = (await targetsFor(['clean']))[0]!;
    // `mergeStateStatus`/`mergeable` absent — not null, ABSENT. The cheap pass does not select
    // them, and GitHub's own 'unknown' is a different, positive statement.
    await mod.applyPrLiveness(1, before, obs({ nodeId: before.githubNodeId }));
    const after = (await targetsFor(['clean']))[0]!;
    expect(after.mergeStateStatus).toBe('clean');
    expect(after.mergeable).toBe('mergeable');
  });

  // ⚠ THE CONVERGENCE GUARD. GitHub does not store mergeability — asking for it starts a trial
  // merge and returns UNKNOWN while that runs. At a 60s cadence this sweep sits inside that
  // window, so without the guard a `clean` PR would go clean → unknown → clean forever, each
  // transition reported as `changed`, and the board would refetch on a fixed timer with a GitHub
  // call in front of it. Measured live: sweeps 1 and 2 reported 8 and 14 changes as real
  // staleness converged, and sweep 3 reported 0 — which is only stable if this holds.
  it('an observed UNKNOWN never demotes a known merge state', async () => {
    const t = (await targetsFor(['clean']))[0]!;
    expect(t.mergeStateStatus).toBe('clean');
    const diff = await mod.applyPrLiveness(
      1,
      t,
      obs({ nodeId: t.githubNodeId, mergeStateStatus: 'unknown', mergeable: 'unknown' }),
    );
    expect(diff).toBeNull();
    expect((await targetsFor(['clean']))[0]!.mergeStateStatus).toBe('clean');
  });

  it('but an UNKNOWN IS written when nothing is stored — it is still the honest answer', async () => {
    const t = (await targetsFor(['unknown-state']))[0]!;
    expect(t.mergeStateStatus).toBeNull();
    const diff = await mod.applyPrLiveness(
      1,
      t,
      obs({ nodeId: t.githubNodeId, mergeStateStatus: 'unknown' }),
    );
    expect(diff?.movedOnBoard).toBe(true);
    expect((await targetsFor(['unknown-state']))[0]!.mergeStateStatus).toBe('unknown');
  });

  it('a merge-state flip is board movement; a restated review decision is not', async () => {
    const t = (await targetsFor(['unknown-state']))[0]!;
    const flip = await mod.applyPrLiveness(
      1,
      t,
      obs({ nodeId: t.githubNodeId, mergeStateStatus: 'clean', mergeable: 'mergeable' }),
    );
    expect(flip?.movedOnBoard).toBe(true);
    expect(flip?.leftOpenSet).toBe(false);

    // Now only the review decision changes. The row IS written — the column is real and the next
    // reader wants it — but nothing on the board renders it, so the SPA must not be told to
    // refetch: `changed` counts `movedOnBoard`, and a board that refetched on this would be
    // refetching on a timer with a GitHub call in front of it.
    const t2 = (await targetsFor(['unknown-state']))[0]!;
    const rd = await mod.applyPrLiveness(
      1,
      t2,
      obs({
        nodeId: t2.githubNodeId,
        reviewDecision: 'approved',
        mergeStateStatus: 'clean',
        mergeable: 'mergeable',
      }),
    );
    expect(rd).not.toBeNull();
    expect(rd?.movedOnBoard).toBe(false);
    expect((await targetsFor(['unknown-state']))[0]!.reviewDecision).toBe('approved');
  });
});

describe('foldLivenessNode', () => {
  // `state` is the proof the inline fragment landed. graphqlTolerant hands back partial data with
  // forbidden fields NULLED, so without this gate a node the token lost access to would read as a
  // PR with no merge state — and the write-back would treat that as news.
  it('refuses a node whose PullRequest selection did not arrive', () => {
    expect(foldLivenessNode({ __typename: 'PullRequest', id: 'PR_1' })).toBeNull();
    expect(foldLivenessNode({ __typename: 'Issue', id: 'I_1', state: null })).toBeNull();
    expect(foldLivenessNode(null)).toBeNull();
  });

  it('leaves the merge fields UNSET when they were not asked for', () => {
    const o = foldLivenessNode({ __typename: 'PullRequest', id: 'PR_1', state: 'OPEN' });
    expect(o?.state).toBe('open');
    expect('mergeable' in (o ?? {})).toBe(false);
    expect('mergeStateStatus' in (o ?? {})).toBe(false);
  });

  it('lowercases the enums it models and drops ones it does not', () => {
    const o = foldLivenessNode({
      __typename: 'PullRequest',
      id: 'PR_1',
      state: 'MERGED',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      reviewDecision: 'CHANGES_REQUESTED',
    });
    expect(o).toMatchObject({
      state: 'merged',
      mergeable: 'conflicting',
      mergeStateStatus: 'dirty',
      reviewDecision: 'changes_requested',
    });
    // A future GitHub enum member must not reach the column as a value nothing renders.
    const unknown = foldLivenessNode({
      __typename: 'PullRequest',
      id: 'PR_1',
      state: 'OPEN',
      mergeStateStatus: 'SOMETHING_NEW',
    });
    expect('mergeStateStatus' in (unknown ?? {})).toBe(false);
  });
});
