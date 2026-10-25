import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';
import { claudeModelChoice, getActiveProvider, type AgentToolServer } from '../../ai/provider.js';
import { config } from '../../config.js';
import type { ReviewThreadReport } from '../../platform/contract.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { estimateCostUsd } from '../pricing.js';
import { buildSubmitThreadsShape } from './thread-check-schema.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { DISPATCH_TOOL_NAMES } from './specialists.js';

// CHECK THREADS — the SDK half (the CI review's agent.ts, one tool narrower). The manager
// (thread-check.ts) plans, prepares the read-only worktree and the prompt, and cleans up; this
// module runs the agent and returns what it submitted. It never touches the DB and never throws for
// an expected failure.
//
// THE TOOL SURFACE: Read, Glob, Grep and the in-process `submit_threads` — nothing else. Bash is
// denied outright (review/agent.ts explains why), so are the write and web tools and the sub-agent
// dispatch tools. A PreToolUse PATH GUARD confines every file path to the scratch directory and the
// worktree (the thread text is attacker-influenced). The account's claude.ai connectors are isolated.

export const THREAD_CHECK_TOOL_NAME = 'mcp__threads__submit_threads';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', THREAD_CHECK_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

// The `submit_threads` shape lives in ./thread-check-schema.ts (the result-schema registry builds it
// from there); re-exported under its old home.
export { buildSubmitThreadsShape };

/** The tool policy for a check. Pure, so the no-shell, no-dispatch rule is testable. */
export function threadCheckToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export interface RunThreadCheckArgs {
  model: ClaudeReviewModel;
  cwd: string;
  // [] = diff-only (the checkout could not be prepared).
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress(p: { recentActivity: string[]; usage: { inputTokens: number; outputTokens: number; costUsd: number } }): void;
}

export interface RunThreadCheckResult {
  submitted: boolean;
  threads: ReviewThreadReport[] | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

export async function runThreadCheckAgent(args: RunThreadCheckArgs): Promise<RunThreadCheckResult> {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  const telemetry = (): Pick<RunThreadCheckResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunThreadCheckResult => ({
    submitted: false,
    threads: null,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = buildSubmitThreadsShape(await loadZod());
    let captured: ReviewThreadReport[] | null = null;
    const tools: AgentToolServer = {
      server: 'threads',
      tools: [
        {
          name: 'submit_threads',
          description: 'Submit your judgement of every review thread. Call this EXACTLY once, at the end.',
          shape,
          handle: async (a) => {
            if (captured == null) captured = (a as { threads: ReviewThreadReport[] }).threads ?? [];
            return { text: 'Threads recorded.' };
          },
        },
      ],
    };
    const policy = threadCheckToolPolicy();
    const activity: string[] = [];
    ({ result } = await getActiveProvider().runAgent({
      kind: 'thread_check',
      model: claudeModelChoice(model),
      effort: args.worktrees.length > 0 ? 'worktree' : 'diff_only',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard, first on PreToolUse — a deny holds under
      // bypassPermissions): the scratch cwd and the worktrees, nothing else.
      cwd: args.cwd,
      roots: [...args.worktrees],
      readOnlyRoots: [],
      writeRoots: [],
      tools,
      budget: { usd: config.threadCheckBudgetUsd, turns: config.threadCheckMaxTurns },
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
              activity.push(line.startsWith(THREAD_CHECK_TOOL_NAME) ? 'Saving the judgements…' : line);
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
          ? `agent stopped (${result.subtype}) without submitting the threads`
          : 'agent finished without calling submit_threads';
      return fail(reason, false);
    }
    return { submitted: true, threads: captured, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
