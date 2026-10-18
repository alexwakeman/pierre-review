import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { z as Zod } from 'zod';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { claudeExecutableOptions, loadAgentSdk, loadZod } from '../../ai/runtime.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../../ai/agent-isolation.js';
import { config } from '../../config.js';
import type { ReviewThreadReport } from '../../pro/contract.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { sdkModelOptions } from '../model-options.js';
import { createPathGuard, pathGuardHook } from '../path-guard.js';
import { estimateCostUsd } from '../pricing.js';
import { buildThreadReportItem } from '../schema.js';
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

type ZodNs = typeof Zod;

/** The `submit_threads` shape: the review's own thread item (review/schema.ts), so they never drift. */
export function buildSubmitThreadsShape(z: ZodNs) {
  return {
    threads: z
      .array(buildThreadReportItem(z))
      .describe("One entry per thread in the 'Review threads' section, each ref once. Leave out a ref you cannot judge."),
  };
}

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
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const shape = buildSubmitThreadsShape(await loadZod());
    let captured: ReviewThreadReport[] | null = null;
    const server = createSdkMcpServer({
      name: 'threads',
      version: '1.0.0',
      tools: [
        tool(
          'submit_threads',
          'Submit your judgement of every review thread. Call this EXACTLY once, at the end.',
          shape,
          async (a) => {
            if (captured == null) captured = (a as { threads: ReviewThreadReport[] }).threads ?? [];
            return { content: [{ type: 'text', text: 'Threads recorded.' }] };
          },
        ),
      ],
    });
    const guard = createPathGuard(args.cwd, args.worktrees);
    const policy = threadCheckToolPolicy();
    const q = query({
      prompt: args.prompt,
      options: {
        model,
        ...sdkModelOptions(model, args.worktrees.length > 0 ? 'worktree' : 'diff_only'),
        systemPrompt: args.systemPrompt,
        cwd: args.cwd,
        additionalDirectories: [...args.worktrees],
        permissionMode: 'bypassPermissions',
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        maxTurns: config.threadCheckMaxTurns,
        // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under
        // bypassPermissions.
        hooks: { PreToolUse: [pathGuardHook(guard), ownToolsOnlyHook(['threads'])] },
        maxBudgetUsd: config.threadCheckBudgetUsd,
        settingSources: [],
        ...ISOLATED_MCP,
        mcpServers: { threads: server },
        abortController,
        ...claudeExecutableOptions(),
      },
    });

    const activity: string[] = [];
    for await (const message of q) {
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
    }

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
