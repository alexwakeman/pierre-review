// AUTO FIX (coding/ai-fix/auto-fix.ts) over the REAL core client and migrations. What this pins:
//   1. ⚠ THE AUTHOR GATE — only the reader's OWN PR (author login = account login, any case) gets an
//      auto fix; anyone else's gets nothing, and nothing is recorded;
//   2. the skips, each with its reason: nothing to fix, a moved head, a fix in flight, a finished fix
//      waiting unpushed on this head, the 3-per-24h cap, and a re-try of items the last auto fix at
//      this head already reported as not addressed;
//   3. a start passes the review's model and `trigger: 'auto'`, and records the outcome for the
//      Claude Review tab (owner-scoped).
//
//   pnpm --filter @pierre-review/backend test ai-fix/auto-fix
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiFixReviewItem } from '@pierre-review/shared';
import type { AgentContext } from '../../review/agent-context.js';

const DB_PATH = '/tmp/pierre-auto-fix-db.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let schema: any;
let closeDb: (() => Promise<void> | void) | undefined;
let mod: typeof import('./auto-fix.js');
let ctx: AgentContext;
let repoId = 0;
let viewerId = 0;
let aliceId = 0;
let n = 1;
const HOUR = 3_600_000;
const NOW = Date.now();

const item = (ref: string, title: string, over: Partial<AiFixReviewItem> = {}): AiFixReviewItem => ({
  ref,
  kind: 'finding',
  title,
  path: 'src/a.ts',
  line: 1,
  findingId: null,
  threadId: null,
  ticketIndex: null,
  included: true,
  ...over,
});

async function seedPr(authorId: number, headSha = 'h1'): Promise<number> {
  const [row] = await db
    .insert(schema.pullRequests)
    .values({
      githubNodeId: `PR_af_${n}`,
      accountId: 1,
      repoId,
      number: n++,
      title: 't',
      state: 'open',
      isDraft: false,
      authorId,
      headSha,
      openedAt: new Date(NOW - 10 * HOUR),
      updatedAt: new Date(NOW - 10 * HOUR),
    })
    .returning()
    .execute();
  return row.id;
}

async function fix(
  prId: number,
  over: {
    status?: string;
    baseSha?: string;
    patch?: string | null;
    pushedAt?: Date | null;
    trigger?: string;
    createdAt?: number;
    reviewItems?: AiFixReviewItem[];
    unaddressed?: string[];
  } = {},
): Promise<void> {
  await db
    .insert(schema.aiFixes)
    .values({
      accountId: 1,
      repoId,
      prId,
      baseSha: over.baseSha ?? 'h1',
      status: over.status ?? 'succeeded',
      model: 'claude-opus-5-5',
      seed: 'review',
      patch: over.patch === undefined ? 'diff --git a b' : over.patch,
      pushedAt: over.pushedAt ?? null,
      trigger: over.trigger ?? 'auto',
      createdAt: new Date(over.createdAt ?? NOW - HOUR),
      reviewItems: over.reviewItems ? JSON.stringify(over.reviewItems) : null,
      changeReport: over.unaddressed
        ? JSON.stringify({
            changes: [],
            unaddressed: over.unaddressed.map((ref) => ({ ref, reason: 'no' })),
            notReported: [],
          })
        : null,
    })
    .execute();
}

// The fakes: what the review would seed, and what the fixer was asked to do.
let seed: { headSha: string; model: string; items: AiFixReviewItem[] } | null;
let running = false;
let started: any[];
let startAnswer: any;
const deps = () => ({
  loadReviewSeed: (async () =>
    seed
      ? {
          review: { headSha: seed.headSha, model: seed.model } as any,
          seed: { items: seed.items, sentRefs: seed.items.filter((i) => i.included).map((i) => i.ref), text: 'x' },
        }
      : null) as any,
  isFixRunning: () => running,
  startReviewFix: (async (_ctx: unknown, input: any) => {
    started.push(input);
    return startAnswer;
  }) as any,
});
const go = (prId: number, reviewId = 900 + prId) =>
  mod.maybeStartAutoFix(ctx, { accountId: 1, prId, reviewId }, deps(), NOW);

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  mod = await import('./auto-fix.js');
  ctx = {
    db,
    schema,
    isPg: false,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  } as any as AgentContext;
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_me', githubLogin: 'Viewer-Me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'Viewer-Me' } })
    .execute();
  const user = async (login: string): Promise<number> =>
    (
      await db
        .insert(schema.users)
        .values({ githubLogin: login, githubNodeId: `U_${login}` })
        .returning()
        .execute()
    )[0].id;
  viewerId = await user('viewer-me');
  aliceId = await user('alice-dev');
  const [repo] = await db
    .insert(schema.repos)
    .values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_af', createdAt: new Date(NOW - 99 * HOUR) })
    .returning()
    .execute();
  repoId = repo.id;
});

afterAll(async () => {
  await closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  seed = { headSha: 'h1', model: 'claude-sonnet-5', items: [item('F1', 'Null deref')] };
  running = false;
  started = [];
  startAnswer = { status: 'queued', fixId: 77 };
  mod._resetAutoFixForTest();
});

describe('maybeStartAutoFix — the author gate', () => {
  it('⚠ own PR (login compared case-insensitively) → a review-seeded fix, model from the review, trigger auto', async () => {
    const prId = await seedPr(viewerId);
    const r = await go(prId, 501);
    expect(r).toEqual({ reviewId: 501, status: 'started', fixId: 77 });
    expect(started).toEqual([
      { accountId: 1, prId, reviewId: 501, model: 'claude-sonnet-5', trigger: 'auto' },
    ]);
    expect(mod.autoFixOutcomeFor(501, 1)).toEqual(r);
    expect(mod.autoFixOutcomeFor(501, 2)).toBeNull(); // owner-scoped
  });

  it('⚠ someone else’s PR → no fix, nothing recorded', async () => {
    const prId = await seedPr(aliceId);
    expect(await go(prId, 502)).toEqual({ status: 'not_own' });
    expect(started).toEqual([]);
    expect(mod.autoFixOutcomeFor(502, 1)).toBeNull();
  });

  it('a retired review model falls back to the fixer’s default', async () => {
    seed!.model = 'claude-opus-4-1';
    await go(await seedPr(viewerId));
    expect(started[0].model).toBe('claude-opus-5-5');
  });
});

describe('maybeStartAutoFix — the skips', () => {
  it('nothing to fix', async () => {
    seed!.items = [];
    const prId = await seedPr(viewerId);
    expect(await go(prId, 510)).toEqual({ reviewId: 510, status: 'skipped', reason: 'nothing_to_fix' });
    expect(started).toEqual([]);
    expect(mod.autoFixOutcomeFor(510, 1)?.status).toBe('skipped');
  });

  it('the PR moved on after the review', async () => {
    const prId = await seedPr(viewerId, 'h2');
    expect(await go(prId)).toMatchObject({ status: 'skipped', reason: 'head_moved' });
  });

  it('a fix (auto or manual) is queued or running', async () => {
    running = true;
    expect(await go(await seedPr(viewerId))).toMatchObject({ reason: 'fix_in_progress' });
    expect(started).toEqual([]);
  });

  it('a finished fix waits unpushed on this head — but not a pushed, empty or older-head one', async () => {
    const waiting = await seedPr(viewerId);
    await fix(waiting, { trigger: 'manual' });
    expect(await go(waiting)).toMatchObject({ reason: 'fix_waiting' });

    const pushed = await seedPr(viewerId);
    await fix(pushed, { pushedAt: new Date(NOW - HOUR) });
    const empty = await seedPr(viewerId);
    await fix(empty, { patch: '' });
    const older = await seedPr(viewerId);
    await fix(older, { baseSha: 'h0' });
    const failed = await seedPr(viewerId);
    await fix(failed, { status: 'failed' });
    for (const prId of [pushed, empty, older, failed]) {
      expect(await go(prId)).toMatchObject({ status: 'started' });
    }
  });

  it('⚠ a lagging sync does not hide a waiting fix: the reviewed head and the live head count', async () => {
    // Synced head not known yet; the fix sits on the head the review ran on.
    const unsynced = await seedPr(viewerId, null as unknown as string);
    await fix(unsynced, { baseSha: 'h1', trigger: 'manual' });
    expect(await go(unsynced)).toMatchObject({ reason: 'fix_waiting' });

    // Synced = reviewed = h1, but the fix was built on the LIVE head h2 the sync has not seen.
    const lagging = await seedPr(viewerId);
    await fix(lagging, { baseSha: 'h2', trigger: 'manual' });
    const asked: number[] = [];
    const withLive = {
      ...deps(),
      liveHeadSha: async (_c: unknown, _a: number, prId: number) => {
        asked.push(prId);
        return 'h2';
      },
    };
    expect(await mod.maybeStartAutoFix(ctx, { accountId: 1, prId: lagging, reviewId: 1 }, withLive, NOW))
      .toMatchObject({ reason: 'fix_waiting' });
    expect(asked).toEqual([lagging]);
    expect(started).toEqual([]);

    // No unpushed fix at all ⇒ GitHub is not asked.
    const clean = await seedPr(viewerId);
    asked.length = 0;
    expect(await mod.maybeStartAutoFix(ctx, { accountId: 1, prId: clean, reviewId: 2 }, withLive, NOW))
      .toMatchObject({ status: 'started' });
    expect(asked).toEqual([]);
  });

  it('⚠ at most 3 auto fixes per PR in a rolling 24 hours (manual fixes do not count)', async () => {
    const prId = await seedPr(viewerId);
    for (let i = 0; i < 3; i++) await fix(prId, { baseSha: `old${i}`, createdAt: NOW - (i + 1) * HOUR });
    await fix(prId, { baseSha: 'm', trigger: 'manual', createdAt: NOW - HOUR });
    expect(await go(prId)).toMatchObject({ reason: 'cap' });

    const aged = await seedPr(viewerId);
    await fix(aged, { baseSha: 'o1', createdAt: NOW - 25 * HOUR });
    await fix(aged, { baseSha: 'o2', createdAt: NOW - 2 * HOUR });
    await fix(aged, { baseSha: 'o3', createdAt: NOW - HOUR });
    expect(await go(aged)).toMatchObject({ status: 'started' });
  });

  it('⚠ the last auto fix at this head already said "not addressed" to every item → no retry', async () => {
    const prId = await seedPr(viewerId);
    // That fix changed nothing (an empty patch is not "waiting") and refused both items, under its
    // own refs; this review numbers them differently.
    await fix(prId, {
      patch: '',
      reviewItems: [item('F3', 'Null  deref'), item('T1', 'Rename', { kind: 'thread', threadId: 9, path: 'b.ts' })],
      unaddressed: ['F3', 'T1'],
    });
    seed!.items = [
      item('F1', 'null deref'),
      item('T2', 'Rename', { kind: 'thread', threadId: 9, path: 'b.ts' }),
    ];
    expect(await go(prId)).toMatchObject({ reason: 'already_tried' });

    // One NEW item ⇒ worth a try.
    seed!.items.push(item('F2', 'Missing await'));
    expect(await go(prId)).toMatchObject({ status: 'started' });
  });

  it('a refusal from the fixer is recorded, never thrown', async () => {
    startAnswer = { status: 'no_auth' };
    expect(await go(await seedPr(viewerId))).toMatchObject({ reason: 'not_started' });
    startAnswer = { status: 'already_running' };
    expect(await go(await seedPr(viewerId))).toMatchObject({ reason: 'fix_in_progress' });
  });
});
