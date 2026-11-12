// THE AUTO FIX QUEUE (coding/ai-fix/auto-fix-queue.ts) over the REAL core client and migrations, with the
// in-process facts and the start faked. What this pins:
//   • only the reader's own PR with auto fix on is judged (else nothing is kept);
//   • a running fix queues the next; the head's CI jobs still running wait (bounded), a CI failure waits
//     for the CI review (bounded);
//   • a succeeded AUTO AI review of the head ⇒ a review fix; CI causes alone wait (bounded) for the AI
//     review of the head, then start a CI-ONLY fix (reviewId null);
//   • a transient refusal is a wait, a final one is idle; the sweep does not start again on unchanged facts.
//
//   pnpm --filter @pierre-review/backend test ai-fix/auto-fix-queue
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_FIX_CI_REVIEW_WAIT_MS, AUTO_FIX_CI_WAIT_MAX_MS, AUTO_FIX_REVIEW_WAIT_MS } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';
import type { AutoFixQueueDeps } from './auto-fix-queue.js';

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-auto-fix-queue-db.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let Q: typeof import('./auto-fix-queue.js');
let ctx: AgentContext;
let repoId = 0;
let wsId = 0;
let n = 1;
const NOW = 1_800_000_000_000;

async function pr(o: { ciStatus?: string | null; head?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_q_${n}`,
      accountId: 1,
      repoId,
      number: n++,
      title: 't',
      state: 'open',
      isDraft: false,
      authorId: null,
      headSha: o.head ?? 'h1',
      ciStatus: o.ciStatus ?? null,
      openedAt: new Date(NOW - 3_600_000),
      updatedAt: new Date(NOW - 3_600_000),
    })
    .returning()
    .execute();
  return row.id;
}

async function aiReview(prId: number, o: { status?: string; trigger?: string; head?: string } = {}): Promise<number> {
  const [row] = await db
    .insert(schema.claudeReviews)
    .values({ accountId: 1, prId, headSha: o.head ?? 'h1', status: o.status ?? 'succeeded', model: 'claude-opus-5-5', trigger: o.trigger ?? 'auto' })
    .returning()
    .execute();
  return row.id;
}

async function ciReview(prId: number, status = 'succeeded'): Promise<void> {
  await db.insert(schema.ciReviews).values({ accountId: 1, workspaceId: wsId, prId, repoId, headSha: 'h1', status, model: 'claude-opus-5-5', trigger: 'auto' }).execute();
}

let own = true;
let running = false;
let reviewHeld = false;
let ciHeld = false;
let autoReviewOn = true;
let live: { running: number; failing: number } | null = null;
let ciItems = 0;
let starts: Array<{ reviewId: number | null }> = [];
let answer: { status: string; fixId?: number; reason?: any } = { status: 'started', fixId: 9 };

const deps: AutoFixQueueDeps = {
  isOwn: async () => own,
  settings: async () => ({ workspaceId: wsId, enabled: true, ciFailures: true, autoReviewOn }),
  fixRunning: () => running,
  reviewHeld: () => reviewHeld,
  reviewWaiting: () => false,
  ciReviewHeld: () => ciHeld,
  liveChecks: async () => (live == null ? null : { headSha: 'h1', total: 3, running: live.running, failing: live.failing, complete: true }),
  ciItemsAtHead: async () => ciItems,
  start: async (_c, input) => {
    starts.push({ reviewId: input.reviewId });
    return answer;
  },
};
const decide = (prId: number, at = NOW, cause: 'sweep' | 'review' = 'review') => Q.evaluateAutoFix(ctx, { accountId: 1, prId, cause }, deps, at);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  Q = await import('./auto-fix-queue.js');
  ctx = { db, schema, log: { info: () => {}, warn: () => {}, error: () => {} } } as any as AgentContext;
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [repo] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_q', createdAt: new Date(NOW - 99 * 3_600_000) }).returning().execute();
  repoId = repo.id;
  const q = await import('../../db/queries.js');
  wsId = await q.ensureDefaultWorkspace(1);
  await db.insert(schema.workspaceRepos).values({ accountId: 1, workspaceId: wsId, repoId }).execute();
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  own = true;
  running = false;
  reviewHeld = false;
  ciHeld = false;
  autoReviewOn = true;
  live = null;
  ciItems = 0;
  starts = [];
  answer = { status: 'started', fixId: 9 };
  Q._resetAutoFixQueueForTest();
});

describe('the auto fix queue', () => {
  it('judges only the reader’s own PR', async () => {
    own = false;
    const id = await pr();
    expect(await decide(id)).toBeNull();
    expect(Q.autoFixQueueFor(1, id)).toBeNull();
  });

  it('a running fix queues the next', async () => {
    running = true;
    const id = await pr();
    await aiReview(id);
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'fix_running' });
    expect(starts).toEqual([]);
  });

  it('waits for the head’s CI jobs to finish (bounded), then goes on', async () => {
    const id = await pr({ ciStatus: 'failure' });
    await aiReview(id);
    await ciReview(id);
    live = { running: 2, failing: 1 };
    const w = await decide(id);
    expect(w).toMatchObject({ status: 'waiting', reason: 'ci_running', until: new Date(NOW + AUTO_FIX_CI_WAIT_MAX_MS).toISOString() });
    expect(starts).toEqual([]);
    // Past the limit it starts anyway.
    expect(await decide(id, NOW + AUTO_FIX_CI_WAIT_MAX_MS + 1)).toMatchObject({ status: 'started', fixId: 9, source: 'review' });
  });

  it('a CI failure waits for the CI review’s causes (bounded)', async () => {
    const id = await pr({ ciStatus: 'failure' });
    live = { running: 0, failing: 1 };
    ciHeld = true;
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'ci_review', until: new Date(NOW + AUTO_FIX_CI_REVIEW_WAIT_MS).toISOString() });
  });

  it('a succeeded AUTO AI review of the head ⇒ a review fix, once CI is done', async () => {
    const id = await pr({ ciStatus: 'success' });
    const rid = await aiReview(id);
    expect(await decide(id)).toMatchObject({ status: 'started', source: 'review' });
    expect(starts).toEqual([{ reviewId: rid }]);
  });

  it('CI causes alone wait (bounded) for the AI review of the head, then a CI-ONLY fix starts', async () => {
    const id = await pr({ ciStatus: 'failure' });
    live = { running: 0, failing: 1 };
    await ciReview(id);
    ciItems = 2;
    const w = await decide(id);
    expect(w).toMatchObject({ status: 'waiting', reason: 'review_due', until: new Date(NOW + AUTO_FIX_REVIEW_WAIT_MS).toISOString() });
    expect(starts).toEqual([]);
    expect(await decide(id, NOW + AUTO_FIX_REVIEW_WAIT_MS + 1)).toMatchObject({ status: 'started', source: 'ci' });
    expect(starts).toEqual([{ reviewId: null }]);
  });

  it('with auto review off, CI causes start a CI-only fix at once', async () => {
    autoReviewOn = false;
    const id = await pr({ ciStatus: 'failure' });
    live = { running: 0, failing: 1 };
    await ciReview(id);
    ciItems = 1;
    expect(await decide(id)).toMatchObject({ status: 'started', source: 'ci' });
  });

  it('nothing to fix with no review expected is idle; a manual review does not start an auto fix', async () => {
    autoReviewOn = false;
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id, { trigger: 'manual' });
    expect(await decide(id)).toMatchObject({ status: 'idle', reason: 'nothing_to_fix' });
    expect(starts).toEqual([]);
  });

  it('a busy sandbox is a wait; the cap is final, and the sweep does not start again on unchanged facts', async () => {
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id);
    answer = { status: 'skipped', reason: 'sandbox_busy' };
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'sandbox_busy' });
    answer = { status: 'skipped', reason: 'cap' };
    expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'idle', reason: 'cap' });
    expect(starts.length).toBe(2);
    expect(await decide(id, NOW + 60_000, 'sweep')).toMatchObject({ status: 'idle', reason: 'cap' });
    expect(starts.length).toBe(2);
    // A new head is new facts: judged again.
    await db.update(schema.pullRequests).set({ headSha: 'h2' }).where((await import('drizzle-orm')).eq(schema.pullRequests.id, id)).execute();
    autoReviewOn = false;
    expect(await decide(id, NOW + 120_000, 'sweep')).toMatchObject({ status: 'idle', reason: 'nothing_to_fix', headSha: 'h2' });
  });
});
