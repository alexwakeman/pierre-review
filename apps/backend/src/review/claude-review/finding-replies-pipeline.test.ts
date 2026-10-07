// REPLIES TO LIMN'S OWN FINDINGS — end to end through the review manager's pipeline, over the REAL
// core client and migrations (settled-by-reply-pipeline.test.ts's precedent), with a fake prepare
// and a scripted fake model.
//
// One earlier review posted two findings; on GitHub, both threads are still OPEN:
//   • BLOCKER "Drops the error" — alice: "Will fix in a follow-up PR." The model accepts it as a
//     deferral; the server refuses (a blocker) ⇒ reply_disputed, raised again, REQUEST_CHANGES.
//   • WARNING "Unchecked input in sendMail" — alice explains, a bot chimes in, Limn's own marked (kept as context)
//     reply sits there too. The model accepts it as not valid ⇒ settled from the next run on.
//
//   pnpm --filter @pierre-review/backend test finding-replies-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../pro/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-finding-replies.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
process.env.DEPLOYMENT_MODE = 'local';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const PATH = 'src/mail.ts';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const HOUR = 3600_000;
const T = Date.now() - 10 * HOUR;
const DEFER = 'Will fix in a follow-up PR.';
const EXPLAIN = 'Intentional: sendMail is only called with validated input from the form layer.';
const BOT = 'Coverage went down by 0.1%.';
const OWN = 'Addressed in abc1234.';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let lastArgs: RunReviewArgs | null = null;
let script: () => Partial<RunReviewResult> = () => ({});
let node = 1;

const finding = (title: string, extra: object = {}) => ({
  path: PATH, line: 2, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, ...extra,
});

async function thread(pr: number, comments: Array<{ authorId: number; at: number; body: string; databaseId?: string }>): Promise<void> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: `RT_${node++}`, prId: pr, path: PATH, line: 2, isResolved: false, derivedState: 'replied_unresolved', createdAt: new Date(comments[0]!.at) })
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
        return {
          submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [],
          costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1, ...script(),
        } as unknown as RunReviewResult;
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
  const user = async (login: string, isBot = false): Promise<number> =>
    (await db.insert(schema.users).values({ githubLogin: login, githubNodeId: `U_${login}`, isBot }).returning().execute())[0].id;
  const me = await user('viewer-me');
  const alice = await user('alice-dev');
  const bot = await user('codecov[bot]', true);
  const [repo] = await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'api', githubNodeId: 'R_api' }).returning().execute();
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: 'PR_1', accountId: 1, repoId: repo.id, number: 7, title: 'PR', state: 'open', isDraft: false, openedAt: new Date(T), updatedAt: new Date(T), headSha: HEAD2 })
      .returning()
      .execute()
  )[0].id;

  const r1 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
  await persist.saveReviewSuccess(ctx, r1, {
    scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [],
    findings: [finding('Drops the error', { severity: 'blocker' }), finding('Unchecked input in sendMail')],
  });
  const ids = new Map<string, number>((await persist.getClaudeReviewById(ctx, r1, 1))!.findings.map((f) => [f.title, f.id] as const));
  await persist.markFindingPosted(ctx, ids.get('Drops the error')!, '101');
  await persist.markFindingPosted(ctx, ids.get('Unchecked input in sendMail')!, '102');
  const marker = '\n\n<!-- pierre:claude-review-finding v=1 -->';
  await thread(prId, [
    { authorId: me, at: T, body: `Drops the error.${marker}`, databaseId: '101' },
    { authorId: alice, at: T + HOUR, body: DEFER },
  ]);
  await thread(prId, [
    { authorId: me, at: T, body: `Unchecked input in sendMail.${marker}`, databaseId: '102' },
    { authorId: alice, at: T + HOUR, body: EXPLAIN },
    { authorId: bot, at: T + 2 * HOUR, body: BOT },
    { authorId: me, at: T + 3 * HOUR, body: `${OWN}${marker}` },
  ]);
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

describe('a re-review reads the replies on its own findings', () => {
  it('fences people\'s replies only, gates the blocker deferral, accepts the explanation', async () => {
    script = () => ({
      followUp: [
        { ref: 'P1', status: 'reply_accepted', acceptKind: 'deferred', explanation: 'Deferred.', reply: 'Sure, later.' },
        { ref: 'P2', status: 'reply_accepted', acceptKind: 'not_valid', explanation: 'The form validates.', reply: 'Fair, the form layer validates it.' },
      ],
      findings: [finding('Possible unchecked input in sendMail'), finding('A new problem')],
    });
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    const prompt = lastArgs!.prompt;
    expect(prompt).toContain(DEFER);
    expect(prompt).toContain(EXPLAIN);
    expect(prompt).not.toContain(BOT);
    // Limn's own reply stays in the conversation as context, labelled, its marker stripped.
    expect(prompt).toContain(OWN);
    expect(prompt).toContain('(posted from Limn, an earlier reply on this finding)');
    expect(prompt).not.toContain('pierre:claude-review-finding');
    const byTitle = new Map(r.followUp!.items.map((it) => [it.title, it]));
    const blocker = byTitle.get('Drops the error')!;
    expect(blocker).toMatchObject({ status: 'reply_disputed', deferralRefused: true });
    expect(blocker.threadId).not.toBeNull();
    expect(blocker.threadResolved).toBe(false);
    expect(byTitle.get('Unchecked input in sendMail')).toMatchObject({
      status: 'reply_accepted',
      acceptKind: 'not_valid',
      response: 'Fair, the form layer validates it.',
      reply: { author: 'alice-dev', excerpt: EXPLAIN },
    });
    const titles = r.findings.map((f) => f.title);
    expect(titles).toContain('Drops the error'); // the disputed blocker, raised again
    expect(titles).not.toContain('Possible unchecked input in sendMail'); // repeats the accepted one
    expect(titles).toContain('A new problem');
    const { autoVerdictFor } = await import('./auto-post.js');
    expect(autoVerdictFor('APPROVE', r.findings)).toBe('REQUEST_CHANGES');
  });

  it('the accepted finding is settled from then on; the disputed one is still followed up', async () => {
    const settled = await persist.loadSettledByReplyFindings(ctx, prId, 1, 1_000_000);
    expect(settled.map((s) => [s.title, s.acceptKind])).toEqual([['Unchecked input in sendMail', 'not_valid']]);
    script = () => ({ findings: [finding('Unchecked input in sendMail')] });
    const r = await runToEnd();
    expect(r.followUp!.items.map((it) => it.title)).toEqual(['Drops the error']);
    expect(lastArgs!.prompt).toContain('## Settled in an earlier review');
    expect(lastArgs!.prompt).toContain('(Accepted: the finding did not apply.)');
    expect(r.findings.map((f) => f.title)).not.toContain('Unchecked input in sendMail');
  });
});
