// END TO END through the review manager's pipeline, over the REAL core client and migrations (the
// settled-by-reply-pipeline.test.ts precedent), with a fake prepare + a scripted fake model.
//
// 1. A FINDING STILL WAITING TO BE POSTED IS NOT LOST (the 2026-10-27 report, PR 182520): the
//    previous review (same head) had FIVE findings and none was posted. Four were the server's own
//    left-out re-raises of comments already on that commit (included = false, `priorFindingId`
//    set); the fifth was NEW and still included. The next run followed up the four through their
//    posted originals and dropped the fifth silently: not sent, not named, not raised again. Now it
//    is sent (marked "Not posted to GitHub yet"), locked not_addressed on the same head, raised again
//    INCLUDED, and the four left-out re-raises are NAMED on the record (`leftOut`, 'already_posted').
//
// 2. A FROM-SCRATCH RUN (`fresh`) reads no earlier review: no "Previous review" section, no
//    `followUp` record, no carried thread judgement — other reviewers' threads are still shown and
//    judged afresh — and the run is stored as fresh.
//
//   pnpm --filter @pierre-review/backend test follow-up-unposted-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeReview, ClaudeReviewFollowUpRecord, ClaudeThreadAssessment } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';
import type { ReviewThreadForReview } from '../../db/review-threads-for-review.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-follow-up-unposted.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const PATH = 'src/server/controller.js';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,4 @@', '+a', '+b', '+c', '+d'].join('\n');
const T0 = Date.now() - 3600_000;
const THREAD_ID = 9001;
const NEW_TITLE = "Backend validation rejections become a 502 and discard the user's input";

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let lastArgs: RunReviewArgs | null = null;
const threadsByPr = new Map<number, ReviewThreadForReview[]>();

const finding = (title: string, extra: object = {}) => ({
  path: PATH, line: 2, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: true, fileInDiff: true, ...extra,
});

const otherThread: ReviewThreadForReview = {
  threadId: THREAD_ID,
  path: PATH,
  line: 1,
  isOutdated: false,
  derivedState: 'untouched',
  isResolved: false,
  url: null,
  comments: [{ authorLogin: 'alice', authorIsBot: false, createdAt: new Date(T0), body: 'Please rename this.' }],
  commitsAfterFirstComment: 0,
  commitsAfterLastComment: 0,
};

const judgedThread: ClaudeThreadAssessment = {
  ref: 'R1', threadId: THREAD_ID, sent: true, carried: false, authorLogin: 'alice', authorIsBot: false,
  path: PATH, line: 1, resolved: false, excerpt: 'Please rename this.', commentCount: 1,
  lastCommentAt: new Date(T0).toISOString(), url: null, validity: 'valid', addressed: 'not_addressed',
  explanation: 'Still there.', reason: 'Still there.', draftReply: null, assessedAtHead: HEAD,
};

async function newPr(key: string): Promise<number> {
  const repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: key, githubNodeId: `R_${key}` }).returning().execute()
  )[0].id;
  return (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: `PR_${key}`, accountId: 1, repoId, number: 7, title: key, state: 'open', isDraft: false, openedAt: new Date(T0), updatedAt: new Date(T0), headSha: HEAD })
      .returning()
      .execute()
  )[0].id;
}

async function save(rid: number, findings: object[], extra: object = {}): Promise<ClaudeReview> {
  await persist.saveReviewSuccess(ctx, rid, {
    scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [], findings, ...extra,
  } as any);
  return (await persist.getClaudeReviewById(ctx, rid, 1))!;
}

async function runToEnd(prId: number, opts: { fresh?: boolean } = {}): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, 'claude-opus-5-5', 'claude', opts);
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
      // The model finds nothing new and reports nothing: whatever is raised again is the server's.
      runReview: async (args: RunReviewArgs) => {
        lastArgs = args;
        return {
          submitted: true, scope: 'diff_only', summary: 'ok', verdict: 'COMMENT', findings: [],
          costUsd: null, inputTokens: null, outputTokens: null, numTurns: 1,
        } as unknown as RunReviewResult;
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {
      loadReviewThreads: async (_a: number, prId: number) => {
        const threads = threadsByPr.get(prId) ?? [];
        return { threads, newestCommentAt: threads.length ? new Date(T0) : null, ownThreadCount: 0 };
      },
    },
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  await db
    .insert(schema.accounts)
    .values({ id: 1, githubUserId: 'U_viewer-me', githubLogin: 'viewer-me', isLocal: true })
    .onConflictDoUpdate({ target: schema.accounts.id, set: { githubLogin: 'viewer-me' } })
    .execute();
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('a previous review whose five findings are all unposted (one still included), same head', () => {
  it('the included one is sent, raised again INCLUDED; the four left-out re-raises are named', async () => {
    const prId = await newPr('unposted');
    // R0: four findings, all POSTED.
    const r0 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    const titles = ["Edit page loses the 'View baseline' link", 'Back/Cancel ignore returnUrl', 'Dead Created entry', 'No max length on ref'];
    const originals = (await save(r0, titles.map((t, i) => finding(t, i >= 2 ? { severity: 'nit' } : {})))).findings;
    await persist.markReviewPosted(ctx, r0, 'rv0', originals.map((f) => f.id));

    // R1, SAME head: the four re-raised (saved left out — already on this commit) and one NEW.
    const r1 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    const followUp: ClaudeReviewFollowUpRecord = {
      priorReviewId: r0, priorHeadSha: HEAD, headMoved: false, changesSinceShown: false,
      items: originals.map((f, i) => ({
        ref: `P${i + 1}`, priorFindingId: f.id, sent: true, carried: false, status: 'not_addressed' as const,
        explanation: 'The head has not moved.', path: f.path, line: f.line, side: f.side, severity: f.severity,
        title: f.title, headMoved: false, priorPosted: true, statusCarried: true,
      })),
    };
    const second = await save(
      r1,
      [
        ...originals.map((f) => ({ ...finding(f.title, { severity: f.severity }), priorFindingId: f.id, included: false })),
        finding(NEW_TITLE),
      ],
      { followUp },
    );
    // The reported state: NONE posted; included only on the new one.
    expect(second.findings.map((f) => [f.title, f.included, f.postedAt])).toEqual([
      ...titles.map((t) => [t, false, null]),
      [NEW_TITLE, true, null],
    ]);
    const fresh = second.findings.find((f) => f.title === NEW_TITLE)!;

    // R2, SAME head again, a manual run.
    const r = await runToEnd(prId);
    expect(r.status).toBe('succeeded');

    // SENT: the new one (marked as not posted) and the four posted originals, carried.
    const prompt = lastArgs!.prompt;
    expect(prompt).toContain(`Title: ${NEW_TITLE}`);
    expect(prompt).toContain('(Not posted to GitHub yet.)');
    const items = r.followUp!.items;
    expect(items.map((it) => [it.priorFindingId, it.carried, it.priorPosted, it.status]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      ...originals.map((f) => [f.id, true, true, 'not_addressed']),
      [fresh.id, false, false, 'not_addressed'],
    ]);
    // NAMED: every previous finding is either sent or left out with a reason.
    expect(r.followUp!.leftOut?.map((l) => [l.title, l.reason])).toEqual(titles.map((t) => [t, 'already_posted']));
    const accounted = new Set([...items.map((it) => it.priorFindingId), ...(r.followUp!.leftOut ?? []).map((l) => l.priorFindingId)]);
    for (const f of second.findings) {
      expect(accounted.has(f.id) || accounted.has(f.priorFindingId!)).toBe(true);
    }
    expect(r.followUp!.leftOut!.map((l) => l.priorFindingId)).toEqual(
      second.findings.filter((f) => f.title !== NEW_TITLE).map((f) => f.id),
    );

    // RAISED AGAIN: the new one INCLUDED (never posted, so nothing to double-post); the four stay
    // left out (their comments are on this commit).
    const reraise = r.findings.find((f) => f.priorFindingId === fresh.id)!;
    expect(reraise).toBeTruthy();
    expect([reraise.title, reraise.included]).toEqual([NEW_TITLE, true]);
    for (const o of originals) {
      expect(r.findings.find((f) => f.priorFindingId === o.id)?.included).toBe(false);
    }
  });
});

describe('a FROM-SCRATCH run (`fresh`)', () => {
  it('reads no earlier review: no follow-up, no carried thread judgement; stored and listed as fresh', async () => {
    const prId = await newPr('fresh');
    threadsByPr.set(prId, [otherThread]);
    // An earlier review with a POSTED finding and a judgement of the other reviewer's thread.
    const r0 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    const earlier = await save(r0, [finding('Posted earlier')], { threadAssessments: [judgedThread] });
    await persist.markFindingPosted(ctx, earlier.findings[0]!.id, 'c-1', 'inline');

    // An ORDINARY run follows it up and carries the thread judgement (the contrast).
    const ordinary = await runToEnd(prId);
    expect(lastArgs!.prompt).toContain('## Previous review');
    expect(ordinary.followUp?.priorReviewId).toBe(r0);
    expect(ordinary.threadAssessments?.map((t) => [t.threadId, t.carried])).toEqual([[THREAD_ID, true]]);
    expect(ordinary.fresh).toBeUndefined();

    // The FRESH run: as if it were the first run on the PR.
    const r = await runToEnd(prId, { fresh: true });
    expect(r.status).toBe('succeeded');
    expect(r.fresh).toBe(true);
    const prompt = lastArgs!.prompt;
    expect(prompt).not.toContain('## Previous review');
    expect(prompt).not.toContain('PREVIOUS FINDING');
    expect(prompt).not.toContain('## Settled in an earlier review');
    // The other reviewer's thread is still SHOWN, and judged afresh (nothing carried).
    expect(prompt).toContain('Please rename this.');
    expect(r.followUp).toBeNull();
    expect(r.threadAssessments?.map((t) => [t.threadId, t.carried, t.sent])).toEqual([[THREAD_ID, false, true]]);
    expect(r.findings.filter((f) => f.priorFindingId != null)).toEqual([]);

    // The history says so; the ordinary runs do not carry the flag.
    const history = await persist.listClaudeReviewHistory(ctx, prId, 1);
    expect(history.map((h) => [h.id, h.fresh ?? false])).toEqual([
      [r.id, true],
      [ordinary.id, false],
      [r0, false],
    ]);
  });
});
