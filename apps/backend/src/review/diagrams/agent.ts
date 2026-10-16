import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel, SequenceDiagramType } from '@pierre-review/shared';
import { claudeExecutableOptions, loadAgentSdk } from '../../ai/runtime.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../../ai/agent-isolation.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { sdkModelOptions } from '../model-options.js';
import { createPathGuard, pathGuardHook } from '../path-guard.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { submitDiagramShape, type SubmitDiagramPayload } from './schema.js';
import { cleanCaption, cleanTitle, validateMermaid } from './validate.js';

// THE SEQUENCE-DIAGRAM AGENT RUN — the SDK half. The manager (manager.ts) reads the diffs, prepares
// the scratch working directory and the read-only checkouts, builds the prompt and cleans up; this
// module only runs the agent and returns the diagram it submitted. It never touches the DB and never
// throws for an expected failure.
//
// THE TOOL SURFACE is the CI review's: Read, Glob, Grep and the in-process `submit_diagram`; the PR
// review's DISALLOWED_TOOLS (Bash outright, every write tool, the web tools) plus the sub-agent
// dispatch tools are denied. Every checkout is an `additionalDirectories` root, and the PreToolUse
// PATH GUARD (path-guard.ts) denies any path outside them and the working directory.
//
// `submit_diagram` VALIDATES before it accepts (validate.ts): a refused diagram is answered with what
// to fix and the model may call again, at most MAX_SUBMIT_ATTEMPTS times. Only a diagram that passed
// is returned — the manager validates it once more before storing.

export const DIAGRAM_TOOL_NAME = 'mcp__diagram__submit_diagram';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', DIAGRAM_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;
export const MAX_SUBMIT_ATTEMPTS = 3;

export interface RunDiagramAgentArgs {
  model: ClaudeReviewModel;
  cwd: string;
  roots: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress?(p: { recentActivity: string[] }): void;
}

export interface AcceptedDiagram {
  title: string | null;
  caption: string | null;
  diagramType: SequenceDiagramType;
  source: string;
}

export interface RunDiagramAgentResult {
  diagram: AcceptedDiagram | null;
  // The last validation refusal, when the model never sent a usable diagram.
  lastRefusal: string | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

/** The tool policy for a diagram run. Pure, so the no-shell, no-dispatch rule is testable. */
export function diagramToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

/**
 * The `submit_diagram` handler's decision, pure: accept a valid diagram, or answer with what to fix.
 * After MAX_SUBMIT_ATTEMPTS refusals the tool says to stop.
 */
export function judgeSubmission(
  payload: Partial<SubmitDiagramPayload>,
  attempt: number,
): { accepted: AcceptedDiagram } | { reply: string; refusal: string } {
  const v = validateMermaid(payload.diagram);
  if (v.ok) {
    return {
      accepted: {
        title: cleanTitle(payload.title),
        caption: cleanCaption(payload.caption),
        diagramType: v.diagramType,
        source: v.source,
      },
    };
  }
  const last = attempt >= MAX_SUBMIT_ATTEMPTS;
  return {
    refusal: v.message,
    reply: last
      ? `Refused: ${v.message} That was the last attempt; stop now.`
      : `Refused: ${v.message} Fix it and call submit_diagram again.`,
  };
}

export async function runDiagramAgent(args: RunDiagramAgentArgs): Promise<RunDiagramAgentResult> {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  let accepted: AcceptedDiagram | null = null;
  let lastRefusal: string | null = null;
  const telemetry = (): Pick<RunDiagramAgentResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunDiagramAgentResult => ({
    diagram: null,
    lastRefusal,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const shape = await submitDiagramShape();
    let attempts = 0;
    const server = createSdkMcpServer({
      name: 'diagram',
      version: '1.0.0',
      tools: [
        tool(
          'submit_diagram',
          'Submit the one Mermaid diagram. It is checked at once: a refusal says what to fix.',
          shape,
          async (a) => {
            if (accepted != null) return { content: [{ type: 'text', text: 'Diagram already recorded.' }] };
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              return { content: [{ type: 'text', text: 'No more attempts. Stop now.' }], isError: true };
            }
            attempts += 1;
            const j = judgeSubmission(a as unknown as Partial<SubmitDiagramPayload>, attempts);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { content: [{ type: 'text', text: 'Diagram recorded.' }] };
            }
            lastRefusal = j.refusal;
            return { content: [{ type: 'text', text: j.reply }], isError: true };
          },
        ),
      ],
    });
    const guard = createPathGuard(args.cwd, args.roots);
    const policy = diagramToolPolicy();
    const q = query({
      prompt: args.prompt,
      options: {
        model,
        ...sdkModelOptions(model, 'worktree'),
        systemPrompt: args.systemPrompt,
        cwd: args.cwd,
        additionalDirectories: [...args.roots],
        permissionMode: 'bypassPermissions',
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        maxTurns: config.sequenceDiagramMaxTurns,
        // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under
        // bypassPermissions.
        hooks: { PreToolUse: [pathGuardHook(guard), ownToolsOnlyHook(['diagram'])] },
        maxBudgetUsd: config.sequenceDiagramBudgetUsd,
        settingSources: [],
        ...ISOLATED_MCP,
        mcpServers: { diagram: server },
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
            activity.push(line.startsWith(DIAGRAM_TOOL_NAME) ? 'Submitting the diagram…' : line);
            if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
          }
          args.onProgress?.({ recentActivity: [...activity] });
        } catch {
          /* never let progress derivation break the run */
        }
      } else if (message.type === 'result') {
        result = message;
      }
    }

    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable diagram: ${lastRefusal}`
          : result && result.subtype !== 'success'
            ? `agent stopped (${result.subtype}) without submitting a diagram`
            : 'agent finished without calling submit_diagram';
      return fail(reason, false);
    }
    return { diagram: accepted, lastRefusal, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
