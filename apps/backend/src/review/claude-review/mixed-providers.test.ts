// IN-SITU COMPARISON (docs/CODEX-PLAN.md Phase 4): a Claude review and a Codex review of the SAME PR
// head, over the REAL core client and migrations — no model runs (the rows are written as a run's
// manager writes them).
//   1. A second review of a head another provider already reviewed is allowed, and BOTH runs stay in
//      the PR's history and are each viewable, each labelled by the provider and the model that RAN.
//   2. A queued run is labelled by the provider it will run on (the active one, read at queue time);
//      the run's own stamp (`markReviewRanOn`) wins when it ends.
//   3. Auto review's "one run per head" rule counts a run of EITHER provider (the rule is unchanged).
//   4. "What Claude says now" (`currentThreadAssessmentsForPrs` → the thread cards) folds mixed
//      providers like any two runs — the newer wins — and each judgement keeps its own run's label.
//
// ⚠ DATABASE_URL IS SET BEFORE THE FIRST IMPORT of the host's config/client (a scratch file).
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiRunLabel, type ClaudeThreadAssessment } from '@pierre-review/shared';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-mixed-providers.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_PROVIDER;
delete process.env.OPENAI_API_KEY;

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let persist: typeof import('./persist.js');
let judgements: typeof import('./thread-judgements.js');
let setting: typeof import('../../ai/provider-setting.js');
let prId = 0;
let repoId = 0;
let claudeRun = 0;
let codexRun = 0;

const HEAD = 'c'.repeat(40);

const assessment = (threadId: number, over: Partial<ClaudeThreadAssessment> = {}): ClaudeThreadAssessment => ({
  ref: 'R1',
  threadId,
  sent: true,
  carried: false,
  authorLogin: 'x',
  authorIsBot: false,
  path: 'a.ts',
  line: 1,
  excerpt: 'e',
  commentCount: 1,
  lastCommentAt: null,
  url: null,
  validity: 'valid',
  addressed: 'addressed',
  explanation: 'ok',
  draftReply: null,
  assessedAtHead: HEAD,
  ...over,
});

const succeed = async (id: number, threadAssessments: ClaudeThreadAssessment[], title: string): Promise<void> => {
  await persist.saveReviewSuccess(ctx, id, {
    scope: 'diff_only',
    summary: title,
    verdict: 'COMMENT',
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: 1,
    excludedFiles: [],
    findings: [
      {
        path: 'a.ts',
        line: 1,
        side: 'RIGHT',
        severity: 'warning',
        title,
        body: 'b',
        suggestion: null,
        diffHunk: null,
        anchored: true,
        fileInDiff: true,
      },
    ],
    threadAssessments,
  });
};

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
  } as any as AgentContext;
  persist = await import('./persist.js');
  judgements = await import('./thread-judgements.js');
  setting = await import('../../ai/provider-setting.js');

  repoId = (
    await db
      .insert(schema.repos)
      .values({ accountId: 1, owner: 'acme', name: 'mixed', githubNodeId: 'R_mixed' })
      .returning()
      .execute()
  )[0].id as number;
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_mixed',
        accountId: 1,
        repoId,
        number: 1,
        title: 'mixed',
        state: 'open',
        isDraft: false,
        openedAt: new Date(),
        updatedAt: new Date(),
        headSha: HEAD,
      })
      .returning()
      .execute()
  )[0].id as number;
});

afterAll(async () => {
  setting.setStoredAiProviderSetting(null);
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

describe('a Claude review and a Codex review of the same head', () => {
  it('a queued run is labelled by the provider it will run on; the run stamps what ran', async () => {
    // Claude (auto, no Codex sign-in): the Claude model, as asked.
    claudeRun = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    let row = (await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, claudeRun)).execute())[0];
    expect(row).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' });
    await persist.markReviewRanOn(ctx, claudeRun, { provider: 'claude', model: 'claude-opus-5-5' });
    await succeed(claudeRun, [assessment(1, { addressed: 'not_addressed' }), assessment(2)], 'claude finding');

    // Settings → AI switched to Codex: the next run of the SAME head is allowed and labelled Codex
    // from the queue on — the Codex model of the same depth, never "Opus".
    setting.setStoredAiProviderSetting('codex');
    codexRun = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-opus-5-5', 1);
    row = (await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, codexRun)).execute())[0];
    expect(row).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
    await persist.markReviewRanOn(ctx, codexRun, { provider: 'codex', model: 'gpt-6-astra' });
    await succeed(codexRun, [assessment(1, { addressed: 'addressed' })], 'codex finding');
    setting.setStoredAiProviderSetting(null);
  });

  it('both runs stay in the history and each is viewable, labelled by what ran', async () => {
    const history = await persist.listClaudeReviewHistory(ctx, prId, 1);
    const byId = new Map(history.map((h) => [h.id, h]));
    expect(byId.get(claudeRun)).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', status: 'succeeded' });
    expect(byId.get(codexRun)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', status: 'succeeded' });
    expect(aiRunLabel(byId.get(claudeRun)!.provider, byId.get(claudeRun)!.model)).toBe('Claude Opus 5.5');
    expect(aiRunLabel(byId.get(codexRun)!.provider, byId.get(codexRun)!.model)).toBe('Codex · GPT-6 Astra');

    const claude = await persist.getClaudeReviewById(ctx, claudeRun, 1);
    const codex = await persist.getClaudeReviewById(ctx, codexRun, 1);
    expect(claude?.provider).toBe('claude');
    expect(claude?.findings.map((f) => f.title)).toEqual(['claude finding']);
    expect(codex?.provider).toBe('codex');
    expect(codex?.findings.map((f) => f.title)).toEqual(['codex finding']);
    // The newest is the latest, whichever provider ran it.
    expect((await persist.getLatestClaudeReview(ctx, prId, 1))?.id).toBe(codexRun);
  });

  it("auto review's one-run-per-head rule counts either provider's run (unchanged)", async () => {
    expect(await persist.hasReviewAtHead(ctx, prId, 1, HEAD)).toBe(true);
    expect(await persist.isAutoReReviewSettled(ctx, prId, 1, HEAD, null)).toBe(true);
  });

  it('the thread fold: the newer run wins, and each judgement is labelled by its own run', async () => {
    const now = (await judgements.currentThreadAssessmentsForPrs(ctx, 1, [prId])).get(prId)!;
    // The latest review that judged threads is the Codex one.
    expect(now.reviewId).toBe(codexRun);
    expect(now.assessments.map((a) => [a.threadId, a.addressed])).toEqual([[1, 'addressed']]);
    expect(now.providerByThread.get(1)).toBe('codex');

    // A later Check threads run on CLAUDE overlays thread 1: newer wins, labelled Claude.
    const later = new Date(Date.now() + 60_000);
    await db
      .insert(schema.claudeThreadChecks)
      .values({
        accountId: 1,
        workspaceId: 0,
        prId,
        repoId,
        headSha: HEAD,
        status: 'succeeded',
        model: 'claude-sonnet-5',
        provider: 'claude',
        threadAssessments: [assessment(1, { addressed: 'partly_addressed' })],
        startedAt: later,
        completedAt: later,
      })
      .execute();
    const cards = await judgements.getThreadJudgements(ctx, [prId], 1);
    const j = cards[0]!.judgements.find((x) => x.threadId === 1)!;
    expect(j.addressed).toBe('partly_addressed');
    expect(j.provider).toBe('claude');
  });
});
