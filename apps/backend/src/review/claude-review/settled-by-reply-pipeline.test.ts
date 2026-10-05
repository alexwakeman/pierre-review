// SETTLED BY A REPLY — end to end through the review manager's pipeline, over the REAL core client
// and migrations (no-stories-pipeline.test.ts's precedent), with a fake prepare + a fake model.
//
// One earlier review posted four findings; on GitHub:
//   • SETTLED — someone else replied and the thread was resolved, no commit since ⇒ leaves the
//     follow-up, is listed (fenced) as settled in the prompt, and the model's repeat of it is DROPPED;
//   • NO REPLY — resolved with no reply ⇒ unchanged (still followed up: resolving is a click);
//   • OWN REPLY — the only reply is by the account's own login (Limn posts as the reader) ⇒ unchanged;
//   • FIXED — replied + resolved, but a later commit touched the file ⇒ unchanged (the follow-up
//     judges it, the existing "addressed" path).
//
//   pnpm --filter @pierre-review/backend test settled-by-reply-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-settled-by-reply.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const PATH = 'src/mail.ts';
const RETRY = 'src/retry.ts';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const HOUR = 3600_000;
const T = Date.now() - 10 * HOUR;
const REPLY_TEXT = 'Intentional: sendMail is only called with validated input from the form layer.';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let foreignPrId = 0;
let lastArgs: RunReviewArgs | null = null;
let node = 1;

const finding = (title: string, extra: object = {}) => ({
  path: PATH, line: 2, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, ...extra,
});

// The fake model: a repeat of the settled finding (no priorRef), and a genuinely new one.
const reply = (): RunReviewResult =>
  ({
    submitted: true,
    scope: 'diff_only',
    summary: 'ok',
    verdict: 'COMMENT',
    findings: [finding('Possible unchecked input in sendMail'), finding('A new problem')],
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
  }) as unknown as RunReviewResult;

async function thread(
  pr: number,
  comments: Array<{ authorId: number; at: number; body: string; databaseId?: string }>,
  path: string = PATH,
): Promise<void> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: `RT_${node++}`, prId: pr, path, line: 2, isResolved: true, derivedState: 'resolved', createdAt: new Date(comments[0]!.at) })
    .returning()
    .execute();
  for (const c of comments) {
    await db
      .insert(schema.reviewComments)
      .values({ githubNodeId: `RC_${node++}`, threadId: t.id, prId: pr, authorId: c.authorId, body: c.body, databaseId: c.databaseId ?? null, createdAt: new Date(c.at) })
      .execute();
  }
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
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF, promptDiff: DIFF, changedFiles: [PATH], excludedFiles: [], omittedFiles: [],
        fileMetrics: [{ path: PATH, additions: 4, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length, diffCapped: false,
      }),
      runReview: async (args: RunReviewArgs) => {
        lastArgs = args;
        return reply();
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');

  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
  await db.insert(schema.accounts).values({ id: 2, githubUserId: 'U_other', githubLogin: 'other', isLocal: false }).execute();
  const user = async (login: string): Promise<number> =>
    (await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}` }).returning().execute())[0].id;
  const me = await user('viewer-me');
  const alice = await user('alice-dev');
  const repo = async (accountId: number, name: string): Promise<number> =>
    (await db.insert(schema.repos).values({ accountId, owner: 'acme', name, githubNodeId: `R_${accountId}_${name}` }).returning().execute())[0].id;
  const pr = async (accountId: number, repoId: number): Promise<number> =>
    (
      await db
        .insert(schema.pullRequests)
        .values({ githubNodeId: `PR_${accountId}_${repoId}`, accountId, repoId, number: 7, title: 'PR', state: 'open', isDraft: false, openedAt: new Date(T), updatedAt: new Date(T), headSha: HEAD })
        .returning()
        .execute()
    )[0].id;
  prId = await pr(1, await repo(1, 'api'));
  foreignPrId = await pr(2, await repo(2, 'api'));

  // The earlier review, all four findings posted. FIXED's thread has a later commit on the file.
  const r1 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
  await persist.saveReviewSuccess(ctx, r1, {
    scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [],
    findings: [
      finding('Unchecked input in sendMail'),
      finding('Missing await on save'),
      finding('Leaks the file handle'),
      finding('Off-by-one in the retry loop', { path: RETRY }),
    ],
  });
  const ids = new Map<string, number>(
    (await persist.getClaudeReviewById(ctx, r1, 1))!.findings.map((f) => [f.title, f.id] as const),
  );
  await persist.markFindingPosted(ctx, ids.get('Unchecked input in sendMail')!, '101');
  await persist.markFindingPosted(ctx, ids.get('Missing await on save')!, '102');
  // Post review stores no per-comment id: matched by its body.
  await db.update(schema.claudeReviewFindings).set({ postedAt: new Date(T), postedCommentKind: 'inline' }).where(eq(schema.claudeReviewFindings.id, ids.get('Leaks the file handle')!)).execute();
  await persist.markFindingPosted(ctx, ids.get('Off-by-one in the retry loop')!, '104');

  const marker = '\n\n<!-- pierre:claude-review-finding v=1 -->';
  await thread(prId, [
    { authorId: me, at: T, body: `Unchecked input in sendMail.${marker}`, databaseId: '101' },
    { authorId: alice, at: T + HOUR, body: REPLY_TEXT },
  ]);
  await thread(prId, [{ authorId: me, at: T, body: `Missing await on save.${marker}`, databaseId: '102' }]);
  await thread(prId, [
    { authorId: me, at: T, body: `Leaks the file handle.${marker}`, databaseId: '103' },
    { authorId: me, at: T + HOUR, body: 'Will look later.' },
  ]);
  await thread(prId, [
    { authorId: me, at: T, body: `Off-by-one in the retry loop.${marker}`, databaseId: '104' },
    { authorId: alice, at: T + HOUR, body: 'Fixed in the next push.' },
  ], RETRY);
  await db.insert(schema.commits).values({ sha: 'c'.repeat(40), prId, committedAt: new Date(T + 2 * HOUR) }).execute();
  await db.insert(schema.commitFiles).values({ sha: 'c'.repeat(40), paths: [RETRY] }).execute();
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function runToEnd(): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5');
  if (!started.ok) throw new Error(`not started: ${started.reason}`);
  for (let i = 0; i < 200; i++) {
    const r = await persist.getClaudeReviewById(ctx, started.reviewId, 1);
    if (r && r.status !== 'queued' && r.status !== 'running') {
      await new Promise((res) => setTimeout(res, 20));
      return r;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('review did not finish');
}

describe('a finding settled by a reply', () => {
  it('the loader settles only the replied-and-resolved, unchanged one — account-scoped', async () => {
    const settled = await persist.loadSettledByReplyFindings(ctx, prId, 1, 1_000_000);
    expect(settled.map((s) => [s.title, s.replyAuthor, s.reply])).toEqual([
      ['Unchecked input in sendMail', 'alice-dev', REPLY_TEXT],
    ]);
    expect(await persist.loadSettledByReplyFindings(ctx, prId, 2, 1_000_000)).toEqual([]);
    expect(await persist.loadSettledByReplyFindings(ctx, foreignPrId, 1, 1_000_000)).toEqual([]);
  });

  it('leaves the follow-up, is fenced as settled in the prompt, and its repeat is dropped', async () => {
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    // (a) not followed up — the other three are, unchanged.
    expect(r.followUp?.items.map((it) => it.title).sort()).toEqual([
      'Leaks the file handle',
      'Missing await on save',
      'Off-by-one in the retry loop',
    ]);
    // (b) the prompt says so, inside a fence, with the reply as data…
    const prompt = lastArgs!.prompt;
    expect(prompt).toContain('## Settled in an earlier review');
    expect(prompt).toMatch(/---BEGIN SETTLED FINDING S1 [0-9a-f]{16}---/);
    expect(prompt).toContain(REPLY_TEXT);
    const previous = prompt.slice(prompt.indexOf('## Previous review'), prompt.indexOf('## Settled in an earlier review'));
    expect(previous).toContain('Title: Missing await on save');
    expect(previous).not.toContain('Unchecked input in sendMail');
    // …and the code enforces it: the model's repeat is gone, the new finding stays.
    const titles = r.findings.map((f) => f.title);
    expect(titles).not.toContain('Possible unchecked input in sendMail');
    expect(titles).not.toContain('Unchecked input in sendMail');
    expect(titles).toContain('A new problem');
  });
});
