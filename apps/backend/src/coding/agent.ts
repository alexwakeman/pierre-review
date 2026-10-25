import {
  claudeModelChoice,
  getActiveProvider,
  type AgentKind,
  type AgentOutcome,
  type AgentToolServer,
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
import type { ClaudeReviewModel } from '@pierre-review/shared';
import type {
  GenerateFixArgs,
  GenerateFixResult,
} from '../platform/contract.js';
import { submitFixShape, submitPlanShape, type SubmitFixPayload } from './schema.js';
import {
  checkPlanSubmission,
  type GeneratePlanArgs,
  type GeneratePlanResult,
  type RawPlanSubmission,
} from './ai-fix/plan.js';
import { captureWorktreeDiff } from './git.js';
import { withPartialSpend } from './partial-spend.js';

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
}

interface AgentRunOutcome {
  /** How the run ended (the provider's neutral outcome), or null when it never said. */
  outcome: AgentOutcome | null;
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
  let liveUsage: UsageTokens = emptyUsage();
  let outcome: AgentOutcome | null = null;

  // The credential ladder (ai/credentials.ts): the Claude Code login, else ANTHROPIC_API_KEY. Restored below.
  const restoreEnv = applyClaudeReviewAuth(true);
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
  const spentSoFar = (): { usage: LiveUsage; costUsd: number | null } => {
    const u = { ...liveUsage };
    const has = u.inputTokens + u.outputTokens + u.cacheReadTokens > 0;
    return { usage: u, costUsd: has ? estimateCostUsd(model, u) : null };
  };

  try {
  // THROUGH THE PROVIDER (ai/provider.ts; Claude's is ai/providers/claude.ts). It OWNS the sandbox
  // config (`permissionMode:'bypassPermissions'`, `settingSources:[]`, the isolated MCP config) and
  // puts ⚠ THE PATH GUARD first on PreToolUse: file tools stay inside the worktree (cwd, no other
  // root). Under bypassPermissions nothing else confines an ABSOLUTE path, and this agent WRITES — a
  // seed item (PR text, review threads, a ticket review's items) saying "also add this to ~/.zshrc"
  // would otherwise write outside the worktree, where captureWorktreeDiff never shows it to the
  // reader. 'worktree' effort ⇒ config.reviewEffort, exactly the effort this path always used.
  ({ outcome } = await getActiveProvider().runAgent({
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
    budget: { usd: opts.maxBudgetUsd, turns: opts.maxTurns },
    abortController: opts.abortController,
    claude: { allowedTools: opts.allowedTools, disallowedTools: opts.disallowedTools },
    // The fixer's words for its steps (the write tools too).
    activity: 'fix',
    onProgress: (p) => {
      if (p.kind === 'step') {
        if (p.usage) liveUsage = p.usage;
        for (const line of p.lines) pushActivity(line);
        const live = liveUsage;
        opts.onActivity?.([...activity], {
          ...live,
          estCostUsd: estimateCostUsd(model, live),
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
    };
  }

  const usage = outcome?.usage ?? liveUsage;
  const hasUsage =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  const costUsd =
    outcome?.costUsd ?? (hasUsage ? estimateCostUsd(model, usage) : null);

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

    const fixShape = await submitFixShape();
    let captured: SubmitFixPayload | null = null;
    const tools: AgentToolServer = {
      server: 'fix',
      tools: [
        {
          name: 'submit_fix',
          description: 'Report the fix you applied. Call this EXACTLY once, at the very end, after editing files.',
          shape: fixShape,
          handle: (a) => {
            const p = a as unknown as SubmitFixPayload;
            captured = {
              summary: p.summary,
              commitMessage: p.commitMessage,
              // Passed through verbatim; the AI Fix manager validates refs + clips text.
              changes: p.changes,
              unaddressed: p.unaddressed,
            };
            return { text: 'Fix recorded.' };
          },
        },
      ],
    };

    onProgress({ phase: 'fixing' });
    const outcome = await runAgentInWorktree({
      kind: 'fix',
      worktreePath,
      model,
      systemPrompt: args.systemPrompt,
      prompt: args.prompt,
      allowedTools: FIX_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      tools,
      writes: true,
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
              return {
                text: `The plan was not recorded. Fix this and call submit_plan again:\n- ${problems.join('\n- ')}`,
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
    });

    // A cancelled pass still hands back what it spent, so the manager records it and counts it
    // against the plan's budget.
    if (outcome.aborted || abortController.signal.aborted) {
      return { plan: null, usage: outcome.usage, costUsd: outcome.costUsd, numTurns: null, aborted: true };
    }
    return {
      plan: accepted as RawPlanSubmission | null,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      numTurns: outcome.numTurns,
      aborted: false,
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
