// A POSTED INLINE finding links to its review thread — `ClaudeFinding.threadId`, computed on read
// from `github_comment_id = review_comments.database_id`, scoped to the review's own PR.
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's client, which opens at module load.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReviewFinding } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = process.env.DATABASE_URL?.endsWith('.db')
  ? process.env.DATABASE_URL.replace(/\.db$/, '-thread-id.db')
  : join(tmpdir(), `pierre-persist-thread-id-${process.pid}.sqlite`);
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let prId = 0;
let otherPrId = 0;

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
  path: 'src/a.ts',
  line: 3,
  side: 'RIGHT',
  severity: 'warning',
  title: 't',
  body: 'b',
  suggestion: null,
  diffHunk: null,
  anchored: true,
  fileInDiff: true,
  ...over,
});

const success = (findings: ReviewFinding[]) => ({
  scope: 'diff_only' as const,
  summary: 's',
  verdict: 'COMMENT' as const,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  numTurns: 1,
  excludedFiles: [],
  findings,
});

async function thread(pr: number, key: string, databaseId: string): Promise<number> {
  const { reviewThreads, reviewComments } = schema;
  const t = (
    await db
      .insert(reviewThreads)
      .values({
        githubNodeId: `T_${key}`,
        prId: pr,
        path: 'src/a.ts',
        line: 3,
        isResolved: false,
        derivedState: 'untouched',
        createdAt: new Date(),
      })
      .returning()
      .execute()
  )[0].id as number;
  await db
    .insert(reviewComments)
    .values({ githubNodeId: `C_${key}`, threadId: t, prId: pr, databaseId, createdAt: new Date() })
    .execute();
  return t;
}

beforeAll(async () => {
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
  const { runMigrations } = await import('../../db/run-migrations.js');
  const client = await import('../../db/client.js');
  db = client.db;
  schema = client.schema;
  closeDb = client.closeDb;
  await runMigrations();
  ctx = {
    db,
    schema,
    isPg: false,
    runTransaction: client.runTransaction,
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
  } as any as AgentContext;
  persist = await import('./persist.js');
  const { repos, pullRequests } = schema;
  const mk = async (key: string) => {
    const repoId = (
      await db
        .insert(repos)
        .values({ accountId: 1, owner: 'acme', name: key, githubNodeId: `R_${key}` })
        .returning()
        .execute()
    )[0].id as number;
    return (
      await db
        .insert(pullRequests)
        .values({
          githubNodeId: `PR_${key}`,
          accountId: 1,
          repoId,
          number: 1,
          title: key,
          state: 'open',
          isDraft: false,
          openedAt: new Date(),
          updatedAt: new Date(),
          headSha: 'h'.repeat(40),
        })
        .returning()
        .execute()
    )[0].id as number;
  };
  prId = await mk('thread-id-a');
  otherPrId = await mk('thread-id-b');
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('ClaudeFinding.threadId', () => {
  it('is the synced thread of a posted inline comment, and null otherwise', async () => {
    const r = await persist.insertQueuedReview(ctx, prId, 'a'.repeat(40), 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(
      ctx,
      r,
      success([
        finding({ title: 'inline' }),
        finding({ title: 'pr comment' }),
        finding({ title: 'not synced yet' }),
        finding({ title: 'unposted' }),
        finding({ title: 'other pr id' }),
      ]),
    );
    const [inline, prComment, notSynced, , otherPr] = (await persist.getClaudeReviewById(ctx, r, 1))!
      .findings;
    const t1 = await thread(prId, 'one', '111');
    await thread(prId, 'two', '222');
    // The same comment id on ANOTHER PR must never resolve here.
    await thread(otherPrId, 'three', '333');
    await persist.markFindingPosted(ctx, inline!.id, '111', 'inline');
    await persist.markFindingPosted(ctx, prComment!.id, '222', 'pr_comment');
    await persist.markFindingPosted(ctx, notSynced!.id, '999', 'inline');
    await persist.markFindingPosted(ctx, otherPr!.id, '333', 'inline');

    const read = (await persist.getClaudeReviewById(ctx, r, 1))!.findings;
    expect(read.map((f) => [f.title, f.threadId])).toEqual([
      ['inline', t1],
      ['pr comment', null],
      ['not synced yet', null],
      ['unposted', null],
      ['other pr id', null],
    ]);
  });
});

describe('ClaudeFinding.threadId — findings posted INSIDE a review', () => {
  // A thread whose root comment is authored by `login` with `body`.
  async function rootThread(pr: number, key: string, login: string, body: string, path = 'src/a.ts'): Promise<number> {
    const { reviewThreads, reviewComments, users } = schema;
    const existing = (await db.select().from(users).execute()).find((u: any) => u.githubLogin === login);
    const userId =
      existing?.id ?? (await db.insert(users).values({ githubLogin: login }).returning().execute())[0].id;
    const t = (
      await db
        .insert(reviewThreads)
        .values({ githubNodeId: `T_${key}`, prId: pr, path, line: 3, isResolved: false, derivedState: 'untouched', createdAt: new Date() })
        .returning()
        .execute()
    )[0].id as number;
    await db
      .insert(reviewComments)
      .values({ githubNodeId: `C_${key}`, threadId: t, prId: pr, databaseId: `db_${key}`, authorId: userId, body, createdAt: new Date() })
      .execute();
    return t;
  }

  beforeAll(async () => {
    const { accounts } = schema;
    const rows = await db.select().from(accounts).execute();
    if (rows.length === 0) {
      await db.insert(accounts).values({ id: 1, githubUserId: 'U_me', githubLogin: 'me', isLocal: true }).execute();
    } else {
      await db.update(accounts).set({ githubLogin: 'me' }).execute();
    }
  });

  it('the comment ids read back after the submit are stamped, and resolve the thread', async () => {
    const r = await persist.insertQueuedReview(ctx, prId, 'b'.repeat(40), 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, r, success([finding({ title: 'read back', body: 'rb' }), finding({ title: 'no id', body: 'zz-nothing' })]));
    const [a, b] = (await persist.getClaudeReviewById(ctx, r, 1))!.findings;
    const t = await thread(prId, 'readback', '4242');
    await persist.markReviewPosted(ctx, r, 'RV', [a!.id, b!.id], [], {
      // An id for a finding not posted inline in this review is ignored.
      inlineComments: [
        { findingId: a!.id, commentId: '4242' },
        { findingId: 999_999, commentId: '1' },
      ],
    });
    const read = (await persist.getClaudeReviewById(ctx, r, 1))!.findings;
    expect(read.map((f) => [f.title, f.githubCommentId, f.postedCommentKind, f.threadId])).toEqual([
      ['read back', '4242', 'inline', t],
      ['no id', null, 'inline', null],
    ]);
  });

  it('with no stored id, falls back to the thread whose root is ours, on the file, marked, and starts with the text', async () => {
    const r = await persist.insertQueuedReview(ctx, prId, 'c'.repeat(40), 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(
      ctx,
      r,
      success([
        finding({ title: 'match', body: 'Guard the null here.' }),
        finding({ title: 'twin', body: 'Guard the null here.' }),
        finding({ title: 'unposted', body: 'Never posted.' }),
      ]),
    );
    const [m, twin, unposted] = (await persist.getClaudeReviewById(ctx, r, 1))!.findings;
    const marker = '<!-- pierre:claude-review-finding v=1 -->';
    // Decoys first: someone else's, an unmarked one of ours, one on another file.
    await rootThread(prId, 'fb-other-author', 'someone', `Guard the null here.\n\n${marker}`);
    await rootThread(prId, 'fb-unmarked', 'me', 'Guard the null here.');
    await rootThread(prId, 'fb-other-file', 'me', `Guard the null here.\n\n${marker}`, 'src/b.ts');
    const t = await rootThread(prId, 'fb-ours', 'ME', `Guard the null here.\n\n${marker}`);
    // Never posted, but a matching thread exists: still no link.
    await rootThread(prId, 'fb-unposted', 'me', `Never posted.\n\n${marker}`);
    await persist.markReviewPosted(ctx, r, 'RV2', [m!.id, twin!.id]);
    const read = (await persist.getClaudeReviewById(ctx, r, 1))!.findings;
    expect(read.find((f) => f.id === m!.id)!.threadId).toBe(t);
    // Two findings never share one thread.
    expect(read.find((f) => f.id === twin!.id)!.threadId).toBeNull();
    expect(read.find((f) => f.id === unposted!.id)!.threadId).toBeNull();
  });
});

describe('getLatestSucceededReviewId (what AI Fix builds from)', () => {
  it('skips a failed newer run, and is null when nothing succeeded', async () => {
    expect(await persist.getLatestSucceededReviewId(ctx, otherPrId, 1)).toBeNull();
    const ok = await persist.insertQueuedReview(ctx, otherPrId, 'd'.repeat(40), 'claude-opus-5-5', 1);
    await persist.saveReviewSuccess(ctx, ok, success([]));
    const bad = await persist.insertQueuedReview(ctx, otherPrId, 'e'.repeat(40), 'claude-opus-5-5', 1);
    await persist.markReviewFailed(ctx, bad, 'boom');
    expect(await persist.getLatestSucceededReviewId(ctx, otherPrId, 1)).toBe(ok);
    // Another account sees nothing.
    expect(await persist.getLatestSucceededReviewId(ctx, otherPrId, 2)).toBeNull();
  });
});
