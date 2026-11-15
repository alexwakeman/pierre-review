// TAG SYNC (sync/repo-tags.ts; docs/RELEASES.md § Invariants) — the pure folds, then `syncRepoTags`
// against a THROWAWAY sqlite DB with the GitHub reads stubbed through its `deps` seam.
//
// What this pins:
//   1. Annotated tags are PEELED to their commit; a tag of a tree / tag-of-tag is skipped, not stored.
//   2. The read cap: tags past it are DROPPED and counted; an incomplete read deletes only absent
//      tags inside the read window (a positive statement), a complete one deletes every absent tag.
//   3. A tag MOVED to another commit keeps `previous_sha`.
//   4. No ancestry call (the history pass derives it). A failed read is non-fatal and changes nothing.
//   5. The settle sweep's signature, the PR walk's merge-commit write rule.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlTagRef, RepoTagsResponse } from '../github/tag-queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-repo-tags-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let m: typeof import('./repo-tags.js');
let client: any;
let repoId = 0;

const sha = (c: string) => c.repeat(40);
const light = (name: string, oid: string, date: string): GqlTagRef => ({
  name,
  target: { __typename: 'Commit', oid, committedDate: date },
});
const annotated = (name: string, tagOid: string, oid: string, date: string, tagDate: string): GqlTagRef => ({
  name,
  target: {
    __typename: 'Tag',
    oid: tagOid,
    tagger: { date: tagDate },
    target: { __typename: 'Commit', oid, committedDate: date },
  },
});
const response = (nodes: GqlTagRef[], totalCount = nodes.length, head = sha('f')): RepoTagsResponse => ({
  rateLimit: { cost: 1, remaining: 4000, resetAt: null },
  repository: {
    defaultBranchRef: { name: 'main', target: { oid: head } },
    refs: { totalCount, nodes },
  },
});

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  client = await import('../db/client.js');
  await runMigrations();
  m = await import('./repo-tags.js');
  const [repo] = await client.db
    .insert(client.schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_tags_api' })
    .returning()
    .execute();
  repoId = repo.id;
});

afterAll(async () => {
  await client?.closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('foldTagRefs', () => {
  it('peels annotated tags to the commit and skips tags that do not point at one', () => {
    const read = m.foldTagRefs({
      totalCount: 3,
      nodes: [
        annotated('v1.1.0', sha('t'), sha('b'), '2026-11-02T00:00:00Z', '2026-11-02T01:00:00Z'),
        light('v1.0.0', sha('a'), '2026-11-01T00:00:00Z'),
        { name: 'tree-tag', target: { __typename: 'Tree', oid: sha('e') } },
      ],
    })!;
    expect(read.tags.map((t) => [t.name, t.sha, t.tagObjectOid])).toEqual([
      ['v1.1.0', sha('b'), sha('t')],
      ['v1.0.0', sha('a'), null],
    ]);
    expect(read.tags[0]!.taggedAt?.toISOString()).toBe('2026-11-02T01:00:00.000Z');
    expect(read.skipped).toEqual(['tree-tag']);
    expect(read.complete).toBe(true);
    expect(read.dropped).toBe(0);
  });

  it('counts the tags past the read cap as dropped and calls the read incomplete', () => {
    const read = m.foldTagRefs({ totalCount: 250, nodes: [light('v9', sha('9'), '2026-11-01T00:00:00Z')] })!;
    expect(read.complete).toBe(false);
    expect(read.dropped).toBe(249);
  });

  it('is null when the selection did not arrive', () => {
    expect(m.foldTagRefs(null)).toBeNull();
    expect(m.foldTagRefs({ totalCount: 3, nodes: null })).toBeNull();
  });

  it('builds the same signature the settle sweep builds from refs(first: 1)', () => {
    const newest = light('v1.1.0', sha('b'), '2026-11-02T00:00:00Z');
    const read = m.foldTagRefs({ totalCount: 2, nodes: [newest, light('v1.0.0', sha('a'), '2026-11-01T00:00:00Z')] })!;
    expect(read.signature).toBe(m.tagSignature(2, { name: 'v1.1.0', target: { oid: sha('b') } }));
    expect(m.tagSignature(0, null)).toBe('0||');
  });
});

describe('planTagWrites', () => {
  const stored = (name: string, s: string, date: string, id: number) => ({
    id,
    name,
    sha: s,
    tagObjectOid: null,
    committedAt: new Date(date),
    taggedAt: null,
    onDefaultBranch: true,
    ancestryHeadSha: null,
  });
  it('inserts new tags, moves a re-pointed one and deletes absent ones on a complete read', () => {
    const read = m.foldTagRefs({
      totalCount: 2,
      nodes: [light('v1.1.0', sha('c'), '2026-11-03T00:00:00Z'), light('v1.2.0', sha('d'), '2026-11-04T00:00:00Z')],
    })!;
    const plan = m.planTagWrites(
      [stored('v1.0.0', sha('a'), '2026-11-01T00:00:00Z', 1), stored('v1.1.0', sha('b'), '2026-11-02T00:00:00Z', 2)],
      read,
    );
    expect(plan.inserts.map((t) => t.name)).toEqual(['v1.2.0']);
    expect(plan.moves).toEqual([expect.objectContaining({ id: 2, previousSha: sha('b') })]);
    expect(plan.deletes).toEqual([1]);
  });

  it('on an incomplete read deletes only absent tags inside the read window', () => {
    const read = m.foldTagRefs({ totalCount: 500, nodes: [light('v5', sha('5'), '2026-11-05T00:00:00Z')] })!;
    const plan = m.planTagWrites(
      [stored('old', sha('1'), '2026-01-01T00:00:00Z', 1), stored('gone', sha('6'), '2026-11-06T00:00:00Z', 2)],
      read,
    );
    expect(plan.deletes).toEqual([2]);
  });
});

describe('syncRepoTags (DB)', () => {
  const tagRows = async () =>
    (
      await client.db
        .select()
        .from(client.schema.repoTags)
        .execute()
    ).sort((a: any, b: any) => (a.name < b.name ? -1 : 1));

  it('stores the tags and the signature — no ancestry call (derived from the history pass)', async () => {
    const res = await m.syncRepoTags({
      owner: 'acme',
      name: 'api',
      repoId,
      accountId: 1,
      token: 't',
      deps: {
        readTags: async () =>
          response([
            light('v1.0.0-hotfix', sha('9'), '2026-11-05T00:00:00Z'),
            annotated('v1.1.0', sha('t'), sha('b'), '2026-11-02T00:00:00Z', '2026-11-02T01:00:00Z'),
            light('v1.0.0', sha('a'), '2026-11-01T00:00:00Z'),
          ]),
      },
    });
    expect(res).toMatchObject({ read: true, inserted: 3, moved: 0, deleted: 0, headSha: sha('f') });
    const rows = await tagRows();
    expect(rows.map((r: any) => [r.name, r.onDefaultBranch, r.tagObjectOid != null])).toEqual([
      ['v1.0.0', null, false],
      ['v1.0.0-hotfix', null, false],
      ['v1.1.0', null, true],
    ]);
    const [repo] = await client.db.select().from(client.schema.repos).execute();
    expect(repo.tagsSignature).toBe(`3|v1.0.0-hotfix|${sha('9')}`);
  });

  it('flags a moved tag; a deleted tag goes', async () => {
    const res = await m.syncRepoTags({
      owner: 'acme',
      name: 'api',
      repoId,
      accountId: 1,
      token: 't',
      deps: {
        readTags: async () =>
          response([
            light('v1.0.0-hotfix', sha('9'), '2026-11-05T00:00:00Z'),
            light('v1.1.0', sha('c'), '2026-11-03T00:00:00Z'),
          ]),
      },
    });
    expect(res).toMatchObject({ inserted: 0, moved: 1, deleted: 1 });
    const rows = await tagRows();
    const moved = rows.find((r: any) => r.name === 'v1.1.0');
    expect(moved).toMatchObject({ sha: sha('c'), previousSha: sha('b'), tagObjectOid: null });
    expect(moved.movedAt).not.toBeNull();
    expect(rows.map((r: any) => r.name)).toEqual(['v1.0.0-hotfix', 'v1.1.0']);
  });

  it('a tag list that did not arrive changes nothing; a failing read is non-fatal', async () => {
    const before = await tagRows();
    const res = await m.syncRepoTags({
      owner: 'acme',
      name: 'api',
      repoId,
      accountId: 1,
      token: 't',
      deps: { readTags: async () => ({ repository: { refs: null } }) },
    });
    expect(res.read).toBe(false);
    expect(await m.syncRepoTagsSafe({
      owner: 'acme',
      name: 'api',
      repoId,
      accountId: 1,
      token: 't',
      deps: { readTags: async () => { throw new Error('boom'); } },
    })).toBeNull();
    expect(await tagRows()).toEqual(before);
  });
});

describe('syncRepoTags — a RELEASABLE repo reads the whole history (acceptance 38)', () => {
  it('pages past 100 tags up to the read cap', async () => {
    const [repo2] = await client.db
      .insert(client.schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'paged', githubNodeId: 'R_tags_paged', defaultBranchName: 'main' })
      .returning()
      .execute();
    const all = Array.from({ length: 212 }, (_, i) =>
      light(`v0.${211 - i}.0`, sha(`p${211 - i}`), new Date(Date.UTC(2026, 0, 1, 0, 211 - i)).toISOString()),
    );
    const pages: Array<string | null> = [];
    const res = await m.syncRepoTags({
      owner: 'acme',
      name: 'paged',
      repoId: repo2.id,
      accountId: 1,
      token: 't',
      readCap: m.REPO_TAGS_READ_CAP_RELEASABLE,
      deps: {
        readTags: async (after) => {
          pages.push(after);
          const from = after == null ? 0 : Number(after);
          const nodes = all.slice(from, from + 100);
          const r = response(nodes, all.length);
          r.repository!.refs!.pageInfo = { hasNextPage: from + 100 < all.length, endCursor: String(from + 100) };
          return r;
        },
      },
    });
    expect(pages).toEqual([null, '100', '200']);
    expect(res).toMatchObject({ read: true, inserted: 212, dropped: 0 });
    // One page only for a repo no workspace releases (the old cap): the rest is dropped and logged.
    const one = await m.syncRepoTags({
      owner: 'acme',
      name: 'paged',
      repoId: repo2.id,
      accountId: 1,
      token: 't',
      deps: {
        readTags: async () => {
          const r = response(all.slice(0, 100), all.length);
          r.repository!.refs!.pageInfo = { hasNextPage: true, endCursor: '100' };
          return r;
        },
      },
    });
    expect(one).toMatchObject({ read: true, dropped: 112, deleted: 0 });
  });
});

describe('the PR walk stores the landed commit only on a positive statement', () => {
  it('writes an oid, clears on a not-merged PR, and omits a nulled selection on a merged one', async () => {
    const { mergeCommitOidToWrite } = await import('./upsert.js');
    expect(mergeCommitOidToWrite({ state: 'MERGED', mergeCommit: { oid: sha('m') } } as any)).toBe(sha('m'));
    expect(mergeCommitOidToWrite({ state: 'OPEN', mergeCommit: null } as any)).toBeNull();
    expect(mergeCommitOidToWrite({ state: 'CLOSED', mergeCommit: null } as any)).toBeNull();
    expect(mergeCommitOidToWrite({ state: 'MERGED', mergeCommit: null } as any)).toBeUndefined();
    expect(mergeCommitOidToWrite({ state: 'MERGED' } as any)).toBeUndefined();
  });
});

describe('the settle sweep notices a tag push', () => {
  it('reads the signature off its refs(first: 1) and asks for a sync once per observation', async () => {
    const { observedTagSig, tagSyncDue } = await import('./settle-sweep.js');
    const sig = observedTagSig({ tags: { totalCount: 4, nodes: [{ name: 'v2', target: { oid: sha('2') } }] } });
    expect(sig).toBe(`4|v2|${sha('2')}`);
    expect(observedTagSig({})).toBeUndefined();
    expect(tagSyncDue(`3|v1|${sha('1')}`, sig, undefined)).toBe(true);
    expect(tagSyncDue(sig!, sig, undefined)).toBe(false);
    expect(tagSyncDue(`3|v1|${sha('1')}`, sig, sig)).toBe(false);
    expect(tagSyncDue(null, undefined, undefined)).toBe(false);
  });
});
