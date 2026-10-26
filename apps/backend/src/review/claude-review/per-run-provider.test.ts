// THE PER-RUN PROVIDER, end to end through the review manager's pipeline and the review chat, over the
// REAL core client and migrations, with a fake prepare and a fake model (no model runs).
// docs/CODEX-PLAN.md § 6 (revised 2026-10-26): a MANUAL run goes to the provider its picker named,
// whatever the default (Settings → AI); everything provider-dependent follows the RUN's provider:
//   1. the run itself (`RunReviewArgs.provider`), the queued row's label and the stamped `ranOn`;
//   2. the follow-up chain: a run reads only its OWN provider's earlier review as "Previous review";
//   3. the history lists EVERY run (both providers), each with its finding count;
//   4. the review chat answers on its review's provider while that one is signed in, else the default.
//
//   pnpm --filter @pierre-review/backend test per-run-provider
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ClaudeReview } from '@pierre-review/shared';
import type { ReviewChatArgs, ReviewChatResult, RunReviewArgs, RunReviewResult } from '../../platform/contract.js';
import type { AgentContext } from '../agent-context.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DB_PATH = '/tmp/pierre-claude-review-per-run-provider.sqlite';
process.env.DATABASE_URL = DB_PATH;
process.env.DISABLE_SCHEDULER = 'true';
delete process.env.LIMN_AI_DISABLED;
// THE DEFAULT is Claude here; the runs below pick their own.
process.env.LIMN_AI_PROVIDER = 'claude';

const HEAD = 'f'.repeat(40);
const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -0,0 +1,2 @@', '+a', '+b'].join('\n');

let db: any;
let schema: any;
let closeDb: (() => void) | undefined;
let ctx: AgentContext;
let manager: typeof import('./manager.js');
let persist: typeof import('./persist.js');
let chat: typeof import('./chat.js');
let prId = 0;
const runArgs: RunReviewArgs[] = [];
const chatArgs: ReviewChatArgs[] = [];
// Which providers the fake pre-flight calls signed in.
const signedIn = { claude: true, codex: true };

const CODEX_MODEL: Record<string, string> = { 'claude-opus-5-5': 'gpt-6.1-sol', 'claude-sonnet-5': 'gpt-6.1-terra' };

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
    llm: {
      detectAuth: () => ({ status: 'ok' }),
      detectProviderAuth: (p: 'claude' | 'codex') => (signedIn[p] ? { status: 'ok' } : { status: 'none', message: 'no' }),
    },
    review: {
      prepareReview: async () => ({
        strippedDiff: DIFF,
        promptDiff: DIFF,
        changedFiles: ['src/a.ts'],
        excludedFiles: [],
        omittedFiles: [],
        fileMetrics: [{ path: 'src/a.ts', additions: 2, deletions: 0, isNew: true, apiTouch: false }],
        diffBytes: DIFF.length,
        diffCapped: false,
      }),
      // The fake model: one finding titled by the provider that ran it; `ranOn` as a provider stamps it.
      runReview: async (args: RunReviewArgs): Promise<RunReviewResult> => {
        runArgs.push(args);
        const provider = args.provider ?? 'claude';
        return {
          submitted: true,
          ranOn: { provider, model: provider === 'codex' ? CODEX_MODEL[args.model]! : args.model },
          scope: 'diff_only',
          summary: 'ok',
          verdict: 'COMMENT',
          findings: [
            {
              path: 'src/a.ts', line: 1, side: 'RIGHT', severity: 'warning', title: `${provider} finding ${runArgs.length}`,
              body: 'b', suggestion: null, diffHunk: null, anchored: true, fileInDiff: true,
            },
          ],
          costUsd: null,
          inputTokens: null,
          outputTokens: null,
          numTurns: 1,
          aborted: false,
        } as unknown as RunReviewResult;
      },
      chat: async (args: ReviewChatArgs): Promise<ReviewChatResult> => {
        chatArgs.push(args);
        const provider = args.provider ?? 'claude';
        return {
          ok: true,
          ranOn: { provider, model: provider === 'codex' ? CODEX_MODEL[args.model]! : args.model },
          text: 'an answer',
          costUsd: null,
          inputTokens: 1,
          outputTokens: 1,
          numTurns: 1,
          aborted: false,
        };
      },
    },
    github: { fetchCompareDiff: async () => ({ ok: false }) },
    queries: {},
  } as any as AgentContext;
  manager = await import('./manager.js');
  persist = await import('./persist.js');
  chat = await import('./chat.js');

  const repoId = (
    await db.insert(schema.repos).values({ accountId: 1, owner: 'acme', name: 'per-run', githubNodeId: 'R_per_run' }).returning().execute()
  )[0].id as number;
  prId = (
    await db
      .insert(schema.pullRequests)
      .values({
        githubNodeId: 'PR_per_run', accountId: 1, repoId, number: 3, title: 'per run', state: 'open', isDraft: false,
        openedAt: new Date(), updatedAt: new Date(), headSha: HEAD, files: [{ path: 'src/a.ts', additions: 2, deletions: 0 }],
      })
      .returning()
      .execute()
  )[0].id as number;
});

afterAll(async () => {
  closeDb?.();
  for (const s of ['', '-shm', '-wal']) rmSync(DB_PATH + s, { force: true });
});

async function runToEnd(provider: 'claude' | 'codex', model: 'claude-opus-5-5' | 'claude-sonnet-5' = 'claude-opus-5-5'): Promise<ClaudeReview> {
  const started = await manager.startReview(ctx, 1, prId, model, provider);
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

// Only POSTED findings join a follow-up (persist.ts `loadPriorReviewForFollowUp`): post a run's findings.
async function postAll(reviewId: number): Promise<void> {
  await db
    .update(schema.claudeReviewFindings)
    .set({ postedAt: new Date(), included: true })
    .where(eq(schema.claudeReviewFindings.reviewId, reviewId))
    .execute();
}

let codexFirst: ClaudeReview;
let claudeSecond: ClaudeReview;
let codexThird: ClaudeReview;

describe('a manual run on the provider it names', () => {
  it('runs on Codex while the default is Claude: the run, its label and its stamp say Codex', async () => {
    codexFirst = await runToEnd('codex');
    expect(runArgs[0]!.provider).toBe('codex');
    expect(codexFirst).toMatchObject({ status: 'succeeded', provider: 'codex', model: 'gpt-6.1-sol' });
    await postAll(codexFirst.id);
  });

  it('a Claude run next reviews afresh: the Codex review is not its "Previous review"', async () => {
    claudeSecond = await runToEnd('claude', 'claude-sonnet-5');
    expect(runArgs[1]!.provider).toBe('claude');
    expect(runArgs[1]!.prompt).not.toContain('## Previous review');
    expect(claudeSecond).toMatchObject({ provider: 'claude', model: 'claude-sonnet-5' });
    await postAll(claudeSecond.id);
  });

  it('a second Codex run follows up on the first Codex run, not on the Claude one in between', async () => {
    codexThird = await runToEnd('codex');
    expect(runArgs[2]!.provider).toBe('codex');
    expect(runArgs[2]!.prompt).toContain('## Previous review');
    expect(runArgs[2]!.prompt).toContain('codex finding 1');
    expect(runArgs[2]!.prompt).not.toContain('claude finding 2');
    expect(codexThird.followUp?.priorReviewId).toBe(codexFirst.id);
  });

  it('a queued row is labelled by the provider it was asked to run on, not the default', async () => {
    const id = await persist.insertQueuedReview(ctx, prId, HEAD, 'claude-sonnet-5', 1, [], 'manual', 'codex');
    const row = (await db.select().from(schema.claudeReviews).where(eq(schema.claudeReviews.id, id)).execute())[0];
    expect(row).toMatchObject({ provider: 'codex', model: 'gpt-6.1-terra' });
    await persist.markReviewCancelled(ctx, id);
  });
});

describe('the history', () => {
  it('lists every run, both providers, newest first, each with its finding count', async () => {
    const history = await persist.listClaudeReviewHistory(ctx, prId, 1);
    expect(history.map((h) => [h.provider, h.status, h.findingCount])).toEqual([
      ['codex', 'cancelled', 0],
      ['codex', 'succeeded', 2], // its own finding + the earlier one it carries (both stored on the run)
      ['claude', 'succeeded', 1],
      ['codex', 'succeeded', 1],
    ]);
  });
});

describe('the review chat', () => {
  it("answers on its review's provider while it is signed in", async () => {
    const out = await chat.answerReviewChat(ctx, 1, codexThird.id, { question: 'Why?' });
    expect(out.ok).toBe(true);
    expect(chatArgs.at(-1)!.provider).toBe('codex');
    const onClaude = await chat.answerReviewChat(ctx, 1, claudeSecond.id, { question: 'Why?' });
    expect(onClaude.ok).toBe(true);
    expect(chatArgs.at(-1)!.provider).toBe('claude');
  });

  it("falls back to the default when the review's provider is not signed in", async () => {
    signedIn.codex = false;
    try {
      const out = await chat.answerReviewChat(ctx, 1, codexFirst.id, { question: 'Still?' });
      expect(out.ok).toBe(true);
      expect(chatArgs.at(-1)!.provider).toBe('claude');
    } finally {
      signedIn.codex = true;
    }
  });
});
