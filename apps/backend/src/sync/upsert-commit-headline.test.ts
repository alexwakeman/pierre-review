// COMMIT HEADLINES in persistPr — `commits.message_headline` (migration 0072 / pg 0059).
// Throwaway sqlite; the real persistPr, no GitHub.
//
// What this pins:
//   1. A received `messageHeadline` is stored (capped at 200 chars) in BOTH storage modes — it is
//      not lean-gated like `message`.
//   2. "NOT RECEIVED" WRITES NOTHING: an absent key leaves a stored headline alone. My Turn's
//      "Pushed since" card reads it, and NULL there means "not synced yet".
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GqlPullRequest } from '../github/queries.js';

const DB_PATH = '/tmp/pierre-upsert-commit-headline-test.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let repoId = 0;

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_hl_${n}`,
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
    url: `https://github.com/acme/hl/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'dependabot/npm_and_yarn/mermaid-11.16.1',
    mergeable: null,
    mergeStateStatus: null,
    author: { login: 'alice-dev', id: 'U_alice', __typename: 'User' },
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

function commitNode(oid: string, headline?: string | null): any {
  return {
    commit: {
      oid,
      committedDate: '2026-09-01T12:00:00Z',
      ...(headline === undefined ? {} : { messageHeadline: headline }),
      message: '',
      author: { user: { login: 'alice-dev', id: 'U_alice' } },
      committer: null,
    },
  };
}

async function headlineOf(oid: string): Promise<string | null | undefined> {
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(schema.commits).where(eq(schema.commits.sha, oid)).execute();
  return rows[0]?.messageHeadline;
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
    .values({ accountId: 1, owner: 'acme', name: 'hl', githubNodeId: 'R_hl_1' })
    .returning()
    .execute();
  repoId = r.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — commit headlines', () => {
  it('stores a received headline, capped at 200 characters', async () => {
    await persist(
      gqlPr(1, {
        commits: { nodes: [commitNode('c_one', 'Fix the parser'), commitNode('c_long', 'x'.repeat(300))] },
      } as any),
    );
    expect(await headlineOf('c_one')).toBe('Fix the parser');
    expect((await headlineOf('c_long'))?.length).toBe(200);
  });

  it('leaves a stored headline alone when the key was not received', async () => {
    await persist(gqlPr(1, { commits: { nodes: [commitNode('c_one')] } } as any));
    expect(await headlineOf('c_one')).toBe('Fix the parser');
  });

  it('starts NULL for a commit whose headline was never received', async () => {
    await persist(gqlPr(1, { commits: { nodes: [commitNode('c_new')] } } as any));
    expect(await headlineOf('c_new')).toBeNull();
  });
});
