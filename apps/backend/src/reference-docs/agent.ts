import { readdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ClaudeReviewModel } from '@pierre-review/shared';
import { providerName } from '../ai/prompt-tools.js';
import {
  claudeModelChoice,
  getActiveProvider,
  type AgentOutcome,
  type AgentProviderId,
  type AgentToolReply,
  type AgentToolServer,
  type AgentUsageRecord,
} from '../ai/provider.js';
import { config } from '../config.js';
import { applyClaudeReviewAuth } from '../review/auth.js';
import type { DispatchDecision } from '../review/claude-review/specialists.js';
import { DISPATCH_TOOL_NAMES } from '../review/claude-review/specialists.js';
import { resolveReal } from '../review/path-guard.js';
import { estimateCostUsd } from '../review/pricing.js';
import { emptyUsage, type UsageTokens } from '../review/usage.js';
import {
  MAX_FINISH_ATTEMPTS,
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
//
// ON CODEX (docs/CODEX-PLAN.md Phase 3, kinds 'docs_build' + 'docs_chat'): the same runs through the
// active provider's `runAgent`, reading through Limn's workspace MCP server confined to the SAME folder
// the Claude path guard allows (the staging folder / the library), read-only.
//   build   'sections' only. Codex has no tools of Limn's own, so it answers ONCE with every section's
//           summary and the document summary and topics (`submit_document` = the record_sections and
//           finish_document shapes side by side), judged by the SAME judgeRecord + judgeFinish. Codex
//           gets two answers (its one retry), so its retry is the build's LAST finish attempt — where
//           the Claude build, after MAX_FINISH_ATTEMPTS, accepts what it has rather than fail.
//           ⚠ A 'pdf' build REFUSES on Codex before any run (CODEX_PDF_MESSAGE): the PDF's pages are
//           read through Claude's own Read tool, which Codex has no equivalent of (Limn's read_file
//           shows no binary file), and its section writes are guarded by a Claude-only hook.
//   chat    no result tool: Codex's final message is the answer, exactly as Claude's result text is.
// Codex records its own ledger row (`usageRecord`), so the callers record none for a Codex run.

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
  /** Which provider ran it. 'codex' ⇒ its ledger row is already written. */
  provider: AgentProviderId;
}

/** Why a PDF never builds on Codex (see the header). Shown on the document. */
export const CODEX_PDF_MESSAGE =
  'Codex cannot read PDF files. Upload the document as Word, text or markdown, or use Claude for PDFs.';

/** Codex's words for a judge's refusal: it answers again, it never calls a tool. */
export function codexRefusalWords(reply: string): string {
  return reply
    .replace(/ Fix these and call record_sections again\./g, ' Fix these and answer again with the whole answer.')
    .replace(/ Then call finish_document again\./g, ' Then answer again with the whole answer.');
}

function telemetryOf(
  model: ClaudeReviewModel,
  outcome: AgentOutcome | null,
  liveUsage: UsageTokens,
  provider: AgentProviderId,
): AgentTelemetry {
  const usage = outcome?.usage ?? liveUsage;
  const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0;
  return {
    costUsd: outcome?.costUsd ?? (hasUsage ? estimateCostUsd(model, usage) : null),
    inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    numTurns: outcome?.numTurns ?? null,
    provider,
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
  /** Who to bill. A provider that records its own usage (Codex) writes the ledger row from it. */
  usageRecord?: AgentUsageRecord;
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
  // Who runs it (the same LIMN_AI_PROVIDER read the run's own `getActiveProvider()` makes): its words
  // in the handlers' replies, and whether its ledger row is already written.
  const provider = getActiveProvider();
  const onCodex = provider.id === 'codex';
  const state = newBuildState(args.mode, args.expected);
  // Codex answers at most twice (its one retry): that retry is the build's LAST finish attempt,
  // whatever became of the first answer — refused by judgeRecord before any finish was tried, or
  // failing Limn's shape check so the handler never ran. The provider says when its retry starts
  // (`status` with `retry`), and the handler then forces the attempt count (below).
  let codexRetrying = false;
  let finish: AcceptedFinish | null = null;
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let liveUsage: UsageTokens = emptyUsage();
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
    ...telemetryOf(model, outcome, liveUsage, provider.id),
  });

  // A PDF build never runs on Codex (see the header): refused before anything starts.
  if (onCodex && args.mode === 'pdf') return done(CODEX_PDF_MESSAGE, false);

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
    // CODEX: ONE result — the sections and the closing call together, judged in that order by the
    // SAME two judges (a record refusal stops before the finish is tried).
    if (onCodex) {
      tools.tools.push({
        name: 'submit_document',
        description: "Every section's summary, then the document summary and topics, in one answer.",
        shape: shapes.document,
        handle: async (a) => {
          if (finish != null) return text('Already finished.');
          const p = (a ?? {}) as Record<string, unknown>;
          const written = listWritten(args.sectionsDir);
          const rec = judgeRecord(state, { sections: p.sections }, written);
          emit();
          if (rec.isError) return text(codexRefusalWords(rec.reply), true);
          if (codexRetrying) state.finishAttempts = Math.max(state.finishAttempts, MAX_FINISH_ATTEMPTS - 1);
          const j = judgeFinish(state, { title: p.title, summary: p.summary, topics: p.topics }, written);
          if ('accepted' in j) {
            finish = j.accepted;
            return text('Finished.');
          }
          const recProblems = rec.reply.includes('Not recorded:') ? ` ${codexRefusalWords(rec.reply)}` : '';
          return text(`${codexRefusalWords(j.reply)}${recProblems}`, true);
        },
      });
    }
    const policy = docsToolPolicy(args.mode);
    ({ outcome } = await getActiveProvider().runAgent({
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
      // Codex: the whole build is the run's final answer (the strict `submit_document` schema).
      codex: { resultTool: 'submit_document' },
      ...(args.usageRecord ? { usageRecord: args.usageRecord } : {}),
      claude: {
        builtinTools: policy.builtinTools,
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
        extraPreToolUse: args.mode === 'pdf' ? [sectionsWriteGuardHook(args.sectionsDir, args.cwd)] : [],
        // ⚠ THE CLAUDE-ONLY ESCAPE HATCH (ai/provider.ts `ClaudeRunOptions.onMessage`): the PDF page a
        // `Read` reached is an argument of Claude's own Read tool (`pages`), which no neutral step
        // carries. It runs BEFORE that message's step, so the step's progress line shows the page.
        onMessage: (message) => {
          if (message.type !== 'assistant') return;
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
          } catch {
            /* never let progress derivation break the run */
          }
        },
      },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          for (const line of p.lines) {
            activity.push(line);
            if (activity.length > ACTIVITY_LOG_CAP) activity.shift();
          }
          emit();
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        } else if (p.kind === 'status' && p.retry === true) {
          codexRetrying = true;
        }
      },
    }));
    if (finish == null) {
      return done(
        outcome && outcome.subtype !== 'success'
          ? `${providerName(provider.id)} stopped (${outcome.subtype}) before finishing the document.`
          : `${providerName(provider.id)} finished without closing the document.`,
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
  /** Who to bill. A provider that records its own usage (Codex) writes the ledger row from it. */
  usageRecord?: AgentUsageRecord;
}

export interface RunChatResult extends AgentTelemetry {
  ok: boolean;
  text: string;
  failureReason?: string;
  aborted: boolean;
}

export async function runDocsChatAgent(args: RunChatArgs): Promise<RunChatResult> {
  const model = DOCS_MODEL;
  // Who runs it (the same LIMN_AI_PROVIDER read the run's own `getActiveProvider()` makes): its words
  // in the handlers' replies, and whether its ledger row is already written.
  const provider = getActiveProvider();
  let outcome: AgentOutcome | null = null;
  let restoreEnv: (() => void) | null = null;
  let lastText = '';
  let liveUsage: UsageTokens = emptyUsage();
  const fail = (failureReason: string | undefined, aborted: boolean): RunChatResult => ({
    ok: false,
    text: '',
    failureReason,
    aborted,
    ...telemetryOf(model, outcome, liveUsage, provider.id),
  });
  try {
    restoreEnv = applyClaudeReviewAuth(args.applyAuthEnv);
    const policy = docsToolPolicy('chat');
    ({ outcome } = await getActiveProvider().runAgent({
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
      ...(args.usageRecord ? { usageRecord: args.usageRecord } : {}),
      claude: {
        builtinTools: policy.builtinTools,
        allowedTools: policy.allowedTools,
        disallowedTools: policy.disallowedTools,
      },
      onProgress: (p) => {
        if (p.kind === 'step') {
          if (p.usage) liveUsage = p.usage;
          if (p.text) lastText = p.text;
        } else if (p.kind === 'outcome') {
          outcome = p.outcome;
        }
      },
    }));
    const finalText =
      outcome?.text?.trim()
        ? outcome.text.trim()
        : lastText.trim();
    if (!finalText) {
      const who = providerName(provider.id);
      return fail(outcome && outcome.subtype !== 'success' ? `${who} stopped (${outcome.subtype}) without answering.` : `${who} did not answer.`, false);
    }
    return { ok: true, text: finalText, aborted: false, ...telemetryOf(model, outcome, liveUsage, provider.id) };
  } catch (err) {
    if (args.abortController.signal.aborted) return fail(undefined, true);
    return fail(err instanceof Error ? err.message : String(err), false);
  } finally {
    restoreEnv?.();
  }
}
