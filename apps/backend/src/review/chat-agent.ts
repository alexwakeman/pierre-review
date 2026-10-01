import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutableOptions, loadAgentSdk } from '../ai/runtime.js';
import type { ReviewChatArgs, ReviewChatResult } from '../pro/contract.js';
import { config } from '../config.js';
import { applyClaudeReviewAuth } from './auth.js';
import { cleanupCloneCache, prepWorktree, removeWorktreeLocked } from './clone-manager.js';
import { sdkModelOptions } from './model-options.js';
import { estimateCostUsd } from './pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from './usage.js';

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

/** The tool surface for one chat turn — exported so a test can pin it without running an agent. */
export function chatToolsFor(mode: ReviewChatArgs['mode']): {
  allowedTools: string[];
  disallowedTools: string[];
} {
  return {
    allowedTools: [...(mode === 'worktree' ? CHAT_WORKTREE_TOOLS : CHAT_DIFF_ONLY_TOOLS)],
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
    const { allowedTools, disallowedTools } = chatToolsFor(mode);
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // From the AI runtime (ai/runtime.ts); a missing one throws into the catch below.
    const { query } = await loadAgentSdk();
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
        tools: allowedTools,
        allowedTools,
        disallowedTools,
        maxTurns,
        maxBudgetUsd: config.reviewChatBudgetUsd,
        settingSources: [],
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
