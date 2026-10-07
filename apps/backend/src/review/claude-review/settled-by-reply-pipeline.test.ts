// A RESOLVED THREAD WITH A REPLY IS JUDGED, NOT SETTLED ON SIGHT — end to end through the review
// manager's pipeline, over the REAL core client and migrations (no-stories-pipeline.test.ts's
// precedent), with a fake prepare + a scripted fake model.
//
// Two earlier reviews (same head). R1 posted LEGACY; R2 posted BLOCKER and NO REPLY. R2's follow-up
// record says nothing about LEGACY — what the RETIRED settle-on-sight rule left behind. On GitHub:
//   • BLOCKER "Unchecked input in sendMail" — alice replied, then alice resolved the thread. It is
//     SENT to the model with the replies and "resolved on GitHub by @alice-dev", AFTER the open one;
//     the model disputes it ⇒ stays open, raised again, REQUEST_CHANGES, no pushback recorded;
//   • NO REPLY "Missing await on save" — resolved with no reply ⇒ followed up on the code, as before;
//   • LEGACY "Leaks the file handle" — bob replied and the thread was resolved, and the old rule took
//     it out of the chain without judging it ⇒ loaded again as a CARRIED item and judged; accepted ⇒
//     settled from then on: out of the next follow-up, fenced as settled in the prompt, a repeat
//     dropped, and listed on the read as `settledEarlier` (bob + excerpt + how it was accepted).
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
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const HOUR = 3600_000;
const T = Date.now() - 10 * HOUR;
const REPLY_TEXT = 'Intentional: sendMail is only called with validated input from the form layer.';
const LEGACY_REPLY = 'The handle is closed by the pool on release.';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let foreignPrId = 0;
let lastArgs: RunReviewArgs | null = null;
let script: () => Partial<RunReviewResult> = () => ({});
let node = 1;
const ids = new Map<string, number>();

const finding = (title: string, extra: object = {}) => ({
  path: PATH, line: 2, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, ...extra,
});

const reply = (): RunReviewResult =>
  ({
    submitted: true,
    scope: 'diff_only',
    summary: 'ok',
    verdict: 'APPROVE',
    findings: [],
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    ...script(),
  }) as unknown as RunReviewResult;

async function thread(
  pr: number,
  comments: Array<{ authorId: number; at: number; body: string; databaseId?: string }>,
  resolvedByLogin: string | null = null,
): Promise<void> {
  const [t] = await db
    .insert(schema.reviewThreads)
    .values({ githubNodeId: `RT_${node++}`, prId: pr, path: PATH, line: 2, isResolved: true, derivedState: 'resolved', resolvedByLogin, createdAt: new Date(comments[0]!.at) })
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
  const bob = await user('bob-dev');
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

  const save = async (rid: number, findings: object[], followUp: object | null = null): Promise<void> => {
    await persist.saveReviewSuccess(ctx, rid, {
      scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
      numTurns: 1, excludedFiles: [], findings, followUp,
    } as any);
    for (const f of (await persist.getClaudeReviewById(ctx, rid, 1))!.findings) ids.set(f.title, f.id);
  };
  // R1: LEGACY, posted.
  const r1 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
  await save(r1, [finding('Leaks the file handle')]);
  await persist.markFindingPosted(ctx, ids.get('Leaks the file handle')!, '103');
  // R2: its follow-up of R1 says nothing about LEGACY (the retired rule settled it on sight).
  const r2 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
  await save(r2, [finding('Unchecked input in sendMail', { severity: 'blocker' }), finding('Missing await on save')], {
    priorReviewId: r1, priorHeadSha: HEAD, headMoved: false, changesSinceShown: false, items: [],
  });
  await persist.markFindingPosted(ctx, ids.get('Unchecked input in sendMail')!, '101');
  // Post review stores no per-comment id: matched by its body.
  await db.update(schema.claudeReviewFindings).set({ postedAt: new Date(T), postedCommentKind: 'inline' }).where(eq(schema.claudeReviewFindings.id, ids.get('Missing await on save')!)).execute();

  const marker = '\n\n<!-- pierre:claude-review-finding v=1 -->';
  await thread(prId, [
    { authorId: me, at: T, body: `Unchecked input in sendMail.${marker}`, databaseId: '101' },
    { authorId: alice, at: T + HOUR, body: REPLY_TEXT },
  ], 'alice-dev');
  await thread(prId, [{ authorId: me, at: T, body: `Missing await on save.${marker}`, databaseId: '102' }], 'viewer-me');
  await thread(prId, [
    { authorId: me, at: T, body: `Leaks the file handle.${marker}`, databaseId: '103' },
    { authorId: bob, at: T + HOUR, body: LEGACY_REPLY },
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

describe('a resolved thread with a reply goes through the reply judgement', () => {
  it('nothing is settled on sight any more — account-scoped loader', async () => {
    expect(await persist.loadSettledByReplyFindings(ctx, prId, 1, 1_000_000)).toEqual([]);
    expect(await persist.loadSettledByReplyFindings(ctx, prId, 2, 1_000_000)).toEqual([]);
  });

  it('sends it (after the open one, with who resolved it); disputed stays open and counts; legacy is judged', async () => {
    script = () => ({
      followUp: [
        { ref: 'P1', status: 'not_addressed', explanation: 'Still not awaited.' },
        { ref: 'P2', status: 'reply_disputed', explanation: 'Not validated.', reply: 'The form layer does not cover the API path.' },
        { ref: 'P3', status: 'reply_accepted', acceptKind: 'not_valid', explanation: 'Pool closes it.', reply: 'Fair, the pool closes it.' },
      ] as any,
      findings: [finding('A new problem')],
    });
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    const prompt = lastArgs!.prompt;
    // The open (no-reply) finding first; the resolved-with-reply ones after it, own then carried.
    const p1 = prompt.slice(prompt.indexOf('PREVIOUS FINDING P1'), prompt.indexOf('PREVIOUS FINDING P2'));
    expect(p1).toContain('Title: Missing await on save');
    expect(p1).not.toContain('Replies on GitHub');
    const p2 = prompt.slice(prompt.indexOf('PREVIOUS FINDING P2'), prompt.indexOf('PREVIOUS FINDING P3'));
    expect(p2).toContain('Title: Unchecked input in sendMail');
    expect(p2).toContain(REPLY_TEXT);
    expect(p2).toContain('(The thread was resolved on GitHub by @alice-dev.)');
    const p3 = prompt.slice(prompt.indexOf('PREVIOUS FINDING P3'));
    expect(p3).toContain('Title: Leaks the file handle');
    expect(p3).toContain(LEGACY_REPLY);
    expect(p3).toContain('(The thread was resolved on GitHub.)');
    expect(prompt).not.toContain('## Settled in an earlier review');

    const byTitle = new Map(r.followUp!.items.map((it) => [it.title, it]));
    expect(byTitle.get('Missing await on save')).toMatchObject({ status: 'not_addressed' });
    const disputed = byTitle.get('Unchecked input in sendMail')!;
    expect(disputed).toMatchObject({ status: 'reply_disputed', threadResolved: true, reply: { author: 'alice-dev', excerpt: REPLY_TEXT } });
    expect(disputed.pushback ?? null).toBeNull(); // nothing posted by itself
    expect(byTitle.get('Leaks the file handle')).toMatchObject({ status: 'reply_accepted', acceptKind: 'not_valid', carried: true });

    // Disputed is OPEN: raised again (left out — already on this commit — but still counted).
    const reraise = r.findings.find((f) => f.title === 'Unchecked input in sendMail')!;
    expect(reraise.priorFindingId).toBe(ids.get('Unchecked input in sendMail'));
    expect(reraise.severity).toBe('blocker');
    const { autoVerdictFor } = await import('./auto-post.js');
    expect(autoVerdictFor('APPROVE', r.findings)).toBe('REQUEST_CHANGES');
    expect(r.findings.map((f) => f.title)).not.toContain('Leaks the file handle');
    // The accepting run lists it itself, so nothing is "settled earlier" here.
    expect(r.settledEarlier ?? []).toEqual([]);
  });

  it('accepted ⇒ settled from then on: out of the follow-up, fenced, repeat dropped, shown as settled earlier', async () => {
    const settled = await persist.loadSettledByReplyFindings(ctx, prId, 1, 1_000_000);
    expect(settled.map((s) => [s.title, s.replyAuthor, s.acceptKind])).toEqual([['Leaks the file handle', 'bob-dev', 'not_valid']]);
    expect(await persist.loadSettledByReplyFindings(ctx, prId, 2, 1_000_000)).toEqual([]);
    expect(await persist.loadSettledByReplyFindings(ctx, foreignPrId, 1, 1_000_000)).toEqual([]);

    script = () => ({ findings: [finding('Possibly leaks the file handle'), finding('Another new problem')] });
    const r = await runToEnd();
    expect(r.status).toBe('succeeded');
    const titles = r.followUp!.items.map((it) => it.title).sort();
    expect(titles).toEqual(['Missing await on save', 'Unchecked input in sendMail']);
    expect(lastArgs!.prompt).toContain('## Settled in an earlier review');
    expect(lastArgs!.prompt).toContain(LEGACY_REPLY);
    expect(r.findings.map((f) => f.title)).not.toContain('Possibly leaks the file handle');
    expect(r.findings.map((f) => f.title)).toContain('Another new problem');
    // The disputed one is still open (carried), and still counted.
    const { autoVerdictFor } = await import('./auto-post.js');
    expect(autoVerdictFor('APPROVE', r.findings)).toBe('REQUEST_CHANGES');
    // The read path names what was dismissed, by whom, and how.
    expect(r.settledEarlier).toEqual([
      expect.objectContaining({
        priorFindingId: ids.get('Leaks the file handle'),
        title: 'Leaks the file handle',
        acceptKind: 'not_valid',
        reply: { author: 'bob-dev', excerpt: LEGACY_REPLY },
        severity: 'warning',
      }),
    ]);
    // Another account reading the same id sees nothing.
    expect(await persist.getClaudeReviewById(ctx, r.id, 2)).toBeNull();
  });
});
