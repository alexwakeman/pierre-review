import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { ConflictAiChoice, ConflictAiResolution } from '@pierre-review/shared';
import { config } from '../../config.js';
import { getAccessToken } from '../../auth/account.js';
import type { AgentContext } from '../../review/agent-context.js';
import {
  claimSession,
  getSession,
  peekSession,
  subscribe,
  type ConflictSessionRecord,
} from '../../conflict/session.js';
import { acceptAiChoices, AI_CHOICE_REFUSAL_TEXT, type AiChoiceInput } from './validate.js';
import { buildAiResolvePrompt } from './prompt.js';

/**
 * "RESOLVE WITH CLAUDE" — the agentic half of the merge-conflict resolver (CORE, free, LOCAL ONLY:
 * registered by `registerAgenticRoutes`, which refuses in cloud and under LIMN_AI_DISABLED).
 *
 * One run = one conflict SESSION (built or reused), then one read-only agent run in a worktree at
 * the session's pinned head, answering with resolver decisions through `submit_resolution`. The
 * answer is stored ON THE SESSION (`rec.ai`) and the reader reviews it in the resolver.
 *
 * ⚠ NOTHING IS COMMITTED OR PUSHED HERE. The reader presses "Commit and push" through the
 * resolver's own gate and land path, exactly as for decisions they made by hand.
 *
 * ⚠ THE AGENT CAN ONLY READ. Read/Glob/Grep plus the submit tool; Bash, NotebookEdit and every
 * write tool are denied outright. It has no reason to write — its answer is decisions, validated by
 * `acceptAiChoices` — and the conflict text it reads is attacker-authored.
 *
 * ⚠ ONE RUN PER ACCOUNT, claimed SYNCHRONOUSLY (no `await` between the check and the write), the
 * AI in-flight-slot rule. A second click on another PR is told about the reader's own run.
 */

const READ_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__resolve__submit_resolution'];
const DENIED_TOOLS = ['Bash', 'NotebookEdit', 'Write', 'Edit', 'MultiEdit'];

/** Accounts with a run in flight. */
const runningAccounts = new Set<number>();

export type StartAiResolveResult =
  | { status: 'started'; resolution: ConflictAiResolution }
  /** A run for this PR is already in flight — its view, re-attached. */
  | { status: 'running'; resolution: ConflictAiResolution }
  | { status: 'busy_account' }
  | { status: 'busy_pr' }
  | { status: 'busy_service' }
  | { status: 'no_conflicts'; baseRef: string }
  | { status: 'no_auth'; message?: string }
  | { status: 'credits_exhausted' };

export interface StartAiResolveInput {
  accountId: number;
  prId: number;
  model: string;
  /** The PR's synced head. A settled session pinned to a DIFFERENT head is rebuilt rather than
   *  resolved — unless an overlay is watching it, which the resolver's own head-moved guard owns. */
  headSha?: string | null;
  log: FastifyBaseLogger;
  /** Builds the session behind a `created` claim — `runOpen` in api/routes/conflicts.ts, passed
   *  in so this module does not import the route file. */
  runOpen: (rec: ConflictSessionRecord, log: FastifyBaseLogger) => Promise<void>;
}

function freshView(rec: ConflictSessionRecord, model: string): ConflictAiResolution {
  return {
    runId: randomUUID(),
    prId: rec.prId,
    sessionId: rec.sessionId,
    headSha: rec.model?.headSha ?? '',
    baseSha: rec.model?.baseSha ?? '',
    modelHash: rec.modelHash,
    baseRef: rec.model?.baseRef ?? '',
    status: rec.status === 'preparing' ? 'preparing' : 'running',
    error: null,
    model,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    choices: [],
    decidableTotal: 0,
    summary: null,
    costUsd: null,
  };
}

export async function startAiResolve(
  ctx: AgentContext,
  input: StartAiResolveInput,
): Promise<StartAiResolveResult> {
  const { accountId, prId } = input;
  const auth = ctx.llm.detectAuth();
  if (auth.status !== 'ok') return { status: 'no_auth', message: auth.message };
  // Local accounts are unmetered, so this never refuses there; it is here so the rule cannot be
  // forgotten if the feature ever leaves local.
  if ((await ctx.aiCredits.check(accountId)).agentBlocked) return { status: 'credits_exhausted' };

  // ── THE SYNCHRONOUS CLAIM WINDOW. No `await` from here to `runningAccounts.add`. ──
  const live = peekSession(accountId, prId);
  if (live?.aiRunning && live.ai) return { status: 'running', resolution: live.ai.view };
  if (runningAccounts.has(accountId)) return { status: 'busy_account' };
  // A CLEAN session is a fact about the base it was built against, and the base may have moved
  // since (nothing synced pins the base SHA). The entry is only offered while the synced verdict is
  // `conflicts`, so a clean session nobody is watching is rebuilt rather than believed — otherwise
  // every click 409s "no longer conflicts" until the session is reaped. One an overlay is showing
  // stays: tearing it down would close the reader's own "no conflicts" view.
  if (live && live.status === 'clean' && live.subscribers.size > 0) {
    return { status: 'no_conflicts', baseRef: live.model?.baseRef ?? 'the base branch' };
  }
  const staleClean = live != null && live.status === 'clean';
  // A failed build is not worth re-attaching to; a ready or preparing one is — unless it is pinned
  // to a head the PR has since moved off and nobody has it open.
  const stale =
    live != null &&
    live.status === 'ready' &&
    input.headSha != null &&
    live.model != null &&
    live.model.headSha !== input.headSha &&
    live.subscribers.size === 0;
  const claim = claimSession(accountId, prId, {
    restart: live != null && (live.status === 'failed' || stale || staleClean),
    autoApply: false,
  });
  if (claim.kind === 'busy') {
    if (claim.reason === 'account') return { status: 'busy_account' };
    if (claim.reason === 'pr') return { status: 'busy_pr' };
    return { status: 'busy_service' };
  }
  const rec = claim.session;
  const abort = new AbortController();
  rec.aiRunning = true;
  rec.ai = { view: freshView(rec, input.model), abort };
  runningAccounts.add(accountId);
  // ── end of the claim window ──

  void runJob(ctx, rec, claim.kind === 'created', input, abort);
  return { status: 'started', resolution: rec.ai.view };
}

/** Resolve once the session's build settles (ready, clean or failed), or it is dropped. */
function waitForBuild(rec: ConflictSessionRecord): Promise<void> {
  if (rec.status !== 'preparing') return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = subscribe(rec, (e) => {
      if (e.type === 'ready' || e.type === 'failed' || e.type === 'done') {
        unsub();
        resolve();
      }
    });
    // Settled between the check above and the subscribe.
    if (rec.status !== 'preparing') {
      unsub();
      resolve();
    }
  });
}

function settle(
  rec: ConflictSessionRecord,
  patch: Partial<ConflictAiResolution>,
): void {
  if (!rec.ai) return;
  const { recentActivity: _drop, ...rest } = rec.ai.view;
  rec.ai.view = { ...rest, ...patch, finishedAt: new Date().toISOString() };
}

/** NEVER REJECTS — fired with `void`. */
async function runJob(
  ctx: AgentContext,
  rec: ConflictSessionRecord,
  created: boolean,
  input: StartAiResolveInput,
  abort: AbortController,
): Promise<void> {
  let worktree: { owner: string; name: string; repoCloneDir: string; worktreePath: string } | null =
    null;
  try {
    if (created) await input.runOpen(rec, input.log);
    else await waitForBuild(rec);

    if (rec.status === 'clean') {
      settle(rec, {
        status: 'failed',
        error: `This pull request no longer conflicts with ${rec.model?.baseRef ?? 'its base branch'}.`,
      });
      return;
    }
    const model = rec.model;
    if (rec.status !== 'ready' || !model) {
      settle(rec, {
        status: 'failed',
        error: rec.error?.message ?? 'Couldn’t work out the conflicts in this pull request.',
      });
      return;
    }

    const built = buildAiResolvePrompt(model);
    if (rec.ai) {
      rec.ai.view = {
        ...rec.ai.view,
        status: 'running',
        headSha: model.headSha,
        baseSha: model.baseSha,
        modelHash: rec.modelHash,
        baseRef: model.baseRef,
        sessionId: rec.sessionId,
        decidableTotal: built.decidableTotal,
      };
    }
    if (built.offered.size === 0) {
      settle(rec, {
        status: 'failed',
        error: 'None of the conflicting files can be resolved here. Resolve them on GitHub.',
      });
      return;
    }
    if (abort.signal.aborted) {
      settle(rec, { status: 'cancelled' });
      return;
    }

    const [{ runAgentInWorktree }, { loadAgentSdk }, { prepWorktree }, { submitResolutionShape }] =
      await Promise.all([
        import('../agent.js'),
        import('../../ai/runtime.js'),
        import('../../review/clone-manager.js'),
        import('./schema.js'),
      ]);
    const token = await getAccessToken(rec.accountId);
    const prepared = await prepWorktree(model.owner, model.name, model.number, model.headSha, token);
    worktree = { owner: model.owner, name: model.name, ...prepared };

    const accepted = new Map<string, ConflictAiChoice>();
    let summary: string | null = null;
    const { createSdkMcpServer, tool } = await loadAgentSdk();
    const shape = await submitResolutionShape();
    const server = createSdkMcpServer({
      name: 'resolve',
      version: '1.0.0',
      tools: [
        tool(
          'submit_resolution',
          'Submit your decisions for the conflict regions. Call again with only the refused ones to fix them.',
          shape,
          async (a) => {
            const p = a as unknown as { choices?: AiChoiceInput[]; summary?: string };
            if (typeof p.summary === 'string' && p.summary.trim() !== '') {
              summary = p.summary.trim().slice(0, 2000);
            }
            const rejected = acceptAiChoices(rec, p.choices ?? [], built.offered, accepted);
            if (rec.ai) rec.ai.view = { ...rec.ai.view, choices: [...accepted.values()] };
            const text =
              rejected.length === 0
                ? `Recorded. ${accepted.size} region(s) decided so far.`
                : [
                    `Recorded ${accepted.size} region(s). Refused:`,
                    ...rejected.map(
                      (r) => `- file=${r.file} region=${r.region}: ${AI_CHOICE_REFUSAL_TEXT[r.refusal]}`,
                    ),
                  ].join('\n');
            return { content: [{ type: 'text', text }] };
          },
        ),
      ],
    });

    const outcome = await runAgentInWorktree({
      worktreePath: worktree.worktreePath,
      model: input.model,
      systemPrompt: built.system,
      prompt: built.prompt,
      allowedTools: READ_TOOLS,
      disallowedTools: DENIED_TOOLS,
      mcpServers: { resolve: server },
      maxTurns: config.aiFixMaxTurns,
      maxBudgetUsd: config.aiFixBudgetUsd,
      abortController: abort,
      onActivity: (activity) => {
        if (rec.ai) rec.ai.view = { ...rec.ai.view, recentActivity: activity.slice(-8) };
      },
    });

    if (outcome.costUsd != null && outcome.costUsd > 0) {
      await ctx
        .recordAiUsage({
          accountId: rec.accountId,
          seam: 'agent',
          feature: 'ai_resolve',
          model: input.model,
          costUsd: outcome.costUsd,
          inputTokens: outcome.usage.inputTokens,
          outputTokens: outcome.usage.outputTokens,
          prId: rec.prId,
        })
        .catch(() => {});
    }
    if (outcome.aborted || abort.signal.aborted) {
      settle(rec, { status: 'cancelled', choices: [], costUsd: outcome.costUsd });
      return;
    }
    settle(rec, {
      status: 'succeeded',
      choices: [...accepted.values()],
      summary,
      costUsd: outcome.costUsd,
    });
  } catch (err) {
    if (abort.signal.aborted) {
      settle(rec, { status: 'cancelled', choices: [] });
    } else {
      input.log.warn({ err, prId: rec.prId }, 'ai-resolve run failed');
      settle(rec, { status: 'failed', error: 'Claude couldn’t finish resolving these conflicts.' });
    }
  } finally {
    rec.aiRunning = false;
    if (rec.ai) rec.ai.abort = null;
    runningAccounts.delete(rec.accountId);
    // Keep the session alive past the run: the reader opens the resolver next.
    getSession(rec.accountId, rec.prId, rec.sessionId);
    if (worktree) {
      const wt = worktree;
      const { removeWorktreeLocked, cleanupCloneCache } = await import('../../review/clone-manager.js');
      await removeWorktreeLocked(wt.owner, wt.name, wt.repoCloneDir, wt.worktreePath).catch(() => {});
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory */
        }
      });
    }
  }
}

/** This account's latest answer for the PR, or null. Touches the session (a read is not idle). */
export function getAiResolution(accountId: number, prId: number): ConflictAiResolution | null {
  const live = peekSession(accountId, prId);
  if (!live?.ai) return null;
  getSession(accountId, prId, live.sessionId);
  return live.ai.view;
}

/** Cancel this account's run on the PR. True when there was one to cancel. */
export function cancelAiResolve(accountId: number, prId: number): boolean {
  const live = peekSession(accountId, prId);
  if (!live?.aiRunning || !live.ai?.abort) return false;
  live.ai.abort.abort();
  return true;
}

/** Test seam only. */
export const __testing = {
  runningAccounts,
  reset: (): void => runningAccounts.clear(),
};
