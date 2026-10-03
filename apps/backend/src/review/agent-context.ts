import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema, runTransaction, isPg } from '../db/client.js';
import * as hostQueries from '../db/queries.js';
import { recordAiUsage, type AiUsageRecord } from '../db/usage.js';
import { aiCreditStatus, type AiCreditStatus } from '../db/credits.js';
import { getAccessToken, getAccountById } from '../auth/account.js';
import { fetchPrHeadInfo, fetchPrUnifiedDiff } from '../github/mutations.js';
import { fetchCompareDiff } from '../github/compare.js';
import { fetchActionsJobLog } from '../github/actions-logs.js';
import {
  fetchActionsJobFailedStep,
  fetchCommitChecks,
  type CommitChecksRead,
} from '../github/commit-checks.js';
import { fetchReviewCommentHunks } from '../sync/hydrate-detail.js';
import { applyAndPush } from '../coding/git-ops.js';
import { registerScheduledJob } from '../sync/scheduled-jobs.js';
import { detectClaudeAuth } from './auth.js';
import {
  loadReviewThreadsForReview,
  type ReviewThreadsForReview,
} from '../db/review-threads-for-review.js';
import type { CheckLogsResponse } from '@pierre-review/shared';
import type {
  ApplyAndPushArgs,
  ApplyAndPushResult,
  GenerateFixArgs,
  GenerateFixResult,
  GithubSeam,
  ReviewSeam,
} from '../pro/contract.js';

// THE AGENTIC FEATURES' ONE CONTEXT OBJECT — Claude Review (+ chat, follow-up, ticket check, auto
// review) and AI Fix's fixer, all CORE since they left the private plugin.
//
// They were written against the plugin's `ProContext`, and they keep a context ARGUMENT rather
// than importing each primitive at every call site for two reasons: their tests build a tiny fake
// context (no DB, no GitHub, no SDK) and pass it in, and the queue managers carry it on each
// queued item. What changed is who builds it — core, from DIRECT imports, once, in
// `buildAgentContext` below — and that the seams it used to cross (`ctx.review`, `ctx.coding`'s
// fixer half, the review event bus, the learnings provider) are gone from `ProContext`. (The event
// bus and review memory itself were deleted outright later.)
//
// ⚠ THE AGENT SDK IS NEVER IMPORTED HERE. Every SDK-bearing module (review/agent.ts,
// review/chat-agent.ts, coding/agent.ts) is reached through a lazy `await import()` inside the
// member that runs it, so booting the server — and every npm install without the AI runtime —
// never loads it.

export type DetectAuthResult = { status: 'ok' | 'none'; message?: string };

export interface AgentContext {
  log: FastifyBaseLogger;
  host: { isCloud: boolean };
  accountIdOf(req: FastifyRequest): number;
  // Loosely typed exactly as the plugin saw them: the moved code reads core tables through
  // `ctx.schema.<table>` and casts its rows, so it compiles identically against either dialect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: Record<string, any>;
  runTransaction: typeof runTransaction;
  isPg: boolean;
  llm: { detectAuth(): DetectAuthResult };
  aiCredits: { check(accountId: number): Promise<AiCreditStatus> };
  recordAiUsage(row: AiUsageRecord): Promise<void>;
  github: Pick<
    GithubSeam,
    'fetchPrDiff' | 'fetchPrHeadInfo' | 'fetchCompareDiff' | 'fetchReviewCommentHunks'
  >;
  coding: {
    generateFix(args: GenerateFixArgs): Promise<GenerateFixResult>;
    applyAndPush(args: ApplyAndPushArgs): Promise<ApplyAndPushResult>;
  };
  review: ReviewSeam;
  queries: {
    getAutoReviewCandidates?(
      accountId: number,
      workspaceId: number,
      opts: { openedSinceMs: number; dayStartMs: number; limit: number },
    ): Promise<{
      prIds: number[];
      autoToday: number;
      // Already-reviewed PRs whose head moved past every run, OR whose head is unchanged but a
      // newer qualifying review comment arrived (auto RE-review). `commentsAtMs` is that comment's
      // time (null/absent for a moved head); the sweeper settles on (headSha, commentsAtMs).
      // Absent on an older host ⇒ none.
      reReview?: Array<{ prId: number; headSha: string; commentsAtMs?: number | null }>;
      // Per offered PR: is its head's synced CI still running, and when was that head first
      // observed (null = no record). Absent on an older host ⇒ never running.
      ci?: Array<{ prId: number; headSha: string | null; running: boolean; headSeenAtMs: number | null }>;
    } | null>;
    // The OTHER reviewers' open threads on a PR + the newest qualifying comment
    // (db/review-threads-for-review.ts). Absent ⇒ the review assesses no threads.
    loadReviewThreads?(accountId: number, prId: number): Promise<ReviewThreadsForReview>;
  };
  // The reviewed head's CI, read LIVE and server-side (review/claude-review/ci-failures.ts). None of
  // these throws. ⚠ `readJobLog` returns the log TEXT of one ranged window; the signed blob URL it
  // resolves never leaves github/actions-logs.ts. Absent ⇒ the review does not look at CI.
  ci?: {
    readCommitChecks(
      accountId: number,
      a: { owner: string; name: string; sha: string },
    ): Promise<CommitChecksRead>;
    readJobLog(
      accountId: number,
      a: { owner: string; name: string; jobId: number },
    ): Promise<CheckLogsResponse>;
    readFailedStep(
      accountId: number,
      a: { owner: string; name: string; jobId: number },
    ): Promise<string | null>;
  };
  registerScheduledJob(cron: string, handler: () => Promise<void> | void, label?: string): void;
}

export function buildAgentContext(log: FastifyBaseLogger): AgentContext {
  return {
    log,
    host: { isCloud: config.isCloud },
    accountIdOf,
    db,
    schema: schema as unknown as Record<string, unknown> as AgentContext['schema'],
    runTransaction,
    isPg,
    llm: {
      detectAuth: () => {
        const r = detectClaudeAuth();
        return r.status === 'ok' ? { status: 'ok' } : { status: 'none', message: r.message };
      },
    },
    aiCredits: {
      check: async (accountId) => {
        const account = await getAccountById(accountId);
        // Fail closed on a missing account (never happens for a live request).
        if (!account)
          return {
            summaryTurnsUsed: 0,
            summaryTurnLimit: 0,
            summaryTurnsRemaining: 0,
            summaryBlocked: true,
            agentCreditsUsed: 0,
            agentAllowanceCredits: 0,
            agentCreditsRemaining: 0,
            agentBlocked: true,
            blocked: true,
          };
        // Local accounts are UNMETERED (null limits → never blocked). The ledger still records
        // spend for the local usage display; it is the user's own money, not ours.
        return aiCreditStatus(account, Date.now());
      },
    },
    recordAiUsage: (row) => recordAiUsage(row),
    github: {
      fetchPrDiff: async (accountId, owner, name, number) =>
        fetchPrUnifiedDiff(await getAccessToken(accountId), owner, name, number),
      fetchPrHeadInfo: async (accountId, owner, name, number) =>
        fetchPrHeadInfo(await getAccessToken(accountId), owner, name, number),
      // `accountId` passed THROUGH so a rate-limited compare feeds that account's budget. Never
      // throws (github/compare.ts).
      fetchCompareDiff: async (accountId, a) =>
        fetchCompareDiff(await getAccessToken(accountId), { ...a, accountId }),
      // Never throws: the token is resolved inside the fetcher's own try.
      fetchReviewCommentHunks: (accountId, a) =>
        fetchReviewCommentHunks(accountId, a.owner, a.name, a.prNumber, {
          maxHunkChars: a.maxHunkChars,
        }),
    },
    coding: {
      // Lazy: coding/agent.ts pulls in the Claude Agent SDK.
      generateFix: async (fixArgs) => (await import('../coding/agent.js')).runCodingAgent(fixArgs),
      applyAndPush: (pushArgs) => applyAndPush(pushArgs),
    },
    review: {
      prepareReview: async (a) => (await import('./prepare.js')).prepareReview(a),
      runReview: async (a) => (await import('./agent.js')).runReview(a),
      postReview: async (a) => (await import('./post-seam.js')).postReview(a),
      postFinding: async (a) => (await import('./post-seam.js')).postFinding(a),
      chat: async (a) => (await import('./chat-agent.js')).runReviewChat(a),
    },
    queries: {
      getAutoReviewCandidates: (accountId, workspaceId, opts) =>
        hostQueries.getAutoReviewCandidates(accountId, workspaceId, opts),
      // `newestCommentAt` (→ comments_through) counts only the authors who may re-trigger an auto
      // review — the SAME filter the candidate read uses, so seen and new cannot disagree.
      loadReviewThreads: async (accountId, prId) =>
        loadReviewThreadsForReview(
          accountId,
          prId,
          await hostQueries.reReviewCommentAuthorFilterForPr(accountId, prId),
        ),
    },
    ci: {
      readCommitChecks: async (accountId, a) => {
        try {
          return await fetchCommitChecks(await getAccessToken(accountId), { ...a, accountId });
        } catch {
          return { ok: false, reason: 'error' };
        }
      },
      // The log's TAIL window (DEFAULT_LOG_WINDOW_BYTES, 128 KiB — one ranged GET), never the
      // whole log.
      readJobLog: async (accountId, a) => {
        try {
          return await fetchActionsJobLog(await getAccessToken(accountId), a.owner, a.name, a.jobId, {}, {
            accountId,
          });
        } catch {
          return {
            available: false,
            reason: 'token',
            text: '',
            totalLines: 0,
            returnedLines: 0,
            totalBytes: null,
            startByte: null,
            endByte: null,
            hasMore: false,
            truncated: false,
          };
        }
      },
      readFailedStep: async (accountId, a) => {
        try {
          return await fetchActionsJobFailedStep(await getAccessToken(accountId), { ...a, accountId });
        } catch {
          return null;
        }
      },
    },
    registerScheduledJob,
  };
}
