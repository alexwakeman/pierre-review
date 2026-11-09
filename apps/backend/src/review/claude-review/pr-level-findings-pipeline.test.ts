// PR-LEVEL FINDINGS — a Limn finding posted as a PR COMMENT (it could not be placed on a line) gets
// the same lifecycle as an inline thread. End to end over the REAL core client and migrations, with a
// fake prepare, a scripted fake model and a fake GitHub (finding-replies-pipeline.test.ts's precedent).
//
// THE 221266 SHAPE: an earlier Codex-style review posted two findings as PR comments (a BLOCKER and a
// WARNING). The author answered BOTH in ONE later PR comment that neither links nor quotes them. A
// review bot and a Limn PR comment sit in the conversation too (never replies).
//   • the follow-up prompt lists that comment ONCE (C1) and names it under both findings;
//   • a reply status stands only with a cited ref of that finding (the gate);
//   • the sweeper sees the person's PR comment as a reply on Limn's own finding;
//   • "Still open:" is ONE PR comment per finding, ever; a close is an acknowledgement + the hide.
//
//   pnpm --filter @pierre-review/backend test pr-level-findings-pipeline
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeReview } from '@pierre-review/shared';
import type { RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = `${process.env.LIMN_TEST_RUN_DIR ?? '/tmp'}/pierre-claude-review-pr-level-findings.sqlite`;
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;

const HEAD = 'a'.repeat(40);
const HEAD2 = 'b'.repeat(40);
const PATH = 'src/forms.ts';
const DIFF = [`diff --git a/${PATH} b/${PATH}`, `--- a/${PATH}`, `+++ b/${PATH}`, '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n');
const HOUR = 3600_000;
const T = Date.now() - 10 * HOUR;
const ANSWER =
  'On the form saves cutting an untouched over-long value: not changing this, the legacy route is being decommissioned. And the parent link is parent_uuid, so the geometry check does not apply.';
const BOT = 'Coverage went down by 0.1%.';
const MARK = '\n\n<!-- pierre:claude-review-finding v=1 -->';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let prId = 0;
let me = 0;
let alex = 0;
let lastArgs: RunReviewArgs | null = null;
let script: () => Partial<RunReviewResult> = () => ({});
let node = 1;
const ids = new Map<string, number>();

const finding = (title: string, extra: object = {}) => ({
  path: PATH, line: null, side: 'RIGHT' as const, severity: 'warning' as const, title, body: `${title}.`,
  suggestion: null, diffHunk: null, anchored: false, fileInDiff: false, ...extra,
});

async function prComment(authorId: number, at: number, body: string, databaseId: string, limnPostedByUserId: number | null = null): Promise<void> {
  await db
    .insert(schema.prComments)
    .values({ githubNodeId: `IC_${node++}`, prId, authorId, body, databaseId, createdAt: new Date(at), limnPostedByUserId })
    .execute();
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
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF, promptDiff: DIFF, changedFiles: [PATH], excludedFiles: [], omittedFiles: [],
        fileMetrics: [{ path: PATH, additions: 2, deletions: 0, isNew: true, apiTouch: false }],
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
  me = await user('viewer-me');
  alex = await user('alexwakeman');
  const bot = await user('codecov[bot]', true);
  const [repo] = await db.insert(schema.repos).values({ accountId: 1, owner: 'DEFRA', name: 'bng-metric-template', githubNodeId: 'R_bng' }).returning().execute();
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({ githubNodeId: 'PR_12', accountId: 1, repoId: repo.id, number: 12, title: 'Forms', state: 'open', isDraft: false, openedAt: new Date(T), updatedAt: new Date(T), headSha: HEAD2 })
      .returning()
      .execute()
  )[0].id;

  const r1 = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
  await persist.saveReviewSuccess(ctx, r1, {
    scope: 'diff_only', summary: 's', verdict: 'COMMENT', costUsd: null, inputTokens: null, outputTokens: null,
    numTurns: 1, excludedFiles: [],
    findings: [
      finding('Form saves cut an untouched over-long value', { severity: 'blocker' }),
      finding('Geometry check misses the parent link'),
    ],
  });
  for (const f of (await persist.getClaudeReviewById(ctx, r1, 1))!.findings) ids.set(f.title, f.id);
  await persist.markFindingPosted(ctx, ids.get('Form saves cut an untouched over-long value')!, '6739728311', 'pr_comment');
  await persist.markFindingPosted(ctx, ids.get('Geometry check misses the parent link')!, '6739728312', 'pr_comment');
  // The finding comments as synced (stored under the reader's `limn:` bot, the person kept beside it).
  await prComment(me, T, `**Blocker** Form saves cut an untouched over-long value.${MARK}`, '6739728311', me);
  await prComment(me, T + 1, `**Warning** Geometry check misses the parent link.${MARK}`, '6739728312', me);
  // ONE person's comment answering BOTH (no link, no quote), a bot, and an unrelated Limn comment.
  await prComment(alex, T + HOUR, ANSWER, '6741829467');
  await prComment(bot, T + 2 * HOUR, BOT, '6741829999');
  await prComment(me, T + 3 * HOUR, `Story check: all criteria met.\n\n<!-- pierre:claude-review-story v=1 -->`, '6741830000', me);
});

afterAll(async () => {
  const { _setPrLevelDepsForTest } = await import('./pr-level-writes.js');
  _setPrLevelDepsForTest(null);
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

// The first run's review, which the writes below act on.
let review: ClaudeReview;

describe('a PR-level finding is followed up against the PR conversation', () => {
  it('lists the one answering comment ONCE (C1) and names it under both findings; never the bot or Limn', async () => {
    script = () => ({
      followUp: [
        // The blocker: the reply is judged, citing C1 — and a deferral of a blocker is refused.
        { ref: 'P1', status: 'reply_accepted', acceptKind: 'deferred', explanation: 'Deferred.', reply: 'Fine, later.', replyRef: 'C1' },
        // The warning: accepted as not valid, citing C1.
        { ref: 'P2', status: 'reply_accepted', acceptKind: 'not_valid', explanation: 'parent_uuid is the link.', reply: 'Fair, the link is parent_uuid.', replyRef: 'c1' },
      ],
    });
    review = await runToEnd();
    expect(review.status).toBe('succeeded');
    const prompt = lastArgs!.prompt;
    expect(prompt.split(ANSWER).length - 1).toBe(1); // sent once, shared
    expect(prompt).toContain('PR CONVERSATION');
    expect(prompt).toContain('C1 @alexwakeman:');
    expect(prompt.match(/PR conversation since then: C1\./g)?.length).toBe(2);
    expect(prompt).not.toContain(BOT);
    expect(prompt).not.toContain('Story check');
    expect(prompt).toContain('set `replyRef`');
  });

  it('records each item with its PR comment, the cited reply and its link', () => {
    const byTitle = new Map(review.followUp!.items.map((it) => [it.title, it]));
    const blocker = byTitle.get('Form saves cut an untouched over-long value')!;
    expect(blocker).toMatchObject({ status: 'reply_disputed', deferralRefused: true, replyRef: 'C1' });
    expect(blocker.threadId ?? null).toBeNull();
    expect(blocker.prComment).toEqual({
      findingId: ids.get('Form saves cut an untouched over-long value'),
      commentId: '6739728311',
      url: 'https://github.com/DEFRA/bng-metric-template/pull/12#issuecomment-6739728311',
    });
    expect(blocker.reply).toMatchObject({
      author: 'alexwakeman',
      url: 'https://github.com/DEFRA/bng-metric-template/pull/12#issuecomment-6741829467',
    });
    expect(byTitle.get('Geometry check misses the parent link')).toMatchObject({
      status: 'reply_accepted',
      acceptKind: 'not_valid',
      replyRef: 'C1',
      response: 'Fair, the link is parent_uuid.',
    });
  });

  it('the sweeper sees the person\'s PR comment as a reply on Limn\'s own finding (never the bot\'s, never Limn\'s)', async () => {
    const { newestPrLevelReplyTimes } = await import('../../db/review-threads-for-review.js');
    const { foldPrLevelReply } = await import('../../db/queries.js');
    const times = await newestPrLevelReplyTimes(1, [prId], new Date(0));
    const at = new Date(Math.floor((T + HOUR) / 1000) * 1000); // stored in whole seconds
    expect(times.get(prId)).toEqual(at);
    expect(foldPrLevelReply(undefined, times.get(prId))).toEqual({ newest: at, newestOwn: at, newestOther: null });
    // Folded into a thread burst: it is the newest OWN reply, never a Check threads input.
    const older = new Date(T);
    expect(foldPrLevelReply({ newest: older, newestOwn: null, newestOther: older }, at)).toEqual({ newest: at, newestOwn: at, newestOther: older });
    // Only after the finding: nothing newer than the window.
    expect((await newestPrLevelReplyTimes(1, [prId], new Date(T + HOUR))).has(prId)).toBe(false);
  });

  it('a NEW comment is planned for a replies pass, and the pass gate needs a cited ref', async () => {
    await prComment(alex, Date.now() + 1_000, 'Also: the over-long value is trimmed by the API anyway.', '6741900000');
    const rc = await import('./replies-check.js');
    const planned = await rc.planRepliesCheck(ctx, 1, prId);
    if ('refused' in planned) throw new Error(`refused: ${planned.refused}`);
    const blockerId = ids.get('Form saves cut an untouched over-long value')!;
    const f = planned.findings.find((x) => x.id === blockerId)!;
    expect(f.conversation?.replies.map((r) => r.body)).toContain('Also: the over-long value is trimmed by the API anyway.');
    const { planRepliesPass, reconcileReplies } = await import('./replies-pass.js');
    const plan = planRepliesPass([f], HEAD2);
    const newRef = f.conversation!.replies.find((r) => r.body.startsWith('Also:'))!.ref;
    // No ref ⇒ not checked; a ref of the finding ⇒ judged.
    expect(reconcileReplies(plan, [{ ref: 'T1', status: 'reply_disputed', reply: 'Still cut.' }])[0]!.status).toBe('not_checked');
    expect(reconcileReplies(plan, [{ ref: 'T1', status: 'reply_disputed', reply: 'Still cut.', replyRef: 'C99' }])[0]!.status).toBe('not_checked');
    expect(reconcileReplies(plan, [{ ref: 'T1', status: 'reply_disputed', reply: 'Still cut.', replyRef: newRef }])[0]).toMatchObject({
      status: 'reply_disputed',
      replyRef: newRef,
      prComment: { commentId: '6739728311' },
    });
  });
});

describe('the GitHub writes for a PR-level finding', () => {
  const comments: Array<{ prNumber: number; body: string; how: string }> = [];
  const hidden: Array<{ commentId: string; nodeId: string | null }> = [];

  beforeAll(async () => {
    const { _setPrLevelDepsForTest } = await import('./pr-level-writes.js');
    _setPrLevelDepsForTest({
      comment: async (_a, pr, body, how) => {
        comments.push({ prNumber: pr.number, body, how });
        return { commentId: String(7_000 + comments.length) };
      },
      minimize: async (_a, _pr, finding) => {
        hidden.push(finding);
      },
    });
  });

  it('"Post reply" on the disputed blocker: ONE "Still open:" PR comment linking the finding — ever', async () => {
    const { postFollowUpReply } = await import('./manual-reply.js');
    const first = await postFollowUpReply(ctx, { accountId: 1, reviewId: review.id, priorFindingId: ids.get('Form saves cut an untouched over-long value')! });
    expect(first).toMatchObject({ kind: 'done', result: { status: 'posted' } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.how).toBe('reader_pressed');
    expect(comments[0]!.body).toMatch(/^\*\*Still open:\*\* /);
    expect(comments[0]!.body).toContain('([the finding](https://github.com/DEFRA/bng-metric-template/pull/12#issuecomment-6739728311))');
    expect(comments[0]!.body).toContain('<!-- pierre:claude-review-followup on=6739728311 act=still_open -->');
    const again = await postFollowUpReply(ctx, { accountId: 1, reviewId: review.id, priorFindingId: ids.get('Form saves cut an untouched over-long value')! });
    expect(again).toMatchObject({ kind: 'conflict', code: 'AlreadyPosted' });
    // An automatic run says nothing more either: the owner's record holds it.
    const { postPrLevelStillOpen } = await import('./pr-level-writes.js');
    const { loadPrLevelOwners } = await import('./finding-replies.js');
    const owner = (await loadPrLevelOwners(ctx, 1, prId, [ids.get('Form saves cut an untouched over-long value')!], { ownOnly: true })).values().next().value!;
    expect(await postPrLevelStillOpen(ctx, { accountId: 1, prId, reviewId: review.id, owner, footer: '', how: 'auto', reason: 'x' })).toMatchObject({ kind: 'skipped' });
    expect(comments).toHaveLength(1);
  });

  it('a marker already on the PR (a teammate\'s Limn, a lost record) blocks the still-open comment too', async () => {
    const { postPrLevelStillOpen } = await import('./pr-level-writes.js');
    const { loadPrLevelOwners } = await import('./finding-replies.js');
    const warnId = ids.get('Geometry check misses the parent link')!;
    await prComment(alex, T + 4 * HOUR, 'Robin’s Limn: still open.\n\n<!-- pierre:claude-review-followup on=6739728312 act=still_open -->', '6741830500', alex);
    const owner = (await loadPrLevelOwners(ctx, 1, prId, [warnId], { ownOnly: true })).get(warnId)!;
    expect(await postPrLevelStillOpen(ctx, { accountId: 1, prId, reviewId: review.id, owner, footer: '', how: 'auto', reason: 'x' })).toEqual({ kind: 'skipped', why: 'already' });
  });

  it('"Post reply" on the accepted warning: the acknowledgement, then the finding comment is hidden as resolved', async () => {
    const { postFollowUpReply } = await import('./manual-reply.js');
    const warnId = ids.get('Geometry check misses the parent link')!;
    const out = await postFollowUpReply(ctx, { accountId: 1, reviewId: review.id, priorFindingId: warnId });
    expect(out).toMatchObject({ kind: 'done', result: { status: 'resolved' } });
    const ack = comments[comments.length - 1]!.body;
    expect(ack).toMatch(/^Fair, the link is parent_uuid\. \(\[the finding\]/);
    expect(ack).toContain('act=ack');
    expect(hidden).toEqual([{ commentId: '6739728312', nodeId: 'IC_2' }]);
    // The wire item now says so (derived on read from the owner's record).
    const view = await persist.getClaudeReviewById(ctx, review.id, 1);
    const item = view!.followUp!.items.find((it) => it.priorFindingId === warnId)!;
    expect(item.autoResolve).toMatchObject({ status: 'resolved', minimized: true, manual: true });
    const { markPrLevelResolved } = await import('./manual-reply.js');
    expect(await markPrLevelResolved(ctx, { accountId: 1, reviewId: review.id, priorFindingId: warnId })).toMatchObject({ kind: 'conflict' });
  });
});
