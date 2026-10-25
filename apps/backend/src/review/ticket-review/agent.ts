import type { ClaudeReviewModel } from '@pierre-review/shared';
import { config } from '../../config.js';
import { DISALLOWED_TOOLS } from '../agent.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { DISPATCH_TOOL_NAMES } from '../claude-review/specialists.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
import { submitTicketReviewShape, type SubmitTicketReviewPayload } from './schema.js';
import {
  claudeModelChoice,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolServer,
  type AgentUsageRecord,
} from '../../ai/provider.js';
import { fallbackCostUsd, ledgerByProvider, liveCostUsd, runProvider } from '../run-provider.js';

// THE TICKET REVIEW'S AGENT RUN — the SDK half. The manager (manager.ts) prepares the scratch
// working directory (MEMBERS.md) and every member's read-only worktree, builds the prompts, and
// cleans up afterwards; this module only runs the agent and returns what it submitted. It never
// touches the DB and never throws for an expected failure.
//
// THE TOOL SURFACE is the PR review's deep-review surface minus everything optional:
//   allowed     Read, Glob, Grep and the in-process `submit_ticket_review`
//   denied      the PR review's DISALLOWED_TOOLS (Write/Edit/MultiEdit/NotebookEdit, Bash, the web
//               tools — Bash outright, review/agent.ts explains why) plus the sub-agent dispatch
//               tools (a ticket review has no specialists, and the SDK's built-in agent types
//               would inherit every tool)
// Every worktree is an `additionalDirectories` root, and a PreToolUse PATH GUARD (path-guard.ts)
// denies any file path outside the working directory and those worktrees: under
// bypassPermissions nothing else confines an absolute path, and the prompt is attacker-authored.

// ON CODEX (ai/codex/kinds/tickets.ts): the SAME spec goes to the provider the manager resolved — the
// read roots are these, `submit_*` becomes the strict final answer handed to the SAME handler, the
// tool lists below are Claude's only, and the provider writes the ledger row (`ledgerByProvider`).

export const TICKET_TOOL_NAME = 'mcp__ticket__submit_ticket_review';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', TICKET_TOOL_NAME];
const ACTIVITY_LOG_CAP = 25;

export interface RunTicketAgentArgs {
  model: ClaudeReviewModel;
  cwd: string;
  worktrees: readonly string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  // The workspace's reference library, READ-ONLY (docs/REFERENCE-DOCS.md § Use in reviews). Absent ⇒
  // the run is exactly as before (no extra root, no `references` field).
  docsDir?: string | null;
  // The provider the manager resolved (and worded the prompts for). Absent ⇒ the active one.
  provider?: AgentProviderId;
  // Who the ledger row bills. A provider that records its own usage (Codex) writes it from this; on
  // Claude it is unused and the manager records the run as it always has.
  usageRecord?: AgentUsageRecord;
  onProgress(p: { recentActivity: string[]; usage: { inputTokens: number; outputTokens: number; costUsd: number } }): void;
}

export interface RunTicketAgentResult {
  submitted: boolean;
  payload: SubmitTicketReviewPayload | null;
  failureReason?: string;
  aborted: boolean;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  // The model the run was on (the provider's id for it) and whether the PROVIDER wrote the ledger row.
  // Absent (a stand-in runner in a test) ⇒ the requested model, and the manager's ledger.
  model?: string;
  ledgerByProvider?: boolean;
}

/** The tool policy for a ticket run. Pure, so the no-shell, no-dispatch rule is testable. */
export function ticketToolPolicy(): { allowedTools: string[]; disallowedTools: string[] } {
  return {
    allowedTools: [...ALLOWED_TOOLS],
    disallowedTools: [...new Set([...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES])],
  };
}

export async function runTicketReviewAgent(args: RunTicketAgentArgs): Promise<RunTicketAgentResult> {
  const { model, abortController } = args;
  const provider = runProvider(args.provider);
  const choice = claudeModelChoice(model);
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  const telemetry = (): Pick<
    RunTicketAgentResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'numTurns' | 'model' | 'ledgerByProvider'
  > => {
    const usage = outcome?.usage ?? liveUsage;
    return {
      costUsd: outcome?.costUsd ?? fallbackCostUsd(provider, model, usage),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: outcome?.numTurns ?? null,
      model: provider.resolveModel(choice),
      ledgerByProvider: ledgerByProvider(provider),
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunTicketAgentResult => ({
    submitted: false,
    payload: null,
    failureReason,
    aborted,
    ...telemetry(),
  });

  try {
    if (provider.id === 'claude') restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const docsDir = args.docsDir ?? null;
    const shape = await submitTicketReviewShape({ docs: docsDir != null });
    let captured: SubmitTicketReviewPayload | null = null;
    const tools: AgentToolServer = {
      server: 'ticket',
      tools: [
        {
          name: 'submit_ticket_review',
          description: 'Submit your verdict on the ticket. Call this EXACTLY once, at the end.',
          shape,
          handle: async (a) => {
            captured = a as unknown as SubmitTicketReviewPayload;
            return { text: 'Ticket review recorded.' };
          },
        },
      ],
    };
    // The library is a READ-ONLY root: Read/Glob/Grep may reach it, nothing else may name it.
    const policy = ticketToolPolicy();
    const activity: string[] = [];
    ({ outcome } = await provider.runAgent({
      kind: 'ticket_review',
      model: choice,
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard, first on PreToolUse — a deny holds under
      // bypassPermissions): the scratch cwd and the members' worktrees, and the reference library
      // READ-ONLY when in use.
      cwd: args.cwd,
      roots: [...args.worktrees],
      readOnlyRoots: docsDir != null ? [docsDir] : [],
      writeRoots: [],
      tools,
      budget: { usd: config.ticketReviewBudgetUsd, turns: config.ticketReviewMaxTurns },
      abortController,
      claude: { allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools },
      ...(args.usageRecord ? { usageRecord: args.usageRecord } : {}),
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          for (const line of p.lines) {
            const t = line.startsWith(TICKET_TOOL_NAME) ? 'Submitting the ticket review…' : line;
            activity.push(t);
            if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
          }
          const live = liveUsage;
          args.onProgress({
            recentActivity: [...activity],
            usage: { inputTokens: live.inputTokens, outputTokens: live.outputTokens, costUsd: liveCostUsd(provider, model, live) },
          });
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));

    if (!captured) {
      const reason =
        outcome && outcome.subtype !== 'success'
          ? `agent stopped (${outcome.subtype}) without submitting the ticket review`
          : 'agent finished without calling submit_ticket_review';
      return fail(reason, false);
    }
    return { submitted: true, payload: captured, aborted: false, ...telemetry() };
  } catch (err) {
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
