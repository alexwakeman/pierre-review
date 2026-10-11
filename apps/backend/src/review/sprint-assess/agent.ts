import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel, SprintAssessMode } from '@pierre-review/shared';
import { AiRuntimeMissingError, claudeExecutableOptions, loadAgentSdk } from '../../ai/runtime.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../../ai/agent-isolation.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { sdkModelOptions } from '../model-options.js';
import { createPathGuard, pathGuardHook } from '../path-guard.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { submitAssessmentShape } from './schema.js';

// THE SPRINT ASSESSMENT'S AGENT RUN ("Check against code") — the SDK half. The manager (manager.ts)
// prepares a scratch working directory and a read-only DEFAULT-BRANCH checkout of every accepted
// repo, builds the prompts, validates what comes back and cleans up; this module only runs the agent
// and returns the FIRST `submit_assessment` payload, raw. It never touches the DB and never throws
// for an expected failure. Reached only through a lazy import, so booting never loads the SDK.
//
// THE TOOL SURFACE:
//   allowed     Read, Glob, Grep and the in-process `submit_assessment`
//   denied      the PR review's DISALLOWED_TOOLS (Write/Edit/MultiEdit/NotebookEdit, Bash — outright,
//               review/agent.ts explains why — and the web tools) plus the sub-agent dispatch tools
// Every checkout is an `additionalDirectories` root, and a PreToolUse PATH GUARD (path-guard.ts)
// denies any path outside the working directory and those checkouts (under bypassPermissions nothing
// else confines an absolute path, and the ticket text is attacker-authored). ISOLATED_MCP + the
// ownToolsOnlyHook backstop keep the account's claude.ai connectors out (ai/agent-isolation.ts).
// ⚠ No tool can WRITE to a tracker: the write-back is a separate, per-ticket, confirmed press.

export const SPRINT_ASSESS_TOOL = 'mcp__sprint__submit_assessment';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', SPRINT_ASSESS_TOOL];

export interface SprintAssessRunArgs {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  worktrees: string[];
  model: string;
  /** Plan or verify — picks the tool's shape (the prompt is built by the manager). */
  mode: SprintAssessMode;
  abortController: AbortController;
  applyAuthEnv: boolean;
  /** Called on the FIRST submit_assessment attempt (the manager's 'writing' phase). */
  onSubmit?: () => void;
}

export interface SprintAssessRunResult {
  /** The FIRST submit_assessment payload, raw (validate.ts decides what survives), or null. */
  submitted: unknown | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  aborted: boolean;
  runtimeMissing: boolean;
  /** The SDK result subtype ('success', 'error_max_turns', 'error_max_budget_usd', …) or null. */
  subtype?: string | null;
  /** Log-only detail; never sent to a client. */
  failureReason?: string;
}

export type SprintAssessRunner = (a: SprintAssessRunArgs) => Promise<SprintAssessRunResult>;

/** The tool policy for an assessment run. Pure, so the no-shell, no-dispatch rule is testable. */
export function sprintAssessToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, 'Bash', 'NotebookEdit', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'WebSearch', ...DISPATCH_TOOL_NAMES])],
  };
}

export const runSprintAssessAgent: SprintAssessRunner = async (args) => {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  let submitted: unknown | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  const done = (extra: Partial<SprintAssessRunResult> = {}): SprintAssessRunResult => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      submitted,
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model as ClaudeReviewModel, usage) : null),
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
      aborted: abortController.signal.aborted,
      runtimeMissing: false,
      subtype: result?.subtype ?? null,
      ...extra,
    };
  };

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const shape = await submitAssessmentShape(args.mode);
    let attempted = false;
    const server = createSdkMcpServer({
      name: 'sprint',
      version: '1.0.0',
      tools: [
        tool(
          'submit_assessment',
          'Submit your assessment of the ticket. Call this EXACTLY once, at the end.',
          shape,
          async (a) => {
            if (!attempted) {
              attempted = true;
              try {
                args.onSubmit?.();
              } catch {
                /* a progress hook must never break the run */
              }
            }
            // THE FIRST CALL WINS — a second submit cannot rewrite what was recorded.
            if (submitted != null) return { content: [{ type: 'text', text: 'Already recorded.' }] };
            submitted = a;
            return { content: [{ type: 'text', text: 'Assessment recorded.' }] };
          },
        ),
      ],
    });
    const guard = createPathGuard(args.cwd, args.worktrees);
    const policy = sprintAssessToolPolicy();
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
        maxTurns: config.sprintAssessMaxTurns,
        maxBudgetUsd: config.sprintAssessBudgetUsd,
        // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under
        // bypassPermissions.
        hooks: { PreToolUse: [pathGuardHook(guard), ownToolsOnlyHook(['sprint'])] },
        settingSources: [],
        ...ISOLATED_MCP,
        mcpServers: { sprint: server },
        abortController,
        ...claudeExecutableOptions(),
      },
    });
    for await (const message of q) {
      if (message.type === 'assistant') {
        try {
          recordUsage(usageByUuid, message);
        } catch {
          /* usage shape varies — never let it break the run */
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }
    if (submitted == null) {
      return done({
        failureReason:
          result && result.subtype !== 'success'
            ? `agent stopped (${result.subtype}) without submitting`
            : 'agent finished without calling submit_assessment',
      });
    }
    return done();
  } catch (err) {
    if (abortController.signal.aborted) return done({ aborted: true });
    return done({
      runtimeMissing: err instanceof AiRuntimeMissingError,
      failureReason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    restoreEnv?.();
  }
};
