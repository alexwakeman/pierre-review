// CI-failure feed items (the opt-in "CI failures" pill) on a THROWAWAY sqlite DB.
//
// The things worth pinning, each with a silent failure mode:
//  1. OFF BY DEFAULT. `includeCiFailures` absent/false must emit ZERO CI rows AND a zero facet
//     — the whole feature is a toggle, and a builder that runs anyway is invisible until a
//     user complains their feed doubled.
//  2. THE DEDUPE GRAIN. Both sources are TRANSITION logs that write a fresh row whenever the
//     failing-check SET changes, so one broken push routinely produces several rows. One card
//     per (target, head sha, check name), timestamped by the EARLIEST observation — otherwise a
//     re-confirmed failure keeps jumping to the top of the feed.
//  3. THE TRUNK HALF IS PR-LESS. `prId: null` is what keeps it out of the My-Turn lane and the
//     per-page PR enrichment; a regression here would be a card claiming to belong to a PR.
//  4. CI ROWS NEVER ENTER THE MY-TURN LANE. They are actor-less, so `actorId !== localUserId`
//     is trivially true — handing them to enrichMyTurn would make every red build on a PR you
//     participate in an UNCAPPED yellow card. The fixture makes the viewer the PR's AUTHOR and
//     asserts a normal row on the SAME PR *is* my-turn, so the check cannot pass vacuously.
//  5. THE FACET RECONCILES with the items actually in the stream.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsolidatedFeedItem, ConsolidatedFeedResponse } from '@pierre-review/shared';
import type { trunkCiTransitionChanged as TrunkCiTransitionChanged } from '../sync/branch-status.js';

// ⚠ EVERY runtime import of a module that reaches db/client.ts must be DYNAMIC, inside
// beforeAll and AFTER the rmSync below. A static import opens the sqlite file at module load —
// i.e. before the file is deleted — and the surviving handle then keeps reading the PREVIOUS
// run's unlinked inode, so the suite silently runs against stale data.
const DB_PATH = '/tmp/pierre-ci-feed-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let getConsolidatedFeed: (accountId: number, opts: any) => Promise<ConsolidatedFeedResponse>;
let resolveWorkspaceScope: (
  accountId: number,
  raw: string | undefined,
  narrow: number[] | null,
) => Promise<{ workspaceId: number; repoIds: number[] }>;
let trunkCiTransitionChanged: typeof TrunkCiTransitionChanged;

// ⚠ RELATIVE TO NOW, ON PURPOSE. The consolidated feed's un-isolated window is a rolling 14
// days, so a fixture pinned to absolute calendar dates silently ages out and the whole suite
// starts asserting against an empty feed — every list comes back empty and every assertion
// fails for a reason that has nothing to do with the code under test. Everything below sits
// well inside 336 hours.
// Second-aligned: sqlite stores `mode:'timestamp'` columns as unix SECONDS, so a base carrying
// milliseconds round-trips truncated and every exact-timestamp assertion misses by <1s.
const T0 = Math.floor(Date.now() / 1000) * 1000;
const hAgo = (hours: number): Date => new Date(T0 - hours * 3_600_000);

let accountId = 0;
let repoId = 0;
let prId = 0;
let workspaceId = 0;

const isCi = (i: ConsolidatedFeedItem): boolean =>
  i.kind === 'ci_failed' || i.kind === 'trunk_ci_failed';

async function feed(over: Record<string, unknown> = {}): Promise<ConsolidatedFeedResponse> {
  return getConsolidatedFeed(accountId, {
    workspaceId,
    repoIds: [repoId],
    userIds: null,
    prId: null,
    limit: null,
    offset: 0,
    ...over,
  });
}

const check = (name: string) => ({
  name,
  state: 'failure' as const,
  url: null,
  runId: null,
  jobId: null,
  workflowName: null,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('./run-migrations.js');
  const client = await import('./client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  const q = await import('./queries.js');
  getConsolidatedFeed = q.getConsolidatedFeed as typeof getConsolidatedFeed;
  resolveWorkspaceScope = q.resolveWorkspaceScope as typeof resolveWorkspaceScope;
  ({ trunkCiTransitionChanged } = await import('../sync/branch-status.js'));
  await runMigrations();

  const { accounts, repos, users, pullRequests, events, ciStatusEvents, trunkCiStatusEvents } =
    schema;

  // The migrations may or may not have seeded a local account, so resolve by login.
  const existing = await db.select().from(accounts).execute();
  const found = existing.find((a: any) => a.githubLogin === 'viewer');
  accountId =
    found?.id ??
    (
      await db
        .insert(accounts)
        .values({ githubUserId: 'U_viewer', githubLogin: 'viewer' })
        .returning()
        .execute()
    )[0].id;

  // A `users` row whose login matches the account's is what makes getAccountUserId (and thus
  // enrichMyTurn) resolve — without it the my-turn assertions below would be vacuous.
  const [viewer] = await db
    .insert(users)
    .values({ githubLogin: 'viewer', githubNodeId: 'U_viewer' })
    .returning()
    .execute();
  const [other] = await db
    .insert(users)
    .values({ githubLogin: 'other', githubNodeId: 'U_other' })
    .returning()
    .execute();

  const [repo] = await db
    .insert(repos)
    .values({ accountId, owner: 'acme', name: 'app', githubNodeId: 'R_app' })
    .returning()
    .execute();
  repoId = repo.id;

  // Authored by the VIEWER → participation is real, so a normal feed row on this PR is my-turn.
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_1',
      accountId,
      repoId,
      number: 12,
      title: 'Add the thing',
      authorId: viewer.id,
      state: 'open',
      openedAt: hAgo(240),
      updatedAt: hAgo(24),
    })
    .returning()
    .execute();
  prId = pr.id;

  // One ordinary activity row, by SOMEONE ELSE, so the my-turn lane is demonstrably live.
  await db
    .insert(events)
    .values({
      accountId,
      repoId,
      actorId: other.id,
      prId,
      type: 'pr_comment',
      occurredAt: hAgo(24),
      dedupeKey: 'pr_comment:1',
    })
    .execute();

  // ---- PR-side CI transition log ----------------------------------------------------------
  // Head A: 'build' fails; a later row RE-REPORTS the same set (an ordinary re-walk); a later
  // one WIDENS it; then it goes green. Expect exactly two cards, each at its first sighting.
  await db
    .insert(ciStatusEvents)
    .values([
      {
        accountId,
        repoId,
        prId,
        headSha: 'aaaaaaa1111',
        status: 'failure',
        failingChecks: ['build'],
        observedAt: hAgo(120),
      },
      {
        accountId,
        repoId,
        prId,
        headSha: 'aaaaaaa1111',
        status: 'failure',
        failingChecks: ['build'],
        observedAt: hAgo(119),
      },
      {
        accountId,
        repoId,
        prId,
        headSha: 'aaaaaaa1111',
        status: 'failure',
        failingChecks: ['build', 'lint'],
        observedAt: hAgo(118),
      },
      // The green row that followed must contribute nothing.
      {
        accountId,
        repoId,
        prId,
        headSha: 'aaaaaaa1111',
        status: 'success',
        failingChecks: [],
        observedAt: hAgo(117),
      },
      // A different head with SEVEN failing checks — past MAX_CI_ITEMS_PER_HEAD.
      {
        accountId,
        repoId,
        prId,
        headSha: 'bbbbbbb2222',
        status: 'failure',
        failingChecks: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
        observedAt: hAgo(96),
      },
      // A red rollup that named no contexts at all — still one honest card.
      {
        accountId,
        repoId,
        prId,
        headSha: 'ccccccc3333',
        status: 'error',
        failingChecks: [],
        observedAt: hAgo(72),
      },
      // ---- THE MATRIX BUILD: ONE head going red SHARD BY SHARD ------------------------------
      // Seven transition rows on ONE head, each carrying the CUMULATIVE failing set — exactly
      // what sync/upsert.ts writes as a sharded workflow reports failures one at a time. The
      // names are chosen so each NEW shard sorts FIRST, i.e. it lands inside whatever
      // top-MAX_CI_ITEMS_PER_HEAD window a per-ROW cap would compute: a cap applied per row
      // (with a dedupe set keyed globally) therefore emits a fresh card for every single row and
      // the head produces SEVEN cards, while the "N more checks also failing" disclosure — the
      // whole reason the cap exists — reads 0 on the early ones.
      ...['shard-7', 'shard-6', 'shard-5', 'shard-4', 'shard-3', 'shard-2', 'shard-1'].map(
        (_name, i) => ({
          accountId,
          repoId,
          prId,
          headSha: 'fffffff6666',
          status: 'failure' as const,
          failingChecks: ['shard-7', 'shard-6', 'shard-5', 'shard-4', 'shard-3', 'shard-2', 'shard-1']
            .slice(0, i + 1),
          observedAt: hAgo(60 - i),
        }),
      ),
    ])
    .execute();

  // ---- Trunk-side CI transition log -------------------------------------------------------
  await db
    .insert(trunkCiStatusEvents)
    .values([
      {
        accountId,
        repoId,
        branchName: 'main',
        headSha: 'ddddddd4444',
        status: 'failure',
        failingChecks: [check('e2e')],
        observedAt: hAgo(48),
      },
      // Re-observation of the same head + set → no second card.
      {
        accountId,
        repoId,
        branchName: 'main',
        headSha: 'ddddddd4444',
        status: 'failure',
        failingChecks: [check('e2e')],
        observedAt: hAgo(47),
      },
      // Green again — contributes nothing.
      {
        accountId,
        repoId,
        branchName: 'main',
        headSha: 'eeeeeee5555',
        status: 'success',
        failingChecks: null,
        observedAt: hAgo(46),
      },
    ])
    .execute();

  const scope = await resolveWorkspaceScope(accountId, undefined, [repoId]);
  workspaceId = scope.workspaceId;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('CI-failure feed items', () => {
  it('emits nothing at all unless includeCiFailures is set', async () => {
    const off = await feed();
    expect(off.items.filter(isCi)).toEqual([]);
    expect(off.counts?.ciFailures).toBe(0);
    // Explicit false must behave exactly like absent.
    const explicit = await feed({ includeCiFailures: false });
    expect(explicit.items.filter(isCi)).toEqual([]);
  });

  it('emits one card per (PR, head sha, check name), at the EARLIEST observation', async () => {
    const on = await feed({ includeCiFailures: true });
    const head = on.items.filter((i) => i.ciHeadSha === 'aaaaaaa1111');
    expect(head.map((i) => i.failingChecks?.[0]).sort()).toEqual(['build', 'lint']);
    // Three rows named 'build' (two identical re-walks + the widened set) → ONE card, stamped
    // when it was first seen, not when it was last re-confirmed.
    const build = head.find((i) => i.failingChecks?.[0] === 'build');
    expect(build?.occurredAt).toBe(hAgo(120).toISOString());
    expect(build?.kind).toBe('ci_failed');
    expect(build?.prId).toBe(prId);
    expect(build?.prNumber).toBe(12);
    expect(build?.actorId).toBeNull();
    // 'lint' first appeared on the widened row.
    expect(head.find((i) => i.failingChecks?.[0] === 'lint')?.occurredAt).toBe(
      hAgo(118).toISOString(),
    );
  });

  it('a success row after a failure emits no card of its own', async () => {
    const on = await feed({ includeCiFailures: true });
    // Head aaaa went green last; only the two failing checks are cards.
    expect(on.items.filter((i) => i.ciHeadSha === 'aaaaaaa1111')).toHaveLength(2);
    // The trunk head that went green contributes nothing.
    expect(on.items.filter((i) => i.ciHeadSha === 'eeeeeee5555')).toEqual([]);
  });

  it('caps the cards one head can emit and DISCLOSES the overflow', async () => {
    const on = await feed({ includeCiFailures: true });
    const many = on.items.filter((i) => i.ciHeadSha === 'bbbbbbb2222');
    expect(many).toHaveLength(5);
    for (const it of many) expect(it.changeSummary).toContain('2 more checks also failing');
  });

  // ⚠ THE CAP IS PER (target, head), NOT PER ROW. `ci_status_events` is a TRANSITION log, so one
  // head routinely owns many rows; a cap computed from a single row's list — with the dedupe set
  // keyed globally — lets every row contribute one more card, and the overflow disclosure is
  // computed from a set that is not the head's real one. Both halves are asserted here.
  it('caps a head that goes red SHARD BY SHARD across many transition rows', async () => {
    const on = await feed({ includeCiFailures: true });
    const shards = on.items.filter((i) => i.ciHeadSha === 'fffffff6666');
    expect(shards).toHaveLength(5);
    // The five kept are the five FIRST OBSERVED, each stamped when it first appeared — not the
    // five that happen to sort first across the union.
    expect(shards.map((i) => i.failingChecks?.[0]).sort()).toEqual([
      'shard-3',
      'shard-4',
      'shard-5',
      'shard-6',
      'shard-7',
    ]);
    expect(shards.find((i) => i.failingChecks?.[0] === 'shard-7')?.occurredAt).toBe(
      hAgo(60).toISOString(),
    );
    expect(shards.find((i) => i.failingChecks?.[0] === 'shard-3')?.occurredAt).toBe(
      hAgo(56).toISOString(),
    );
    // …and the disclosure counts the head's WHOLE union (7) minus what was emitted (5).
    for (const it of shards) expect(it.changeSummary).toContain('2 more checks also failing');
  });

  it('a red rollup with no named checks still emits one honest card', async () => {
    const on = await feed({ includeCiFailures: true });
    const bare = on.items.filter((i) => i.ciHeadSha === 'ccccccc3333');
    expect(bare).toHaveLength(1);
    expect(bare[0]?.failingChecks).toEqual([]);
    expect(bare[0]?.changeSummary).toContain('CI failed');
  });

  it('surfaces a trunk failure as a PR-LESS card linking the commit', async () => {
    const on = await feed({ includeCiFailures: true });
    const trunk = on.items.filter((i) => i.kind === 'trunk_ci_failed');
    expect(trunk).toHaveLength(1);
    const t = trunk[0]!;
    expect(t.prId).toBeNull();
    expect(t.prNumber).toBeNull();
    expect(t.actorId).toBeNull();
    expect(t.failingChecks).toEqual(['e2e']);
    expect(t.githubUrl).toBe('https://github.com/acme/app/commit/ddddddd4444');
    // Earliest observation, not the re-walk an hour later.
    expect(t.occurredAt).toBe(hAgo(48).toISOString());
    // The branch name is in the summary, never faked into a PR reference.
    expect(t.changeSummary).toContain('main');
  });

  it('never flags a CI card as My Turn — and the lane is demonstrably live', async () => {
    const on = await feed({ includeCiFailures: true });
    // NOT VACUOUS: the viewer authored this PR, so the ordinary comment row IS my-turn.
    const comment = on.items.find((i) => i.kind === 'pr_comment');
    expect(comment?.isMyTurn, 'fixture broken — enrichMyTurn flagged nothing').toBe(true);
    for (const it of on.items.filter(isCi)) {
      expect(it.isMyTurn).toBe(false);
      expect(it.myTurnReasons).toEqual([]);
      expect(it.reasonTag).toBeNull();
    }
  });

  it('reports a ciFailures facet that reconciles with the stream', async () => {
    const on = await feed({ includeCiFailures: true });
    expect(on.counts?.ciFailures).toBe(on.items.filter(isCi).length);
    // 2 (head aaaa) + 5 (capped head bbbb) + 1 (bare ccc) + 5 (capped head ffff) + 1 (trunk) = 14.
    expect(on.counts?.ciFailures).toBe(14);
  });

  it('skips both halves when a member filter is active (the rows are actor-less)', async () => {
    const scoped = await feed({ includeCiFailures: true, userIds: [1] });
    expect(scoped.items.filter(isCi)).toEqual([]);
  });

  it('skips the trunk half under single-PR isolation, keeping the PR half', async () => {
    const isolated = await feed({ includeCiFailures: true, prId });
    expect(isolated.items.filter((i) => i.kind === 'trunk_ci_failed')).toEqual([]);
    expect(isolated.items.filter((i) => i.kind === 'ci_failed').length).toBeGreaterThan(0);
  });

  it('emits no CI rows on the bot-only feed', async () => {
    const bots = await feed({ includeCiFailures: true, botsOnly: true });
    expect(bots.items.filter(isCi)).toEqual([]);
  });
});

// The partial-response half of the writer, which has no observable symptom until a repo's log
// fills with spurious "checks changed" rows.
describe('trunkCiTransitionChanged', () => {
  const last = {
    status: 'failure' as const,
    headSha: 'sha1',
    failingChecks: [check('build')],
  };

  it('records the first observation', () => {
    expect(
      trunkCiTransitionChanged(null, {
        status: 'success',
        headSha: 'sha1',
        failingCheckNames: [],
      }),
    ).toBe(true);
  });

  it('records a status or head-sha change', () => {
    expect(
      trunkCiTransitionChanged(last, {
        status: 'success',
        headSha: 'sha1',
        failingCheckNames: [],
      }),
    ).toBe(true);
    // A NEW head that is still red is a NEW failure — its own commit, its own feed card — so it
    // is recorded even though the failing set is byte-identical to the previous head's.
    expect(
      trunkCiTransitionChanged(last, {
        status: 'failure',
        headSha: 'sha2',
        failingCheckNames: ['build'],
      }),
    ).toBe(true);
  });

  // ⚠ THE ONE HEAD MOVE THAT IS NOT A TRANSITION. Trunk's head changes on every landed PR, and
  // the snapshot runs at the end of every walk (as often as every 120s on a hot repo), so
  // recording green-on-a-newer-commit filled the log with rows that state nothing — and, under
  // the old count-only trim, pushed the real failures out of the Feed's window. The narrowing is
  // minimal by construction: it needs a POSITIVE green on both sides with nothing named.
  it('does NOT record a head move while trunk is green and nothing is failing', () => {
    const green = { status: 'success' as const, headSha: 'sha1', failingChecks: null };
    expect(
      trunkCiTransitionChanged(green, {
        status: 'success',
        headSha: 'sha2',
        failingCheckNames: [],
      }),
    ).toBe(false);
    // 'expected' is the other positive "nothing is failing" rollup.
    expect(
      trunkCiTransitionChanged(
        { status: 'expected', headSha: 'sha1', failingChecks: [] },
        { status: 'expected', headSha: 'sha2', failingCheckNames: [] },
      ),
    ).toBe(false);
  });

  it('still records a head move for every rollup that is not a positive green', () => {
    for (const status of ['failure', 'error', 'pending'] as const) {
      expect(
        trunkCiTransitionChanged(
          { status, headSha: 'sha1', failingChecks: null },
          { status, headSha: 'sha2', failingCheckNames: [] },
        ),
        `${status} head move must be recorded`,
      ).toBe(true);
    }
    // …and a green head move can never swallow a named failure: a green rollup that still names
    // a failing check is a contradiction we record rather than drop.
    expect(
      trunkCiTransitionChanged(
        { status: 'success', headSha: 'sha1', failingChecks: null },
        { status: 'success', headSha: 'sha2', failingCheckNames: ['flaky'] },
      ),
    ).toBe(true);
  });

  it('records a changed failing-check SET', () => {
    expect(
      trunkCiTransitionChanged(last, {
        status: 'failure',
        headSha: 'sha1',
        failingCheckNames: ['build', 'lint'],
      }),
    ).toBe(true);
  });

  it('does NOT record an identical re-observation', () => {
    expect(
      trunkCiTransitionChanged(last, {
        status: 'failure',
        headSha: 'sha1',
        failingCheckNames: ['build'],
      }),
    ).toBe(false);
  });

  // THE PARTIAL-RESPONSE RULE: names we never received are not a statement that the set
  // emptied. Comparing them against `[]` would log a spurious transition every single sync for
  // any repo whose phase-2 detail fetch is failing.
  it('drops the name dimension entirely when the names were not received', () => {
    expect(
      trunkCiTransitionChanged(last, {
        status: 'failure',
        headSha: 'sha1',
        failingCheckNames: undefined,
      }),
    ).toBe(false);
    // …but an unreceived name set still cannot mask a real status change.
    expect(
      trunkCiTransitionChanged(last, {
        status: 'error',
        headSha: 'sha1',
        failingCheckNames: undefined,
      }),
    ).toBe(true);
  });
});
