import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutableOptions, loadAgentSdk } from '../ai/runtime.js';
import type { ReviewChatArgs, ReviewChatResult } from '../pro/contract.js';
import { config } from '../config.js';
import { applyClaudeReviewAuth } from './auth.js';
import { cleanupCloneCache, prepWorktree, removeWorktreeLocked } from './clone-manager.js';
import { createPathGuard, pathGuardHook } from './path-guard.js';
import { sdkModelOptions } from './model-options.js';
import { estimateCostUsd } from './pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from './usage.js';
import { submitExplanationsShape } from './claude-review/chat-explain.js';

// ctx.review.chat — ONE answered question about a succeeded Claude Review. The plugin owns the
// product (the prompt, the stored transcript, gating, metering); core owns the run, exactly as for
// runReview (agent.ts), and MIRRORS the review's own mode:
//
//   • worktree review → Read/Glob/Grep on a worktree checked out at the REVIEWED head, so "where
//     else is this called?" reads the code the findings were written against, never newer code.
//   • diff-only review → TOOL-LESS: the diff is in the prompt and there is nothing to explore.
//
// ⚠ BASH IS DENIED OUTRIGHT, for the reason agent.ts spells out at length: every byte of the
// review's grounding came from whoever opened the pull request, and `bypassPermissions` plus a
// shell is remote code execution on the developer's machine. It is absent from the allow list AND
// on the deny list — two independent reasons it cannot run (three: the SDK's `tools` base set is
// pinned to the same list, so nothing else is even offered). Never widen this surface.
export const CHAT_WORKTREE_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep'];
export const CHAT_DIFF_ONLY_TOOLS: readonly string[] = [];
export const CHAT_DISALLOWED_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Task',
];

// An EXPLAIN turn's one extra tool: the in-process structured answer (chat-explain.ts). It reads and
// writes nothing — it only hands the cards back to this process.
export const CHAT_EXPLAIN_TOOL_NAME = 'mcp__chat__submit_explanations';
const EXPLAIN_EXTRA_TURNS = 4;

/** The tool surface for one chat turn — exported so a test can pin it without running an agent. */
export function chatToolsFor(
  mode: ReviewChatArgs['mode'],
  explain = false,
): {
  // The built-in base set (`tools`): never the MCP tool, never a shell.
  builtinTools: string[];
  allowedTools: string[];
  disallowedTools: string[];
} {
  const builtin = [...(mode === 'worktree' ? CHAT_WORKTREE_TOOLS : CHAT_DIFF_ONLY_TOOLS)];
  return {
    builtinTools: builtin,
    allowedTools: explain ? [...builtin, CHAT_EXPLAIN_TOOL_NAME] : builtin,
    disallowedTools: [...CHAT_DISALLOWED_TOOLS],
  };
}

export async function runReviewChat(args: ReviewChatArgs): Promise<ReviewChatResult> {
  const { model, mode, abortController } = args;
  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  let lastText = '';
  let submitted: unknown = undefined;
  const usageByUuid = new Map<string, UsageTokens>();

  const telemetry = (): Pick<
    ReviewChatResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'
  > => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      // Input as the reader would count it: fresh + cache reads + cache writes.
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): ReviewChatResult => ({
    ok: false,
    text: '',
    failureReason,
    ...telemetry(),
    aborted,
  });

  try {
    let cwd: string;
    let maxTurns: number;
    if (mode === 'worktree') {
      ({ repoCloneDir, worktreePath } = await prepWorktree(
        args.owner,
        args.name,
        args.prNumber,
        args.headSha,
      ));
      cwd = worktreePath;
      maxTurns = config.reviewChatMaxTurns;
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'pierre-review-chat-'));
      cwd = tempCwd;
      maxTurns = config.reviewChatDiffOnlyMaxTurns;
    }
    // An explain turn spends one more turn on the submit call and usually reads a file per item.
    if (args.explain) maxTurns += EXPLAIN_EXTRA_TURNS;
    const { builtinTools, allowedTools, disallowedTools } = chatToolsFor(mode, args.explain === true);
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // From the AI runtime (ai/runtime.ts); a missing one throws into the catch below.
    const { query, createSdkMcpServer, tool } = await loadAgentSdk();
    let mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
    if (args.explain) {
      const shape = await submitExplanationsShape();
      mcpServers = {
        chat: createSdkMcpServer({
          name: 'chat',
          version: '1.0.0',
          tools: [
            tool(
              'submit_explanations',
              'Submit one card per item the developer asked about. Call this EXACTLY once, at the end.',
              shape,
              async (a) => {
                submitted = a;
                return { content: [{ type: 'text', text: 'Explanations recorded.' }] };
              },
            ),
          ],
        }),
      };
    }
    const q = query({
      prompt: args.prompt,
      options: {
        model,
        ...sdkModelOptions(model, mode),
        systemPrompt: args.systemPrompt,
        cwd,
        permissionMode: 'bypassPermissions',
        // `tools` is the BASE SET the model can see at all ([] = no built-in tools); allowedTools
        // only skips prompts. Both say the same thing, plus the deny list.
        tools: builtinTools,
        allowedTools,
        disallowedTools,
        maxTurns,
        maxBudgetUsd: config.reviewChatBudgetUsd,
        settingSources: [],
        // ⚠ The same PATH GUARD the review runs under (review/path-guard.ts): under
        // bypassPermissions nothing else confines an absolute path, so the file tools may read
        // cwd and nothing else.
        hooks: { PreToolUse: [pathGuardHook(createPathGuard(cwd, []))] },
        ...(mcpServers ? { mcpServers } : {}),
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
        const text = assistantText(message);
        if (text) lastText = text;
      } else if (message.type === 'result') {
        result = message;
      }
    }

    if (args.explain) {
      if (submitted === undefined) {
        const reason =
          result && result.subtype !== 'success'
            ? `agent stopped (${result.subtype}) without submitting explanations`
            : 'agent finished without calling submit_explanations';
        return fail(reason, false);
      }
      return { ok: true, text: lastText.trim(), submitted, ...telemetry(), aborted: false };
    }
    const finalText =
      result && result.subtype === 'success' && typeof result.result === 'string' && result.result.trim()
        ? result.result.trim()
        : lastText.trim();
    if (!finalText) {
      const reason =
        result && result.subtype !== 'success'
          ? `agent stopped (${result.subtype}) without answering`
          : 'agent finished without answering';
      return fail(reason, false);
    }
    return { ok: true, text: finalText, ...telemetry(), aborted: false };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(args.owner, args.name, repoCloneDir, worktreePath).catch(
        () => {},
      );
    }
    if (tempCwd) {
      try {
        rmSync(tempCwd, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    if (repoCloneDir) {
      setImmediate(() => {
        try {
          cleanupCloneCache();
        } catch {
          /* advisory cleanup — never surface */
        }
      });
    }
  }
}

/** The text blocks of one assistant message, joined. Defensive — the SDK shape varies. */
function assistantText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}
