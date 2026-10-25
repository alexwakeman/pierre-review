import { readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import {
  claudeModelChoice,
  getActiveProvider,
  type AgentToolReply,
  type AgentToolServer,
} from '../ai/provider.js';
import { config } from '../config.js';
import { describeAssistantBlocks } from '../review/agent.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import type { DispatchDecision } from '../review/claude-review/specialists.js';
import { DISPATCH_TOOL_NAMES } from '../review/claude-review/specialists.js';
import { resolveReal } from '../review/path-guard.js';
import { estimateCostUsd } from '../review/pricing.js';
import { recordUsage, sumModelUsage, sumUsageMap, type UsageTokens } from '../review/usage.js';
import {
  judgeFinish,
  judgeRecord,
  newBuildState,
  progressReply,
  type AcceptedFinish,
  type BuildMode,
  type BuildState,
} from './build-judge.js';
import { buildToolShapes } from './schema.js';

// THE REFERENCE-DOCS AGENT RUNS — the SDK half (docs/REFERENCE-DOCS.md § The build, § The chat). The
// manager prepares the staging folder and the prompt and assembles the output; this module only runs
// the agent and returns what it recorded. It never touches the DB and never throws for an expected
// failure.
//
// THE TOOL SURFACE, per run:
//   build 'sections'  Read, Glob, Grep + mcp__docs__{record_sections, progress, finish_document}.
//                     Every write tool is DENIED: the server wrote the files.
//   build 'pdf'       the same + Write and Edit, which a SECOND PreToolUse hook (sectionsWriteGuard)
//                     confines to `<staging>/sections/<name>.md` — nothing else can be created or
//                     changed, not even inside the staging folder.
//   chat              Read, Glob, Grep over the workspace's library, nothing else.
// Bash is denied OUTRIGHT in all three (absent from the allow list AND on the deny list), and the
// PATH GUARD (review/path-guard.ts) confines every path to the run's folder: the document is a
// stranger's text and `bypassPermissions` confines nothing on its own.

export const DOCS_MODEL: ClaudeReviewModel = 'claude-sonnet-5';
export const DOCS_TOOLS = {
  record: 'mcp__docs__record_sections',
  progress: 'mcp__docs__progress',
  finish: 'mcp__docs__finish_document',
} as const;
const ACTIVITY_LOG_CAP = 25;
const BASE_DENY = ['Bash', 'NotebookEdit', 'MultiEdit', 'WebFetch', 'WebSearch', 'Task'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
/** The largest section file the PDF build may write in one call (characters). */
export const MAX_WRITE_CHARS = 80_000;
const WRITABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.md$/;

/** The tool policy for one run. Pure, so the no-shell rule is testable. */
export function docsToolPolicy(run: 'sections' | 'pdf' | 'chat'): {
  builtinTools: string[];
  allowedTools: string[];
  disallowedTools: string[];
} {
  const read = ['Read', 'Glob', 'Grep'];
  if (run === 'chat') {
    return { builtinTools: read, allowedTools: read, disallowedTools: [...new Set([...BASE_DENY, ...WRITE_TOOLS, ...DISPATCH_TOOL_NAMES])] };
  }
  const own = [DOCS_TOOLS.record, DOCS_TOOLS.progress, DOCS_TOOLS.finish];
  if (run === 'pdf') {
    const builtin = [...read, 'Write', 'Edit'];
    return { builtinTools: builtin, allowedTools: [...builtin, ...own], disallowedTools: [...new Set([...BASE_DENY, ...DISPATCH_TOOL_NAMES])] };
  }
  return { builtinTools: read, allowedTools: [...read, ...own], disallowedTools: [...new Set([...BASE_DENY, ...WRITE_TOOLS, ...DISPATCH_TOOL_NAMES])] };
}

const deny = (reason: string): DispatchDecision => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
});

/**
 * The PDF build's write rule, pure: a write tool may touch ONLY `<sectionsDir>/<name>.md`. Every other
 * tool passes through (the path guard judges reads).
 */
export function judgeWrite(sectionsDir: string, cwd: string, toolName: string, toolInput: unknown): DispatchDecision {
  if (!WRITE_TOOLS.includes(toolName)) return { continue: true };
  const input = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : {};
  const raw = input.file_path ?? input.notebook_path;
  if (typeof raw !== 'string' || raw === '' || raw.includes('\u0000')) return deny('Give file_path as sections/<name>.md.');
  const abs = resolveReal(resolve(cwd, raw));
  if (dirname(abs) !== resolveReal(resolve(sectionsDir)) || !WRITABLE_NAME.test(basename(abs))) {
    return deny('Only markdown files directly inside sections/ may be written, e.g. sections/001-introduction.md.');
  }
  if (toolName === 'Write' && typeof input.content === 'string' && input.content.length > MAX_WRITE_CHARS) {
    return deny(`That file is too long (${input.content.length} characters). Split the section into parts.`);
  }
  return { continue: true };
}

function sectionsWriteGuardHook(sectionsDir: string, cwd: string) {
  return {
    hooks: [
      async (input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }): Promise<DispatchDecision> =>
        input.hook_event_name === 'PreToolUse' ? judgeWrite(sectionsDir, cwd, input.tool_name ?? '', input.tool_input) : { continue: true },
    ],
  };
}

export interface AgentTelemetry {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

function telemetryOf(model: ClaudeReviewModel, result: SDKResultMessage | null, usageByUuid: Map<string, UsageTokens>): AgentTelemetry {
  const usage = sumModelUsage(result) ?? sumUsageMap(usageByUuid);
  const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  return {
    costUsd: result?.total_cost_usd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    numTurns: result?.num_turns ?? null,
  };
}

/** The highest page a Read of the PDF has reached, from a tool_use's `pages` ("21-40", "7"). */
export function lastPageRead(pages: unknown): number | null {
  if (typeof pages !== 'string') return null;
  let max = 0;
  for (const m of pages.matchAll(/(\d+)/g)) max = Math.max(max, Number(m[1]));
  return max > 0 ? max : null;
}

// ---- the build ----

export interface BuildProgress {
  recorded: number;
  expected: number;
  pagesRead: number;
  written: number;
  activity: string[];
}

export interface RunBuildArgs {
  mode: BuildMode;
  cwd: string;
  sectionsDir: string;
  expected: string[];
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
  onProgress?(p: BuildProgress): void;
}

export interface RunBuildResult extends AgentTelemetry {
  state: BuildState;
  finish: AcceptedFinish | null;
  failureReason?: string;
  aborted: boolean;
}

const listWritten = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => WRITABLE_NAME.test(f));
  } catch {
    return [];
  }
};

export async function runBuildAgent(args: RunBuildArgs): Promise<RunBuildResult> {
  const model = DOCS_MODEL;
  const state = newBuildState(args.mode, args.expected);
  let finish: AcceptedFinish | null = null;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  const usageByUuid = new Map<string, UsageTokens>();
  let pagesRead = 0;
  const activity: string[] = [];
  const emit = (): void => {
    try {
      args.onProgress?.({
        recorded: state.recorded.size,
        expected: state.expected.length,
        pagesRead,
        written: args.mode === 'pdf' ? listWritten(args.sectionsDir).length : 0,
        activity: [...activity],
      });
    } catch {
      /* never let progress break the run */
    }
  };
  const done = (failureReason: string | undefined, aborted: boolean): RunBuildResult => ({
    state,
    finish,
    failureReason,
    aborted,
    ...telemetryOf(model, result, usageByUuid),
  });

  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const shapes = await buildToolShapes();
    const text = (t: string, isError = false): AgentToolReply => ({ text: t, ...(isError ? { isError: true } : {}) });
    const tools: AgentToolServer = {
      server: 'docs',
      tools: [
        {
          name: 'record_sections',
          description: 'Record section titles and one-line summaries, in reading order. Call it after each batch.',
          shape: shapes.record,
          handle: async (a) => {
            if (finish != null) return text('The document is already finished.');
            const j = judgeRecord(state, a, listWritten(args.sectionsDir));
            emit();
            return text(j.reply, j.isError);
          },
        },
        {
          name: 'progress',
          description: 'What is recorded so far and what is left.',
          shape: shapes.empty,
          handle: async () => text(progressReply(state, listWritten(args.sectionsDir))),
        },
        {
          name: 'finish_document',
          description: 'Close the build with the document summary and topics. Call it once, at the end.',
          shape: shapes.finish,
          handle: async (a) => {
            if (finish != null) return text('Already finished. Stop now.');
            const j = judgeFinish(state, a, listWritten(args.sectionsDir));
            if ('accepted' in j) {
              finish = j.accepted;
              return text('Finished. Stop now.');
            }
            return text(j.reply, true);
          },
        },
      ],
    };
    const policy = docsToolPolicy(args.mode);
    ({ result } = await getActiveProvider().runAgent({
      kind: 'docs_build',
      model: claudeModelChoice(model),
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // ⚠ THE CONFINEMENT LIVES IN THE HOOKS, not in the prompt (a PreToolUse deny holds under
      // bypassPermissions): the provider's path guard rooted at the staging folder, then — on a PDF
      // build — the sections-write guard.
      cwd: args.cwd,
      roots: [],
      readOnlyRoots: [],
      writeRoots: args.mode === 'pdf' ? [args.sectionsDir] : [],
      tools,
      budget: { usd: config.docsBuildBudgetUsd, turns: config.docsBuildMaxTurns },
      abortController: args.abortController,
      claude: {
        builtinTools: policy.builtinTools,
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        extraPreToolUse: args.mode === 'pdf' ? [sectionsWriteGuardHook(args.sectionsDir, args.cwd)] : [],
      },
      onMessage: (message) => {
        if (message.type === 'assistant') {
          try {
            recordUsage(usageByUuid, message);
          } catch {
            /* usage shape varies — never let it break the run */
          }
          try {
            const content = (message as { message?: { content?: unknown } }).message?.content;
            if (Array.isArray(content)) {
              for (const b of content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
                if (b?.type === 'tool_use' && b.name === 'Read' && typeof b.input?.file_path === 'string' && /\.pdf$/i.test(b.input.file_path)) {
                  const p = lastPageRead(b.input.pages);
                  if (p != null && p > pagesRead) pagesRead = p;
                }
              }
            }
            for (const line of describeAssistantBlocks(message)) {
              activity.push(line);
              if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
            }
            emit();
          } catch {
            /* never let progress derivation break the run */
          }
        } else if (message.type === 'result') {
          result = message;
        }
      },
    }));
    if (finish == null) {
      return done(
        result && result.subtype !== 'success'
          ? `Claude stopped (${result.subtype}) before finishing the document.`
          : 'Claude finished without closing the document.',
        false,
      );
    }
    return done(undefined, false);
  } catch (err) {
    if (args.abortController.signal.aborted) return done(undefined, true);
    return done(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}

// ---- the chat ----

export interface RunChatArgs {
  cwd: string;
  systemPrompt: string;
  prompt: string;
  applyAuthEnv: boolean;
  abortController: AbortController;
}

export interface RunChatResult extends AgentTelemetry {
  ok: boolean;
  text: string;
  failureReason?: string;
  aborted: boolean;
}

function assistantText(message: unknown): string {
  const content = (message as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function runDocsChatAgent(args: RunChatArgs): Promise<RunChatResult> {
  const model = DOCS_MODEL;
  let result: SDKResultMessage | null = null;
  let restoreEnv: (() => void) | null = null;
  let lastText = '';
  const usageByUuid = new Map<string, UsageTokens>();
  const fail = (failureReason: string | undefined, aborted: boolean): RunChatResult => ({
    ok: false,
    text: '',
    failureReason,
    aborted,
    ...telemetryOf(model, result, usageByUuid),
  });
  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const policy = docsToolPolicy('chat');
    ({ result } = await getActiveProvider().runAgent({
      kind: 'docs_chat',
      model: claudeModelChoice(model),
      effort: 'worktree',
      prompt: args.prompt,
      system: args.systemPrompt,
      // The provider's path guard, rooted at the library folder; no result tools.
      cwd: args.cwd,
      roots: [],
      readOnlyRoots: [],
      writeRoots: [],
      budget: { usd: config.docsChatBudgetUsd, turns: config.docsChatMaxTurns },
      abortController: args.abortController,
      claude: {
        builtinTools: policy.builtinTools,
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
      },
      onMessage: (message) => {
        if (message.type === 'assistant') {
          try {
            recordUsage(usageByUuid, message);
          } catch {
            /* usage shape varies */
          }
          const t = assistantText(message);
          if (t) lastText = t;
        } else if (message.type === 'result') {
          result = message;
        }
      },
    }));
    const finalText =
      result && result.subtype === 'success' && typeof result.result === 'string' && result.result.trim()
        ? result.result.trim()
        : lastText.trim();
    if (!finalText) {
      return fail(result && result.subtype !== 'success' ? `Claude stopped (${result.subtype}) without answering.` : 'Claude did not answer.', false);
    }
    return { ok: true, text: finalText, aborted: false, ...telemetryOf(model, result, usageByUuid) };
  } catch (err) {
    if (args.abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
