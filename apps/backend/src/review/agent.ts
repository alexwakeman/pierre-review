import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  ClaudeFindingSide,
  ClaudeReviewModel,
  ClaudeReviewProgress,
  RequestedReviewMode,
} from '@pierre-review/shared';
import { config } from '../config.js';
import { submitReviewShape, type SubmitReviewPayload } from './schema.js';
import { applyUserAnthropicKey } from './local-settings.js';
import {
  addWorktree,
  cleanupCloneCache,
  ensureClone,
  fetchPrHead,
  removeWorktree,
} from './clone-manager.js';
import {
  buildUserPrompt,
  isNoiseFile,
  systemPromptForMode,
} from './prompt.js';
import {
  buildAnchorIndex,
  extractHunk,
  fetchPrDiff,
  isFindingAnchored,
  splitDiffByFile,
  stripNoiseFromDiff,
} from './post-review.js';
import { decideReviewMode } from './routing.js';
import {
  markReviewCancelled,
  markReviewFailed,
  markReviewRouted,
  markReviewRunning,
  saveReviewSuccess,
  type PersistedFinding,
} from './persist.js';

export interface RunReviewArgs {
  reviewId: number;
  prId: number;
  owner: string;
  name: string;
  repoFullName: string;
  prNumber: number;
  title: string;
  body: string | null;
  baseRefName: string | null;
  headSha: string;
  model: ClaudeReviewModel;
  // The user's requested depth: 'auto' lets the router decide; 'diff_only'/'worktree'
  // force the mode, overriding the router's metrics.
  requestedMode: RequestedReviewMode;
  abortController: AbortController;
  onProgress: (p: ClaudeReviewProgress) => void;
}

// Read-only tool surface for a WORKTREE review. submit_review is the ONLY way
// structured output leaves the agent. Write/Edit are forbidden and destructive Bash
// is denied (DISALLOWED_TOOLS).
const WORKTREE_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'mcp__review__submit_review',
];
// A DIFF-ONLY review is tool-less: the agent has the full diff in its prompt and no
// repository to explore, so submit_review is the only tool it gets.
const DIFF_ONLY_TOOLS = ['mcp__review__submit_review'];
const DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash(rm *)',
  'Bash(sudo *)',
  'Bash(git push *)',
  'Bash(git commit *)',
  'Bash(git config *)',
];

// How many recent-activity lines to keep in the live progress ring buffer.
const ACTIVITY_LOG_CAP = 25;

// Run a review end-to-end and persist its result. Owns status transitions:
// running → succeeded/failed/cancelled. Never throws to the caller for an
// expected failure (it records it); rethrows only truly unexpected errors so the
// manager can log them.
export async function runReview(args: RunReviewArgs): Promise<void> {
  const { reviewId, onProgress, abortController } = args;
  await markReviewRunning(reviewId);

  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;

  try {
    // Fetch the diff FIRST — it's independent of any clone (`gh pr diff`), so the
    // router can decide the mode before we do any expensive worktree setup.
    onProgress({ phase: 'fetching_diff' });
    const rawDiff = await fetchPrDiff(args.owner, args.name, args.prNumber);
    const { diff: strippedDiff, excluded } = stripNoiseFromDiff(
      rawDiff,
      isNoiseFile,
    );
    const changedFiles = splitDiffByFile(strippedDiff).map((s) => s.path);

    // Route: skip / diff_only / worktree. Recorded on the run for audit BEFORE
    // anything else runs (or, for skip, instead of running the agent at all).
    onProgress({ phase: 'deciding' });
    const decision = decideReviewMode({
      diff: strippedDiff,
      requested: args.requestedMode,
    });
    await markReviewRouted(reviewId, decision.mode, decision.reason);

    // 'skip' — the diff is entirely noise / binary / rename-only. Synthesize a
    // succeeded run with a one-line note and spend NO agent turns (no clone either).
    if (decision.mode === 'skip') {
      onProgress({ phase: 'persisting' });
      await saveReviewSuccess(reviewId, {
        scope: null,
        summary: skipSummary(decision.reason.changedFiles),
        verdict: 'COMMENT',
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        numTurns: 0,
        excludedFiles: excluded,
        findings: [],
      });
      return;
    }

    // The mode that actually runs an agent.
    const mode = decision.mode; // 'diff_only' | 'worktree'

    // Working directory + tool surface per mode. A worktree review clones + checks
    // out the head and gets the read-only file tools; a diff-only review is
    // TOOL-LESS with a throwaway cwd and NO clone/worktree (the dominant per-run
    // cost), since the whole change is already inlined in its prompt.
    let cwd: string;
    let allowedTools: string[];
    let maxTurns: number;
    if (mode === 'worktree') {
      onProgress({ phase: 'cloning', reviewMode: mode });
      repoCloneDir = await ensureClone(args.owner, args.name);
      await fetchPrHead(repoCloneDir, args.prNumber, args.headSha);
      worktreePath = await addWorktree(repoCloneDir, args.headSha);
      cwd = worktreePath;
      allowedTools = WORKTREE_TOOLS;
      maxTurns = config.reviewMaxTurns;
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'pierre-review-'));
      cwd = tempCwd;
      allowedTools = DIFF_ONLY_TOOLS;
      maxTurns = config.reviewDiffOnlyMaxTurns;
    }

    // If the user supplied an Anthropic API key, override ambient Claude auth for
    // this run (restored in finally). Safe only at reviewConcurrency === 1.
    restoreEnv = applyUserAnthropicKey();

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
      prompt: buildUserPrompt({
        repoFullName: args.repoFullName,
        prNumber: args.prNumber,
        title: args.title,
        body: args.body,
        headSha: args.headSha,
        baseRef: args.baseRefName,
        changedFiles,
        excludedFiles: excluded,
        diff: strippedDiff,
        mode,
      }),
      options: {
        model: args.model,
        systemPrompt: systemPromptForMode(mode),
        cwd,
        permissionMode: 'bypassPermissions',
        allowedTools,
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns,
        maxBudgetUsd: config.reviewBudgetUsd,
        // Don't inherit the host's .claude settings / CLAUDE.md / skills.
        settingSources: [],
        mcpServers: { review: server },
        abortController,
      },
    });

    // Rolling, newest-last log of what the agent is doing right now, surfaced via
    // onProgress (rides the /status poll). Live-only — never persisted.
    const activity: string[] = [];
    const pushActivity = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      activity.push(trimmed);
      if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
    };

    // Flip to 'reviewing' the moment setup is done — BEFORE the first model token.
    // Otherwise the prior phase ('deciding' for diff-only, 'cloning' for worktree)
    // would linger through the agent's whole first turn (the model reading the diff),
    // which makes the instant routing step look slow. Also carries the decided mode.
    onProgress({ phase: 'reviewing', reviewMode: mode });

    for await (const message of q) {
      if (message.type === 'assistant') {
        // Derive short, human-readable lines from the assistant turn's content
        // blocks. Defensive throughout: content may be missing and tool input
        // shapes vary — a malformed block must never abort the review.
        try {
          for (const line of describeAssistantBlocks(message)) pushActivity(line);
        } catch {
          /* never let progress derivation break the run */
        }
        onProgress({
          phase: 'reviewing',
          recentActivity: [...activity],
          reviewMode: mode,
        });
      } else if (message.type === 'result') {
        result = message;
      }
    }

    const telemetry = {
      costUsd: result?.total_cost_usd ?? null,
      inputTokens: result?.usage?.input_tokens ?? null,
      outputTokens: result?.usage?.output_tokens ?? null,
      numTurns: result?.num_turns ?? null,
    };

    if (!captured) {
      const reason =
        result && result.subtype !== 'success'
          ? `agent stopped (${result.subtype}) without submitting a review`
          : 'agent finished without calling submit_review';
      await markReviewFailed(reviewId, reason, {
        ...telemetry,
        scope: null,
        excludedFiles: excluded,
      });
      return;
    }

    // ---- anchor + persist ----
    onProgress({ phase: 'persisting' });
    const payload: SubmitReviewPayload = captured;
    const index = buildAnchorIndex(strippedDiff);
    const findings: PersistedFinding[] = payload.findings.map((f) => {
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
        diffHunk: extractHunk(strippedDiff, f.path, line, side),
        anchored: isFindingAnchored(index, f.path, line, side),
      };
    });

    await saveReviewSuccess(reviewId, {
      scope: payload.scopeUsed,
      summary: payload.summary,
      verdict: payload.verdict,
      costUsd: telemetry.costUsd,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      numTurns: telemetry.numTurns,
      excludedFiles: excluded,
      findings,
    });
  } catch (err) {
    // A user cancel aborts the SDK iterator, surfacing as an error here.
    if (abortController.signal.aborted) {
      await markReviewCancelled(reviewId);
      return;
    }
    await markReviewFailed(reviewId, errorMessage(err), {
      costUsd: result?.total_cost_usd ?? null,
      inputTokens: result?.usage?.input_tokens ?? null,
      outputTokens: result?.usage?.output_tokens ?? null,
      numTurns: result?.num_turns ?? null,
    });
  } finally {
    restoreEnv?.();
    if (repoCloneDir && worktreePath) {
      await removeWorktree(repoCloneDir, worktreePath).catch(() => {});
    }
    // Diff-only runs use a throwaway cwd — remove it (best-effort).
    if (tempCwd) {
      try {
        rmSync(tempCwd, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
    // Only a worktree run touched the clone cache. LRU eviction does a full
    // recursive dir walk; keep it off the run-teardown critical path. Defer it
    // (fire-and-forget) so the review result returns promptly. cleanupCloneCache is
    // itself best-effort and never throws.
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

// The one-line summary recorded for a 'skip' run (no agent ran). `changedFiles` is
// the non-noise file count: 0 means the whole diff was lockfile/generated/vendored.
function skipSummary(changedFiles: number): string {
  return changedFiles === 0
    ? 'Skipped — after stripping lockfile/generated/vendored files, this PR has no substantive changes to review.'
    : 'Skipped — no reviewable line changes (the diff is binary, rename, or mode-only after stripping noise files).';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const TEXT_SNIPPET_CAP = 120;
const BASH_CMD_CAP = 80;

/**
 * Turn one assistant message into a few short, human-readable progress lines:
 * a label per tool_use block (e.g. `Read src/foo.ts`, `Grep "TODO"`, `Bash npm
 * test`) plus a clipped snippet of any assistant text. Defensive throughout —
 * the SDK content/tool-input shapes vary, so every access is guarded and this
 * never throws.
 */
function describeAssistantBlocks(message: unknown): string[] {
  const lines: string[] = [];
  const content = (message as { message?: { content?: unknown } })?.message
    ?.content;
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
      // Generic: name + a truncated first string-valued arg, if any.
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
