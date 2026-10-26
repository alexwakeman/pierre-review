import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeModelChoice,
  getActiveProvider,
  ranOn,
  type AgentToolServer,
  type AgentOutcome,
  type ModelChoice,
} from '../ai/provider.js';
import type { ReviewChatArgs, ReviewChatResult } from '../platform/contract.js';
import { config } from '../config.js';
import { applyClaudeReviewAuth } from './auth.js';
import { cleanupCloneCache, prepWorktree, removeWorktreeLocked } from './clone-manager.js';
import { estimateCostUsd } from './pricing.js';
import { emptyUsage, type UsageTokens } from './usage.js';
import { submitExplanationsShape } from './claude-review/chat-explain.js';
import { codexReviewEffort, codexReviewModelOverride } from './codex-review.js';
import { codexChatText } from './codex-wording.js';

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
  // THE PROVIDER, asked once (LIMN_AI_PROVIDER). `onCodex` is the Codex port (docs/CODEX-PLAN.md Phase
  // 3, stream a); with Claude active none of it runs and the turn is exactly what it was.
  const provider = getActiveProvider();
  const onCodex = provider.id === 'codex';
  // Codex writes its own ledger row when told who to bill; chat.ts must then not write one too.
  const usageRecorded = onCodex && args.usage != null;
  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let lastText = '';
  let submitted: unknown = undefined;
  let liveUsage: UsageTokens = emptyUsage();

  const telemetry = (): Pick<
    ReviewChatResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'
  > => {
    const usage = outcome?.usage ?? liveUsage;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      // ⚠ Codex tokens are never priced as Claude's: its outcome carries its own US$ (0 on ChatGPT).
      costUsd: outcome?.costUsd ?? (hasUsage ? (onCodex ? 0 : estimateCostUsd(model, usage)) : null),
      // Input as the reader would count it: fresh + cache reads + cache writes.
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
    };
  };
  // The model choice, resolved before anything can fail, so every answer names what RAN (`ranOn`).
  const override = onCodex ? codexReviewModelOverride() : null;
  const modelChoice: ModelChoice = override
    ? { role: claudeModelChoice(model).role, id: override.model }
    : claudeModelChoice(model);
  const ran = ranOn(provider, modelChoice);
  const fail = (failureReason: string | undefined, aborted: boolean): ReviewChatResult => ({
    ok: false,
    ranOn: ran,
    text: '',
    failureReason,
    ...telemetry(),
    aborted,
    ...(usageRecorded ? { usageRecorded: true } : {}),
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
    // Codex: its child gets its own allow-listed environment (ai/codex/config.ts), never this one.
    if (!onCodex) restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // THROUGH THE PROVIDER (ai/provider.ts; Claude's is ai/providers/claude.ts). From the AI runtime
    // (ai/runtime.ts); a missing one throws into the catch below.
    let tools: AgentToolServer | undefined;
    if (args.explain) {
      const shape = await submitExplanationsShape();
      tools = {
        server: 'chat',
        tools: [
          {
            name: 'submit_explanations',
            description: 'Submit one card per item the developer asked about. Call this EXACTLY once, at the end.',
            shape,
            handle: (a) => {
              submitted = a;
              return { text: 'Explanations recorded.' };
            },
          },
        ],
      };
    }
    // Codex: the same prompts in Codex's words (codex-wording.ts), the review's own depth (the role,
    // one effort step lower on a diff-only review), its own ledger row.
    ({ outcome } = await provider.runAgent({
      kind: 'review_chat',
      model: modelChoice,
      effort: mode,
      prompt: onCodex ? codexChatText(args.prompt) : args.prompt,
      system: onCodex ? codexChatText(args.systemPrompt) : args.systemPrompt,
      // ⚠ The same PATH GUARD the review runs under (review/path-guard.ts), put first on PreToolUse
      // by the provider: under bypassPermissions nothing else confines an absolute path, so the
      // file tools may read cwd and nothing else.
      cwd,
      roots: [],
      readOnlyRoots: [],
      writeRoots: [],
      ...(tools ? { tools } : {}),
      budget: { usd: config.reviewChatBudgetUsd, turns: maxTurns },
      abortController,
      ...(args.usage
        ? {
            usageRecord: {
              accountId: args.usage.accountId,
              seam: 'agent' as const,
              feature: 'claude_review_chat',
              prId: args.usage.prId,
              repoId: args.usage.repoId ?? null,
            },
          }
        : {}),
      codex: {
        ...(tools ? { resultTool: 'submit_explanations' } : {}),
        effort: override?.effort ?? codexReviewEffort(modelChoice.role, mode),
      },
      // `tools` is the BASE SET the model can see at all ([] = no built-in tools); allowedTools
      // only skips prompts. Both say the same thing, plus the deny list.
      claude: { builtinTools, allowedTools, disallowedTools },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          if (p.text) lastText = p.text;
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));

    if (args.explain) {
      if (submitted === undefined) {
        const reason =
          outcome && outcome.subtype !== 'success'
            ? `agent stopped (${outcome.subtype}) without submitting explanations`
            : 'agent finished without calling submit_explanations';
        return fail(reason, false);
      }
      // Codex: the step text IS the final JSON answer, not prose; the cards carry the answer.
      const text = onCodex ? '' : lastText.trim();
      return { ok: true, ranOn: ran, text, submitted, ...telemetry(), aborted: false, ...(usageRecorded ? { usageRecorded: true } : {}) };
    }
    const finalText =
      outcome?.text?.trim()
        ? outcome.text.trim()
        : lastText.trim();
    if (!finalText) {
      const reason =
        outcome && outcome.subtype !== 'success'
          ? `agent stopped (${outcome.subtype}) without answering`
          : 'agent finished without answering';
      return fail(reason, false);
    }
    return { ok: true, ranOn: ran, text: finalText, ...telemetry(), aborted: false, ...(usageRecorded ? { usageRecorded: true } : {}) };
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
