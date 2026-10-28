// A CLAUDE + CODEX PAIR'S ONE CHAT (chat.ts; docs/CLAUDE-REVIEW.md § Claude + Codex → The chat), over
// the REAL core client and migrations. Pinned:
//   • the chat is keyed to ONE stable id, the pair's FIRST row, whichever half's id it is asked through;
//     a chat stored under the latest half's id before 2026-10-28 is still read;
//   • its context is the CONSOLIDATED view: the merged summary and verdict, both halves' findings each
//     naming who raised it;
//   • it runs on the DEFAULT provider when that half succeeded, else on the half that did;
//   • a per-finding chat works for a finding of either half;
//   • the chat history lists the pair ONCE, under its view id.
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewChatArgs, ReviewChatResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const DB_PATH = '/tmp/pierre-claude-review-pair-chat.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
// The default provider (Settings → AI) is read from here: Claude.
process.env.LIMN_AI_PROVIDER = 'claude';

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let chat: typeof import('./chat.js');
let prId = 0;
let firstId = 0;
let secondId = 0;
let claudeFinding = 0;
let codexFinding = 0;
// A second pair whose CLAUDE half failed.
let failedFirstId = 0;
let okSecondId = 0;

const calls: ReviewChatArgs[] = [];
const answer = (text: string): ReviewChatResult => ({
  ok: true,
  text,
  costUsd: 0.01,
  inputTokens: 10,
  outputTokens: 5,
  numTurns: 1,
  aborted: false,
});

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
    host: {},
    log: { warn: () => {}, info: () => {}, error: () => {} },
    recordAiUsage: async () => {},
    review: {
      prepareReview: async () => ({
        strippedDiff: '',
        promptDiff: 'diff --git a/a.ts b/a.ts',
        changedFiles: ['a.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [],
        diffBytes: 10,
        diffCapped: false,
      }),
      chat: async (a: ReviewChatArgs) => {
        calls.push(a);
        return { ...answer(`Answered on ${a.provider}.`), ranOn: { provider: a.provider, model: a.provider === 'codex' ? 'gpt-6.1-sol' : 'claude-opus-5-5' } } as any;
      },
    },
  } as any as AgentContext;
  chat = await import('./chat.js');

  const { repos, pullRequests, claudeReviews: cr, claudeReviewFindings: crf } = schema;
  const [repo] = await db.insert(repos).values({ accountId: 1, owner: 'acme', name: 'pair-chat', githubNodeId: 'R_pc' }).returning().execute();
  const [pr] = await db
    .insert(pullRequests)
    .values({
      githubNodeId: 'PR_pc',
      accountId: 1,
      repoId: repo.id,
      number: 3,
      title: 'Pair',
      state: 'open',
      isDraft: false,
      openedAt: new Date(),
      updatedAt: new Date(),
      headSha: 'p'.repeat(40),
    })
    .returning()
    .execute();
  prId = pr.id;
  const run = async (over: object) =>
    (
      await db
        .insert(cr)
        .values({
          accountId: 1,
          prId,
          headSha: 'p'.repeat(40),
          status: 'succeeded',
          reviewMode: 'diff_only',
          verdict: 'COMMENT',
          ...over,
        })
        .returning()
        .execute()
    )[0].id as number;
  const finding = async (reviewId: number, title: string) =>
    (
      await db
        .insert(crf)
        .values({ reviewId, path: 'a.ts', line: 1, severity: 'warning', title, body: 'Body' })
        .returning()
        .execute()
    )[0].id as number;

  firstId = await run({ model: 'claude-opus-5-5', provider: 'claude', summary: 'Claude says.', pairRole: 'first' });
  await db.update(cr).set({ pairId: firstId }).where((await import('drizzle-orm')).eq(cr.id, firstId)).execute();
  secondId = await run({ model: 'gpt-6.1-sol', provider: 'codex', summary: 'Codex says.', pairRole: 'second', pairId: firstId });
  claudeFinding = await finding(firstId, 'Claude found this');
  codexFinding = await finding(secondId, 'Codex found that');
  await db
    .update(cr)
    .set({
      pairConsolidation: {
        how: 'pass',
        summary: 'Both agree: one merged summary.',
        verdict: 'REQUEST_CHANGES',
        sourceOf: { [String(claudeFinding)]: 'claude', [String(codexFinding)]: 'both' },
        mergedFrom: {},
        failedHalf: null,
        at: new Date().toISOString(),
      },
    })
    .where((await import('drizzle-orm')).eq(cr.id, firstId))
    .execute();

  failedFirstId = await run({ model: 'claude-opus-5-5', provider: 'claude', status: 'failed', summary: null, verdict: null, pairRole: 'first' });
  await db.update(cr).set({ pairId: failedFirstId }).where((await import('drizzle-orm')).eq(cr.id, failedFirstId)).execute();
  okSecondId = await run({ model: 'gpt-6.1-sol', provider: 'codex', summary: 'Only Codex.', pairRole: 'second', pairId: failedFirstId });
  await finding(okSecondId, 'Codex alone');
});

afterAll(() => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

beforeEach(() => {
  calls.length = 0;
});

describe("a pair's one chat", () => {
  it('is stored under the FIRST row id, whichever half it is asked through, and reads as one thread', async () => {
    const a = await chat.answerReviewChat(ctx, 1, secondId, { question: 'What matters most?' });
    expect(a.ok).toBe(true);
    const b = await chat.answerReviewChat(ctx, 1, firstId, { question: 'And then?' });
    expect(b.ok).toBe(true);
    const stored = await db.select().from(schema.claudeReviewChatMessages).execute();
    expect(new Set(stored.map((m: any) => m.reviewId))).toEqual(new Set([firstId]));
    // The second question's prompt carries the first turn: one thread.
    expect(calls[1]!.prompt).toContain('Developer: What matters most?');
    const viaSecond = await chat.listChatMessages(ctx, 1, chat.chatThreadIds({ id: secondId, pair: { pairId: firstId, role: 'second', otherReviewId: firstId, halves: [] } as any }), null);
    expect(viaSecond).toHaveLength(4);
  });

  it("still reads a chat stored under the latest half's id (before 2026-10-28)", async () => {
    await db
      .insert(schema.claudeReviewChatMessages)
      .values([
        { accountId: 1, reviewId: secondId, findingId: null, role: 'user', content: 'An old question', createdAt: new Date(0) },
        { accountId: 1, reviewId: secondId, findingId: null, role: 'assistant', content: 'An old answer', createdAt: new Date(0) },
      ])
      .execute();
    await chat.answerReviewChat(ctx, 1, secondId, { question: 'A new one' });
    expect(calls[0]!.prompt).toContain('An old question');
  });

  it('asks about the CONSOLIDATED review: merged summary and verdict, each finding naming who raised it', async () => {
    await chat.answerReviewChat(ctx, 1, secondId, { question: 'Explain.' });
    const p = calls[0]!.prompt;
    expect(p).toContain('This is one review by Claude and Codex together');
    expect(p).toContain('Verdict: REQUEST_CHANGES');
    expect(p).toContain('Both agree: one merged summary.');
    expect(p).toContain('Title: Claude found this');
    expect(p).toContain('Title: Codex found that');
    expect(p).toContain('Raised by: Claude\n');
    expect(p).toContain('Raised by: Claude + Codex');
  });

  it('runs on the DEFAULT provider when its half succeeded, else on the half that did; answers name it', async () => {
    const ok = await chat.answerReviewChat(ctx, 1, secondId, { question: 'Who answers?' });
    expect(calls[0]!.provider).toBe('claude');
    if (ok.ok) expect(ok.answer.messages[1]).toMatchObject({ provider: 'claude' });
    const solo = await chat.answerReviewChat(ctx, 1, okSecondId, { question: 'Who answers now?' });
    expect(calls[1]!.provider).toBe('codex');
    if (solo.ok) expect(solo.answer.messages[1]).toMatchObject({ provider: 'codex' });
    // The pure rule.
    const pair = (statuses: Array<['claude' | 'codex', string]>) =>
      ({ provider: 'codex', model: 'gpt-6.1-sol', pair: { halves: statuses.map(([provider, status]) => ({ provider, status })) } }) as any;
    expect(chat.chatPreferredProvider(pair([['claude', 'succeeded'], ['codex', 'succeeded']]), () => 'codex')).toBe('codex');
    expect(chat.chatPreferredProvider(pair([['claude', 'succeeded'], ['codex', 'succeeded']]), () => 'claude')).toBe('claude');
    expect(chat.chatPreferredProvider(pair([['claude', 'succeeded'], ['codex', 'failed']]), () => 'codex')).toBe('claude');
    expect(chat.chatPreferredProvider({ provider: 'codex', model: 'gpt-6.1-sol', pair: null } as any, () => 'claude')).toBe('codex');
  });

  it("a per-finding chat works for a finding of EITHER half", async () => {
    const c = await chat.answerReviewChat(ctx, 1, secondId, { question: 'Why?', findingId: claudeFinding });
    const x = await chat.answerReviewChat(ctx, 1, secondId, { question: 'Why?', findingId: codexFinding });
    expect(c.ok && x.ok).toBe(true);
    expect(calls[0]!.prompt).toContain('This conversation is about finding');
    const thread = await chat.listChatMessages(ctx, 1, [firstId, secondId], claudeFinding);
    expect(thread).toHaveLength(2);
  });

  it("the chat history lists the pair ONCE, under its view id (the latest half)", async () => {
    const h = await chat.listChatHistoryForPr(ctx, 1, prId);
    const ids = h!.runs.map((r) => r.reviewId);
    expect(ids).toContain(secondId);
    expect(ids).not.toContain(firstId);
    expect(ids.filter((i) => i === secondId)).toHaveLength(1);
  });
});
