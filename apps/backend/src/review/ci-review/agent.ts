import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { claudeModelChoice, getActiveProvider, type AgentToolServer } from '../../ai/provider.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { submitCiReviewShape, type SubmitCiReviewPayload } from './schema.js';

// THE CI REVIEW'S AGENT RUN — the SDK half. The manager (manager.ts) reads the checks and logs,
// prepares the scratch working directory and the PR's read-only worktree, builds the prompts, and
// cleans up afterwards; this module only runs the agent and returns what it submitted. It never
// touches the DB and never throws for an expected failure.
//
// THE TOOL SURFACE is the PR review's deep-review surface minus everything optional:
//   allowed     Read, Glob, Grep and the in-process `submit_ci_review`
//   denied      the PR review's DISALLOWED_TOOLS (Write/Edit/MultiEdit/NotebookEdit, Bash, the web
//               tools — Bash outright, review/agent.ts explains why) plus the sub-agent dispatch
//               tools (a CI review has no specialists, and the SDK's built-in agent types would
//               inherit every tool)
// The worktree is an `additionalDirectories` root, and a PreToolUse PATH GUARD (path-guard.ts)
// denies any file path outside the working directory and that worktree: under bypassPermissions
// nothing else confines an absolute path, and the log excerpts are produced by untrusted code.

export const CI_TOOL_NAME = 'mcp__ci__submit_ci_review';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', CI_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

export interface RunCiAgentArgs {
  model: ClaudeReviewModel;
  cwd: string;
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress(p: { recentActivity: string[]; usage: { inputTokens: number; outputTokens: number; costUsd: number } }): void;
}

export interface RunCiAgentResult {
  submitted: boolean;
  payload: SubmitCiReviewPayload | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** The tool policy for a CI run. Pure, so the no-shell, no-dispatch rule is testable. */
export function ciToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export async function runCiReviewAgent(args: RunCiAgentArgs): Promise<RunCiAgentResult> {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  const telemetry = (): Pick<RunCiAgentResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunCiAgentResult => ({
    submitted: false,
    payload: null,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = await submitCiReviewShape();
    let captured: SubmitCiReviewPayload | null = null;
    const tools: AgentToolServer = {
      server: 'ci',
      tools: [
        {
          name: 'submit_ci_review',
          description: 'Submit why each failing check failed. Call this EXACTLY once, at the end.',
          shape,
          handle: (a) => {
            captured = a as unknown as SubmitCiReviewPayload;
            return { text: 'CI review recorded.' };
          },
        },
      ],
    };
    const policy = ciToolPolicy();
    const activity: string[] = [];
    ({ result } = await getActiveProvider().runAgent({
      kind: 'ci_review',
      model: claudeModelChoice(model),
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard, first on PreToolUse — a deny holds under
      // bypassPermissions): the scratch cwd and the PR's worktree, nothing else.
      cwd: args.cwd,
      roots: [...args.worktrees],
      readOnlyRoots: [],
      writeRoots: [],
      tools,
      budget: { usd: config.ciReviewBudgetUsd, turns: config.ciReviewMaxTurns },
      abortController,
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools },
      onMessage: (message) => {
        if (message.type === 'assistant') {
          try {
            recordUsage(usageByUuid, message);
          } catch {
            /* usage shape varies — never let it break the run */
          }
          try {
            for (const line of describeAssistantBlocks(message)) {
              const t = line.startsWith(CI_TOOL_NAME) ? 'Submitting the CI review…' : line;
              activity.push(t);
              if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
            }
          } catch {
            /* never let progress derivation break the run */
          }
          const live = sumUsageMap(usageByUuid);
          args.onProgress({
            recentActivity: [...activity],
            usage: { inputTokens: live.inputTokens, outputTokens: live.outputTokens, costUsd: estimateCostUsd(model, live) },
          });
        } else if (message.type === 'result') {
          result = message;
        }
      },
    }));

    if (!captured) {
      const reason =
        result && result.subtype !== 'success'
          ? `agent stopped (${result.subtype}) without submitting the CI review`
          : 'agent finished without calling submit_ci_review';
      return fail(reason, false);
    }
    return { submitted: true, payload: captured, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
