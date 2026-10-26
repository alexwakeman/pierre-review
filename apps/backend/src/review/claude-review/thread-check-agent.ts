import type { ClaudeReviewModel } from '@pierre-review/shared';
import { loadZod } from '../../ai/runtime.js';
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
import type { ReviewThreadReport } from '../../platform/contract.js';
import { DISALLOWED_TOOLS, isJsonAnswerLine } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { estimateCostUsd } from '../pricing.js';
import { buildSubmitThreadsShape } from './thread-check-schema.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
import { DISPATCH_TOOL_NAMES } from './specialists.js';
import { codexReviewEffort, codexReviewModelOverride } from '../codex-review.js';
import { codexThreadCheckText } from '../codex-wording.js';
import { runProvider } from '../run-provider.js';

// CHECK THREADS — the SDK half (the CI review's agent.ts, one tool narrower). The manager
// (thread-check.ts) plans, prepares the read-only worktree and the prompt, and cleans up; this
// module runs the agent and returns what it submitted. It never touches the DB and never throws for
// an expected failure.
//
// THE TOOL SURFACE: Read, Glob, Grep and the in-process `submit_threads` — nothing else. Bash is
// denied outright (review/agent.ts explains why), so are the write and web tools and the sub-agent
// dispatch tools. A PreToolUse PATH GUARD confines every file path to the scratch directory and the
// worktree (the thread text is attacker-influenced). The account's claude.ai connectors are isolated.

export const THREAD_CHECK_TOOL_NAME = 'mcp__threads__submit_threads';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', THREAD_CHECK_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

// The `submit_threads` shape lives in ./thread-check-schema.ts (the result-schema registry builds it
// from there); re-exported under its old home.
export { buildSubmitThreadsShape };

/** The tool policy for a check. Pure, so the no-shell, no-dispatch rule is testable. */
export function threadCheckToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export interface RunThreadCheckArgs {
  model: ClaudeReviewModel;
  cwd: string;
  // [] = diff-only (the checkout could not be prepared).
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress(p: { recentActivity: string[]; usage: { inputTokens: number; outputTokens: number; costUsd: number } }): void;
  // Who to bill, for a provider that writes its own ledger row (Codex; ai/provider.ts `usageRecord`).
  usage?: { accountId: number; prId: number | null; repoId?: number | null };
  // The provider to run on (the check's own, `thread-check.ts` Job). Absent ⇒ the default.
  provider?: AgentProviderId | null;
}

export interface RunThreadCheckResult {
  submitted: boolean;
  // What RAN (ai/provider.ts `ranOn`): stored on the run row. Optional for fakes in tests.
  ranOn?: AiRanOn;
  threads: ReviewThreadReport[] | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  // True when the provider already wrote the run's ledger row (Codex): the manager must not again.
  usageRecorded?: boolean;
}

export async function runThreadCheckAgent(args: RunThreadCheckArgs): Promise<RunThreadCheckResult> {
  const { model, abortController } = args;
  // THE PROVIDER, asked once (LIMN_AI_PROVIDER). `onCodex` is the Codex port (docs/CODEX-PLAN.md Phase
  // 3, stream a); with Claude active none of it runs and the check is exactly what it was.
  const provider = runProvider(args.provider);
  const onCodex = provider.id === 'codex';
  const usageRecorded = onCodex && args.usage != null;
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  const telemetry = (): Pick<RunThreadCheckResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns'> => {
    const usage = outcome?.usage ?? liveUsage;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      // ⚠ Codex tokens are never priced as Claude's: its outcome carries its own US$ (0 on ChatGPT).
      costUsd: outcome?.costUsd ?? (hasUsage ? (onCodex ? 0 : estimateCostUsd(model, usage)) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
    };
  };
  // The model choice, resolved before anything can fail, so every result names what RAN (`ranOn`).
  const override = onCodex ? codexReviewModelOverride() : null;
  const modelChoice: ModelChoice = override
    ? { role: claudeModelChoice(model).role, id: override.model }
    : claudeModelChoice(model);
  const ran = ranOn(provider, modelChoice);
  const fail = (failureReason: string | undefined, aborted: boolean): RunThreadCheckResult => ({
    submitted: false,
    ranOn: ran,
    threads: null,
    failureReason,
    aborted,
    ...telemetry(),
    ...(usageRecorded ? { usageRecorded: true } : {}),
  });

  try {
    // Codex: its child gets its own allow-listed environment (ai/codex/config.ts), never this one.
    if (!onCodex) restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shape = buildSubmitThreadsShape(await loadZod());
    let captured: ReviewThreadReport[] | null = null;
    const tools: AgentToolServer = {
      server: 'threads',
      tools: [
        {
          name: 'submit_threads',
          description: 'Submit your judgement of every review thread. Call this EXACTLY once, at the end.',
          shape,
          handle: async (a) => {
            if (captured == null) captured = (a as { threads: ReviewThreadReport[] }).threads ?? [];
            return { text: 'Threads recorded.' };
          },
        },
      ],
    };
    const policy = threadCheckToolPolicy();
    const activity: string[] = [];
    const effort = args.worktrees.length > 0 ? 'worktree' : 'diff_only';
    // Codex: the prompts in Codex's words (codex-wording.ts), the role's effort (one step lower with no
    // checkout), its own ledger row.
    ({ outcome } = await provider.runAgent({
      kind: 'thread_check',
      model: modelChoice,
      effort,
      prompt: onCodex ? codexThreadCheckText(args.prompt) : args.prompt,
      system: onCodex ? codexThreadCheckText(args.systemPrompt) : args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard, first on PreToolUse — a deny holds under
      // bypassPermissions): the scratch cwd and the worktrees, nothing else.
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
              feature: 'thread_check',
              prId: args.usage.prId,
              repoId: args.usage.repoId ?? null,
            },
          }
        : {}),
      codex: { resultTool: 'submit_threads', effort: override?.effort ?? codexReviewEffort(modelChoice.role, effort) },
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          for (const line of p.lines) {
            // Codex's final answer arrives as a message (the JSON itself): worded as the save step too.
            const saving = line.startsWith(THREAD_CHECK_TOOL_NAME) || (onCodex && isJsonAnswerLine(line));
            activity.push(saving ? 'Saving the judgements…' : line);
            if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
          }
          const live = liveUsage;
          args.onProgress({
            recentActivity: [...activity],
            usage: { inputTokens: live.inputTokens, outputTokens: live.outputTokens, costUsd: onCodex ? 0 : estimateCostUsd(model, live) },
          });
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));

    if (!captured) {
      const reason =
        outcome && outcome.subtype !== 'success'
          ? `agent stopped (${outcome.subtype}) without submitting the threads`
          : 'agent finished without calling submit_threads';
      return fail(reason, false);
    }
    return { submitted: true, ranOn: ran, threads: captured, aborted: false, ...telemetry(), ...(usageRecorded ? { usageRecorded: true } : {}) };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
