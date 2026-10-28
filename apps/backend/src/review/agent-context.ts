import type { AiRunKind } from '@pierre-review/shared';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { accountIdOf } from '../api/plugins/auth.js';
import { db, schema, runTransaction } from '../db/client.js';
import * as hostQueries from '../db/queries.js';
import { recordAiUsage, type AiUsageRecord } from '../db/usage.js';
import type { CheapCompleteOpts, CheapCompleteResult } from './llm.js';
import { buildAiBudgetGate, type AiBudgetGate } from '../ai/budget.js';
import { getAccessToken } from '../auth/account.js';
import { fetchBranchHeadSha, fetchPrHeadInfo, fetchPrUnifiedDiff } from '../github/mutations.js';
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
import { detectClaudeAuth, detectProviderAuth } from './auth.js';
import {
  loadReviewThreadsForReview,
  type ReviewThreadsForReview,
} from '../db/review-threads-for-review.js';
import type { CheckLogsResponse } from '@pierre-review/shared';
import type { GeneratePlanArgs, GeneratePlanResult } from '../coding/ai-fix/plan.js';
import type {
  ApplyAndPushArgs,
  ApplyAndPushResult,
  GenerateFixArgs,
  GenerateFixResult,
  GithubSeam,
  ReviewSeam,
} from '../platform/contract.js';

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
  accountIdOf(req: FastifyRequest): number;
  // Loosely typed exactly as the plugin saw them: the moved code reads core tables through
  // `ctx.schema.<table>` and casts its rows, so it compiles identically against either dialect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: Record<string, any>;
  runTransaction: typeof runTransaction;
  // The pre-flight PER RUN KIND (review/auth.ts `detectClaudeAuth`): pass the kind about to run —
  // an agent kind, or 'complete' for a one-shot feature. No kind ⇒ "any agent" (the strictest answer).
  llm: {
    detectAuth(kind?: AiRunKind): DetectAuthResult;
    // The same pre-flight for a NAMED provider (a manual run's per-run choice, a follow-up on a stored
    // run's provider). Optional so a test's fake ctx may omit it (`preflightFor` then asks detectAuth).
    detectProviderAuth?(provider: 'claude' | 'codex', kind: AiRunKind): DetectAuthResult;
    // The one-shot completion (review/llm.ts `cheapComplete`, through the provider seam). Optional so
    // a test's fake ctx may omit it — a caller then takes its no-model path (never a live call).
    complete?(opts: CheapCompleteOpts): Promise<CheapCompleteResult>;
  };
  recordAiUsage(row: AiUsageRecord): Promise<void>;
  github: Pick<
    GithubSeam,
    'fetchPrDiff' | 'fetchPrHeadInfo' | 'fetchCompareDiff' | 'fetchReviewCommentHunks'
  > & {
    // A branch's tip sha, or null when it does not exist (github/mutations.ts `fetchBranchHeadSha`).
    // Optional so a test's fake ctx may omit it (related-repo rule 3 is then skipped).
    fetchBranchHeadSha?(accountId: number, a: { owner: string; name: string; branch: string }): Promise<string | null>;
  };
  coding: {
    generateFix(args: GenerateFixArgs): Promise<GenerateFixResult>;
    // PLAN MODE: the read-only planning pass (coding/agent.ts runPlanAgent).
    generatePlan(args: GeneratePlanArgs): Promise<GeneratePlanResult>;
    applyAndPush(args: ApplyAndPushArgs): Promise<ApplyAndPushResult>;
  };
  review: ReviewSeam;
  queries: {
    getAutoReviewCandidates?(
      accountId: number,
      workspaceId: number,
      opts: { openedSinceMs: number; dayStartMs: number; limit: number; pressPrId?: number; pressed?: boolean },
    ): Promise<{
      prIds: number[];
      autoToday: number;
      // Already-reviewed PRs whose head moved past every run, OR whose head is unchanged but a
      // newer qualifying review comment arrived (auto RE-review). `commentsAtMs` is that comment's
      // time (null/absent for a moved head); the sweeper settles on (headSha, commentsAtMs).
      // Absent on an older host ⇒ none.
      // `lastRunAtMs` is the latest start or finish of any run of the PR (the "immediately on
      // receipt" test; absent ⇒ treated as none).
      // `coveredMs` (comment re-reviews): the newest qualifying comment the reviews at this head saw.
      reReview?: Array<{
        prId: number;
        headSha: string;
        commentsAtMs?: number | null;
        lastRunAtMs?: number | null;
        coveredMs?: number | null;
        // How far the reviews covered replies on Limn's OWN findings (a pair: its earlier-reaching
        // half). Absent ⇒ `coveredMs`.
        ownCoveredMs?: number | null;
        // How far the latest Check threads row at this head reached, and the newest qualifying reply
        // on one of Limn's own findings (null: none). Absent ⇒ the sweeper reads them itself.
        checkCoveredMs?: number | null;
        newestOwnThreadCommentAtMs?: number | null;
        // How far the replies passes at this head reached (null: none), and the newest qualifying
        // comment in a thread NOT rooted on Limn's own finding (null: none). Absent ⇒ not split.
        repliesCoveredMs?: number | null;
        newestOtherCommentAtMs?: number | null;
      }>;
      // PRs whose run is queued or running while their synced head has moved past it: never
      // cancelled — the sweeper only starts the new head's settle clock. Absent ⇒ none.
      inFlightMoved?: Array<{ prId: number; headSha: string }>;
      // PRs whose latest run at the current head is a FAILED AUTO run (db/queries.ts
      // `AutoRetryCandidate`); the sweeper's start rule decides whether each is due. Absent ⇒ none.
      retry?: Array<{
        prId: number;
        headSha: string;
        failedReviewId: number;
        failedAtMs: number;
        error: string | null;
        provider: 'claude' | 'codex';
        attempts: number;
      }>;
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
    // `full`: the WHOLE log up to actions-logs.ts MAX_LOG_BYTES (anchored at its end), for the CI
    // review's pre-scan; absent ⇒ the viewer's one tail page.
    readJobLog(
      accountId: number,
      a: { owner: string; name: string; jobId: number; full?: boolean },
    ): Promise<CheckLogsResponse>;
    readFailedStep(
      accountId: number,
      a: { owner: string; name: string; jobId: number },
    ): Promise<string | null>;
  };
  registerScheduledJob(cron: string, handler: () => Promise<void> | void, label?: string): void;
  // THE CLAUDE SPEND BUDGET's gate (ai/budget.ts). Every AUTOMATIC run asks it before it queues —
  // through `automaticRunAllowed` (./budget-gate.ts), never directly. Absent (a test's fake) ⇒ allowed.
  aiBudget?: AiBudgetGate;
}

export function buildAgentContext(log: FastifyBaseLogger): AgentContext {
  return {
    log,
    accountIdOf,
    db,
    schema: schema as unknown as Record<string, unknown> as AgentContext['schema'],
    runTransaction,
    llm: {
      detectAuth: (kind) => {
        const r = detectClaudeAuth(kind);
        return r.status === 'ok' ? { status: 'ok' } : { status: 'none', message: r.message };
      },
      detectProviderAuth: (provider, kind) => {
        const r = detectProviderAuth(provider, kind);
        return r.status === 'ok' ? { status: 'ok' } : { status: 'none', message: r.message };
      },
      complete: async (opts) => (await import('./llm.js')).cheapComplete(opts),
    },
    recordAiUsage: (row) => recordAiUsage(row),
    github: {
      fetchPrDiff: async (accountId, owner, name, number) =>
        fetchPrUnifiedDiff(await getAccessToken(accountId), owner, name, number),
      fetchPrHeadInfo: async (accountId, owner, name, number) =>
        fetchPrHeadInfo(await getAccessToken(accountId), owner, name, number),
      fetchBranchHeadSha: async (accountId, a) =>
        fetchBranchHeadSha(await getAccessToken(accountId), a.owner, a.name, a.branch),
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
      generatePlan: async (planArgs) => (await import('../coding/agent.js')).runPlanAgent(planArgs),
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
      // The log's TAIL window (DEFAULT_LOG_WINDOW_BYTES, 128 KiB — one ranged GET), or with `full`
      // the whole log (`tail: 0`, capped at MAX_LOG_BYTES and anchored at its end).
      readJobLog: async (accountId, a) => {
        try {
          return await fetchActionsJobLog(await getAccessToken(accountId), a.owner, a.name, a.jobId, a.full ? { tail: 0 } : {}, {
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
    aiBudget: buildAiBudgetGate({ info: (m) => log.info(m) }),
  };
}
