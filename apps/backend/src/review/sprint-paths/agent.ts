import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPRINT_PATHS_CAPS, type ClaudeReviewModel } from '@pierre-review/shared';
import { AiRuntimeMissingError, loadZod } from '../../ai/runtime.js';
import { claudeModelChoice, getActiveProvider, type AgentToolServer, type AgentOutcome } from '../../ai/provider.js';
import { buildSubmitPathsShape } from './schema.js';
import type { SprintPathsInput, StoredPathsJson } from '../../db/sprint-paths.js';
import { applyClaudeReviewAuth } from '../auth.js';
import { estimateCostUsd } from '../pricing.js';
import { emptyUsage, type UsageTokens } from '../usage.js';
import { validateSprintPaths } from './validate.js';

// THE SPRINT BUILDER'S AGENT RUN (docs/CLAUDE-REVIEW.md § Sprint paths) — the SDK half. Agentic ONLY so
// a refused answer can be fixed in the same run: the model reads NOTHING from disk.
//
//   • ONE TOOL, the in-process `submit_paths` on the `paths` MCP server. `tools: []` (no built-in tool
//     is even offered), every built-in on the deny list (Bash outright, every file and web tool), the
//     PreToolUse PATH GUARD over a throwaway cwd (removed in `finally`) and the ownToolsOnlyHook
//     backstop with ISOLATED_MCP (the account's claude.ai connectors must never reach a run that reads
//     text strangers wrote), `settingSources: []`.
//   • `submit_paths` VALIDATES before it accepts (validate.ts, against the run's input keys): a refusal
//     lists every problem; at most SPRINT_PATHS_CAPS.maxSubmits calls. The first ACCEPTED answer wins.
//   • The SDK is loaded ONLY through ai/runtime.ts; this module is reached through a lazy import from
//     the manager, so booting the server never loads it.

export const SPRINT_PATHS_TOOL = 'mcp__paths__submit_paths';
export const SPRINT_PATHS_DISALLOWED_TOOLS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Task',
] as const;

/** The tool policy, pure (the no-shell, no-file rule is testable). */
export function sprintPathsToolPolicy(): { tools: string[]; allowedTools: string[]; disallowedTools: string[] } {
  return { tools: [], allowedTools: [SPRINT_PATHS_TOOL], disallowedTools: [...SPRINT_PATHS_DISALLOWED_TOOLS] };
}

/** The `submit_paths` handler's decision, pure: accept a valid answer, or say what to fix. */
export function judgePathsSubmission(
  payload: unknown,
  attempt: number,
  input: Pick<SprintPathsInput, 'keys'>,
): { accepted: StoredPathsJson } | { reply: string; refusal: string } {
  const v = validateSprintPaths(payload, input);
  if (v.ok) return { accepted: v.value };
  const last = attempt >= SPRINT_PATHS_CAPS.maxSubmits;
  return {
    refusal: v.problems.join(' '),
    reply: last
      ? `Refused:\n${v.message}\nThat was the last attempt; stop now.`
      : `Refused:\n${v.message}\nFix every point and call submit_paths again with the whole answer.`,
  };
}

export interface SprintPathsAgentArgs {
  input: SprintPathsInput;
  model: ClaudeReviewModel;
  systemPrompt: string;
  prompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  applyAuthEnv: boolean;
  abortController: AbortController;
}

export interface SprintPathsAgentResult {
  /** The accepted answer (validated in the tool), or null. */
  accepted: StoredPathsJson | null;
  /** The last refusal when nothing was accepted. */
  lastRefusal: string | null;
  /** The SDK result subtype ('success', 'error_max_turns', 'error_max_budget_usd', …) or null. */
  subtype: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  runtimeMissing: boolean;
  /** Log-only detail of a thrown failure; never sent to a client. */
  error: string | null;
}

export type SprintPathsAgentRunner = (args: SprintPathsAgentArgs) => Promise<SprintPathsAgentResult>;

export const runSprintPathsAgent: SprintPathsAgentRunner = async (args) => {
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let cwd: string | null = null;
  let accepted: StoredPathsJson | null = null;
  let lastRefusal: string | null = null;
  let liveUsage: UsageTokens = emptyUsage();
  const done = (extra: Partial<SprintPathsAgentResult> = {}): SprintPathsAgentResult => {
    const usage = outcome?.usage ?? liveUsage;
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
    return {
      accepted,
      lastRefusal,
      subtype: outcome?.subtype ?? null,
      costUsd: outcome?.costUsd ?? (hasUsage ? estimateCostUsd(args.model, usage) : null),
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      runtimeMissing: false,
      error: null,
      ...extra,
    };
  };
  try {
    const z = await loadZod();
    let attempts = 0;
    // ⚠ DELIBERATELY LOOSE (./schema.ts): the SERVER's validator judges the answer inside the tool.
    const shape = buildSubmitPathsShape(z);
    const tools: AgentToolServer = {
      server: 'paths',
      tools: [
        {
          name: 'submit_paths',
          description: 'Submit the critical paths and call-outs. It is checked at once: a refusal lists what to fix.',
          shape,
          handle: async (a: unknown) => {
            if (accepted != null) return { text: 'Already recorded.' };
            if (attempts >= SPRINT_PATHS_CAPS.maxSubmits) {
              return { text: 'No more attempts. Stop now.', isError: true };
            }
            attempts += 1;
            const j = judgePathsSubmission(a, attempts, args.input);
            if ('accepted' in j) {
              accepted = j.accepted;
              return { text: 'Recorded.' };
            }
            lastRefusal = j.refusal;
            return { text: j.reply, isError: true };
          },
        },
      ],
    };
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    cwd = mkdtempSync(join(tmpdir(), 'limn-sprint-paths-'));
    const policy = sprintPathsToolPolicy();
    ({ outcome } = await getActiveProvider().runAgent({
      kind: 'sprint_paths',
      model: claudeModelChoice(args.model),
      effort: 'diff_only',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT (the provider's path guard — a deny holds under bypassPermissions).
      cwd,
      roots: [],
      readOnlyRoots: [],
      writeRoots: [],
      tools,
      budget: { usd: args.maxBudgetUsd, turns: args.maxTurns },
      abortController: args.abortController,
      claude: { builtinTools: policy.tools, allowedTools: policy.allowedTools, disallowedTools: policy.disallowedTools },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));
    return done();
  } catch (err) {
    return done({ runtimeMissing: err instanceof AiRuntimeMissingError, error: err instanceof Error ? err.message : String(err) });
  } finally {
    restoreEnv?.();
    if (cwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        /* advisory cleanup — never surface */
      }
    }
  }
};
