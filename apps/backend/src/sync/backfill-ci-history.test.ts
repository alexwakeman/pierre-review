// The PR CI-history backfill: eligibility, synthesis, request shape, and the write path —
// throwaway sqlite for the DB halves, hand-built fragments for the pure ones.
//
// The three things worth pinning down, because each has a silent failure mode:
//   1. THE ELIGIBILITY GUARD. A PR is synthesized only when its stored events are provably the
//      initial walk's snapshot (zero rows, or ONE row whose headSha is the newest stored
//      commit). Widening this re-writes real observed history on every deep re-sync — a
//      corruption nothing would ever report.
//   2. THE COST SHAPE. The states query must carry shas as VARIABLES and select NO contexts
//      (state-only is what makes 100 aliases ≈ 1 point; the names query is separately capped).
//   3. THE REPLACE. The first-observation row is deleted by ID in the same transaction that
//      inserts the series — a PR passed with an empty series must not lose that row.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GraphqlClient } from '../github/client.js';
import {
  buildCommitStatesQuery,
  type CommitStatesResponse,
} from '../github/branch-queries.js';
import type { CiStatus } from '@pierre-review/shared';

const DB_PATH = '/tmp/pierre-ci-backfill-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let mod: typeof import('./backfill-ci-history.js');

const at = (day: number): Date => new Date(Date.UTC(2026, 6, day, 12));

let acct = 0;
let foreignAcct = 0;
let repoId = 0;
let foreignRepoId = 0;
let prFresh = 0; // 3 commits, no events — the plain new-repo case
let prSnapshot = 0; // 2 commits, ONE event at the newest sha — the replaceable snapshot
let prMidHistory = 0; // 2 commits, one event at an OLDER sha — real history, untouchable
let prRealHistory = 0; // 2 commits, two events — real history, untouchable
let prForeign = 0; // another tenant's PR — must never surface
let snapshotEventId = 0;

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  mod = await import('./backfill-ci-history.js');
  await runMigrations();

  const { accounts, repos, pullRequests, commits, ciStatusEvents } = schema;
  // Account 1 may be pre-seeded by the migrations' local-account path; upsert by login.
  const mkAccount = async (login: string): Promise<number> => {
    const existing = await db.select().from(accounts).execute();
    const found = existing.find((a: any) => a.githubLogin === login);
    if (found) return found.id;
    const [row] = await db
      .insert(accounts)
      .values({ githubUserId: `U_${login}`, githubLogin: login })
      .returning()
      .execute();
    return row.id;
  };
  acct = await mkAccount('mine');
  foreignAcct = await mkAccount('theirs');

  const mkRepo = async (accountId: number, tag: string): Promise<number> => {
    const [r] = await db
      .insert(repos)
      .values({ accountId, owner: 'acme', name: tag, githubNodeId: `R_${tag}` })
      .returning()
      .execute();
    return r.id;
  };
  repoId = await mkRepo(acct, 'app');
  foreignRepoId = await mkRepo(foreignAcct, 'other');

  const mkPr = async (accountId: number, rId: number, num: number): Promise<number> => {
    const [p] = await db
      .insert(pullRequests)
      .values({
        accountId,
        repoId: rId,
        githubNodeId: `PR_${rId}_${num}`,
        number: num,
        title: `pr ${num}`,
        state: 'merged',
        openedAt: at(9),
        updatedAt: at(14),
        mergedAt: at(14),
      })
      .returning()
      .execute();
    return p.id;
  };
  const mkCommit = async (prId: number, sha: string, day: number): Promise<void> => {
    await db.insert(commits).values({ prId, sha, committedAt: at(day) }).execute();
  };
  const mkEvent = async (
    accountId: number,
    rId: number,
    prId: number,
    headSha: string,
    day: number,
  ): Promise<number> => {
    const [e] = await db
      .insert(ciStatusEvents)
      .values({
        accountId,
        repoId: rId,
        prId,
        headSha,
        status: 'success',
        failingChecks: [],
        observedAt: at(day),
      })
      .returning()
      .execute();
    return e.id;
  };

  prFresh = await mkPr(acct, repoId, 1);
  await mkCommit(prFresh, 'F1', 10);
  await mkCommit(prFresh, 'F2', 11);
  await mkCommit(prFresh, 'F3', 12);

  prSnapshot = await mkPr(acct, repoId, 2);
  await mkCommit(prSnapshot, 'S1', 10);
  await mkCommit(prSnapshot, 'S2', 13);
  snapshotEventId = await mkEvent(acct, repoId, prSnapshot, 'S2', 20);

  prMidHistory = await mkPr(acct, repoId, 3);
  await mkCommit(prMidHistory, 'M1', 10);
  await mkCommit(prMidHistory, 'M2', 12);
  await mkEvent(acct, repoId, prMidHistory, 'M1', 11);

  prRealHistory = await mkPr(acct, repoId, 4);
  await mkCommit(prRealHistory, 'R1', 10);
  await mkCommit(prRealHistory, 'R2', 11);
  await mkEvent(acct, repoId, prRealHistory, 'R1', 10);
  await mkEvent(acct, repoId, prRealHistory, 'R2', 11);

  prForeign = await mkPr(foreignAcct, foreignRepoId, 1);
  await mkCommit(prForeign, 'X1', 14);
});

afterAll(() => closeDb?.());

describe('isSynthesizable (the eligibility guard)', () => {
  it('rejects a PR with no stored commits', () => {
    expect(mod.isSynthesizable([], undefined)).toBe(false);
  });

  it('accepts zero events, and ONE event only when it sits at the newest stored sha', () => {
    expect(mod.isSynthesizable([], 'head')).toBe(true);
    expect(mod.isSynthesizable([{ headSha: 'head' }], 'head')).toBe(true);
    // A single row at an OLDER sha is a real mid-history observation, not the snapshot.
    expect(mod.isSynthesizable([{ headSha: 'older' }], 'head')).toBe(false);
  });

  it('rejects any PR with two or more rows — that is real observed history', () => {
    expect(mod.isSynthesizable([{ headSha: 'a' }, { headSha: 'head' }], 'head')).toBe(false);
  });
});

describe('synthesizeCiEvents', () => {
  const commitsAsc = [
    { sha: 'a', committedAt: at(10) },
    { sha: 'b', committedAt: at(11) },
    { sha: 'c', committedAt: at(12) },
  ];

  it('replays commits in order, stamping observedAt with the committer date', () => {
    const rows = mod.synthesizeCiEvents(
      commitsAsc,
      new Map<string, CiStatus>([
        ['a', 'failure'],
        ['b', 'success'],
        ['c', 'success'],
      ]),
      new Map([['a', ['unit', 'lint']]]),
    );
    expect(rows).toEqual([
      { headSha: 'a', status: 'failure', failingChecks: ['unit', 'lint'], observedAt: at(10) },
      { headSha: 'b', status: 'success', failingChecks: [], observedAt: at(11) },
      { headSha: 'c', status: 'success', failingChecks: [], observedAt: at(12) },
    ]);
  });

  it('contributes nothing for unknowable or non-final shas (absent / pending / expected)', () => {
    const rows = mod.synthesizeCiEvents(
      commitsAsc,
      new Map<string, CiStatus>([
        ['a', 'pending'],
        ['b', 'error'],
        // 'c' absent — rollup never arrived.
      ]),
      new Map(),
    );
    expect(rows).toEqual([
      { headSha: 'b', status: 'error', failingChecks: [], observedAt: at(11) },
    ]);
  });

  it('returns [] for an all-green replay — nothing either chart could read', () => {
    const rows = mod.synthesizeCiEvents(
      commitsAsc,
      new Map<string, CiStatus>([
        ['a', 'success'],
        ['b', 'success'],
        ['c', 'success'],
      ]),
      new Map(),
    );
    expect(rows).toEqual([]);
  });

  it('a red commit past the detail cap still opens a streak, with no names', () => {
    const rows = mod.synthesizeCiEvents(
      commitsAsc.slice(0, 2),
      new Map<string, CiStatus>([
        ['a', 'failure'],
        ['b', 'success'],
      ]),
      new Map(), // no names fetched for 'a'
    );
    expect(rows[0]).toEqual({
      headSha: 'a',
      status: 'failure',
      failingChecks: [],
      observedAt: at(10),
    });
  });
});

describe('buildCommitStatesQuery (the cost shape)', () => {
  it('declares one GitObjectID variable per sha, aliases by index, and selects NO contexts', () => {
    const q = buildCommitStatesQuery(2);
    expect(q).toContain('$s0: GitObjectID!');
    expect(q).toContain('$s1: GitObjectID!');
    expect(q).toContain('c0: object(oid: $s0)');
    expect(q).toContain('c1: object(oid: $s1)');
    // State-only is the whole point: a contexts selection would multiply the node budget ~100×.
    expect(q).not.toContain('contexts');
  });
});

describe('fetchCommitStates', () => {
  const fakeClient = (
    resp: CommitStatesResponse,
  ): {
    client: GraphqlClient;
    calls: { query: string; variables: Record<string, unknown> }[];
  } => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const fn = (query: string, variables: Record<string, unknown>) => {
      calls.push({ query, variables });
      return Promise.resolve(resp);
    };
    return { client: fn as unknown as GraphqlClient, calls };
  };

  it('sends the shas as VARIABLES, never interpolated into the query text', async () => {
    const { client, calls } = fakeClient({ repository: {} });
    await mod.fetchCommitStates(client, 'acme', 'app', ['deadbeef', 'cafebabe']);
    const call = calls[0]!;
    expect(call.variables).toEqual({
      owner: 'acme',
      name: 'app',
      s0: 'deadbeef',
      s1: 'cafebabe',
    });
    expect(call.query).not.toContain('deadbeef');
  });

  it('maps received rollups through the shared enum and OMITS unknowable shas', async () => {
    const { client } = fakeClient({
      rateLimit: { cost: 1, remaining: 5000 },
      repository: {
        c0: { statusCheckRollup: { state: 'FAILURE' } },
        c1: { statusCheckRollup: { state: 'SUCCESS' } },
        // Rollup nulled (partial response, or CI never ran) and sha unresolvable: both absent.
        c2: { statusCheckRollup: null },
        c3: null,
      },
    });
    const { bySha, cost } = await mod.fetchCommitStates(client, 'acme', 'app', [
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(bySha.get('a')).toBe('failure');
    expect(bySha.get('b')).toBe('success');
    expect(bySha.has('c')).toBe(false);
    expect(bySha.has('d')).toBe(false);
    expect(cost).toBe(1);
  });
});

describe('collectCandidatePrs (throwaway DB)', () => {
  it('returns only the synthesizable PRs, newest activity first', async () => {
    const cands = await mod.collectCandidatePrs(acct, repoId);
    // prSnapshot's newest commit (day 13) beats prFresh's (day 12); the mid-history and
    // two-row PRs are untouchable.
    expect(cands.map((c) => c.prId)).toEqual([prSnapshot, prFresh]);
  });

  it('carries the replaceable first-observation row id, and null when there is none', async () => {
    const cands = await mod.collectCandidatePrs(acct, repoId);
    expect(cands.find((c) => c.prId === prSnapshot)?.soleEventId).toBe(snapshotEventId);
    expect(cands.find((c) => c.prId === prFresh)?.soleEventId).toBeNull();
  });

  it('orders each candidate’s commits ascending — the replay order', async () => {
    const cands = await mod.collectCandidatePrs(acct, repoId);
    expect(cands.find((c) => c.prId === prFresh)?.commits.map((c) => c.sha)).toEqual([
      'F1',
      'F2',
      'F3',
    ]);
  });

  it('never surfaces another tenant’s PRs, in either direction', async () => {
    const mine = await mod.collectCandidatePrs(acct, repoId);
    expect(mine.map((c) => c.prId)).not.toContain(prForeign);
    const theirs = await mod.collectCandidatePrs(foreignAcct, foreignRepoId);
    expect(theirs.map((c) => c.prId)).toEqual([prForeign]);
  });
});

describe('writeSynthesizedEvents (throwaway DB)', () => {
  it('skips a PR whose series came back empty WITHOUT deleting its snapshot row', async () => {
    const written = await mod.writeSynthesizedEvents({ accountId: acct, repoId }, [
      { prId: prSnapshot, soleEventId: snapshotEventId, rows: [] },
    ]);
    expect(written).toBe(0);
    const { eq } = await import('drizzle-orm');
    const rows = await db
      .select()
      .from(schema.ciStatusEvents)
      .where(eq(schema.ciStatusEvents.prId, prSnapshot))
      .execute();
    expect(rows.map((r: any) => r.id)).toEqual([snapshotEventId]);
  });

  it('replaces the snapshot row with the series, and inserts fresh series verbatim', async () => {
    const written = await mod.writeSynthesizedEvents({ accountId: acct, repoId }, [
      {
        prId: prSnapshot,
        soleEventId: snapshotEventId,
        rows: [
          { headSha: 'S1', status: 'failure', failingChecks: ['unit'], observedAt: at(10) },
          { headSha: 'S2', status: 'success', failingChecks: [], observedAt: at(13) },
        ],
      },
      {
        prId: prFresh,
        soleEventId: null,
        rows: [
          { headSha: 'F1', status: 'failure', failingChecks: [], observedAt: at(10) },
          { headSha: 'F2', status: 'success', failingChecks: [], observedAt: at(11) },
        ],
      },
    ]);
    expect(written).toBe(4);

    const { asc, eq } = await import('drizzle-orm');
    const snapRows = await db
      .select()
      .from(schema.ciStatusEvents)
      .where(eq(schema.ciStatusEvents.prId, prSnapshot))
      .orderBy(asc(schema.ciStatusEvents.observedAt))
      .execute();
    expect(snapRows.map((r: any) => r.id)).not.toContain(snapshotEventId);
    expect(snapRows.map((r: any) => [r.headSha, r.status])).toEqual([
      ['S1', 'failure'],
      ['S2', 'success'],
    ]);
    expect(snapRows[0].failingChecks).toEqual(['unit']);

    const freshRows = await db
      .select()
      .from(schema.ciStatusEvents)
      .where(eq(schema.ciStatusEvents.prId, prFresh))
      .orderBy(asc(schema.ciStatusEvents.observedAt))
      .execute();
    expect(freshRows.map((r: any) => r.headSha)).toEqual(['F1', 'F2']);
  });
});
