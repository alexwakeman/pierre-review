import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { claudeExecutableOptions, loadAgentSdk } from '../../ai/runtime.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { sdkModelOptions } from '../model-options.js';
import { createPathGuard, pathGuardHook } from '../path-guard.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { submitTicketReviewShape, type SubmitTicketReviewPayload } from './schema.js';

// THE TICKET REVIEW'S AGENT RUN — the SDK half. The manager (manager.ts) prepares the scratch
// working directory (MEMBERS.md) and every member's read-only worktree, builds the prompts, and
// cleans up afterwards; this module only runs the agent and returns what it submitted. It never
// touches the DB and never throws for an expected failure.
//
// THE TOOL SURFACE is the PR review's deep-review surface minus everything optional:
//   allowed     Read, Glob, Grep and the in-process `submit_ticket_review`
//   denied      the PR review's DISALLOWED_TOOLS (Write/Edit/MultiEdit/NotebookEdit, Bash, the web
//               tools — Bash outright, review/agent.ts explains why) plus the sub-agent dispatch
//               tools (a ticket review has no specialists, and the SDK's built-in agent types
//               would inherit every tool)
// Every worktree is an `additionalDirectories` root, and a PreToolUse PATH GUARD (path-guard.ts)
// denies any file path outside the working directory and those worktrees: under
// bypassPermissions nothing else confines an absolute path, and the prompt is attacker-authored.

export const TICKET_TOOL_NAME = 'mcp__ticket__submit_ticket_review';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', TICKET_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

export interface RunTicketAgentArgs {
  model: ClaudeReviewModel;
  cwd: string;
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress(p: { recentActivity: string[]; usage: { inputTokens: number; outputTokens: number; costUsd: number } }): void;
}

export interface RunTicketAgentResult {
  submitted: boolean;
  payload: SubmitTicketReviewPayload | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** The tool policy for a ticket run. Pure, so the no-shell, no-dispatch rule is testable. */
export function ticketToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export async function runTicketReviewAgent(args: RunTicketAgentArgs): Promise<RunTicketAgentResult> {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  const telemetry = (): Pick<RunTicketAgentResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunTicketAgentResult => ({
    submitted: false,
    payload: null,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const shape = await submitTicketReviewShape();
    let captured: SubmitTicketReviewPayload | null = null;
    const server = createSdkMcpServer({
      name: 'ticket',
      version: '1.0.0',
      tools: [
        tool(
          'submit_ticket_review',
          'Submit your verdict on the ticket. Call this EXACTLY once, at the end.',
          shape,
          async (a) => {
            captured = a as unknown as SubmitTicketReviewPayload;
            return { content: [{ type: 'text', text: 'Ticket review recorded.' }] };
          },
        ),
      ],
    });
    const guard = createPathGuard(args.cwd, args.worktrees);
    const policy = ticketToolPolicy();
    const q = query({
      prompt: args.prompt,
      options: {
        model,
        ...sdkModelOptions(model, 'worktree'),
        systemPrompt: args.systemPrompt,
        cwd: args.cwd,
        additionalDirectories: [...args.worktrees],
        permissionMode: 'bypassPermissions',
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        maxTurns: config.ticketReviewMaxTurns,
        // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under
        // bypassPermissions.
        hooks: { PreToolUse: [pathGuardHook(guard)] },
        maxBudgetUsd: config.ticketReviewBudgetUsd,
        settingSources: [],
        mcpServers: { ticket: server },
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
            const t = line.startsWith(TICKET_TOOL_NAME) ? 'Submitting the ticket review…' : line;
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
    }

    if (!captured) {
      const reason =
        result && result.subtype !== 'success'
          ? `agent stopped (${result.subtype}) without submitting the ticket review`
          : 'agent finished without calling submit_ticket_review';
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
