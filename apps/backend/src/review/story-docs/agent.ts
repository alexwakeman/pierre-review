import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { STORY_DOCS_ALIGNMENT_MODEL, type ClaudeReviewModel } from '@pierre-review/shared';
import { claudeExecutableOptions, loadAgentSdk } from '../../ai/runtime.js';
import { agentAuthOptions } from '../../ai/credentials.js';
import { ISOLATED_MCP, ownToolsOnlyHook } from '../../ai/agent-isolation.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { sdkModelOptions } from '../model-options.js';
import { createPathGuard, pathGuardHook } from '../path-guard.js';
import { estimateCostUsd } from '../pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../usage.js';
import { STORY_DOCS_TOOL_NAME } from './prompts.js';
export { storyDocsRoots } from './prompts.js';
import { submitAlignmentShape } from './schema.js';
import { alignmentShapeProblems, type AlignmentContext } from './validate.js';

// THE STORY DOCS READ — the SDK half (a copy of diagrams/agent.ts). Reached ONLY through a lazy
// `await import('./agent.js')` from the manager, so booting the server never loads the SDK.
//
// TOOLS: Read, Glob, Grep and the in-process `submit_alignment`; Bash, every write tool, the web tools
// and sub-agent dispatch are DENIED. CONFINEMENT: the PreToolUse PATH GUARD, with the SHORTLISTED
// DOCUMENTS' FOLDERS as its only READ-ONLY roots (`storyDocsRoots`) — never the library folder itself,
// so INDEX.md and every other document are unreachable. The working directory is an empty scratch dir.
//
// `submit_alignment` refuses SHAPE problems only (validate.ts `alignmentShapeProblems`), at most
// MAX_SUBMIT_ATTEMPTS times. Grounding is NOT judged here: a quote that does not check out is dropped at
// storage and the model is simply told "Recorded." — so a mismatch cannot loop.

export const STORY_DOCS_TOOL = `mcp__storydocs__${STORY_DOCS_TOOL_NAME}`;
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', STORY_DOCS_TOOL];
export const MAX_SUBMIT_ATTEMPTS = 3;

/** The tool policy. Pure, so the no-shell, no-write, no-dispatch rule is pinned by a test. */
export function storyDocsToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

/** The tool's decision, pure: accept, or answer with what to fix (shape only). */
export function judgeSubmission(
  payload: unknown,
  attempt: number,
  ctx: AlignmentContext,
): { accepted: unknown } | { reply: string; refusal: string } {
  const problems = alignmentShapeProblems(payload, ctx);
  if (problems.length === 0) return { accepted: payload };
  const message = problems.map((p) => `- ${p}`).join('\n');
  return {
    refusal: problems.join(' '),
    reply:
      attempt >= MAX_SUBMIT_ATTEMPTS
        ? `Refused:\n${message}\nThat was the last attempt; stop now.`
        : `Refused:\n${message}\nFix every point and call ${STORY_DOCS_TOOL_NAME} again with the whole answer.`,
  };
}

export interface RunStoryDocsAgentArgs {
  cwd: string;
  roots: readonly string[];
  systemPrompt: string;
  prompt: string;
  alignment: AlignmentContext;
  applyAuthEnv: boolean;
  abortController: AbortController;
  model?: ClaudeReviewModel;
}

export interface RunStoryDocsAgentResult {
  payload: unknown | null;
  lastRefusal: string | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

export async function runStoryDocsAgent(args: RunStoryDocsAgentArgs): Promise<RunStoryDocsAgentResult> {
  const model = args.model ?? (STORY_DOCS_ALIGNMENT_MODEL as ClaudeReviewModel);
  const { abortController } = args;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  let accepted: unknown | null = null;
  let lastRefusal: string | null = null;
  const telemetry = (): Pick<RunStoryDocsAgentResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunStoryDocsAgentResult => ({
    payload: null,
    lastRefusal,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const shape = await submitAlignmentShape();
    let attempts = 0;
    const server = createSdkMcpServer({
      name: 'storydocs',
      version: '1.0.0',
      tools: [
        tool(
          STORY_DOCS_TOOL_NAME,
          'Submit the whole check of the story against the docs. Its shape is checked at once: a refusal lists what to fix.',
          shape,
          async (a) => {
            if (accepted != null) return { content: [{ type: 'text', text: 'Already recorded.' }] };
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              return { content: [{ type: 'text', text: 'No more attempts. Stop now.' }], isError: true };
            }
            attempts += 1;
            const j = judgeSubmission(a, attempts, args.alignment);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { content: [{ type: 'text', text: 'Recorded.' }] };
            }
            lastRefusal = j.refusal;
            return { content: [{ type: 'text', text: j.reply }], isError: true };
          },
        ),
      ],
    });
    // ⚠ THE CONFINEMENT LIVES HERE, not in the prompt: a PreToolUse deny holds under bypassPermissions.
    const guard = createPathGuard(args.cwd, [], { readOnlyRoots: args.roots });
    const policy = storyDocsToolPolicy();
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
        maxTurns: config.storyDocsMaxTurns,
        hooks: { PreToolUse: [pathGuardHook(guard), ownToolsOnlyHook(['storydocs'])] },
        maxBudgetUsd: config.storyDocsBudgetUsd,
        settingSources: [],
        ...ISOLATED_MCP,
        mcpServers: { storydocs: server },
        abortController,
        ...claudeExecutableOptions(),
        ...agentAuthOptions(),
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

    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable answer: ${lastRefusal}`
          : result && result.subtype !== 'success'
            ? `agent stopped (${result.subtype}) without submitting`
            : `agent finished without calling ${STORY_DOCS_TOOL_NAME}`;
      return fail(reason, false);
    }
    return { payload: accepted, lastRefusal, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
