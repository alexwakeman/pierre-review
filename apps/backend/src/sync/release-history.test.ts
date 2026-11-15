// THE ONE HISTORY PASS (sync/release-history.ts; docs/RELEASES.md § One history pass) against a
// THROWAWAY sqlite DB with GitHub stubbed through `deps`: the first walk to the root, the pause at the
// baseline, the resumable cursor, the INCREMENTAL rescan of a fast-forwarded head, and the restart on
// rewritten history. Also the notes builder reading light records (releases/notes.ts).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReleaseHistoryResponse } from '../github/tag-queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-release-history-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;
let m: typeof import('./release-history.js');
let repoId = 0;

const sha = (c: string) => `${c}x`.padEnd(40, '0');
const day0 = Date.UTC(2026, 0, 1);
const VIEWS = [{ workspaceId: 1, settings: { releaseSuffix: '-rc', hotfixSuffix: '-hotfix' } }];

/** A linear first-parent chain, NEWEST first: `c<i>` with PR #i on every third commit. */
function chain(n: number, prefix = 'c'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${n - 1 - i}`);
}

/** GitHub's `history` over a linear chain (newest first), pinned to `oid`, 100 a page. */
function fakeHistory(commits: string[], calls: Array<{ oid: string; after: string | null }>) {
  return async (oid: string, after: string | null): Promise<ReleaseHistoryResponse> => {
    calls.push({ oid, after });
    const start = commits.findIndex((c) => sha(c) === oid);
    const from = start + (after == null ? 0 : Number(after));
    const page = commits.slice(from, from + 100);
    const idx = (c: string) => commits.indexOf(c);
    return {
      rateLimit: { cost: 3, remaining: 4000, resetAt: null },
      repository: {
        object: {
          sinceCount: { totalCount: commits.length - start },
          history: {
            totalCount: commits.length - start,
            pageInfo: { hasNextPage: from + 100 < commits.length, endCursor: String(from - start + 100) },
            nodes: page.map((c) => {
              const n = Number(c.replace(/\D/g, ''));
              const parent = commits[idx(c) + 1];
              return {
                oid: sha(c),
                committedDate: new Date(day0 + n * 60_000).toISOString(),
                parents: { nodes: parent == null ? [] : [{ oid: sha(parent) }] },
                associatedPullRequests: {
                  nodes:
                    n % 3 === 0
                      ? [{ number: n + 1, title: `PLAT-${n + 1}: change`, url: `https://github.com/acme/api/pull/${n + 1}`, headRefName: `PLAT-${n + 1}`, baseRefName: 'main', merged: true, mergedAt: null, mergeCommit: { oid: sha(c) }, author: { __typename: n % 2 === 0 ? 'Bot' : 'User', login: 'ada' }, repository: { nameWithOwner: 'acme/api' } }]
                      : [],
                },
              };
            }),
          },
        },
      },
    };
  };
}

const opts = (headSha: string, deps: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  owner: 'acme',
  name: 'api',
  repoId,
  accountId: 1,
  token: 't',
  headSha,
  defaultBranch: 'main',
  views: VIEWS,
  deps,
  ...extra,
});

async function stored(): Promise<Array<{ sha: string; seq: number; prNumbers: number[] }>> {
  const rows = await client.db.select().from(client.schema.releaseHistoryCommits).execute();
  return rows.sort((a: { seq: number }, b: { seq: number }) => b.seq - a.seq);
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  m = await import('./release-history.js');
  const [repo] = await client.db
    .insert(client.schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_hist_api', defaultBranch: 'main' })
    .returning()
    .execute();
  repoId = repo.id;
});

beforeEach(async () => {
  const { schema, db } = client;
  for (const t of [schema.releaseHistoryCommits, schema.releaseHistoryScans, schema.releaseRangePrs, schema.repoTags]) await db.delete(t).execute();
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('walkReleaseHistory', () => {
  it('no release yet: walks the whole first-parent history newest first, ONE call per 100 commits, and stores light PR records', async () => {
    const commits = chain(250);
    const calls: Array<{ oid: string; after: string | null }> = [];
    const r = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: fakeHistory(commits, calls) }));
    expect(r).toMatchObject({ pages: 3, compares: 0, walked: 250, complete: true, paused: false });
    expect(calls.map((c) => c.after)).toEqual([null, '100', '200']);
    const rows = await stored();
    expect(rows).toHaveLength(250);
    expect(rows[0]!.sha).toBe(sha('c249'));
    expect(rows.at(-1)!.sha).toBe(sha('c0'));
    const prs = await client.db.select().from(client.schema.releaseRangePrs).execute();
    expect(prs).toHaveLength(84);
    expect(prs.find((p: { number: number }) => p.number === 1)).toMatchObject({ title: 'PLAT-1: change', headRefName: 'PLAT-1', isBot: true });
    expect(prs.find((p: { number: number }) => p.number === 4)).toMatchObject({ isBot: false });
    // Nothing left: a second run reads nothing.
    const again = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: fakeHistory(commits, calls) }));
    expect(again).toMatchObject({ pages: 0, complete: true });
  });

  it("stops at the baseline (the newest release tag on main) and goes on when that workspace's baseline moves older", async () => {
    const commits = chain(250);
    await client.db
      .insert(client.schema.repoTags)
      .values({ accountId: 1, repoId, name: 'v1.0.0-rc', sha: sha('c130'), committedAt: new Date(day0 + 130 * 60_000), firstSeenAt: new Date(), lastSeenAt: new Date() })
      .execute();
    const calls: Array<{ oid: string; after: string | null }> = [];
    const r = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: fakeHistory(commits, calls) }));
    // c249 … c130: 120 commits, two pages; the second page is NOT done (paused inside it).
    expect(r).toMatchObject({ pages: 2, walked: 120, complete: true });
    const scan = await m.readHistoryScan(1, repoId);
    expect(scan).toMatchObject({ deepExpectedSha: sha('c129'), deepCursor: '100' });
    // The release tag goes (a changed suffix, a deleted tag): the walk picks up where it paused.
    await client.db.delete(client.schema.repoTags).execute();
    calls.length = 0;
    const more = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: fakeHistory(commits, calls) }));
    expect(calls.map((c) => c.after)).toEqual(['100', '200']);
    expect(more).toMatchObject({ walked: 130, complete: true });
    expect(await stored()).toHaveLength(250);
  });

  it('resumable: a run that stops part way goes on from its stored cursor', async () => {
    const commits = chain(250);
    const calls: Array<{ oid: string; after: string | null }> = [];
    const real = fakeHistory(commits, calls);
    let n = 0;
    const flaky = async (oid: string, after: string | null) => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return real(oid, after);
    };
    const first = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: flaky }));
    expect(first).toMatchObject({ pages: 1, walked: 100, complete: false });
    const second = await m.walkReleaseHistory(opts(sha(commits[0]!), { history: real }));
    expect(calls.map((c) => c.after)).toEqual([null, '100', '200']);
    expect(second).toMatchObject({ walked: 150, complete: true });
    expect(m.historyProgress((await m.readHistoryScan(1, repoId))!, 250, false)).toEqual({ done: 250, total: 250 });
  });

  it('INCREMENTAL: a fast-forwarded head is walked only down to the walked head (one compare, one page)', async () => {
    const old = chain(250);
    await m.walkReleaseHistory(opts(sha(old[0]!), { history: fakeHistory(old, []) }));
    const newer = ['n2', 'n1', ...old];
    const calls: Array<{ oid: string; after: string | null }> = [];
    const compared: string[] = [];
    const r = await m.walkReleaseHistory(
      opts(sha('n2'), {
        history: fakeHistory(newer, calls),
        compare: async (base: string, head: string) => {
          compared.push(`${base}...${head}`);
          return { status: 'ahead', ahead_by: 2 };
        },
      }),
    );
    expect(compared).toEqual([`${sha('c249')}...${sha('n2')}`]);
    expect(calls).toEqual([{ oid: sha('n2'), after: null }]);
    expect(r).toMatchObject({ pages: 1, compares: 1, walked: 2, complete: true, restarted: false });
    const rows = await stored();
    expect(rows.slice(0, 3).map((x) => x.sha)).toEqual([sha('n2'), sha('n1'), sha('c249')]);
    expect(rows[0]!.seq).toBeGreaterThan(rows[2]!.seq);
    expect(await m.readHistoryScan(1, repoId)).toMatchObject({ topSha: sha('n2'), tipStartSha: null });
  });

  it('REWRITTEN history (the new head does not descend from the walked one): everything is walked again', async () => {
    const old = chain(120);
    await m.walkReleaseHistory(opts(sha(old[0]!), { history: fakeHistory(old, []) }));
    const rewritten = chain(30, 'r');
    const calls: Array<{ oid: string; after: string | null }> = [];
    const r = await m.walkReleaseHistory(
      opts(sha('r29'), { history: fakeHistory(rewritten, calls), compare: async () => ({ status: 'diverged', ahead_by: 3, behind_by: 5 }) }),
    );
    expect(r).toMatchObject({ restarted: true, walked: 30, complete: true });
    const rows = await stored();
    expect(rows).toHaveLength(30);
    expect(rows.every((x) => x.sha.startsWith('r'))).toBe(true);
  });
});

describe('release notes read light records (releases/notes.ts)', () => {
  it('a story PR known only as a light record gives its title; a stored one also its body', async () => {
    const { storySummaryInputs } = await import('../releases/notes.js');
    const [p] = await client.db
      .insert(client.schema.pullRequests)
      .values({ githubNodeId: 'PR_hist_1', accountId: 1, repoId, number: 1, title: 'stored title', body: 'the body', state: 'merged', isDraft: false, openedAt: new Date(), updatedAt: new Date(), baseRefName: 'main' })
      .returning()
      .execute();
    const out = await storySummaryInputs(
      1,
      [{ ident: 'jira:x#PLAT-1', key: 'PLAT-1', title: 'Story', prs: [{ title: 'PLAT-1: light title', prId: null }, { title: 'stored title', prId: p.id }] }],
      null,
    );
    expect(out[0]!.prs).toEqual([
      { title: 'PLAT-1: light title', body: null },
      { title: 'stored title', body: 'the body' },
    ]);
  });
});
