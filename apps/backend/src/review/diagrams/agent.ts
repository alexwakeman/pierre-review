import type { ClaudeReviewModel } from '@pierre-review/shared';
import { either } from '../../ai/prompt-tools.js';
import {
  claudeModelChoice,
  getActiveProvider,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolServer,
  type AgentUsageRecord,
} from '../../ai/provider.js';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { estimateCostUsd } from '../pricing.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
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
// `DesignContext` — its PR refs and changed files): a refused flow is answered with EVERY problem
// and what to do about it, and the model may call again, at most MAX_SUBMIT_ATTEMPTS times. Only an
// answer that passed is returned — a data-flow diagram, or a DECLINE (`noDiagram`: no data moves
// through the change, with its reason) — and the manager validates it once more before storing.
//
// ON CODEX (docs/CODEX-PLAN.md Phase 3, kind 'diagram'): the same run through the active provider's
// `runAgent`. Codex has no `submit_design` tool: its final message IS the design, checked against the
// strict schema of the SAME shape and handed to the SAME handler (so `validateDesign` judges it), one
// refused answer retried on the thread. Reads go through Limn's workspace MCP server, confined to the
// same roots the Claude path guard allows. Codex records its own ledger row (`usageRecord`), so the
// manager records none for a Codex run (`provider`).

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
  // `steps` counts every tool step so far; `submitted` while the model's latest step sent a design
  // (on Codex, its final answer).
  onProgress?(p: { recentActivity: string[]; steps: number; submitted: boolean }): void;
  /** Who to bill. A provider that records its own usage (Codex) writes the ledger row from it. */
  usageRecord?: AgentUsageRecord;
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
  /** Which provider ran it. 'codex' ⇒ its ledger row is already written. */
  provider: AgentProviderId;
  /** The model id that ran (the provider's for the requested model) — what the row stores. */
  model: string;
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
  provider: AgentProviderId = 'claude',
): { accepted: AcceptedDesign } | { reply: string; refusal: string } {
  const v = validateDesign(payload, ctx);
  if (v.ok) return { accepted: v.value };
  const last = attempt >= MAX_SUBMIT_ATTEMPTS;
  return {
    refusal: v.problems.join(' '),
    reply: last
      ? `Refused:\n${v.message}\nThat was the last attempt; stop now.`
      : `Refused:\n${v.message}\n${either('Fix every point and call submit_design again with the whole design.', 'Fix every point and answer again with the whole design.', provider)}`,
  };
}

export async function runDiagramAgent(args: RunDiagramAgentArgs): Promise<RunDiagramAgentResult> {
  const { model, abortController } = args;
  // Who runs it (the same LIMN_AI_PROVIDER read the run's own `getActiveProvider()` makes): its words
  // in the handlers' replies, and whether its ledger row is already written.
  const provider = getActiveProvider();
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  let accepted: AcceptedDesign | null = null;
  let lastRefusal: string | null = null;
  const ranModel = provider.resolveModel(claudeModelChoice(model));
  const telemetry = (): Pick<RunDiagramAgentResult, 'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns' | 'provider' | 'model'> => {
    const usage = outcome?.usage ?? liveUsage;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: outcome?.costUsd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
      provider: provider.id,
      model: ranModel,
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
          description:
            'Submit the one data-flow diagram, or noDiagram with the reason when no data moves through the change. It is checked at once: a refusal lists what to fix.',
          shape,
          handle: async (a) => {
            if (accepted != null) return { text: 'Design already recorded.' };
            if (attempts >= MAX_SUBMIT_ATTEMPTS) {
              return { text: 'No more attempts. Stop now.', isError: true };
            }
            attempts += 1;
            const j = judgeSubmission(a as unknown as Partial<SubmitDesignPayload>, attempts, args.design, provider.id);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { text: j.accepted.declined != null ? 'Recorded: no diagram.' : 'Design recorded.' };
            }
            lastRefusal = j.refusal;
            return { text: j.reply, isError: true };
          },
        },
      ],
    };
    const policy = diagramToolPolicy();
    const activity: string[] = [];
    let steps = 0;
    let submitted = false;
    ({ outcome } = await getActiveProvider().runAgent({
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
      // Codex: the design is the run's final answer (the strict `submit_design` schema).
      codex: { resultTool: 'submit_design' },
      ...(args.usageRecord ? { usageRecord: args.usageRecord } : {}),
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          try {
            for (const line of p.lines) {
              // Codex has no submit tool: its final message (the JSON design) reads as the same line.
              const submitting = line.startsWith(DIAGRAM_TOOL_NAME) || (provider.id === 'codex' && line.startsWith('{'));
              activity.push(submitting ? 'Submitting the design…' : line);
              if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
              // The LAST line decides: a refused design sends the model back to reading.
              submitted = submitting;
              if (!submitting) steps += 1;
            }
            args.onProgress?.({ recentActivity: [...activity], steps, submitted });
          } catch {
            /* never let a progress listener break the run */
          }
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));

    if (accepted == null) {
      const reason =
        lastRefusal != null
          ? `no usable design: ${lastRefusal}`
          : outcome && outcome.subtype !== 'success'
            ? `agent stopped (${outcome.subtype}) without submitting a design`
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
