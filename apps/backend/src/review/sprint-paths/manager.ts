import { SPRINT_PATHS_MODEL, type SprintPathsFailure } from '@pierre-review/shared';
import { config } from '../../config.js';
import {
  claimSprintPathsPass,
  isPathsCurrent,
  noteSprintPathsRun,
  pathsBackedOff,
  recordSprintPathsAttempt,
  releaseSprintPathsPass,
  runsTodayOf,
  storedSprintPaths,
  storeSprintPaths,
  type SprintPathsInput,
  type SprintPathsRow,
  type StoredSprintPaths,
} from '../../db/sprint-paths.js';
import type { AgentContext } from '../agent-context.js';
import { pickReviewNonce } from '../claude-review/prompts.js';
import type { SprintPathsAgentResult, SprintPathsAgentRunner } from './agent.js';
import { sprintPathsPrompt, sprintPathsSystem, sprintPathsUntrusted } from './prompt.js';
import { validateSprintPaths } from './validate.js';

// THE SPRINT BUILDER'S PASS (docs/CLAUDE-REVIEW.md § Sprint paths). LOCAL ONLY and agentic: started after
// the theme pass by the sprint read's after-read chain (review/sprint-briefs/index.ts), which only
// `registerAgenticRoutes` sets (cloud: never). Never on a view.
//
//   • ONE agentic Sonnet 5 run (agent.ts) over the code-built map (db/sprint-paths.ts), whose ONE tool
//     validates the answer; validated AGAIN here before it is stored. Spend recorded (`recordAiUsage`,
//     seam 'agent', feature 'sprint_paths').
//   • RUNS ONLY WHEN THE INPUT HASH CHANGED (everything sent but the day facts + SPRINT_PATHS_VERSION).
//   • ⚠ THE BACKOFF: every run RECORDS ITS ATTEMPT on the workspace's `sprint_paths` row (when, the input
//     hash, the failure or null). A run that stored nothing for THIS hash is not run again until the
//     hash moves — never a retry loop.
//   • ⚠ THE DAILY CAP: at most `config.sprintPathsDailyCap` (SPRINT_PATHS_DAILY_CAP, default 12) runs per
//     workspace per UTC day, counted BEFORE Claude is called (a run that throws still counts).
//   • ONE PASS PER (account, workspace), claimed SYNCHRONOUSLY (`claimSprintPathsPass`, which the GET
//     reads as 'writing'); a second call while one runs is 'busy'. Never throws.

export interface SprintPathsSeams {
  aiEnabled?: boolean;
  entitled?: (accountId: number) => Promise<boolean>;
  todo?: (accountId: number, workspaceId: number) => Promise<SprintPathsInput | null>;
  row?: (accountId: number, workspaceId: number) => Promise<SprintPathsRow | null>;
  store?: (accountId: number, workspaceId: number, inputHash: string, v: StoredSprintPaths) => Promise<void>;
  recordAttempt?: (accountId: number, workspaceId: number, inputHash: string, error: SprintPathsFailure | null) => Promise<void>;
  noteRun?: (accountId: number, workspaceId: number) => Promise<void>;
  runner?: SprintPathsAgentRunner;
  dailyCap?: number;
  now?: () => Date;
  /** May the run set the auth env (claude-review/manager.ts `chatMayApplyAuthEnv`)? A seam so a test
   *  never imports the review queue (and the DB client with it). */
  applyAuthEnv?: () => Promise<boolean>;
}

export interface SprintPathsPassResult {
  state: 'off' | 'no_credential' | 'not_entitled' | 'busy' | 'no_tracker' | 'too_few' | 'current' | 'backoff' | 'capped' | 'done' | 'failed';
  costUsd: number;
  paths: number;
  failure?: SprintPathsFailure;
}

/** Test seam. */
export { resetSprintPathsFlight as resetSprintPathsPasses } from '../../db/sprint-paths.js';

async function accountExists(accountId: number): Promise<boolean> {
  const { getAccountById } = await import('../../auth/account.js');
  return (await getAccountById(accountId)) != null;
}

/** Why a finished run stored nothing. Pure. */
export function pathsFailureOf(r: Pick<SprintPathsAgentResult, 'accepted' | 'lastRefusal' | 'subtype' | 'runtimeMissing' | 'error'>): SprintPathsFailure {
  if (r.runtimeMissing || r.error != null) return 'error';
  if (r.lastRefusal != null) return 'refused';
  if (r.subtype != null && r.subtype !== 'success') return 'stopped';
  return 'no_submit';
}

/** Write this workspace's critical paths when its input changed. Never throws. */
export async function runSprintPathsPass(
  ctx: Pick<AgentContext, 'log' | 'llm' | 'recordAiUsage'>,
  accountId: number,
  workspaceId: number,
  seams: SprintPathsSeams = {},
): Promise<SprintPathsPassResult> {
  const res: SprintPathsPassResult = { state: 'done', costUsd: 0, paths: 0 };
  if (!(seams.aiEnabled ?? config.aiEnabled)) return { ...res, state: 'off' };
  // ⚠ CLAIMED SYNCHRONOUSLY — no await between the check and the claim.
  if (!claimSprintPathsPass(accountId, workspaceId)) return { ...res, state: 'busy' };
  const now = seams.now ?? (() => new Date());
  let attempted: string | null = null;
  const recordAttempt = seams.recordAttempt ?? ((a: number, w: number, h: string, e: SprintPathsFailure | null) => recordSprintPathsAttempt(a, w, h, e));
  const record = async (hash: string, error: SprintPathsFailure | null): Promise<void> => {
    await recordAttempt(accountId, workspaceId, hash, error).catch((err) => ctx.log.warn({ err: String(err).slice(0, 200) }, 'sprint paths: attempt record failed'));
  };
  try {
    if (ctx.llm.detectAuth('sprint_paths').status !== 'ok') return { ...res, state: 'no_credential' };
    if (!(await (seams.entitled ?? accountExists)(accountId))) return { ...res, state: 'not_entitled' };
    const todo = seams.todo ?? (async (a: number, w: number) => (await import('../../db/sprint-graph.js')).sprintPathsTodo(a, w));
    const input = await todo(accountId, workspaceId);
    if (input == null) return { ...res, state: 'no_tracker' };
    if (!input.eligible) return { ...res, state: 'too_few' };
    const row = await (seams.row ?? storedSprintPaths)(accountId, workspaceId);
    if (isPathsCurrent(row, input.inputHash)) return { ...res, state: 'current' };
    if (pathsBackedOff(row, input.inputHash)) return { ...res, state: 'backoff' };
    if (runsTodayOf(row, now()) >= (seams.dailyCap ?? config.sprintPathsDailyCap)) return { ...res, state: 'capped' };
    await (seams.noteRun ?? ((a: number, w: number) => noteSprintPathsRun(a, w, now())))(accountId, workspaceId);
    attempted = input.inputHash;
    const runner: SprintPathsAgentRunner = seams.runner ?? (await import('./agent.js')).runSprintPathsAgent;
    const applyAuthEnv = await (seams.applyAuthEnv ?? (async () => (await import('../claude-review/manager.js')).chatMayApplyAuthEnv()))();
    const out = await runner({
      input,
      model: SPRINT_PATHS_MODEL,
      systemPrompt: sprintPathsSystem(),
      prompt: sprintPathsPrompt(input, pickReviewNonce(sprintPathsUntrusted(input))),
      maxTurns: config.sprintPathsMaxTurns,
      maxBudgetUsd: config.sprintPathsBudgetUsd,
      applyAuthEnv,
      abortController: new AbortController(),
      // Codex records its own ledger row from this (its model, US$ 0 on a ChatGPT login, its tokens).
      usageRecord: { accountId, seam: 'agent', feature: 'sprint_paths' },
    });
    const costUsd = out.costUsd ?? 0;
    res.costUsd = costUsd;
    // A Codex run's row is already written (by its provider, as Codex): never a second, Claude-named one.
    if (costUsd > 0 && out.provider !== 'codex') {
      await ctx
        .recordAiUsage({
          accountId,
          seam: 'agent',
          feature: 'sprint_paths',
          model: SPRINT_PATHS_MODEL,
          costUsd,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
        })
        .catch((err) => ctx.log.warn({ err }, 'sprint paths: usage record failed'));
    }
    // Validated in the tool, and AGAIN here: nothing reaches the store that this input did not allow.
    const v = out.accepted != null ? validateSprintPaths(out.accepted, input) : null;
    if (v != null && v.ok) {
      await (seams.store ?? storeSprintPaths)(accountId, workspaceId, input.inputHash, {
        ...v.value,
        costUsd,
        inputTokens: out.inputTokens ?? 0,
        outputTokens: out.outputTokens ?? 0,
      });
      await record(input.inputHash, null);
      ctx.log.info({ accountId, workspaceId, paths: v.value.paths.length, costUsd }, 'sprint paths: stored');
      return { ...res, paths: v.value.paths.length };
    }
    const failure: SprintPathsFailure = v != null ? 'refused' : pathsFailureOf(out);
    if (out.error != null) ctx.log.warn({ accountId, workspaceId, err: out.error.slice(0, 200) }, 'sprint paths: run failed');
    await record(input.inputHash, failure);
    return { ...res, state: 'failed', failure };
  } catch (err) {
    ctx.log.warn({ accountId, workspaceId, err: String(err).slice(0, 200) }, 'sprint paths: pass threw');
    if (attempted != null) await record(attempted, 'error');
    return { ...res, state: 'failed', failure: 'error' };
  } finally {
    releaseSprintPathsPass(accountId, workspaceId);
  }
}
