// TAG RANGES (sync/tag-ranges.ts; docs/RELEASES.md § Terms → Range of a version tag) — the pure
// planner, then `computeTagRanges` against a THROWAWAY sqlite DB with GitHub stubbed through `deps`.
//
// What this pins:
//   1. The ORDER and the BASE: oldest first by commit date, then tag date, then name; a tag's base is
//      the tag before it; tags off the default branch are not in the chain.
//   2. A tag sharing its base's commit (a release tag on its version tag) has an EMPTY increment and
//      costs no request.
//   3. Commit → PR: the stored merge commit first, then the stored PR commits, then GraphQL
//      associatedPullRequests — and ONLY PRs merged into the default branch count (acceptance 13: a
//      PR merged into a hotfix branch is in no `main` range).
//   4. The oldest tag (no base) takes every stored PR merged up to its commit (acceptance 4's first
//      release covers everything).
//   5. Computed once per (tag sha, base sha); a MOVED tag is recomputed and flagged.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RangeTag, TagRangeDeps } from './tag-ranges.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-tag-ranges-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let m: typeof import('./tag-ranges.js');
let client: any;
let repoId = 0;

const sha = (c: string) => c.padEnd(40, '0');
const day = (d: number, h = 12) => new Date(Date.UTC(2026, 10, d, h));
const tag = (name: string, s: string, d: number, extra: Partial<RangeTag> = {}): RangeTag => ({
  name,
  sha: sha(s),
  committedAt: day(d),
  taggedAt: null,
  onDefaultBranch: true,
  ...extra,
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  m = await import('./tag-ranges.js');
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('planTagRanges', () => {
  it('orders by commit date, then tag date, then name, and bases each tag on the one before', () => {
    const tags = [
      tag('v1.2.0', 'c5', 5),
      tag('v1.1.0-rc', 'c3', 3, { taggedAt: day(4) }),
      tag('v1.1.0', 'c3', 3),
      tag('v1.0.0', 'c1', 1),
      tag('v1.0.0-hotfix', 'h1', 2, { onDefaultBranch: false }),
      tag('unknown', 'u1', 2, { onDefaultBranch: null }),
    ];
    const plan = m.planTagRanges(tags, []);
    expect(plan.work.map((w) => [w.tag.name, w.base?.name ?? null])).toEqual([
      ['v1.2.0', 'v1.1.0-rc'],
      ['v1.1.0-rc', 'v1.1.0'],
      ['v1.1.0', 'v1.0.0'],
      ['v1.0.0', null],
    ]);
  });

  it('skips a fresh range, recomputes a moved tag (flagged) and a changed base', () => {
    const tags = [tag('v1.0.0', 'c1', 1), tag('v1.1.0', 'c3', 3), tag('v1.2.0', 'c6', 6)];
    const stored = [
      { tagName: 'v1.0.0', sha: sha('c1'), baseTagName: null, baseSha: null },
      { tagName: 'v1.1.0', sha: sha('c3'), baseTagName: 'v1.0.0', baseSha: sha('c0') },
      { tagName: 'v1.2.0', sha: sha('c5'), baseTagName: 'v1.1.0', baseSha: sha('c3') },
      { tagName: 'gone', sha: sha('g'), baseTagName: null, baseSha: null },
    ];
    const plan = m.planTagRanges(tags, stored);
    expect(plan.work.map((w) => [w.tag.name, w.movedFromSha])).toEqual([
      ['v1.2.0', sha('c5')],
      ['v1.1.0', null],
    ]);
    expect(plan.deleteTagNames).toEqual(['gone']);
  });

  it('bounds the work to the newest tags in the window, newest first', () => {
    const tags = Array.from({ length: 6 }, (_, i) => tag(`v${i}`, `c${i}`, i + 1));
    const plan = m.planTagRanges(tags, [], { window: 3, perSync: 2 });
    expect(plan.work.map((w) => w.tag.name)).toEqual(['v5', 'v4']);
    // The oldest tag in the window still has a base (outside the window), so it is not 'history'.
    expect(m.planTagRanges(tags, [], { window: 3 }).work.at(-1)?.base?.name).toBe('v2');
  });
});

describe('rangePrNumbersFromAssociated', () => {
  it('keeps merged PRs of this repo into the default branch only (acceptance 13: hotfix PRs are not in it)', () => {
    expect(
      m.rangePrNumbersFromAssociated(
        [
          { number: 1, merged: true, baseRefName: 'main', repository: { nameWithOwner: 'acme/web' } },
          { number: 2, merged: true, baseRefName: 'hotfix/v1.0.0-rc', repository: { nameWithOwner: 'acme/web' } },
          { number: 3, merged: false, baseRefName: 'main', repository: { nameWithOwner: 'acme/web' } },
          { number: 4, merged: true, baseRefName: 'main', repository: { nameWithOwner: 'fork/web' } },
          null,
        ],
        'acme/web',
        'main',
      ),
    ).toEqual([1]);
  });
});

describe('computeTagRanges (DB)', () => {
  const compareCalls: string[] = [];
  const commitPrCalls: string[][] = [];
  const compareLists: Record<string, string[]> = {};
  const deps: TagRangeDeps = {
    compare: async (base: string, head: string, page: number) => {
      compareCalls.push(`${base.slice(0, 2)}...${head.slice(0, 2)}#${page}`);
      const list = compareLists[`${base}...${head}`] ?? [];
      return { status: 'ahead', total_commits: list.length, commits: list.map((s) => ({ sha: s })) };
    },
    commitPrs: async (shas: string[]) => {
      commitPrCalls.push(shas);
      const repository: Record<string, any> = {};
      shas.forEach((s, i) => {
        const nodes =
          s === sha('c3')
            ? [{ number: 3, merged: true, baseRefName: 'main', repository: { nameWithOwner: 'acme/web' } }]
            : s === sha('c4')
              ? [{ number: 4, merged: true, baseRefName: 'hotfix/v1.0.0-rc', repository: { nameWithOwner: 'acme/web' } }]
              : [];
        repository[`c${i}`] = { associatedPullRequests: { nodes } };
      });
      return { rateLimit: { cost: 1, remaining: 4000, resetAt: null }, repository };
    },
  };
  const run = () =>
    m.computeTagRanges({ owner: 'acme', name: 'web', repoId, accountId: 1, token: 't', defaultBranchName: 'main', deps });
  const ranges = async () => {
    const { getTagRanges } = await import('../db/repo-tags.js');
    const rows = await getTagRanges(1, [repoId]);
    return Object.fromEntries(rows.map((r) => [r.tagName, r]));
  };
  let prIdByNumber = new Map<number, number>();

  beforeAll(async () => {
    const { repos, pullRequests, commits, repoTags } = client.schema;
    const [repo] = await client.db
      .insert(repos)
      .values({ accountId: 1, owner: 'acme', name: 'web', githubNodeId: 'R_ranges_web', defaultBranchName: 'main' })
      .returning()
      .execute();
    repoId = repo.id;
    const pr = async (number: number, mergedDay: number, base: string, oid: string | null) => {
      const [row] = await client.db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_ranges_${number}`,
          accountId: 1,
          repoId,
          number,
          title: `pr ${number}`,
          state: 'merged',
          isDraft: false,
          openedAt: day(1, 0),
          updatedAt: day(mergedDay),
          mergedAt: day(mergedDay),
          baseRefName: base,
          mergeCommitOid: oid,
        })
        .returning()
        .execute();
      prIdByNumber.set(number, row.id);
      return row.id;
    };
    await pr(1, 1, 'main', sha('c1'));
    await pr(2, 2, 'main', sha('c2'));
    await pr(3, 3, 'main', null); // not stored yet: found through associatedPullRequests
    await pr(4, 4, 'hotfix/v1.0.0-rc', sha('c4'));
    const pr5 = await pr(5, 5, 'main', sha('m5')); // a true merge: its branch commit b5 is stored
    await client.db.insert(commits).values({ sha: sha('b5'), prId: pr5, committedAt: day(4) }).execute();
    // PR 6 is merged AFTER every tag: in no range.
    await pr(6, 7, 'main', sha('c7'));
    const t = (name: string, s: string, d: number, extra: Record<string, unknown> = {}) => ({
      accountId: 1,
      repoId,
      name,
      sha: sha(s),
      committedAt: day(d),
      onDefaultBranch: true,
      firstSeenAt: day(d),
      lastSeenAt: day(d),
      ...extra,
    });
    await client.db
      .insert(repoTags)
      .values([
        t('v1.0.0', 'c1', 1),
        t('v1.1.0', 'c3', 3),
        t('v1.1.0-rc', 'c3', 3, { taggedAt: day(3, 18), tagObjectOid: sha('t1') }),
        t('v1.2.0', 'm5', 5),
        t('v1.0.0-hotfix', 'h1', 4, { onDefaultBranch: false }),
      ])
      .execute();
    compareLists[`${sha('c1')}...${sha('c3')}`] = [sha('c2'), sha('c3')];
    compareLists[`${sha('c3')}...${sha('m5')}`] = [sha('c4'), sha('d1'), sha('b5'), sha('m5')];
  });

  it('acceptance 4: computes v1.0.0 (history), v1.1.0, the empty release tag and v1.2.0', async () => {
    const res = await run();
    expect(res).toMatchObject({ computed: 4, failed: 0, pending: 0 });
    // The release tag on v1.1.0's commit cost no request.
    expect(compareCalls.sort()).toEqual(['c1...c3#1', 'c3...m5#1']);
    const r = await ranges();
    const ids = (ns: number[]) => ns.map((n) => prIdByNumber.get(n));
    expect(r['v1.0.0']).toMatchObject({ method: 'history', baseTagName: null, prIds: ids([1]) });
    expect(r['v1.1.0']).toMatchObject({ method: 'compare', baseTagName: 'v1.0.0', prIds: ids([2, 3]), commitCount: 2, unmatchedCommits: 0 });
    expect(r['v1.1.0-rc']).toMatchObject({ baseTagName: 'v1.1.0', prIds: [], commitCount: 0 });
    // acceptance 13: PR 4 (into hotfix/…) is in no main range; d1 is a direct push.
    expect(r['v1.2.0']).toMatchObject({ baseTagName: 'v1.1.0-rc', prIds: ids([5]), commitCount: 4, unmatchedCommits: 2 });
    expect(r['v1.0.0-hotfix']).toBeUndefined();
  });

  it('is computed once per (tag sha, base sha): a second run asks GitHub nothing', async () => {
    compareCalls.length = 0;
    commitPrCalls.length = 0;
    expect(await run()).toMatchObject({ computed: 0 });
    expect(compareCalls).toEqual([]);
    expect(commitPrCalls).toEqual([]);
  });

  it('a tag MOVED to another commit is recomputed and flagged', async () => {
    const { repoTags } = client.schema;
    const { and, eq } = await import('drizzle-orm');
    await client.db
      .update(repoTags)
      .set({ sha: sha('c7'), committedAt: day(7), previousSha: sha('m5') })
      .where(and(eq(repoTags.repoId, repoId), eq(repoTags.name, 'v1.2.0')))
      .execute();
    compareLists[`${sha('c3')}...${sha('c7')}`] = [sha('c4'), sha('d1'), sha('b5'), sha('m5'), sha('c7')];
    expect(await run()).toMatchObject({ computed: 1 });
    const r = await ranges();
    expect(r['v1.2.0']).toMatchObject({ sha: sha('c7'), movedFromSha: sha('m5'), prIds: [5, 6].map((n) => prIdByNumber.get(n)) });
  });

  it('a failed compare is non-fatal and leaves the stored range', async () => {
    const { repoTags } = client.schema;
    const { and, eq } = await import('drizzle-orm');
    await client.db
      .insert(repoTags)
      .values({ accountId: 1, repoId, name: 'v1.3.0', sha: sha('c8'), committedAt: day(8), onDefaultBranch: true, firstSeenAt: day(8), lastSeenAt: day(8) })
      .execute();
    const res = await m.computeTagRanges({
      owner: 'acme',
      name: 'web',
      repoId,
      accountId: 1,
      token: 't',
      defaultBranchName: 'main',
      deps: { ...deps, compare: async () => { throw new Error('502'); } },
    });
    expect(res).toMatchObject({ computed: 0, failed: 1 });
    expect((await ranges())['v1.3.0']).toBeUndefined();
    expect((await ranges())['v1.2.0']).toBeDefined();
    await client.db.delete(repoTags).where(and(eq(repoTags.repoId, repoId), eq(repoTags.name, 'v1.3.0'))).execute();
  });
});
