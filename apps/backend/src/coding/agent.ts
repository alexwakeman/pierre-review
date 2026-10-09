import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutableOptions, loadAgentSdk, type AgentSdk } from '../ai/runtime.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import { createPathGuard, pathGuardHook } from '../review/path-guard.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import { sdkModelOptions } from '../review/model-options.js';
import { estimateCostUsd } from '../review/pricing.js';
import {
  recordUsage,
  sumModelUsage,
  sumUsageMap,
  type UsageTokens,
} from '../review/usage.js';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import type {
  GenerateFixArgs,
  GenerateFixResult,
} from '../pro/contract.js';
import { submitFixShape, type SubmitFixPayload } from './schema.js';
import { captureWorktreeDiff } from './git.js';
import { describeAssistantBlocks } from './activity.js';

// The WRITE tool surface for the fixer: Read/Glob/Grep to explore, Write/Edit/MultiEdit to
// make the change, and the submit_fix MCP tool for the prose summary. NO SHELL.
//
// ---- Bash is deliberately ABSENT (this used to include it) ----
//
// Two independent reasons, either sufficient on its own.
//
// SAFETY — the argument the comment above `WORKTREE_TOOLS` in review/agent.ts already makes at
// length, for the identical input shape. Everything this agent reads (the PR title, the description, the diff, the review
// comments — and on the `'comments'` seed, NOTHING BUT review comments) was written by whoever
// opened the pull request. Pair that with `permissionMode:'bypassPermissions'` and
// `settingSources:[]` below, which is to say nothing else was constraining the shell either, and
// a stranger's PR text becomes a remote-code-execution path on the developer's own machine. The
// blocklist that used to sit here — `Bash(rm *)`, `Bash(sudo *)`, `Bash(git push *)`,
// `Bash(git commit *)`, `Bash(git config *)` — stopped five literal prefixes and nothing else:
// "A blocklist cannot enumerate the badness of a shell."
//
// ⚠ THOSE `Bash(git …)` ENTRIES WERE ALSO THE MECHANICAL HALF OF "THE HOST OWNS THE COMMIT, NOT
// THE AGENT", and that rule is unchanged — a denied shell cannot run git at all, so a bare
// 'Bash' guarantees it strictly harder. What is gone is the grep-able evidence, so it is written
// here instead: the agent leaves its edits in the working tree, `captureWorktreeDiff` turns them
// into a patch, and coding/git-ops.ts commits and pushes THAT — after the reader picks a target.
// The prompt still says it too (WORKTREE_RULES in the plugin's ai-fix/prompts.ts).
//
// SPEED — the shell's real use here was running builds and tests, and nothing downstream ever
// read the answer: runCodingAgent's success criterion is a captured diff under
// `aiFixPatchMaxBytes`, and no column on the fix row records whether anything was verified. The
// cost was real: a suite runs against `aiFixMaxTurns` (40) and `aiFixBudgetUsd` ($5) with NO
// wall-clock limit, returns its output as a tool_result billed as input on the next turn, and
// holds the single global job slot (MAX_CONCURRENT = 1, packages/pro/src/ai-fix/manager.ts) that
// every other account's fix queues behind.
//
// ⚠ What this costs, stated plainly: a fix that wanted a codegen step, a formatter, or `git log`
// for context must now write the edit by hand or decline. That is the accepted trade — Claude
// Review made the identical one. The way back is a container/VM boundary, or `canUseTool` under a
// non-bypass permission mode — NOT re-adding 'Bash' with a longer blocklist.
const FIX_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'MultiEdit',
  'mcp__fix__submit_fix',
];
// Denied OUTRIGHT rather than by command pattern, for the reasons above. Belt and braces: Bash is
// also absent from the allow list, so there are two independent reasons it cannot run.
const DISALLOWED_TOOLS = ['Bash', 'NotebookEdit'];

// Per-model effort + thinking options: ONE table in review/model-options.ts, shared with the
// review agent (Opus 5.5 gets explicit adaptive thinking and 400s on
// disabled thinking / a thinking budget / a forced tool_choice, none of which is sent here).
const ACTIVITY_LOG_CAP = 25;

type SdkMcpServer = ReturnType<AgentSdk['createSdkMcpServer']>;

interface LiveUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function emptyUsage(): LiveUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

interface AgentRunOptions {
  worktreePath: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServers: Record<string, SdkMcpServer>;
  maxTurns: number;
  maxBudgetUsd: number;
  abortController: AbortController;
  // Called each assistant turn with the rolling activity log + live usage, so the
  // caller can map it onto its own progress phase.
  onActivity?: (
    activity: string[],
    usage: LiveUsage & { estCostUsd: number },
  ) => void;
}

interface AgentRunOutcome {
  result: SDKResultMessage | null;
  usage: LiveUsage;
  costUsd: number | null;
  numTurns: number | null;
  aborted: boolean;
}

/**
 * The Claude Agent SDK run core behind the fixer (runCodingAgent): it OWNS the sandbox
 * config (`permissionMode:'bypassPermissions'`, `settingSources:[]`, budget/turn caps,
 * whitelisted tools) and streams activity, but knows nothing about worktree prep, diff
 * capture, or git — the caller owns those. (It also used to run AI Fix's agentic conflict
 * resolver; that path was removed with the rest of AI Fix's trunk reconciliation.)
 *
 * Auth: prefers the ambient Claude session, else falls back to the user's local BYO
 * Anthropic key — the SAME advanced-AI credential policy as Claude Review
 * (applyClaudeReviewAuth), restored in `finally`. AI-Fix jobs are concurrency 1; the env
 * mutation only bites when there's no ambient auth (a BYO-key-only setup), where it and a
 * concurrent review would set the identical key.
 */
export async function runAgentInWorktree(
  opts: AgentRunOptions,
): Promise<AgentRunOutcome> {
  const model = opts.model as ClaudeReviewModel;
  const usageByUuid = new Map<string, UsageTokens>();
  let result: SDKResultMessage | null = null;

  const maxTurns = opts.maxTurns;
  // 'worktree' ⇒ config.reviewEffort, exactly the effort this path always used.
  const modelOptions = sdkModelOptions(model, 'worktree');

  // Advanced-AI credential: ambient session preferred, else the local BYO key. Restored below.
  const restoreEnv = applyClaudeReviewAuth(true);
  try {
  // From the AI runtime (ai/runtime.ts) — downloaded on first use for an npm install.
  const { query } = await loadAgentSdk();
  const q = query({
    prompt: opts.prompt,
    options: {
      model,
      ...modelOptions,
      ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      cwd: opts.worktreePath,
      permissionMode: 'bypassPermissions',
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      settingSources: [],
      mcpServers: opts.mcpServers,
      abortController: opts.abortController,
      // ⚠ THE PATH GUARD (review/path-guard.ts): file tools stay inside the worktree. Under
      // bypassPermissions nothing else confines an ABSOLUTE path, and this agent WRITES — a seed
      // item (PR text, review threads, a ticket review's items) saying "also add this to
      // ~/.zshrc" would otherwise write outside the worktree, where captureWorktreeDiff never
      // shows it to the reader.
      hooks: { PreToolUse: [pathGuardHook(createPathGuard(opts.worktreePath))] },
      // LIMN_CLAUDE_PATH → the user's own `claude` instead of the SDK's bundled binary.
      ...claudeExecutableOptions(),
    },
  });

  const activity: string[] = [];
  const pushActivity = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    activity.push(trimmed);
    if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
  };

  for await (const message of q) {
    if (message.type === 'assistant') {
      try {
        recordUsage(usageByUuid, message);
      } catch {
        /* usage shape varies — never let it break the run */
      }
      try {
        for (const line of describeAssistantBlocks(message)) pushActivity(line);
      } catch {
        /* never let progress derivation break the run */
      }
      const live = sumUsageMap(usageByUuid);
      opts.onActivity?.([...activity], {
        ...live,
        estCostUsd: estimateCostUsd(model, live),
      });
    } else if (message.type === 'result') {
      result = message;
    }
  }

  if (opts.abortController.signal.aborted) {
    return {
      result,
      usage: emptyUsage(),
      costUsd: null,
      numTurns: null,
      aborted: true,
    };
  }

  const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
  const hasUsage =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  const costUsd =
    result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null);

  return {
    result,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    },
    costUsd,
    numTurns: result?.num_turns ?? null,
    aborted: false,
  };
  } finally {
    restoreEnv();
  }
}

/**
 * Run the write-capable coding agent against a PR's head in an ephemeral worktree and
 * return the captured changeset (a binary-safe unified diff) + a prose summary. This
 * is the implementation behind ctx.coding.generateFix; it owns the worktree prep +
 * diff capture + teardown, and delegates the sandboxed SDK run to runAgentInWorktree.
 * Never commits or pushes — the host's git-ops does that later from the STORED patch.
 */
export async function runCodingAgent(
  args: GenerateFixArgs,
): Promise<GenerateFixResult> {
  const { owner, name, prNumber, baseSha, abortController, onProgress } = args;
  const model = args.model;
  const token = await getAccessToken(args.accountId);

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;

  try {
    onProgress({ phase: 'cloning' });
    ({ repoCloneDir, worktreePath } = await prepWorktree(
      owner,
      name,
      prNumber,
      baseSha,
      token,
    ));

    const { createSdkMcpServer, tool } = await loadAgentSdk();
    const fixShape = await submitFixShape();
    let captured: SubmitFixPayload | null = null;
    const server = createSdkMcpServer({
      name: 'fix',
      version: '1.0.0',
      tools: [
        tool(
          'submit_fix',
          'Report the fix you applied. Call this EXACTLY once, at the very end, after editing files.',
          fixShape,
          async (a) => {
            const p = a as unknown as SubmitFixPayload;
            captured = {
              summary: p.summary,
              commitMessage: p.commitMessage,
              // Passed through verbatim; the AI Fix manager validates refs + clips text.
              changes: p.changes,
              unaddressed: p.unaddressed,
            };
            return { content: [{ type: 'text', text: 'Fix recorded.' }] };
          },
        ),
      ],
    });

    onProgress({ phase: 'fixing' });
    const outcome = await runAgentInWorktree({
      worktreePath,
      model,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      allowedTools: FIX_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers: { fix: server },
      maxTurns: args.maxTurns ?? config.aiFixMaxTurns,
      maxBudgetUsd: args.maxBudgetUsd ?? config.aiFixBudgetUsd,
      abortController,
      onActivity: (activity, usage) =>
        onProgress({ phase: 'fixing', recentActivity: activity, usage }),
    });

    // A user cancel aborts the SDK iterator; surface a clean aborted result (the
    // manager marks the row cancelled — no worktree changes are captured).
    if (outcome.aborted || abortController.signal.aborted) {
      return {
        summary: '',
        commitMessage: '',
        patch: '',
        filesChanged: [],
        baseSha,
        usage: emptyUsage(),
        costUsd: null,
        numTurns: null,
        aborted: true,
      };
    }

    onProgress({ phase: 'capturing' });
    const { patch, filesChanged } = await captureWorktreeDiff(worktreePath);
    if (patch.length > config.aiFixPatchMaxBytes) {
      throw new Error(
        `fix patch too large (${patch.length} bytes > ${config.aiFixPatchMaxBytes})`,
      );
    }

    // A cast so the closure-assigned `captured` reads back as its declared union.
    // (TS flow-narrows it to `null` because its only assignment is inside the tool
    // callback, which it can't prove ran — a plain annotation wouldn't break that.)
    const fix = captured as SubmitFixPayload | null;
    return {
      summary:
        fix?.summary ??
        (filesChanged.length
          ? `Applied changes to ${filesChanged.length} file(s).`
          : 'The agent made no changes.'),
      commitMessage: fix?.commitMessage ?? 'AI fix',
      // Absent when the agent never called submit_fix (or reported neither list).
      report:
        fix && (fix.changes || fix.unaddressed)
          ? { changes: fix.changes, unaddressed: fix.unaddressed }
          : undefined,
      patch,
      filesChanged,
      baseSha,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      numTurns: outcome.numTurns,
      aborted: false,
    };
  } finally {
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(
        () => {},
      );
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
