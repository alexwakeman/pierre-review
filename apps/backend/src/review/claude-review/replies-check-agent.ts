import type { ClaudeReviewModel } from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';
import { agenticRunEffort } from '../../ai/effort.js';
import {
  claudeModelChoice,
  ranOn,
  type AgentProviderId,
  type AiRanOn,
  type AgentToolServer,
  type AgentOutcome,
  type ModelChoice,
} from '../../ai/provider.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS, isJsonAnswerLine } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { estimateCostUsd } from '../pricing.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
import { DISPATCH_TOOL_NAMES } from './specialists.js';
import { codexReviewModelOverride } from '../codex-review.js';
import { runProvider } from '../run-provider.js';
import { buildSubmitRepliesShape } from './replies-check-schema.js';
import type { RepliesReport } from './replies-pass.js';

// THE REPLIES PASS — the agent half (Check threads' thread-check-agent.ts, with its own result tool).
// The manager (replies-check.ts) plans, prepares the read-only worktree and the prompt, stores and
// cleans up; this module runs ONE agent on ONE provider and returns what it submitted. It never
// touches the DB and never throws for an expected failure.
//
// THE TOOL SURFACE: Read, Glob, Grep and the in-process `submit_replies` — nothing else. Bash is
// denied outright, so are the write and web tools and the sub-agent dispatch tools; the provider's
// PreToolUse PATH GUARD confines every path to the scratch directory and the worktree (the replies
// are attacker-influenced). Connectors are isolated by the provider. The model is the STANDARD depth
// (Claude Sonnet; Codex resolves the role to its own standard model) and the effort is the ONE setting
// (Settings → AI → Effort, `agenticRunEffort`).

export const REPLIES_CHECK_TOOL_NAME = 'mcp__replies__submit_replies';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', REPLIES_CHECK_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

/** The tool policy. Pure, so the no-shell, no-dispatch rule is testable. */
export function repliesCheckToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export interface RunRepliesCheckArgs {
  model: ClaudeReviewModel;
  cwd: string;
  // [] = no checkout (the code around each line is in the prompt when it could be read).
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress?(p: { recentActivity: string[] }): void;
  usage?: { accountId: number; prId: number | null; repoId?: number | null };
  provider: AgentProviderId;
}

export interface RunRepliesCheckResult {
  submitted: boolean;
  ranOn?: AiRanOn & { effort?: string };
  replies: RepliesReport[] | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  usageRecorded?: boolean;
}

export async function runRepliesCheckAgent(args: RunRepliesCheckArgs): Promise<RunRepliesCheckResult> {
  const { model, abortController } = args;
  const provider = runProvider(args.provider);
  const onCodex = provider.id === 'codex';
  const usageRecorded = onCodex && args.usage != null;
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  const telemetry = (): Pick<RunRepliesCheckResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = outcome?.usage ?? liveUsage;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: outcome?.costUsd ?? (hasUsage ? (onCodex ? 0 : estimateCostUsd(model, usage)) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
    };
  };
  const override = onCodex ? codexReviewModelOverride() : null;
  const modelChoice: ModelChoice = override
    ? { role: claudeModelChoice(model).role, id: override.model }
    : claudeModelChoice(model);
  const mode = args.worktrees.length > 0 ? 'worktree' : 'diff_only';
  // THE ONE EFFORT SETTING, read once at the start and stored on the run.
  const levelEffort = agenticRunEffort(provider.id, modelChoice, mode);
  const effort: string = override?.effort ?? levelEffort;
  const ran = { ...ranOn(provider, modelChoice), effort };
  const fail = (failureReason: string | undefined, aborted: boolean): RunRepliesCheckResult => ({
    submitted: false,
    ranOn: ran,
    replies: null,
    failureReason,
    aborted,
    ...telemetry(),
    ...(usageRecorded ? { usageRecorded: true } : {}),
  });

  try {
    if (!onCodex) restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = buildSubmitRepliesShape(await loadZod());
    let captured: RepliesReport[] | null = null;
    const tools: AgentToolServer = {
      server: 'replies',
      tools: [
        {
          name: 'submit_replies',
          description: 'Submit your judgement of every reply. Call this EXACTLY once, at the end.',
          shape,
          handle: async (a) => {
            if (captured == null) captured = (a as { replies: RepliesReport[] }).replies ?? [];
            return { text: 'Replies recorded.' };
          },
        },
      ],
    };
    const policy = repliesCheckToolPolicy();
    const activity: string[] = [];
    ({ outcome } = await provider.runAgent({
      // The Run gate's kind: a replies pass is a thread judgement (Check threads' kind), so it runs
      // wherever Check threads can — on both providers.
      kind: 'thread_check',
      model: modelChoice,
      effort: mode,
      prompt: args.prompt,
      system: args.systemPrompt,
      cwd: args.cwd,
      roots: [...args.worktrees],
      readOnlyRoots: [],
      writeRoots: [],
      tools,
      budget: { usd: config.threadCheckBudgetUsd, turns: config.threadCheckMaxTurns },
      abortController,
      ...(args.usage
        ? {
            usageRecord: {
              accountId: args.usage.accountId,
              seam: 'agent' as const,
              feature: 'replies_check',
              prId: args.usage.prId,
              repoId: args.usage.repoId ?? null,
            },
          }
        : {}),
      codex: { resultTool: 'submit_replies', effort },
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools, effort: levelEffort },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          for (const line of p.lines) {
            const saving = line.startsWith(REPLIES_CHECK_TOOL_NAME) || (onCodex && isJsonAnswerLine(line));
            activity.push(saving ? 'Saving the judgements…' : line);
            if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
          }
          args.onProgress?.({ recentActivity: [...activity] });
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));
    if (!captured) {
      const reason =
        outcome && outcome.subtype !== 'success'
          ? `agent stopped (${outcome.subtype}) without submitting the replies`
          : 'agent finished without calling submit_replies';
      return fail(reason, false);
    }
    return { submitted: true, ranOn: ran, replies: captured, aborted: false, ...telemetry(), ...(usageRecorded ? { usageRecorded: true } : {}) };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
