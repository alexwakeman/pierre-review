// A PAIR INTERRUPTED BY A RESTART, ended at boot (manager.ts `reconcileReviewsOnStartup` →
// `finishInterruptedPairs`), over the REAL core client and migrations and the REAL auto-post claim
// (only GitHub is faked: `ctx.review.postReview` is a recorded stub, the live reads are fakes). Pinned:
//   1. a SECOND half left running + a SUCCEEDED first half ⇒ the pair is consolidated (code path, the
//      second named as the failed half) and its run-end hooks run on the FIRST half: auto-post ONCE,
//      Sonar, diagrams, auto fix — and no Slack signal;
//   2. a second boot does nothing more (and even re-ending the same runs posts nothing: the claim);
//   3. a FIRST half interrupted (second never started), or a failed first + interrupted second ⇒
//      nothing consolidated, nothing posted.
//
//   pnpm --filter @pierre-review/backend test claude-review/pair-interrupted-boot
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { AUTO_POST_DEFAULT_KINDS } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-pair-interrupted-boot.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';

const rec = vi.hoisted(() => ({
  autoPost: [] as Array<Record<string, unknown>>,
  sonar: [] as Array<Record<string, unknown>>,
  fix: [] as Array<Record<string, unknown>>,
  diagrams: [] as Array<Record<string, unknown>>,
  signals: [] as Array<Record<string, unknown>>,
}));
// The REAL auto-post (its claim is what is under test), with GitHub's live reads faked.
vi.mock('./auto-post.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auto-post.js')>();
  return {
    ...real,
    maybeAutoPostReview: (ctx: AgentContext, a: { accountId: number; prId: number; reviewId: number }) => {
      rec.autoPost.push(a);
      return real.maybeAutoPostReview(ctx, a, {
        ...real.defaultAutoPostDeps,
        livePr: async () => ({ headSha: 'HEAD', state: 'open' as const, draft: false, merged: false }),
        liveReviews: async () => [],
        accountLogin: async () => 'me',
        impactLevel: async () => 'low' as const,
        settle: async () => ({ visible: true }),
      } as any);
    },
  };
});
vi.mock('../../platform/event-hooks.js', () => ({
  emitClaudeReviewCompleted: (e: Record<string, unknown>) => rec.signals.push(e),
}));
vi.mock('../../sonar/post.js', () => ({ maybeAutoPostSonar: async (_c: unknown, a: any) => void rec.sonar.push(a) }));
vi.mock('../../coding/ai-fix/auto-fix.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coding/ai-fix/auto-fix.js')>()),
  maybeStartAutoFix: async (_c: unknown, a: any) => {
    rec.fix.push(a);
    return { status: 'not_own' };
  },
}));
vi.mock('../diagrams/trigger.js', () => ({
  maybeDrawDiagramsAfterReview: async (_c: unknown, a: any) => void rec.diagrams.push(a),
  logTriggerLimits: () => {},
}));

let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let wsId = 0;
let repoId = 0;
let authorId = 0;
let prSeq = 0;
const postReview = vi.fn();

async function makePr(): Promise<number> {
  prSeq += 1;
  const [p] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PRI_${prSeq}`, accountId: 1, repoId, number: prSeq, title: `pr ${prSeq}`, state: 'open', isDraft: false,
      headSha: 'HEAD', authorId, openedAt: new Date(), updatedAt: new Date(),
    })
    .returning()
    .execute();
  return p.id;
}

type HalfEnd = 'succeeded' | 'failed' | 'running';
async function half(prId: number, provider: 'claude' | 'codex', pair: { role: 'first' } | { role: 'second'; pairId: number }, end: HalfEnd): Promise<number> {
  const id = await persist.insertQueuedReview(ctx, prId, 'HEAD', 'claude-opus-5-5' as any, 1, [], 'auto', provider, false, pair);
  if (provider === 'codex') await persist.markReviewRanOn(ctx, id, { provider: 'codex', model: 'gpt-6.1-sol' });
  if (end === 'succeeded') {
    await persist.saveReviewSuccess(ctx, id, {
      scope: 'diff_only', summary: `${provider} found things.`, verdict: 'COMMENT', costUsd: null, inputTokens: null,
      outputTokens: null, numTurns: 1, excludedFiles: [],
      findings: [{
        path: 'src/a.ts', line: provider === 'claude' ? 10 : 40, side: 'RIGHT' as const, severity: 'warning', title: `${provider} point`,
        body: 'body', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
      }],
    } as any);
  } else if (end === 'failed') {
    await persist.markReviewFailed(ctx, id, 'usage limit');
  } else {
    await db.update(schema.claudeReviews).set({ status: 'running' }).where(eq(schema.claudeReviews.id, id)).execute();
  }
  return id;
}

const rowOf = async (id: number) =>
  ((await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute()) as any[])[0];

const boot = async () => (await manager.reconcileReviewsOnStartup(ctx)).pairsFinished;

beforeAll(async () => {
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  const q = await import('../../db/queries.js');
  await db.insert(schema.accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).onConflictDoNothing().execute();
  const [u] = await db.insert(schema.users).values({ githubLogin: 'alice', githubNodeId: 'U_alice', isBot: false }).returning().execute();
  authorId = u.id;
  const [r] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  repoId = r.id;
  wsId = await q.ensureDefaultWorkspace(1);
  await q.ensureRepoMemberships(1);
  persist = await import('./persist.js');
  manager = await import('./manager.js');
  ctx = {
    db,
    schema,
    runTransaction: client.runTransaction,
    recordAiUsage: async () => {},
    accountIdOf: () => 1,
    review: { postReview, postFinding: vi.fn() },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  const settings = await import('./auto-settings.js');
  await settings.setWorkspaceAutoReview(ctx, 1, wsId, {
    autoPost: { enabled: true, scope: 'all', kinds: { ...AUTO_POST_DEFAULT_KINDS }, autoVerdict: false } as any,
  });
});

afterAll(async () => {
  await closeDb?.();
  for (const x of ['', '-shm', '-wal']) rmSync(DB_PATH + x, { force: true });
});

beforeEach(async () => {
  for (const k of Object.keys(rec) as Array<keyof typeof rec>) rec[k].length = 0;
  postReview.mockReset();
  postReview.mockImplementation(async (a: any) => ({
    postedReviewId: 'R1',
    inlineFindingIds: a.includedFindings.map((f: any) => f.id),
    prComments: [],
    commentCount: a.includedFindings.length,
    prCommentCount: 0,
  }));
  // Nothing left running from an earlier case.
  await db.update(schema.claudeReviews).set({ status: 'failed' }).where(eq(schema.claudeReviews.status, 'running')).execute();
});

describe('a pair whose second half a restart interrupted', () => {
  it('is consolidated and auto-posted ONCE, on the first half; a second boot does nothing more', async () => {
    const prId = await makePr();
    const first = await half(prId, 'claude', { role: 'first' }, 'succeeded');
    const second = await half(prId, 'codex', { role: 'second', pairId: first }, 'running');

    expect(await boot()).toEqual([first]);
    expect((await rowOf(second)).status).toBe('failed');
    // THE CONSOLIDATION, in code (one half succeeded), naming the interrupted half.
    const stored = await persist.readPairConsolidation(ctx, first, prId);
    expect(stored).toMatchObject({ how: 'single', failedHalf: { provider: 'codex' } });
    // The hooks, exactly as a live failed second half: on the FIRST half, no pairFirstReviewId.
    expect(rec.autoPost).toEqual([{ accountId: 1, prId, reviewId: first }]);
    expect(postReview).toHaveBeenCalledTimes(1);
    expect((await rowOf(first)).autoPost).toMatchObject({ status: 'posted', githubReviewId: 'R1' });
    expect(rec.sonar).toEqual([{ accountId: 1, prId, headSha: 'HEAD' }]);
    expect(rec.fix).toEqual([{ accountId: 1, prId, reviewId: first }]);
    await vi.waitFor(() => expect(rec.diagrams).toHaveLength(1));
    expect(rec.signals).toEqual([]);

    // A SECOND BOOT: nothing was left running, so nothing is ended or posted.
    expect(await boot()).toEqual([]);
    // Even ending the very same runs again posts nothing: the auto-post record is claimed.
    expect(await manager.finishInterruptedPairs(ctx, [{ id: second, accountId: 1, prId, pairId: first, pairRole: 'second' }])).toEqual([first]);
    expect(postReview).toHaveBeenCalledTimes(1);
  });

  it('a FAILED first half: nothing consolidated, nothing posted', async () => {
    const prId = await makePr();
    const first = await half(prId, 'claude', { role: 'first' }, 'failed');
    await half(prId, 'codex', { role: 'second', pairId: first }, 'running');
    expect(await boot()).toEqual([]);
    expect(await persist.readPairConsolidation(ctx, first, prId)).toBeNull();
    expect(rec.autoPost).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
  });

  it('a FIRST half interrupted (the second never started): nothing to end', async () => {
    const prId = await makePr();
    const first = await half(prId, 'claude', { role: 'first' }, 'running');
    expect(await boot()).toEqual([]);
    expect((await rowOf(first)).status).toBe('failed');
    expect(rec.autoPost).toEqual([]);
    expect(postReview).not.toHaveBeenCalled();
  });
});
