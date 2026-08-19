import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { config } from '../config.js';
import { getAccessToken } from '../auth/account.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from '../review/clone-manager.js';
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
import {
  submitFixShape,
  submitResolutionShape,
  type SubmitFixPayload,
  type SubmitResolutionPayload,
} from './schema.js';
import { captureWorktreeDiff } from './git.js';
import { describeAssistantBlocks } from './activity.js';

// The WRITE tool surface for the fixer: the read tools PLUS Write/Edit/MultiEdit, and
// the submit_fix MCP tool for the prose summary. The agent NEVER runs git writes — the
// host commits/pushes — so git commit/push/config stay denied (as do rm/sudo).
const FIX_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'mcp__fix__submit_fix',
];
const DISALLOWED_TOOLS = [
  'NotebookEdit',
  'Bash(rm *)',
  'Bash(sudo *)',
  'Bash(git push *)',
  'Bash(git commit *)',
  'Bash(git config *)',
];

// The conflict-resolver's tool surface is deliberately NARROWER: no Bash at all, so it
// cannot tamper with the in-progress merge/rebase (no `git add`/`--continue`/`--abort`).
// It only reads + edits the conflicted files and reports via submit_resolution; the
// host stages and continues the operation.
const RESOLVE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Write',
  'Edit',
  'MultiEdit',
  'mcp__resolve__submit_resolution',
];
const RESOLVE_DISALLOWED_TOOLS = ['Bash', 'NotebookEdit'];

// Models that accept the `effort` option (Haiku 4.5 rejects it — the API 400s).
const EFFORT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
]);
const ACTIVITY_LOG_CAP = 25;

type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;

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
 * The shared Claude Agent SDK run core used by BOTH the fixer and the conflict
 * resolver: it OWNS the sandbox config (`permissionMode:'bypassPermissions'`,
 * `settingSources:[]`, budget/turn caps, whitelisted tools) and streams activity, but
 * knows nothing about worktree prep, diff capture, or git — the callers own those.
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

  let maxTurns = opts.maxTurns;
  if (model === 'claude-haiku-4-5') {
    maxTurns = Math.ceil(maxTurns * config.reviewHaikuTurnMultiplier);
  }
  const effort = EFFORT_CAPABLE_MODELS.has(model)
    ? config.reviewEffort
    : undefined;

  // Advanced-AI credential: ambient session preferred, else the local BYO key. Restored below.
  const restoreEnv = applyClaudeReviewAuth(true);
  try {
  const q = query({
    prompt: opts.prompt,
    options: {
      model,
      ...(effort ? { effort } : {}),
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

    let captured: SubmitFixPayload | null = null;
    const server = createSdkMcpServer({
      name: 'fix',
      version: '1.0.0',
      tools: [
        tool(
          'submit_fix',
          'Report the fix you applied. Call this EXACTLY once, at the very end, after editing files.',
          submitFixShape,
          async (a) => {
            const p = a as unknown as SubmitFixPayload;
            captured = {
              summary: p.summary,
              commitMessage: p.commitMessage,
              // Present only for a list-seeded run (see submitFixShape); passed through
              // verbatim for the caller to map back to its own items.
              commentVerdicts: p.commentVerdicts,
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
      // Absent (not []) when the agent reported no per-item dispositions — the caller
      // distinguishes "this run had no list" from "it reported an empty list".
      commentVerdicts: fix?.commentVerdicts,
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

export interface ConflictResolverArgs {
  // A worktree that is ALREADY mid-merge/mid-rebase (conflict markers present). The
  // caller (coding/merge.ts) owns its lifecycle + all git writes.
  worktreePath: string;
  model: string;
  systemPrompt?: string;
  // The currently-conflicted files (from `git diff --name-only --diff-filter=U`).
  conflictFiles: string[];
  // Optional one-line context (e.g. the PR title / the fix intent) to steer the merge.
  contextNote?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  abortController: AbortController;
  onActivity?: (activity: string[]) => void;
}

export interface ConflictResolverResult {
  summary: string;
  usage: LiveUsage;
  costUsd: number | null;
  aborted: boolean;
}

/**
 * Run the conflict-resolution agent in an already-prepared, mid-merge/rebase worktree.
 * The agent edits the conflicted files to remove every marker (preserving both sides'
 * intent) and reports via submit_resolution. It has NO Bash/git access, so it cannot
 * touch the in-progress operation — the host stages + continues + verifies afterward.
 */
export async function runConflictResolver(
  args: ConflictResolverArgs,
): Promise<ConflictResolverResult> {
  let captured: { summary: string } | null = null;
  const server = createSdkMcpServer({
    name: 'resolve',
    version: '1.0.0',
    tools: [
      tool(
        'submit_resolution',
        'Report how you resolved the conflicts. Call this EXACTLY once, at the very end, after every conflict marker is gone.',
        submitResolutionShape,
        async (a) => {
          const p = a as unknown as SubmitResolutionPayload;
          captured = { summary: p.summary };
          return { content: [{ type: 'text', text: 'Resolution recorded.' }] };
        },
      ),
    ],
  });

  const fileList = args.conflictFiles.map((f) => `- ${f}`).join('\n');
  const prompt = [
    'You are resolving Git merge/rebase conflicts in this repository.',
    'The working tree has conflict markers (<<<<<<<, =======, >>>>>>>) in these files:',
    fileList || '(git reports conflicted files)',
    '',
    args.contextNote ? `Context: ${args.contextNote}` : '',
    '',
    'For EACH conflicted file: open it, resolve every conflict by preserving the',
    'intent of BOTH sides (combine them correctly — do not just pick one blindly',
    'unless one side is clearly obsolete), and remove ALL conflict markers. Do not',
    'change code outside the conflict regions. Do not run any git commands.',
    'When every marker in every file is gone, call submit_resolution with a short',
    'summary of how you reconciled them.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const outcome = await runAgentInWorktree({
    worktreePath: args.worktreePath,
    model: args.model,
    systemPrompt: args.systemPrompt,
    prompt,
    allowedTools: RESOLVE_TOOLS,
    disallowedTools: RESOLVE_DISALLOWED_TOOLS,
    mcpServers: { resolve: server },
    maxTurns: args.maxTurns ?? config.aiFixMaxTurns,
    maxBudgetUsd: args.maxBudgetUsd ?? config.aiFixBudgetUsd,
    abortController: args.abortController,
    onActivity: (activity) => args.onActivity?.(activity),
  });

  const res = captured as { summary: string } | null;
  return {
    summary: res?.summary ?? 'Resolved merge conflicts.',
    usage: outcome.usage,
    costUsd: outcome.costUsd,
    aborted: outcome.aborted || args.abortController.signal.aborted,
  };
}
