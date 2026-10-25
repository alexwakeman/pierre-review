// THE AI PROVIDER SEAM (docs/CODEX-PLAN.md § 3.1). Every agent run and every one-shot completion
// Limn makes goes through ONE `AgentProvider`: the 12 agent runners (review, fix + plan, resolve,
// ticket review + its pre-pass, CI review, Check threads, diagrams, sprint paths, story docs, the
// docs build + docs chat, the review chat) call `runAgent`, and `review/llm.ts` `cheapComplete` —
// which every core one-shot caller AND the platform's `ctx.llm.complete` use — calls `complete`.
//
// PHASE 1: Claude is the ONLY provider (`ai/providers/claude.ts`), and it is today's Agent SDK code
// moved behind this interface, not rewritten: every prompt, tool list, model, budget, hook, stored
// row and wire shape is byte-for-byte what it was. A source-scan test (`provider-seam.test.ts`)
// pins that no module other than `ai/providers/claude.ts` and `ai/runtime.ts` calls the Agent SDK's
// `query` or loads the Anthropic SDK.
//
// What is provider-neutral already: the model is a ROLE (resolved per provider; a call site that
// must keep an exact model id passes it as `id`), the working directory and the path-guard roots,
// the result tools (name + zod shape + handler; `ai/result-schemas.ts` derives the STRICT JSON
// Schema a provider without tools needs), the turn and US$ caps, the abort signal, and the usage
// reading the spend budget folds (`ProviderUsageSource`). What is still Claude's own sits under
// `spec.claude` — the SDK tool names, the extra PreToolUse hooks and the specialist agents — and the
// messages `onMessage` receives are the Agent SDK's. Phase 3 ports each runner off those.
//
// THE CHOICE: `LIMN_AI_PROVIDER` = `claude` | `auto` (default: `auto`, which is Claude — the one the
// rules were tuned on, docs/CODEX-PLAN.md § 6). `codex` is ACCEPTED but answers "not available
// yet": its placeholder's `detect()` says so, and a run or completion rejects with that sentence
// (every caller already turns a rejection into a readable failure). Nothing crashes.
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AiUsageReading } from '@pierre-review/shared';
import { claudeProvider } from './providers/claude.js';

export type AgentProviderId = 'claude' | 'codex';

/** The model, as a ROLE each provider resolves to its own model id. */
export type ModelRole = 'deep' | 'standard' | 'fast';

/**
 * A model choice: the role, plus (optionally) the exact model id this call must run on. A call site
 * whose model is a reader's pick or a pinned id passes it as `id`, so no model moves in Phase 1.
 */
export interface ModelChoice {
  role: ModelRole;
  id?: string;
}

/** Which agent this is — for logs, tests and (Phase 2+) per-kind provider config. */
export type AgentKind =
  | 'review'
  | 'review_chat'
  | 'fix'
  | 'plan'
  | 'resolve'
  | 'ticket_review'
  | 'pr_card'
  | 'ci_review'
  | 'thread_check'
  | 'diagram'
  | 'sprint_paths'
  | 'story_docs'
  | 'docs_build'
  | 'docs_chat';

/** What a result tool's handler answers the model with. `isError` absent ⇒ not sent at all. */
export interface AgentToolReply {
  text: string;
  isError?: boolean;
}

/**
 * One in-process result tool (`submit_review`, `submit_fix`, `record_sections`, …): its name, its
 * description, the zod RAW SHAPE (built from the AI runtime's zod — never a second zod instance),
 * and the handler that validates and keeps the answer. The SAME shape feeds the strict JSON Schema
 * (`ai/result-schemas.ts`), so both providers validate against one contract.
 */
export interface AgentResultTool {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handle(args: unknown): Promise<AgentToolReply> | AgentToolReply;
}

/** The run's result tools, under one server name (`mcp__<server>__<tool>`). */
export interface AgentToolServer {
  server: string;
  tools: AgentResultTool[];
}

/** A PreToolUse hook entry in the Agent SDK's shape (Claude only). */
export interface ClaudePreToolUseEntry {
  hooks: Array<(input: { hook_event_name: string; tool_name?: string; tool_input?: unknown }) => Promise<unknown>>;
}

/** The Claude-only knobs of a run (docs/CODEX-PLAN.md § 3.1: Phase 3 ports each runner off them). */
export interface ClaudeRunOptions {
  /** The SDK's base tool set (`tools`), when the run narrows it. Absent ⇒ not sent. */
  builtinTools?: string[];
  allowedTools: string[];
  disallowedTools: string[];
  /** Extra PreToolUse entries, AFTER the path guard and the own-tools-only hook. */
  extraPreToolUse?: ClaudePreToolUseEntry[];
  /** SDK sub-agents (Claude Review's specialists). Absent ⇒ not sent. */
  agents?: Record<string, unknown>;
}

/** Provider-neutral agent message, for now the Agent SDK's (Phase 2 normalises Codex's events). */
export type AgentMessage = SDKMessage;
export type AgentResultMessage = SDKResultMessage;

export interface AgentRunSpec {
  kind: AgentKind;
  model: ModelChoice;
  /** Effort profile: a diff-only run vs a worktree run (Claude: `sdkModelOptions(model, effort)`). */
  effort: 'diff_only' | 'worktree';
  prompt: string;
  /** The system prompt. Absent ⇒ not sent. */
  system?: string;
  /** The working directory; the path guard's first root. */
  cwd: string;
  /** More roots the file tools may reach (ticket peers, member worktrees). */
  roots: string[];
  /** Roots the file tools may READ but never write (the reference library). */
  readOnlyRoots: string[];
  /** Roots the run may WRITE ([] ⇒ a read-only run). Informational for Claude (its tools decide). */
  writeRoots: string[];
  /** The result tools. Absent ⇒ the run has none (a chat answering in text). */
  tools?: AgentToolServer;
  budget: { usd: number | undefined; turns: number };
  abortController: AbortController;
  /** Every message the run streams, in order. A throw here ends the run like a throw in a loop body. */
  onMessage?(message: AgentMessage): void;
  claude: ClaudeRunOptions;
}

export interface AgentRunResult {
  /** The run's final result message, or null when it ended without one. */
  result: AgentResultMessage | null;
}

export interface CompleteRequest {
  /** An exact model id (a stored per-account override, say). Absent ⇒ the provider's `fast` model. */
  model?: string;
  role?: ModelRole;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

export interface CompleteResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ProviderStatus {
  id: AgentProviderId;
  /** False ⇒ this provider cannot run anything here (not built yet, not installed, no sign-in). */
  available: boolean;
  /** Which credential rung a run would use. */
  route: 'login' | 'api_key' | 'none';
  /** One plain sentence when not available. */
  message: string | null;
}

/**
 * Where the spend budget reads a provider's usage (docs/CODEX-PLAN.md § 8.1): ONE normalised
 * `AiUsageReading` per provider, whatever produced it. Claude's sources are its `rate_limit_event`
 * messages (tapped from every run by ai/runtime.ts) and the SDK's experimental usage probe.
 */
export interface ProviderUsageSource {
  /** Fold one run message into a reading: the windows it names, or null when it names none. */
  readingFromMessage(message: unknown, nowMs: number): AiUsageReading | null;
  /** Ask the provider's own usage endpoint. Resolves its RAW answer; throws on anything unexpected. */
  probe(): Promise<unknown>;
  /** Normalise the probe's raw answer, or null on any shape mismatch. */
  readingFromProbe(raw: unknown, nowMs: number): AiUsageReading | null;
  /** Can the probe run right now (its runtime installed)? Cheap and sync. */
  probeReady(): boolean;
}

export interface AgentProvider {
  id: AgentProviderId;
  /** Resolve a role (or an explicit id) to this provider's model id. */
  resolveModel(choice: ModelChoice): string;
  runAgent(spec: AgentRunSpec): Promise<AgentRunResult>;
  complete(req: CompleteRequest): Promise<CompleteResult>;
  detect(): Promise<ProviderStatus>;
  /** The credential rung, read at call time. Cheap and sync (the budget asks it per request). */
  credentialRoute(): 'login' | 'api_key' | 'none';
  usage: ProviderUsageSource;
}

// ---- the registry -------------------------------------------------------------------------------

export const AI_PROVIDER_ENV = 'LIMN_AI_PROVIDER';

export type AiProviderSetting = 'claude' | 'codex' | 'auto';

export const CODEX_NOT_AVAILABLE_MESSAGE =
  'Codex is not available in this version of Limn yet. Unset LIMN_AI_PROVIDER (or set it to claude) to use Claude.';

/** The reader's `LIMN_AI_PROVIDER`, read at call time. Unset, empty or unknown ⇒ 'auto'. */
export function aiProviderSetting(env: NodeJS.ProcessEnv = process.env): AiProviderSetting {
  const raw = env[AI_PROVIDER_ENV]?.trim().toLowerCase();
  if (raw === 'claude' || raw === 'codex' || raw === 'auto') return raw;
  return 'auto';
}

const notAvailable = (): Error => new Error(CODEX_NOT_AVAILABLE_MESSAGE);

/**
 * The Codex PLACEHOLDER: `LIMN_AI_PROVIDER=codex` is accepted, and every question it is asked
 * answers "not available yet" — `detect()` says so, a run or a completion rejects with that one
 * sentence, its credential route is 'none' (so the budget is off), and it has no usage reading.
 */
export const codexPlaceholderProvider: AgentProvider = {
  id: 'codex',
  resolveModel: (choice) => choice.id ?? choice.role,
  runAgent: async () => {
    throw notAvailable();
  },
  complete: async () => {
    throw notAvailable();
  },
  detect: async () => ({ id: 'codex', available: false, route: 'none', message: CODEX_NOT_AVAILABLE_MESSAGE }),
  credentialRoute: () => 'none',
  usage: {
    readingFromMessage: () => null,
    probe: async () => {
      throw notAvailable();
    },
    readingFromProbe: () => null,
    probeReady: () => false,
  },
};

/** One provider by id. */
export function getProvider(id: AgentProviderId): AgentProvider {
  return id === 'codex' ? codexPlaceholderProvider : claudeProvider;
}

/** THE provider every run and completion uses, per `LIMN_AI_PROVIDER` (read at call time). */
export function getActiveProvider(env: NodeJS.ProcessEnv = process.env): AgentProvider {
  return aiProviderSetting(env) === 'codex' ? codexPlaceholderProvider : claudeProvider;
}

/**
 * A Claude model id as a ModelChoice: its role, with the id kept EXACTLY (the reader's pick, a
 * config default or a pinned id). Unknown ids keep their id under the 'standard' role.
 */
export function claudeModelChoice(model: string): ModelChoice {
  if (model.startsWith('claude-opus')) return { role: 'deep', id: model };
  if (model.startsWith('claude-haiku')) return { role: 'fast', id: model };
  return { role: 'standard', id: model };
}
