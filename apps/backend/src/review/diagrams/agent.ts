import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { claudeModelChoice, getActiveProvider, type AgentToolServer } from '../../ai/provider.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS, describeAssistantBlocks } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { submitDesignShape, type SubmitDesignPayload } from './schema.js';
import { validateDesign, type AcceptedDesign, type DesignContext } from './validate.js';

// THE DESIGN-DIAGRAM AGENT RUN — the SDK half. The manager (manager.ts) reads the diffs, prepares
// the scratch working directory and the read-only checkouts, builds the prompt and cleans up; this
// module only runs the agent and returns the design it submitted. It never touches the DB and never
// throws for an expected failure.
//
// THE TOOL SURFACE is the CI review's: Read, Glob, Grep and the in-process `submit_design`; the PR
// review's DISALLOWED_TOOLS (Bash outright, every write tool, the web tools) plus the sub-agent
// dispatch tools are denied. Every checkout is an `additionalDirectories` root, and the PreToolUse
// PATH GUARD (path-guard.ts) denies any path outside them and the working directory.
//
// `submit_design` VALIDATES before it accepts (validate.ts `validateDesign`, against the run's
// `DesignContext` — its PR refs and changed files): a refused design is answered with EVERY problem
// and what to do about it, and the model may call again, at most MAX_SUBMIT_ATTEMPTS times. Only a
// design that passed is returned — the manager validates it once more before storing.

export const DIAGRAM_TOOL_NAME = 'mcp__diagram__submit_design';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', DIAGRAM_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;
export const MAX_SUBMIT_ATTEMPTS = 3;

export interface RunDiagramAgentArgs {
  model: ClaudeReviewModel;
  cwd: string;
  roots: readonly string[];
  systemPrompt: string;
  prompt: string;
  // What the answer is validated against (PR refs + their changed files).
  design: DesignContext;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress?(p: { recentActivity: string[] }): void;
}

export interface RunDiagramAgentResult {
  diagram: AcceptedDesign | null;
  // The last validation refusal, when the model never sent a usable design.
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
 * The `submit_design` handler's decision, pure: accept a valid design, or answer with what to fix.
 * After MAX_SUBMIT_ATTEMPTS refusals the tool says to stop.
 */
export function judgeSubmission(
  payload: Partial<SubmitDesignPayload>,
  attempt: number,
  ctx: DesignContext,
): { accepted: AcceptedDesign } | { reply: string; refusal: string } {
  const v = validateDesign(payload, ctx);
  if (v.ok) return { accepted: v.value };
  const last = attempt >= MAX_SUBMIT_ATTEMPTS;
  return {
    refusal: v.problems.join(' '),
    reply: last
      ? `Refused:\n${v.message}\nThat was the last attempt; stop now.`
      : `Refused:\n${v.message}\nFix every point and call submit_design again with the whole design.`,
  };
}

export async function runDiagramAgent(args: RunDiagramAgentArgs): Promise<RunDiagramAgentResult> {
  const { model, abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  let accepted: AcceptedDesign | null = null;
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
    const shape = await submitDesignShape();
    let attempts = 0;
    const tools: AgentToolServer = {
      server: 'diagram',
      tools: [
        {
          name: 'submit_design',
          description: 'Submit the one design grid. It is checked at once: a refusal lists what to fix.',
          shape,
          handle: async (a) => {
            if (accepted != null) return { text: 'Design already recorded.' };
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              return { text: 'No more attempts. Stop now.', isError: true };
            }
            attempts += 1;
            const j = judgeSubmission(a as unknown as Partial<SubmitDesignPayload>, attempts, args.design);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { text: 'Design recorded.' };
            }
            lastRefusal = j.refusal;
            return { text: j.reply, isError: true };
          },
        },
      ],
    };
    const policy = diagramToolPolicy();
    const activity: string[] = [];
    ({ result } = await getActiveProvider().runAgent({
      kind: 'diagram',
      model: claudeModelChoice(model),
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard, first on PreToolUse — a deny holds under
      // bypassPermissions): the scratch cwd and the roots, nothing else.
      cwd: args.cwd,
      roots: [...args.roots],
      readOnlyRoots: [],
      writeRoots: [],
      tools,
      budget: { usd: config.sequenceDiagramBudgetUsd, turns: config.sequenceDiagramMaxTurns },
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
              activity.push(line.startsWith(DIAGRAM_TOOL_NAME) ? 'Submitting the design…' : line);
              if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
            }
            args.onProgress?.({ recentActivity: [...activity] });
          } catch {
            /* never let progress derivation break the run */
          }
        } else if (message.type === 'result') {
          result = message;
        }
      },
    }));

    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable design: ${lastRefusal}`
          : result && result.subtype !== 'success'
            ? `agent stopped (${result.subtype}) without submitting a design`
            : 'agent finished without calling submit_design';
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
