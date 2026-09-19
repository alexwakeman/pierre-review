// DEPENDENCY + SECURITY SIGNALS in persistPr — the three-state write of migration 0067's columns.
// Throwaway sqlite; the real persistPr, no GitHub.
//
// What this pins:
//   1. A received `bodyText` writes all four columns together, NULLs included.
//   2. "NOT RECEIVED" WRITES NOTHING — a nulled or absent `bodyText` leaves a stored verdict alone.
//      Clearing on it would turn every partial response into "not a security fix".
//   3. An EMPTY `bodyText` is a positive statement and DOES clear (and re-stamps).
//   4. Detection reads the FULL bodyText, never the capped `search_index` copy.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = '/tmp/pierre-upsert-security-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let repoId = 0;

const FOOTER_BODY = [
  'Bumps mermaid from 11.15.0 to 11.16.1.',
  '',
  'Release notes',
  'Sourced from mermaid\'s releases.',
  'Fixes: GHSA-c4c3-pg64-4m4v',
  '',
  'Dependabot commands and options',
  'You can trigger Dependabot actions by commenting on this PR:',
  '@dependabot rebase will rebase this PR',
  'You can disable automated security fix PRs for this repo from the Security Alerts page.',
].join('\n');

const SOCKET_FIX_BODY = 'Socket fix for GHSA-9wv6-86v2-598j.\n\nSeverity: HIGH';

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_sec_${n}`,
    number: n,
    title: 'Bump mermaid from 11.15.0 to 11.16.1',
    body: null,
    bodyText: '',
    isDraft: false,
    state: 'OPEN',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    files: { nodes: [] },
    createdAt: '2026-09-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    updatedAt: '2026-09-02T00:00:00Z',
    url: `https://github.com/acme/sec/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'dependabot/npm_and_yarn/mermaid-11.16.1',
    mergeable: null,
    mergeStateStatus: null,
    author: { login: 'dependabot[bot]', id: 'BOT_dependabot', __typename: 'Bot' },
    mergedBy: null,
    labels: { nodes: [{ name: 'dependencies', color: '0366d6' }] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: { nodes: [] },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function rowOf(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (
    await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, nodeId)).execute()
  )[0];
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../db/run-migrations.js');
  const client = await import('../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  upsert = await import('./upsert.js');
  const [r] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'sec', githubNodeId: 'R_sec_1' })
    .returning()
    .execute();
  repoId = r.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — dependency + security signals', () => {
  it('writes all four columns from a received bodyText', async () => {
    const before = Date.now();
    await persist(gqlPr(1, { bodyText: FOOTER_BODY }));
    const row = await rowOf('PR_sec_1');
    expect(row.dependencyVendor).toBe('dependabot');
    expect(row.securityFix).toBe('proven');
    // The GHSA sits in the release notes, not in Dependabot's own words: no ids, stored as NULL.
    expect(row.advisoryIds).toBeNull();
    expect(row.securityCheckedAt).toBeInstanceOf(Date);
    expect(row.securityCheckedAt.getTime()).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
  });

  it('stores advisory ids as a JSON list when the vendor names them', async () => {
    await persist(
      gqlPr(2, { title: 'Fix for GHSA-9wv6-86v2-598j', headRefName: 'socket/fix/GHSA-9wv6-86v2-598j', bodyText: SOCKET_FIX_BODY }),
    );
    const row = await rowOf('PR_sec_2');
    expect(row).toMatchObject({ dependencyVendor: 'socket', securityFix: 'proven', advisoryIds: ['GHSA-9wv6-86v2-598j'] });
  });

  it('leaves a stored verdict alone when bodyText was not received (null or absent)', async () => {
    await persist(gqlPr(3, { bodyText: FOOTER_BODY }));
    const first = await rowOf('PR_sec_3');
    expect(first.securityFix).toBe('proven');

    await persist(gqlPr(3, { bodyText: null, title: 'A retitled PR' }));
    const afterNull = await rowOf('PR_sec_3');
    expect(afterNull.title).toBe('A retitled PR'); // the rest of the row WAS written
    expect(afterNull.dependencyVendor).toBe('dependabot');
    expect(afterNull.securityFix).toBe('proven');
    expect(afterNull.securityCheckedAt.getTime()).toBe(first.securityCheckedAt.getTime());

    const absent = gqlPr(3);
    delete (absent as { bodyText?: unknown }).bodyText;
    await persist(absent);
    expect((await rowOf('PR_sec_3')).securityFix).toBe('proven');
  });

  it('never stamps a PR first seen without a bodyText', async () => {
    await persist(gqlPr(4, { bodyText: null }));
    const row = await rowOf('PR_sec_4');
    expect(row.securityCheckedAt).toBeNull();
    expect(row.dependencyVendor).toBeNull();
  });

  it('clears on an EMPTY bodyText — a positive statement — and re-stamps', async () => {
    await persist(
      gqlPr(5, { title: 'Fix for GHSA-9wv6-86v2-598j', headRefName: 'socket/fix/GHSA-9wv6-86v2-598j', bodyText: SOCKET_FIX_BODY }),
    );
    const first = await rowOf('PR_sec_5');
    expect(first.advisoryIds).toEqual(['GHSA-9wv6-86v2-598j']);
    await new Promise((r) => setTimeout(r, 1100)); // sqlite stores whole seconds

    // The same PR, retitled onto a person's branch, with its description emptied.
    await persist(gqlPr(5, { title: 'Tidy lockfile', headRefName: 'alice/lockfile', bodyText: '' }));
    const row = await rowOf('PR_sec_5');
    expect(row.dependencyVendor).toBeNull();
    expect(row.securityFix).toBeNull();
    expect(row.advisoryIds).toBeNull();
    expect(row.securityCheckedAt.getTime()).toBeGreaterThan(first.securityCheckedAt.getTime());
  });

  it('reads the FULL bodyText: a marker past search_index\'s 4,000-character cap is found', async () => {
    const long = `${'Release note line.\n'.repeat(400)}${FOOTER_BODY.split('\n').slice(-1)[0]}`;
    expect(long.length).toBeGreaterThan(4_000);
    await persist(gqlPr(6, { bodyText: long }));
    const row = await rowOf('PR_sec_6');
    expect(row.securityFix).toBe('proven');

    // And the capped copy really does not hold it — so the verdict cannot have come from there.
    const { and, eq } = await import('drizzle-orm');
    const [indexed] = await db
      .select()
      .from(schema.searchIndex)
      .where(and(eq(schema.searchIndex.prId, row.id), eq(schema.searchIndex.kind, 'pr')))
      .execute();
    expect(indexed.body.length).toBeLessThanOrEqual(4_000);
    expect(indexed.body).not.toContain('You can disable automated security fix PRs');
  });
});
