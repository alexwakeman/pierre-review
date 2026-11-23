// AI VENDOR SIGNALS in persistPr — migration 0218's columns (docs/AI-ADOPTION-REPORT.md § Detection).
// Throwaway sqlite; the real persistPr, no GitHub. PERSIST_BODIES is OFF (lean, the default).
//
// What this pins:
//   1. A received PR (title + bodyText + every commit message) writes the PR's three columns and each
//      commit's `ai_signals`, verdicts only.
//   2. LEAN STORAGE HOLDS: the commit message is fetched now but still NOT stored, nor any name/email.
//   3. "NOT RECEIVED" WRITES NOTHING: a nulled bodyText, or a commit whose message did not arrive,
//      leaves the stored verdicts and the version stamp alone (the stamp vouches for the commits too).
//   4. ⚠ The fetched message does NOT re-attribute a commit to a `limn:` bot on a lean install: the
//      trailer rule (db/limn-bots.ts rule (d)) still reads the message only on PERSIST_BODIES.
//
// DATABASE_URL is set BEFORE importing config/client (they open the connection at load).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AI_SIGNALS_VERSION } from '@pierre-review/shared';
import type { GqlCommitNode, GqlPullRequest } from '../github/queries.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-upsert-ai-signals-test.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.PERSIST_BODIES;
delete process.env.LIMN_ATTRIBUTE_ALL; // default ON: the wide attribution that rule (d) belongs to

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let upsert: typeof import('./upsert.js');
let repoId = 0;

const ALICE = { login: 'alice-ai', id: 'U_alice_ai', __typename: 'User' };

function commit(oid: string, message: string | undefined, over: Partial<GqlCommitNode['commit']> = {}): GqlCommitNode {
  return {
    commit: {
      oid,
      committedDate: '2026-09-01T12:00:00Z',
      messageHeadline: (message ?? 'x').split('\n')[0],
      ...(message === undefined ? {} : { message }),
      author: { name: 'Alice', email: 'alice@example.com', user: { login: ALICE.login, id: ALICE.id } },
      committer: { name: 'GitHub', email: 'noreply@github.com', user: null },
      ...over,
    },
  };
}

function gqlPr(n: number, over: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    id: `PR_ai_${n}`,
    number: n,
    title: 'Retry the webhook sender',
    body: null,
    bodyText: 'Adds a retry.\n\n🤖 Generated with Claude Code',
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
    url: `https://github.com/acme/ai/pull/${n}`,
    baseRefName: 'main',
    headRefName: 'claude/add-retry',
    mergeable: null,
    mergeStateStatus: null,
    author: ALICE,
    mergedBy: null,
    labels: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    comments: { nodes: [] },
    commits: {
      nodes: [
        commit('aaa1', 'Add retry\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
        commit('aaa2', 'Fix review findings\n\nEnsemble-Run: ai-fix/12'),
        commit('aaa3', 'Hand-written tidy-up'),
      ],
    },
    ...over,
  } as unknown as GqlPullRequest;
}

async function persist(pr: GqlPullRequest): Promise<void> {
  await upsert.persistPr(pr, repoId, upsert.createUserResolver(), new Map(), 1);
}

async function prRow(nodeId: string): Promise<any> {
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(schema.pullRequests).where(eq(schema.pullRequests.githubNodeId, nodeId)).execute())[0];
}

async function commitRows(prId: number): Promise<Record<string, any>> {
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(schema.commits).where(eq(schema.commits.prId, prId)).execute();
  return Object.fromEntries(rows.map((r: any) => [r.sha, r]));
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
    .values({ accountId: 1, owner: 'acme', name: 'ai', githubNodeId: 'R_ai_1' })
    .returning()
    .execute();
  repoId = r.id;
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('persistPr — AI vendor signals', () => {
  it('writes the PR verdict, the version stamp and each commit verdict', async () => {
    const { config } = await import('../config.js');
    expect(config.persistBodies).toBe(false);
    await persist(gqlPr(1));
    const pr = await prRow('PR_ai_1');
    expect(JSON.parse(pr.aiSignals)).toEqual([
      { vendor: 'claude', source: 'pr_body' },
      { vendor: 'claude', source: 'pr_branch' },
    ]);
    expect(pr.aiSignalsVersion).toBe(AI_SIGNALS_VERSION);
    expect(pr.aiSignalsCheckedAt).toBeInstanceOf(Date);
    const c = await commitRows(pr.id);
    expect(JSON.parse(c.aaa1.aiSignals)).toEqual([{ vendor: 'claude', source: 'commit_trailer' }]);
    expect(JSON.parse(c.aaa2.aiSignals)).toEqual([{ vendor: 'ensemble', source: 'commit_trailer' }]);
    expect(c.aaa3.aiSignals).toBe('[]');
  });

  it('keeps storage lean: no message, name or email is stored', async () => {
    const pr = await prRow('PR_ai_1');
    const c = await commitRows(pr.id);
    for (const row of Object.values(c)) {
      expect(row.message).toBeNull();
      const flat = JSON.stringify(row);
      expect(flat).not.toContain('alice@example.com');
      expect(flat).not.toContain('Co-Authored-By');
    }
    expect(pr.body).toBeNull();
  });

  it('does not re-attribute a commit with an Ensemble-Run trailer on a lean install', async () => {
    const { eq } = await import('drizzle-orm');
    const pr = await prRow('PR_ai_1');
    const c = await commitRows(pr.id);
    const [alice] = await db.select().from(schema.users).where(eq(schema.users.githubLogin, ALICE.login)).execute();
    expect(c.aaa2.authorId).toBe(alice.id);
    expect(c.aaa2.limnPushedByUserId).toBeNull();
  });

  it('leaves the verdicts alone when the body or a commit message was not received', async () => {
    const first = await prRow('PR_ai_1');
    // A nulled bodyText: nothing about the PR's verdict or stamp changes.
    await persist(gqlPr(1, { bodyText: null, title: 'Retitled', headRefName: 'feature/x' }));
    const afterNull = await prRow('PR_ai_1');
    expect(afterNull.title).toBe('Retitled');
    expect(afterNull.aiSignals).toBe(first.aiSignals);
    expect(afterNull.aiSignalsCheckedAt.getTime()).toBe(first.aiSignalsCheckedAt.getTime());

    // A commit whose message did not arrive: the PR is not re-stamped and that commit keeps its verdict.
    await persist(
      gqlPr(1, {
        bodyText: 'Plain description.',
        headRefName: 'feature/x',
        commits: { nodes: [commit('aaa1', undefined), commit('aaa3', 'Tidy\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>')] },
      }),
    );
    const afterGap = await prRow('PR_ai_1');
    expect(afterGap.aiSignals).toBe(first.aiSignals);
    const c = await commitRows(first.id);
    expect(JSON.parse(c.aaa1.aiSignals)).toEqual([{ vendor: 'claude', source: 'commit_trailer' }]);
    // A commit that DID arrive is re-scanned.
    expect(JSON.parse(c.aaa3.aiSignals)).toEqual([{ vendor: 'cursor', source: 'commit_trailer' }]);
  });

  it('never stamps a PR first seen without a bodyText', async () => {
    await persist(gqlPr(2, { bodyText: null }));
    const pr = await prRow('PR_ai_2');
    expect(pr.aiSignals).toBeNull();
    expect(pr.aiSignalsVersion).toBeNull();
    expect(pr.aiSignalsCheckedAt).toBeNull();
  });

  it('stamps a clean PR with [] (scanned, nothing found)', async () => {
    await persist(gqlPr(3, { bodyText: 'Plain.', headRefName: 'feature/y', commits: { nodes: [commit('ccc1', 'Plain')] } }));
    const pr = await prRow('PR_ai_3');
    expect(pr.aiSignals).toBe('[]');
    expect(pr.aiSignalsVersion).toBe(AI_SIGNALS_VERSION);
  });
});

describe('aiPrColumnsFor / aiCommitColumnsFor', () => {
  it('answers {} unless title, bodyText and every commit message arrived', () => {
    const base = { title: 't', bodyText: '', commits: { nodes: [{ commit: { message: 'm' } }] } };
    expect(Object.keys(upsert.aiPrColumnsFor(base))).toEqual(['aiSignals', 'aiSignalsVersion', 'aiSignalsCheckedAt']);
    expect(upsert.aiPrColumnsFor({ ...base, bodyText: null })).toEqual({});
    expect(upsert.aiPrColumnsFor({ ...base, title: null })).toEqual({});
    expect(upsert.aiPrColumnsFor({ ...base, commits: null })).toEqual({});
    expect(upsert.aiPrColumnsFor({ ...base, commits: { nodes: [null] } })).toEqual({});
    expect(upsert.aiPrColumnsFor({ ...base, commits: { nodes: [{ commit: { message: null } }] } })).toEqual({});
    expect(upsert.aiCommitColumnsFor({ message: null })).toEqual({});
    expect(upsert.aiCommitColumnsFor({ message: 'x', author: { name: 'claude[bot]' } })).toEqual({
      aiSignals: JSON.stringify([{ vendor: 'claude', source: 'commit_author' }]),
    });
  });
});
