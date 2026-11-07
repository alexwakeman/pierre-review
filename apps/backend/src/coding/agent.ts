import {
  claudeModelChoice,
  getActiveProvider,
  getProvider,
  type AgentKind,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolServer,
  type AgentUsageRecord,
  type CodexRunOptions,
} from '../ai/provider.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import { estimateCostUsd } from '../review/pricing.js';
import type { UsageTokens } from '../review/usage.js';
import type { AiEffort, ClaudeReviewModel } from '@pierre-review/shared';
import { withPartialSpend } from './partial-spend.js';

// THE HOST-SIDE AGENT RUN IN A WORKTREE, used ONLY by Resolve with Claude (coding/ai-resolve/run.ts,
// read-only, its own `submit_resolution` tool and its own READ_TOOLS / DENIED_TOOLS lists). It has NO
// SHELL: the caller's deny list carries Bash. AI Fix and Implement no longer run here — both are a
// sandboxed workspace session (sandbox/session/; docs/SANDBOX.md), the ONE place an agent has a shell.

const ACTIVITY_LOG_CAP = 25;

export interface LiveUsage {
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
  /** Which agent this is (ai/provider.ts `AgentKind`). */
  kind: AgentKind;
  worktreePath: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** The run's result tool server (`submit_resolution`). */
  tools: AgentToolServer;
  /** True ⇒ the run may write inside the worktree; false ⇒ read-only (Resolve with Claude). */
  writes: boolean;
  /** Folders the run may READ but never write. Absent ⇒ none. */
  readOnlyRoots?: string[];
  maxTurns: number;
  maxBudgetUsd: number;
  abortController: AbortController;
  // Called each assistant turn with the rolling activity log + live usage, so the
  // caller can map it onto its own progress phase.
  onActivity?: (
    activity: string[],
    usage: LiveUsage & { estCostUsd: number },
  ) => void;
  /**
   * Which provider runs it (the one the prompt was worded for). Absent ⇒ the active provider
   * (ai/provider.ts `getActiveProvider`).
   */
  provider?: AgentProviderId;
  /**
   * Who to bill. A provider that records its own usage (Codex) writes the ledger row from it, and
   * the result says so (`usageRecorded`) so the caller does not write a second. Claude ignores it:
   * its callers record from the returned US$.
   */
  usageRecord?: AgentUsageRecord;
  /** Codex-only knobs. Claude ignores them. */
  codex?: CodexRunOptions;
  /** The run's effort on either provider (ai/effort.ts). Absent ⇒ each provider's Default. */
  effort?: AiEffort;
}

interface AgentRunOutcome {
  /** How the run ended (the provider's neutral outcome), or null when it never said. */
  outcome: AgentOutcome | null;
  usage: LiveUsage;
  costUsd: number | null;
  numTurns: number | null;
  aborted: boolean;
  /** Which provider ran it. */
  provider: AgentProviderId;
  /** True ⇒ the provider already wrote this run's ledger row (Codex): the caller must not write one. */
  usageRecorded: boolean;
}

/**
 * The agent run core: the provider OWNS the isolation config (`permissionMode:'bypassPermissions'`,
 * `settingSources:[]`, budget/turn caps, the caller's tool lists) and streams activity; this knows
 * nothing about worktree prep or git — the caller owns those.
 *
 * Auth: the credential ladder (applyClaudeReviewAuth), restored in `finally`. The env mutation only
 * bites with no ambient login (an API-key-only setup), where a concurrent run would set the identical
 * key; Resolve with Claude runs one at a time per PR.
 */
export async function runAgentInWorktree(
  opts: AgentRunOptions,
): Promise<AgentRunOutcome> {
  const model = opts.model as ClaudeReviewModel;
  let liveUsage: UsageTokens = emptyUsage();
  let outcome: AgentOutcome | null = null;
  const provider = opts.provider ? getProvider(opts.provider) : getActiveProvider();
  // CODEX (docs/CODEX-PLAN.md Phase 3): its tokens are never Claude-priced. On a ChatGPT sign-in a run
  // costs US$ 0 (the budget's share is token-weighted, ai/budget.ts), and the provider reports its
  // own US$ on the outcome — so nothing below estimates a Codex run with Claude's price table. It
  // records its own ledger row when given `usageRecord` (ai/providers/codex.ts), even for a run that
  // failed or was cancelled.
  const isCodex = provider.id === 'codex';
  const usageRecorded = isCodex && opts.usageRecord != null;
  const priceOf = (u: UsageTokens): number => (isCodex ? (outcome?.costUsd ?? 0) : estimateCostUsd(model, u));

  // The credential ladder (ai/credentials.ts): the Claude Code login, else ANTHROPIC_API_KEY. Restored
  // below. (Claude's only: a Codex run's environment is built by its provider from Limn's Codex home.)
  const restoreEnv = isCodex ? () => {} : applyClaudeReviewAuth(true);
  try {
  const activity: string[] = [];
  const pushActivity = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    activity.push(trimmed);
    if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
  };

  // What the run has spent so far, from the streamed assistant turns. A cancelled or failed run
  // still bills: the caller records this.
  const spentSoFar = (): { usage: LiveUsage; costUsd: number | null; usageRecorded?: boolean } => {
    // Codex emits its whole-run outcome before it throws: its tokens beat the live tally.
    const u = { ...(isCodex && outcome?.usage ? outcome.usage : liveUsage) };
    const has = u.inputTokens + u.outputTokens + u.cacheReadTokens > 0;
    return { usage: u, costUsd: has ? priceOf(u) : null, ...(usageRecorded ? { usageRecorded } : {}) };
  };

  try {
  // THROUGH THE PROVIDER (ai/provider.ts; Claude's is ai/providers/claude.ts). It OWNS the sandbox
  // config (`permissionMode:'bypassPermissions'`, `settingSources:[]`, the isolated MCP config) and
  // puts ⚠ THE PATH GUARD first on PreToolUse: file tools stay inside the worktree (cwd, no other
  // root). Under bypassPermissions nothing else confines an ABSOLUTE path. 'worktree' mode; the effort is
  // opts.effort or, when absent, `defaultRunEffort` for a worktree run.
  ({ outcome } = await provider.runAgent({
    kind: opts.kind,
    model: claudeModelChoice(model),
    effort: 'worktree',
    prompt: opts.prompt,
    ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    cwd: opts.worktreePath,
    roots: [],
    readOnlyRoots: opts.readOnlyRoots ?? [],
    writeRoots: opts.writes ? [opts.worktreePath] : [],
    tools: opts.tools,
    budget: { usd: opts.maxBudgetUsd, turns: opts.maxTurns },
    abortController: opts.abortController,
    claude: {
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    ...(opts.usageRecord ? { usageRecord: opts.usageRecord } : {}),
    ...(opts.codex || opts.effort ? { codex: { ...opts.codex, effort: opts.codex?.effort ?? opts.effort } } : {}),
    // The write-capable words for its steps.
    activity: 'fix',
    onProgress: (p) => {
      if (p.kind === 'step') {
        if (p.usage) liveUsage = p.usage;
        for (const line of p.lines) pushActivity(line);
        const live = liveUsage;
        opts.onActivity?.([...activity], {
          ...live,
          estCostUsd: priceOf(live),
        });
      } else if (p.kind === 'outcome') {
        outcome = p.outcome;
      }
    },
  }));
  } catch (err) {
    // A cancel may surface as a throw from the iterator: fall through to the aborted result.
    // Any other failure carries what was spent so far (`partialSpendOf`).
    if (!opts.abortController.signal.aborted) throw withPartialSpend(err, spentSoFar());
  }

  if (opts.abortController.signal.aborted) {
    const spent = spentSoFar();
    return {
      outcome,
      usage: spent.usage,
      costUsd: spent.costUsd,
      numTurns: null,
      aborted: true,
      provider: provider.id,
      usageRecorded,
    };
  }

  const usage = outcome?.usage ?? liveUsage;
  const hasUsage =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  const costUsd =
    outcome?.costUsd ?? (hasUsage ? priceOf(usage) : null);

  return {
    outcome,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    },
    costUsd,
    numTurns: outcome?.numTurns ?? null,
    aborted: false,
    provider: provider.id,
    usageRecorded,
  };
  } finally {
    restoreEnv();
  }
}
