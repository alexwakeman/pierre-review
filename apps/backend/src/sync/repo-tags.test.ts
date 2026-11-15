// TAG SYNC (sync/repo-tags.ts; docs/RELEASES.md § Invariants) — the pure folds, then `syncRepoTags`
// against a THROWAWAY sqlite DB with the GitHub reads stubbed through its `deps` seam.
//
// What this pins:
//   1. Annotated tags are PEELED to their commit; a tag of a tree / tag-of-tag is skipped, not stored.
//   2. The read cap: tags past it are DROPPED and counted; an incomplete read deletes only absent
//      tags inside the read window (a positive statement), a complete one deletes every absent tag.
//   3. A tag MOVED to another commit keeps `previous_sha`, and its ancestry is asked again.
//   4. Ancestry: compare tag...head 'ahead'/'identical' ⇒ on the default branch; 'diverged' ⇒ off
//      it, re-asked only when the head moves. A failed read is non-fatal and changes nothing.
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

describe('ancestry', () => {
  it('reads compare tag...head: ahead or identical is on the default branch', () => {
    expect(m.ancestryFromCompareStatus('ahead')).toBe(true);
    expect(m.ancestryFromCompareStatus('identical')).toBe(true);
    expect(m.ancestryFromCompareStatus('diverged')).toBe(false);
    expect(m.ancestryFromCompareStatus('behind')).toBe(false);
    expect(m.ancestryFromCompareStatus(undefined)).toBeUndefined();
  });

  it('asks about never-asked tags first, then off-branch tags only once the head moved, newest first', () => {
    const t = (name: string, onDefaultBranch: boolean | null, ancestryHeadSha: string | null, day: number) => ({
      name,
      sha: sha(String(day)),
      committedAt: new Date(Date.UTC(2026, 10, day)),
      onDefaultBranch,
      ancestryHeadSha,
    });
    const tags = [t('on', true, sha('h'), 1), t('unknown', null, null, 2), t('off-same', false, sha('h'), 3), t('off-moved', false, sha('o'), 4)];
    expect(m.ancestryTargets(tags, sha('h')).map((x) => x.name)).toEqual(['unknown', 'off-moved']);
    expect(m.ancestryTargets(tags, sha('h'), 1).map((x) => x.name)).toEqual(['unknown']);
  });

  it('a fresh release tag is reached past 20+ newer off-branch tags that are asked again every sync', () => {
    const t = (name: string, onDefaultBranch: boolean | null, s: string, day: number) => ({
      name,
      sha: sha(s),
      committedAt: new Date(Date.UTC(2026, 9, day)),
      onDefaultBranch,
      ancestryHeadSha: onDefaultBranch === false ? sha('old-head') : null,
    });
    const hotfixes = Array.from({ length: 25 }, (_, i) => t(`v2.3.${i}-hotfix`, false, `hf${i}`, 10 + i));
    const tags = [t('v2.4.0', true, 'rel', 1), t('v2.4.0-rc', null, 'rel', 1), t('v2.5.0', null, 'new', 2), ...hotfixes];
    // The release tag shares its version tag's commit: on the branch with no request.
    expect(m.inheritedAncestry(tags)).toEqual([{ name: 'v2.4.0-rc', sha: sha('rel') }]);
    // The never-asked tag is asked before any re-ask of the 25 off-branch ones; the inherited one is not asked.
    const targets = m.ancestryTargets(tags, sha('h'));
    expect(targets[0]).toEqual({ name: 'v2.5.0', sha: sha('new') });
    expect(targets.map((x) => x.name)).not.toContain('v2.4.0-rc');
    expect(targets).toHaveLength(20);
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

  it('stores the tags, their ancestry and the signature', async () => {
    const compared: string[] = [];
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
        compare: async (base) => {
          compared.push(base);
          return { status: base === sha('9') ? 'diverged' : 'ahead' };
        },
      },
    });
    expect(res).toMatchObject({ read: true, inserted: 3, moved: 0, deleted: 0, ancestryChecked: 3, headSha: sha('f') });
    expect(compared).toEqual([sha('9'), sha('b'), sha('a')]);
    const rows = await tagRows();
    expect(rows.map((r: any) => [r.name, r.onDefaultBranch, r.tagObjectOid != null])).toEqual([
      ['v1.0.0', true, false],
      ['v1.0.0-hotfix', false, false],
      ['v1.1.0', true, true],
    ]);
    const [repo] = await client.db.select().from(client.schema.repos).execute();
    expect(repo.tagsSignature).toBe(`3|v1.0.0-hotfix|${sha('9')}`);
  });

  it('flags a moved tag, forgets its ancestry and re-asks; a deleted tag goes', async () => {
    const compared: string[] = [];
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
        compare: async (base) => {
          compared.push(base);
          return { status: 'ahead' };
        },
      },
    });
    expect(res).toMatchObject({ inserted: 0, moved: 1, deleted: 1 });
    // The hotfix tag was off the branch against the SAME head: not asked again.
    expect(compared).toEqual([sha('c')]);
    const rows = await tagRows();
    const moved = rows.find((r: any) => r.name === 'v1.1.0');
    expect(moved).toMatchObject({ sha: sha('c'), previousSha: sha('b'), tagObjectOid: null, onDefaultBranch: true });
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
