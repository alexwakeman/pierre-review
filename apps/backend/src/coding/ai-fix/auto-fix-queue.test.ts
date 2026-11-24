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
import { AUTO_FIX_CI_REVIEW_WAIT_MS, AUTO_FIX_CI_WAIT_MAX_MS, AUTO_FIX_DAILY_CAP, AUTO_FIX_QUEUE_LINE, AUTO_FIX_REVIEW_WAIT_MS } from '@pierre-review/shared';
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

async function aiReview(prId: number, o: { status?: string; trigger?: string; head?: string; pairId?: number; pairRole?: 'first' | 'second' } = {}): Promise<number> {
  const [row] = await db
    .insert(schema.claudeReviews)
    .values({ accountId: 1, prId, headSha: o.head ?? 'h1', status: o.status ?? 'succeeded', model: 'claude-opus-5-5', trigger: o.trigger ?? 'auto', pairId: o.pairId ?? null, pairRole: o.pairRole ?? null })
    .returning()
    .execute();
  return row.id;
}

/** A Claude + Codex pair at the head: the first half's id is the pair id, on both rows. */
async function pair(prId: number, first: string, second: string): Promise<{ firstId: number; secondId: number }> {
  const firstId = await aiReview(prId, { status: first, pairRole: 'first' });
  await db.update(schema.claudeReviews).set({ pairId: firstId }).where((await import('drizzle-orm')).eq(schema.claudeReviews.id, firstId)).execute();
  const secondId = await aiReview(prId, { status: second, pairId: firstId, pairRole: 'second' });
  return { firstId, secondId };
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
let busyPairs = new Set<number>();

const deps: AutoFixQueueDeps = {
  isOwn: async () => own,
  settings: async () => ({ workspaceId: wsId, enabled: true, ciFailures: true, autoReviewOn }),
  fixRunning: () => running,
  reviewHeld: () => reviewHeld,
  reviewWaiting: () => false,
  ciReviewHeld: () => ciHeld,
  liveChecks: async () => (live == null ? null : { headSha: 'h1', total: 3, running: live.running, failing: live.failing, complete: true }),
  ciItemsAtHead: async () => ciItems,
  pairBusy: async (pairId) => busyPairs.has(pairId),
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
  busyPairs = new Set();
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

  it('a start waiting behind the fix of another PR of the same ticket says so (the fix start queue\'s per-ticket line)', async () => {
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id);
    try {
      Q.bindAutoFixStartPlace((_a, p) => (p === id ? { position: 1, blockedBy: 12 } : null));
      expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'ticket_fix_running', line: 'Waiting for the fix of #12 (same ticket).' });
      // Its start goes into the line now (the start answers 'sandbox_busy': it waits).
      Q.bindAutoFixStartPlace(() => null);
      answer = { status: 'skipped', reason: 'sandbox_busy' };
      Q._resetAutoFixQueueForTest();
      let placed = false;
      const realStart = deps.start;
      deps.start = async (c, i) => {
        placed = true;
        return realStart(c, i);
      };
      Q.bindAutoFixStartPlace((_a, p) => (placed && p === id ? { position: 1, blockedBy: 12 } : null));
      expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'ticket_fix_running' });
      deps.start = realStart;
    } finally {
      Q.bindAutoFixStartPlace(() => null);
    }
    expect(AUTO_FIX_QUEUE_LINE.ticket_fix_running).toBe('Waiting for the fix of another pull request of the same ticket.');
  });

  it('a fix pushed from this head waits for the push to reach the PR (never fixes the same head twice)', async () => {
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id);
    await db
      .insert(schema.aiFixes)
      .values({ accountId: 1, repoId, prId: id, baseSha: 'h1', status: 'succeeded', model: 'm', seed: 'review', trigger: 'auto', pushedAt: new Date(NOW - 60_000), createdAt: new Date(NOW - 120_000) })
      .execute();
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'push_settling' });
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

  it('⚠ a head an AI fix pushed after its OWN review loop reviewed it is REVIEWED: idle "reviewed_by_fix", never a wait for an auto review; CI causes still start a CI fix', async () => {
    const id = await pr({ ciStatus: 'success' });
    // The fix's closing review, imported at the pushed head (markLoopReviewOnPr: trigger 'manual').
    await aiReview(id, { trigger: 'manual' });
    const reviewedByFix = async () => true;
    const d2: AutoFixQueueDeps = { ...deps, reviewedByFix };
    const decideFix = (prId: number) => Q.evaluateAutoFix(ctx, { accountId: 1, prId, cause: 'review' }, d2, NOW);
    expect(await decideFix(id)).toMatchObject({ status: 'idle', reason: 'reviewed_by_fix', line: AUTO_FIX_QUEUE_LINE.reviewed_by_fix });
    expect(starts).toEqual([]);
    // With CI causes at that head, the CI-only fix still starts (CI is new work, not the review's).
    ciItems = 2;
    const other = await pr({ ciStatus: 'success' });
    await aiReview(other, { trigger: 'manual' });
    expect(await decideFix(other)).toMatchObject({ status: 'started' });
    expect(starts).toEqual([{ reviewId: null }]);
    // A manual review that is NOT a fix's import reads as before: nothing to fix.
    ciItems = 0;
    const plain = await pr({ ciStatus: 'success' });
    await aiReview(plain, { trigger: 'manual' });
    expect(await Q.evaluateAutoFix(ctx, { accountId: 1, prId: plain, cause: 'review' }, { ...deps, reviewedByFix: async () => false }, NOW)).toMatchObject({ status: 'idle', reason: 'nothing_to_fix' });
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

  it('⚠ A PAIR IN FLIGHT IS ONE REVIEW RUNNING: a succeeded half whose other half runs is a wait, never a source or a skip', async () => {
    const id = await pr({ ciStatus: 'success' });
    // Claude finished first; Codex is still running.
    await pair(id, 'succeeded', 'running');
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'review_running', until: null, line: AUTO_FIX_QUEUE_LINE.review_running });
    expect(starts).toEqual([]);
    // The other order, and a queued half: the same wait.
    const id2 = await pr({ ciStatus: 'success' });
    await pair(id2, 'queued', 'succeeded');
    expect(await decide(id2)).toMatchObject({ status: 'waiting', reason: 'review_running' });
    expect(starts).toEqual([]);
  });

  it('⚠ a pair still MERGING (both halves done) is still in flight; once it ends the half seeds', async () => {
    const id = await pr({ ciStatus: 'success' });
    const { firstId, secondId } = await pair(id, 'succeeded', 'succeeded');
    busyPairs.add(firstId);
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'review_running' });
    expect(starts).toEqual([]);
    busyPairs.clear();
    expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'started', source: 'review' });
    // The newest succeeded auto half names the pair (the seed reads the consolidated view).
    expect(starts).toEqual([{ reviewId: secondId }]);
  });

  it('⚠ a pair that ENDED with one half failed (its cover pass done) still seeds from the half that succeeded', async () => {
    const id = await pr({ ciStatus: 'success' });
    const { firstId } = await pair(id, 'succeeded', 'failed');
    expect(await decide(id)).toMatchObject({ status: 'started', source: 'review' });
    expect(starts).toEqual([{ reviewId: firstId }]);
  });

  it('⚠ one half failed: the pair is in flight while the other half’s COVER PASS runs (pairBusy), and seeds once it ends', async () => {
    const id = await pr({ ciStatus: 'success' });
    const { firstId } = await pair(id, 'succeeded', 'failed');
    // The cover (a `kind = 'replies'` row, no pair_id) runs: only the in-process fact says so.
    await db.insert(schema.claudeReviews).values({ accountId: 1, prId: id, headSha: 'h1', status: 'running', model: 'claude-opus-5-5', trigger: 'auto', kind: 'replies' }).execute();
    busyPairs.add(firstId);
    expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'waiting', reason: 'review_running', until: null });
    expect(starts).toEqual([]);
    busyPairs.clear();
    expect(await decide(id, NOW + 60_000, 'sweep')).toMatchObject({ status: 'started', source: 'review' });
    expect(starts).toEqual([{ reviewId: firstId }]);
  });

  it('⚠ a NEWER review of the head still queued or running holds the older succeeded one (never a stale seed)', async () => {
    const id = await pr({ ciStatus: 'success' });
    const older = await aiReview(id);
    await aiReview(id, { status: 'running' });
    expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'waiting', reason: 'review_running' });
    const id2 = await pr({ ciStatus: 'success' });
    await aiReview(id2);
    await aiReview(id2, { status: 'queued', trigger: 'manual' });
    expect(await decide(id2, NOW, 'sweep')).toMatchObject({ status: 'waiting', reason: 'review_running' });
    expect(starts).toEqual([]);
    // An OLDER in-flight row does not hold a newer succeeded one.
    const id3 = await pr({ ciStatus: 'success' });
    await aiReview(id3, { status: 'running' });
    const newer = await aiReview(id3);
    expect(await decide(id3, NOW, 'sweep')).toMatchObject({ status: 'started', source: 'review' });
    expect(starts).toEqual([{ reviewId: newer }]);
    expect(newer).toBeGreaterThan(older);
  });

  it('⚠ a review of the PR this process holds (no row yet) holds the source on the sweep, never on the review’s own end', async () => {
    const id = await pr({ ciStatus: 'success' });
    const rid = await aiReview(id);
    reviewHeld = true;
    expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'waiting', reason: 'review_running' });
    expect(starts).toEqual([]);
    // The review's own end hook runs while its claim is still held.
    expect(await decide(id, NOW, 'review')).toMatchObject({ status: 'started', source: 'review' });
    expect(starts).toEqual([{ reviewId: rid }]);
  });

  it('a fault from the start names itself and is decided again by the sweep (it may pass)', async () => {
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id);
    answer = { status: 'skipped', reason: 'no_ai_login' };
    expect(await decide(id)).toMatchObject({ status: 'idle', reason: 'no_ai_login', line: AUTO_FIX_QUEUE_LINE.no_ai_login });
    for (const reason of ['review_unavailable', 'pr_unavailable', 'error'] as const) {
      answer = { status: 'skipped', reason };
      expect(await decide(id, NOW, 'sweep')).toMatchObject({ status: 'idle', reason, line: AUTO_FIX_QUEUE_LINE[reason] });
    }
    // Unchanged facts, yet the sweep asks again: the sign-in came back.
    answer = { status: 'started', fixId: 11 };
    expect(await decide(id, NOW + 60_000, 'sweep')).toMatchObject({ status: 'started', fixId: 11 });
  });

  it('the auto FIX cap prints its number from the constant', async () => {
    const id = await pr({ ciStatus: 'success' });
    await aiReview(id);
    answer = { status: 'skipped', reason: 'cap' };
    const s = await decide(id);
    expect(s).toMatchObject({ status: 'idle', reason: 'cap' });
    expect(s!.line).toContain(String(AUTO_FIX_DAILY_CAP));
  });

  it('a DUE AI review is waited for: no daily count of auto reviews stops it (review_capped is gone)', async () => {
    const id = await pr({ ciStatus: 'success' });
    const s = await decide(id);
    expect(s).toMatchObject({ status: 'waiting', reason: 'review_due' });
    expect(s!.reason).not.toBe('review_capped');
    expect(starts).toEqual([]);
  });

  it('a RUNNING review is waited for (it is coming)', async () => {
    const id = await pr({ ciStatus: 'success' });
    reviewHeld = true;
    expect(await decide(id)).toMatchObject({ status: 'waiting', reason: 'review_running' });
  });
});
