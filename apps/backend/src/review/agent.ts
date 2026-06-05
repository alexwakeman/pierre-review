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
} from '@pierre-review/shared';
import { config } from '../config.js';
import { submitReviewShape, type SubmitReviewPayload } from './schema.js';
import {
  addWorktree,
  cleanupCloneCache,
  ensureClone,
  fetchPrHead,
  removeWorktree,
} from './clone-manager.js';
import { REVIEW_SYSTEM_PROMPT, buildUserPrompt, isNoiseFile } from './prompt.js';
import {
  buildAnchorIndex,
  extractHunk,
  fetchPrDiff,
  isFindingAnchored,
  splitDiffByFile,
  stripNoiseFromDiff,
} from './post-review.js';
import {
  markReviewCancelled,
  markReviewFailed,
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
  abortController: AbortController;
  onProgress: (p: ClaudeReviewProgress) => void;
}

// Read-only tool surface. submit_review is the ONLY way structured output leaves
// the agent. Write/Edit are forbidden and destructive Bash is denied.
const ALLOWED_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'Bash',
  'mcp__review__submit_review',
];
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

// Run a review end-to-end and persist its result. Owns status transitions:
// running → succeeded/failed/cancelled. Never throws to the caller for an
// expected failure (it records it); rethrows only truly unexpected errors so the
// manager can log them.
export async function runReview(args: RunReviewArgs): Promise<void> {
  const { reviewId, onProgress, abortController } = args;
  markReviewRunning(reviewId);

  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let result: SDKResultMessage | null = null;

  try {
    onProgress({ phase: 'cloning' });
    repoCloneDir = await ensureClone(args.owner, args.name);

    onProgress({ phase: 'fetching_diff' });
    await fetchPrHead(repoCloneDir, args.prNumber, args.headSha);
    const rawDiff = await fetchPrDiff(args.owner, args.name, args.prNumber);
    const { diff: strippedDiff, excluded } = stripNoiseFromDiff(
      rawDiff,
      isNoiseFile,
    );
    const changedFiles = splitDiffByFile(strippedDiff).map((s) => s.path);

    worktreePath = await addWorktree(repoCloneDir, args.headSha);

    // ---- run the agent ----
    onProgress({ phase: 'deciding' });
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
      }),
      options: {
        model: args.model,
        systemPrompt: REVIEW_SYSTEM_PROMPT,
        cwd: worktreePath,
        permissionMode: 'bypassPermissions',
        allowedTools: ALLOWED_TOOLS,
        disallowedTools: DISALLOWED_TOOLS,
        maxTurns: config.reviewMaxTurns,
        maxBudgetUsd: config.reviewBudgetUsd,
        // Don't inherit the host's .claude settings / CLAUDE.md / skills.
        settingSources: [],
        mcpServers: { review: server },
        abortController,
      },
    });

    let announcedReviewing = false;
    for await (const message of q) {
      if (message.type === 'assistant' && !announcedReviewing) {
        announcedReviewing = true;
        onProgress({ phase: 'reviewing' });
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
      markReviewFailed(reviewId, reason, {
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

    saveReviewSuccess(reviewId, {
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
      markReviewCancelled(reviewId);
      return;
    }
    markReviewFailed(reviewId, errorMessage(err), {
      costUsd: result?.total_cost_usd ?? null,
      inputTokens: result?.usage?.input_tokens ?? null,
      outputTokens: result?.usage?.output_tokens ?? null,
      numTurns: result?.num_turns ?? null,
    });
  } finally {
    if (repoCloneDir && worktreePath) {
      await removeWorktree(repoCloneDir, worktreePath).catch(() => {});
    }
    cleanupCloneCache();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
