import {
  claudeModelChoice,
  getActiveProvider,
  getProvider,
  type AgentCheckTool,
  type AgentKind,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolServer,
  type AgentUsageRecord,
  type CodexRunOptions,
} from '../ai/provider.js';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
import { estimateCostUsd } from '../review/pricing.js';
import type { UsageTokens } from '../review/usage.js';
import type { AiEffort, ClaudeReviewModel } from '@pierre-review/shared';
import type {
  GenerateFixArgs,
  GenerateFixResult,
} from '../platform/contract.js';
import { submitFixShape, submitPlanShape, type SubmitFixPayload } from './schema.js';
import {
  checkPlanSubmission,
  CODEX_PLAIN_TASK_RULE,
  type GeneratePlanArgs,
  type GeneratePlanResult,
  type RawPlanSubmission,
} from './ai-fix/plan.js';
import { captureWorktreeDiff } from './git.js';
import { withPartialSpend } from './partial-spend.js';
import { join } from 'node:path';
import type { AiFixCheckResult, AiFixChecks } from '@pierre-review/shared';
import { openCheckSession, type CheckRunResult, type CheckSession } from './checks/index.js';
import { buildHookRepairPrompt, checksSection } from './ai-fix/prompts.js';
import { pickReviewNonce } from '../review/claude-review/prompts.js';

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
// holds the single global job slot (MAX_CONCURRENT = 1, apps/backend/src/platform/ai-fix/manager.ts) that
// every other account's fix queues behind.
//
// ⚠ What this costs, stated plainly: a fix that wanted a codegen step, a formatter, or `git log`
// for context must now write the edit by hand or decline. That is the accepted trade — Claude
// Review made the identical one. The way back is a container/VM boundary, or `canUseTool` under a
// non-bypass permission mode — NOT re-adding 'Bash' with a longer blocklist.
//
// "RUN TESTS" (2026-10-30) IS THAT WAY BACK, FOR TESTS ONLY: an OS sandbox (coding/checks/) around
// the project's own DECLARED checks, which the agent may ask for by NAME through ONE extra tool,
// `run_check` (FIX_TOOLS_WITH_CHECKS below). Limn builds every argv; the agent never types a command,
// and Bash stays in DISALLOWED_TOOLS. docs/SECURITY.md § Sandboxed checks.
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

// PLAN MODE (ai-fix/plan.ts; docs/CLAUDE-REVIEW.md § AI Fix "Plan mode"): the planning pass is
// READ-ONLY. It reads the same worktree the build will edit, and nothing it does may change it: the
// allow list carries no write tool, and every write tool is ALSO denied outright, so a plan pass
// cannot edit a file even if a later change re-adds one to the allow list by mistake. The path guard
// still confines its reads to the worktree (runAgentInWorktree). Pinned by tool-surface.test.ts.
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__plan__submit_plan'];
const PLAN_DISALLOWED_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
// A plan reads and writes nothing, so it needs far fewer turns than a build.
const PLAN_MAX_TURNS = 25;

// Per-model effort + thinking options: ONE table in review/model-options.ts, shared with the
// review agent (Opus 5.5 gets explicit adaptive thinking and 400s on
// disabled thinking / a thinking budget / a forced tool_choice, none of which is sent here).
const ACTIVITY_LOG_CAP = 25;

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
  /** Which agent this is (ai/provider.ts `AgentKind`). */
  kind: AgentKind;
  worktreePath: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** The run's result tools (submit_fix / submit_plan / submit_resolution), one server. */
  tools: AgentToolServer;
  /** "Run tests": the project's own checks as the `run_check` tool (coding/checks/). Absent ⇒ none. */
  checks?: AgentCheckTool;
  /** True ⇒ the run may write inside the worktree (the fixer); false ⇒ read-only. */
  writes: boolean;
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
   * (ai/provider.ts `getActiveProvider`), exactly as before.
   */
  provider?: AgentProviderId;
  /**
   * Who to bill. A provider that records its own usage (Codex) writes the ledger row from it, and
   * the result says so (`usageRecorded`) so the caller does not write a second. Claude ignores it:
   * its callers record from the returned US$ as they always did.
   */
  usageRecord?: AgentUsageRecord;
  /** Codex-only knobs (an explicit reasoning effort for the opt-in live test). Claude ignores them. */
  codex?: CodexRunOptions;
  /**
   * The run's effort on either provider (Settings → AI → Effort; ai/effort.ts). Absent ⇒ each
   * provider's Default. A Codex `codex.effort` (the live test) beats it.
   */
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
  // still bills: the caller records this (a planning pass counts it against the plan's budget).
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
  // root). Under bypassPermissions nothing else confines an ABSOLUTE path, and this agent WRITES — a
  // seed item (PR text, review threads, a ticket review's items) saying "also add this to ~/.zshrc"
  // would otherwise write outside the worktree, where captureWorktreeDiff never shows it to the
  // reader. 'worktree' mode; the effort is opts.effort (ai/effort.ts `agenticRunEffort`, decided by the AI
  // Fix manager) or, when absent, `defaultRunEffort` for a worktree run.
  ({ outcome } = await provider.runAgent({
    kind: opts.kind,
    model: claudeModelChoice(model),
    effort: 'worktree',
    prompt: opts.prompt,
    ...(opts.systemPrompt ? { system: opts.systemPrompt } : {}),
    cwd: opts.worktreePath,
    roots: [],
    readOnlyRoots: [],
    writeRoots: opts.writes ? [opts.worktreePath] : [],
    tools: opts.tools,
    ...(opts.checks ? { checks: opts.checks } : {}),
    budget: { usd: opts.maxBudgetUsd, turns: opts.maxTurns },
    abortController: opts.abortController,
    claude: {
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    ...(opts.usageRecord ? { usageRecord: opts.usageRecord } : {}),
    ...(opts.codex || opts.effort ? { codex: { ...opts.codex, effort: opts.codex?.effort ?? opts.effort } } : {}),
    // The fixer's words for its steps (the write tools too).
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

/** The fixer's tools when the run carries the project's checks: FIX_TOOLS + `run_check`, still no shell. */
// (ai/check-tool.ts names the server and tool; tool-surface.test.ts pins the spelling to them.)
const FIX_TOOLS_WITH_CHECKS = [...FIX_TOOLS, 'mcp__checks__run_check'];
// How many times a failing pre-commit hook goes back to the agent (each a short follow-up pass).
const MAX_HOOK_REPAIRS = 2;
// A follow-up pass is not started with less than this left of the run's budget.
const MIN_REPAIR_BUDGET_USD = 0.25;

function toWire(r: CheckRunResult): AiFixCheckResult {
  return {
    name: r.name,
    kind: r.kind,
    command: r.command,
    status: r.status,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    output: r.output,
    truncated: r.truncated,
    note: r.note,
  };
}

/** "Run tests" asked for but nothing ran: the reason, and every asked-for check marked skipped. */
function checksNotRun(requested: string[], note: string, skipped: CheckRunResult[] = []): AiFixChecks {
  return { requested, ran: false, note, sandbox: null, install: [], results: skipped.map(toWire), hook: null, hookAttempts: 0, agentRuns: 0 };
}

/** The progress a build in a worktree reports; the caller maps `working` onto its own word. */
export interface WorktreeBuildProgress {
  phase: 'preparing_checks' | 'working' | 'running_checks' | 'capturing';
  message?: string;
  recentActivity?: string[];
  usage?: LiveUsage & { estCostUsd: number };
}

/** The result tool a build in a worktree reports through (the `submit_fix` shape, under its own name). */
export interface WorktreeBuildResultTool {
  /** The MCP server's name (`fix` ⇒ `mcp__fix__submit_fix`). */
  server: string;
  name: string;
  description: string;
  /** The tool's reply to an accepted call. */
  ack: string;
}

export interface BuildInWorktreeArgs {
  accountId: number;
  /** The agent kind (ai/provider.ts): `fix` for AI Fix. */
  kind: AgentKind;
  worktreePath: string;
  repoCloneDir: string;
  /** The commit the worktree is checked out at (the pre-commit hook diffs against it). */
  baseSha: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  abortController: AbortController;
  onProgress: (p: WorktreeBuildProgress) => void;
  /**
   * The tool lists for the pass: the caller's own LITERAL lists (pinned by its tool-surface test), the
   * allow list chosen by whether the run carries `run_check`. ⚠ The deny list must deny Bash outright —
   * a list that does not is refused here before anything runs.
   */
  toolsFor: (checkTool: AgentCheckTool | undefined) => { allowedTools: string[]; disallowedTools: string[] };
  resultTool: WorktreeBuildResultTool;
  /** The ledger row a provider that records its own usage (Codex) writes. */
  usageRecord: AgentUsageRecord;
  /** "Run tests": the check names the reader ticked. Empty ⇒ none. */
  checks: string[];
  /** The commit message the hook is tried with when the agent reported none. */
  defaultCommitMessage: string;
  /** The follow-up prompt after a failing pre-commit hook (its output, fenced with `nonce`). */
  hookRepairPrompt: (output: string, nonce: string) => string;
  provider?: AgentProviderId;
  codex?: CodexRunOptions;
  effort?: AiEffort;
}

export type BuildInWorktreeResult =
  | { aborted: true; usageRecorded: boolean }
  | {
      aborted: false;
      /** The agent's last accepted report (UNVALIDATED), or null when it never called the tool. */
      captured: SubmitFixPayload | null;
      patch: string;
      filesChanged: string[];
      usage: LiveUsage;
      costUsd: number | null;
      numTurns: number | null;
      usageRecorded: boolean;
      /** "Run tests": what ran (null when no tests were asked for). */
      checks: AiFixChecks | null;
    };

/**
 * THE BUILD IN A WORKTREE that is already checked out (the body AI Fix's `runCodingAgent` and the story
 * build's `buildRepo` share): the "Run tests" check session, the result tool, the agent pass, Limn's own
 * check run, the pre-commit hook with at most MAX_HOOK_REPAIRS repair passes, then `restoreGit` and the
 * diff capture. It never preps, removes or pushes the worktree — the caller owns those. The check
 * session is opened and closed here.
 *
 * "RUN TESTS" (`args.checks`; coding/checks/, docs/CLAUDE-REVIEW.md § AI Fix "Run tests"): after the
 * worktree is ready, Limn opens a check session (sandbox, Docker preflight, dependency install) and
 * hands the agent `run_check`; after the agent, Limn runs every chosen check ONCE MORE itself (the
 * result the reader sees), then the commit with the pre-commit hook in the sandbox — a failing hook
 * goes back to the agent, at most twice. Tests that cannot start never fail the run: it goes on as
 * before and the note says why.
 */
export async function buildInWorktree(args: BuildInWorktreeArgs): Promise<BuildInWorktreeResult> {
  const { worktreePath, repoCloneDir, baseSha, abortController, onProgress } = args;
  let checkSession: CheckSession | null = null;
  try {
    // "Run tests": open the session BEFORE the agent, so it gets the tool and its prompt the list.
    const requested = args.checks.filter((n) => typeof n === 'string' && n !== '');
    let checks: AiFixChecks | null = null;
    if (requested.length > 0) {
      onProgress({ phase: 'preparing_checks' });
      try {
        const opened = await openCheckSession({
          worktree: worktreePath,
          repoCloneDir,
          wanted: requested,
          runRoot: join(config.dataDir, 'check-runs'),
          cacheDir: join(config.dataDir, 'check-cache'),
          darkRoots: [config.dataDir, config.cloneDir],
          allowUnsandboxed: config.checksAllowUnsandboxed,
          checkTimeoutMs: config.aiFixCheckTimeoutMs,
          signal: abortController.signal,
          onStatus: (message) => onProgress({ phase: 'preparing_checks', message }),
        });
        if (opened.ok) checkSession = opened.session;
        else checks = checksNotRun(requested, opened.note, opened.skipped);
      } catch (err) {
        checks = checksNotRun(requested, `Tests could not start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const agentTool = checkSession && checkSession.agentChecks.length > 0 ? checkSession.agentTool() : null;
    const checkTool: AgentCheckTool | undefined =
      agentTool && checkSession
        ? { ...agentTool, specFile: checkSession.specFile, timeoutSec: Math.ceil(config.aiFixCheckTimeoutMs / 1000) }
        : undefined;
    const sessionNote = checkSession && checkSession.notes.length > 0 ? checkSession.notes.join(' ') : null;
    const systemPrompt =
      requested.length > 0 && args.systemPrompt != null
        ? args.systemPrompt + checksSection(agentTool?.names ?? null, checkTool ? sessionNote : (checks?.note ?? sessionNote), checkSession?.hook != null)
        : args.systemPrompt;

    const fixShape = await submitFixShape();
    let captured: SubmitFixPayload | null = null;
    const tools: AgentToolServer = {
      server: args.resultTool.server,
      tools: [
        {
          name: args.resultTool.name,
          description: args.resultTool.description,
          shape: fixShape,
          handle: (a) => {
            const p = a as unknown as SubmitFixPayload;
            captured = {
              summary: p.summary,
              commitMessage: p.commitMessage,
              // Passed through verbatim; the caller validates refs + clips text.
              changes: p.changes,
              unaddressed: p.unaddressed,
            };
            return { text: args.resultTool.ack };
          },
        },
      ],
    };

    const total = { usage: emptyUsage(), costUsd: null as number | null, numTurns: null as number | null, usageRecorded: false };
    const add = (o: AgentRunOutcome): void => {
      total.usage.inputTokens += o.usage.inputTokens;
      total.usage.outputTokens += o.usage.outputTokens;
      total.usage.cacheReadTokens += o.usage.cacheReadTokens;
      total.usage.cacheCreationTokens += o.usage.cacheCreationTokens;
      if (o.costUsd != null) total.costUsd = (total.costUsd ?? 0) + o.costUsd;
      if (o.numTurns != null) total.numTurns = (total.numTurns ?? 0) + o.numTurns;
      if (o.usageRecorded) total.usageRecorded = true;
    };
    const maxBudgetUsd = args.maxBudgetUsd;
    const toolLists = args.toolsFor(checkTool);
    // NO SHELL, EVER (the comment above FIX_TOOLS): a caller whose deny list lost Bash runs nothing.
    if (!toolLists.disallowedTools.includes('Bash') || toolLists.allowedTools.some((t) => /^Bash\b/.test(t))) {
      throw new Error('A coding run must deny Bash outright.');
    }
    const pass = (prompt: string, budgetUsd: number): Promise<AgentRunOutcome> =>
      runAgentInWorktree({
        kind: args.kind,
        worktreePath,
        model: args.model,
        systemPrompt,
        prompt,
        ...toolLists,
        tools,
        ...(checkTool ? { checks: checkTool } : {}),
        writes: true,
        maxTurns: args.maxTurns,
        maxBudgetUsd: budgetUsd,
        abortController,
        onActivity: (activity, usage) =>
          onProgress({ phase: 'working', recentActivity: activity, usage }),
        ...(args.provider ? { provider: args.provider } : {}),
        usageRecord: args.usageRecord,
        ...(args.codex ? { codex: args.codex } : {}),
        ...(args.effort ? { effort: args.effort } : {}),
      });

    onProgress({ phase: 'working' });
    const outcome = await pass(args.prompt, maxBudgetUsd);
    add(outcome);

    // A user cancel aborts the SDK iterator; surface a clean aborted result (the caller marks its
    // row cancelled — no worktree changes are captured).
    const aborted = (): boolean => abortController.signal.aborted;
    if (outcome.aborted || aborted()) return { aborted: true, usageRecorded: outcome.usageRecorded };

    // "Run tests": Limn's own run, then the commit hook (and its bounded repair passes).
    if (checkSession) {
      onProgress({ phase: 'running_checks' });
      let results = await checkSession.verify();
      let hook: CheckRunResult | null = null;
      let hookAttempts = 0;
      let repaired = false;
      if (checkSession.hook) {
        for (;;) {
          const fix = captured as SubmitFixPayload | null;
          onProgress({ phase: 'running_checks', message: 'Running the pre-commit hook' });
          hook = await checkSession.runHook(fix?.commitMessage ?? args.defaultCommitMessage, baseSha);
          if (hook) hookAttempts++;
          const left = maxBudgetUsd - (total.costUsd ?? 0);
          if (!hook || hook.status !== 'failed' || hookAttempts > MAX_HOOK_REPAIRS || aborted() || left < MIN_REPAIR_BUDGET_USD) break;
          // The hook's output goes back to the agent: one short follow-up pass in the same worktree.
          onProgress({ phase: 'working', message: 'Fixing what the pre-commit hook reported' });
          const nonce = pickReviewNonce([hook.output]);
          const again = await pass(args.hookRepairPrompt(hook.output, nonce), left);
          add(again);
          repaired = true;
          if (again.aborted || aborted()) break;
        }
      }
      // A repair pass changed the code after Limn's run: run the checks again so the results match.
      if (repaired && !aborted()) results = await checkSession.verify();
      checks = {
        requested,
        ran: results.length > 0 || hook != null,
        note: checkSession.notes.length > 0 ? checkSession.notes.join(' ') : null,
        sandbox: checkSession.sandbox,
        install: checkSession.prepare.map(toWire),
        results: [...results.map(toWire), ...checkSession.skipped.map(toWire)],
        hook: hook ? toWire(hook) : null,
        hookAttempts,
        agentRuns: checkSession.agentRuns().length,
      };
      if (aborted()) return { aborted: true, usageRecorded: total.usageRecorded };
    }

    onProgress({ phase: 'capturing' });
    // ⚠ The worktree's `.git` file goes back to what git wrote BEFORE Limn's own git reads it: a check
    // (or the agent's Write) could have pointed it at a git folder whose config runs a command.
    checkSession?.restoreGit();
    const { patch, filesChanged } = await captureWorktreeDiff(
      worktreePath,
      checkSession ? { excludesFile: checkSession.excludesFile } : {},
    );

    return {
      aborted: false,
      // A cast so the closure-assigned `captured` reads back as its declared union.
      // (TS flow-narrows it to `null` because its only assignment is inside the tool
      // callback, which it can't prove ran — a plain annotation wouldn't break that.)
      captured: captured as SubmitFixPayload | null,
      patch,
      filesChanged,
      usage: total.usage,
      costUsd: total.costUsd,
      numTurns: total.numTurns,
      usageRecorded: total.usageRecorded,
      checks,
    };
  } finally {
    await checkSession?.close().catch(() => {});
  }
}

/**
 * Run the write-capable coding agent against a PR's head in an ephemeral worktree and
 * return the captured changeset (a binary-safe unified diff) + a prose summary. This
 * is the implementation behind ctx.coding.generateFix; it owns the worktree prep +
 * teardown, and delegates the run itself (checks, agent, hook, capture) to buildInWorktree.
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

    const built = await buildInWorktree({
      accountId: args.accountId,
      kind: 'fix',
      worktreePath,
      repoCloneDir,
      baseSha,
      model,
      ...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
      prompt: args.prompt,
      maxTurns: args.maxTurns ?? config.aiFixMaxTurns,
      maxBudgetUsd: args.maxBudgetUsd ?? config.aiFixBudgetUsd,
      abortController,
      onProgress: (p) => onProgress({ ...p, phase: p.phase === 'working' ? 'fixing' : p.phase }),
      toolsFor: (checkTool) => ({
        allowedTools: checkTool ? FIX_TOOLS_WITH_CHECKS : FIX_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
      }),
      resultTool: {
        server: 'fix',
        name: 'submit_fix',
        description: 'Report the fix you applied. Call this EXACTLY once, at the very end, after editing files.',
        ack: 'Fix recorded.',
      },
      usageRecord: { accountId: args.accountId, seam: 'agent', feature: 'ai_fix', prId: args.prId ?? null },
      checks: args.checks ?? [],
      defaultCommitMessage: 'AI fix',
      hookRepairPrompt: (output, nonce) =>
        buildHookRepairPrompt({ output, nonce, ...(args.provider ? { provider: args.provider } : {}) }),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.codex ? { codex: args.codex } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
    });

    if (built.aborted) {
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
        ...(built.usageRecorded ? { usageRecorded: true } : {}),
      };
    }

    const { patch, filesChanged } = built;
    if (patch.length > config.aiFixPatchMaxBytes) {
      throw new Error(
        `fix patch too large (${patch.length} bytes > ${config.aiFixPatchMaxBytes})`,
      );
    }

    const fix = built.captured;
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
      usage: built.usage,
      costUsd: built.costUsd,
      numTurns: built.numTurns,
      aborted: false,
      ...(built.usageRecorded ? { usageRecorded: true } : {}),
      ...(built.checks ? { checks: built.checks } : {}),
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

/**
 * PLAN MODE: run the READ-ONLY planning agent against the PR's head in an ephemeral worktree and
 * return its accepted `submit_plan` call. Nothing in the worktree may change (PLAN_TOOLS /
 * PLAN_DISALLOWED_TOOLS above); the worktree is torn down after, exactly like a fix run's.
 *
 * `submit_plan` is checked IN THE TOOL (ai-fix/plan.ts `checkPlanSubmission`: at most five short
 * bullets, only refs the pass was shown); a refused call is answered with what to fix so the model
 * can call again, and only an accepted call is kept.
 */
export async function runPlanAgent(args: GeneratePlanArgs): Promise<GeneratePlanResult> {
  const { owner, name, prNumber, baseSha, abortController, onProgress } = args;
  const token = await getAccessToken(args.accountId);

  let repoCloneDir: string | null = null;
  let worktreePath: string | null = null;
  try {
    onProgress({ phase: 'cloning' });
    ({ repoCloneDir, worktreePath } = await prepWorktree(owner, name, prNumber, baseSha, token));

    const planShape = await submitPlanShape();
    const planProvider: AgentProviderId = args.provider ?? getActiveProvider().id;
    let accepted: RawPlanSubmission | null = null;
    const tools: AgentToolServer = {
      server: 'plan',
      tools: [
        {
          name: 'submit_plan',
          description: 'Submit the plan. Call this once, at the end, after reading the code.',
          shape: planShape,
          handle: (a) => {
            const p = a as unknown as RawPlanSubmission;
            const problems = checkPlanSubmission(p, args.shownRefs);
            if (problems.length > 0) {
              // CODEX: a task with no refs has no step-less answer, so its one retry is told so beside
              // the problems (CODEX_PLAIN_TASK_RULE) — a refusal for an invented ref alone once led
              // the retry to drop `notAddressed` and answer with no step at all. Claude's text is today's.
              const codexHint = planProvider === 'codex' && args.shownRefs.length === 0 ? `\n${CODEX_PLAIN_TASK_RULE}` : '';
              return {
                text: `The plan was not recorded. Fix this and call submit_plan again:\n- ${problems.join('\n- ')}${codexHint}`,
                // CODEX: its final answer IS the call, so a refusal must say so (`isError`) to earn the
                // provider's one retry with this text as the reason. Claude keeps today's reply exactly:
                // the model reads the text and calls again.
                ...(planProvider === 'codex' ? { isError: true } : {}),
              };
            }
            accepted = { summary: p.summary, steps: p.steps, notAddressed: p.notAddressed, reply: p.reply };
            return { text: 'Plan recorded.' };
          },
        },
      ],
    };

    onProgress({ phase: 'planning' });
    const outcome = await runAgentInWorktree({
      kind: 'plan',
      worktreePath,
      model: args.model,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      allowedTools: PLAN_TOOLS,
      disallowedTools: PLAN_DISALLOWED_TOOLS,
      tools,
      writes: false,
      maxTurns: args.maxTurns ?? PLAN_MAX_TURNS,
      maxBudgetUsd: args.maxBudgetUsd,
      abortController,
      onActivity: (activity, usage) => onProgress({ phase: 'planning', recentActivity: activity, usage }),
      provider: planProvider,
      usageRecord: { accountId: args.accountId, seam: 'agent', feature: 'ai_fix_plan', prId: args.prId ?? null },
      ...(args.codex ? { codex: args.codex } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
    });

    // A cancelled pass still hands back what it spent, so the manager records it and counts it
    // against the plan's budget.
    const recorded = outcome.usageRecorded ? { usageRecorded: true } : {};
    if (outcome.aborted || abortController.signal.aborted) {
      return { plan: null, usage: outcome.usage, costUsd: outcome.costUsd, numTurns: null, aborted: true, ...recorded };
    }
    return {
      plan: accepted as RawPlanSubmission | null,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      numTurns: outcome.numTurns,
      aborted: false,
      ...recorded,
    };
  } finally {
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(owner, name, repoCloneDir, worktreePath).catch(() => {});
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
