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
// rules were tuned on, docs/CODEX-PLAN.md § 6). `codex` is ACCEPTED and, since Phase 2, resolves to
// the real Codex provider (`ai/providers/codex.ts`) — but ONLY its one-shot `complete()` runs. Its
// `runAgent` answers "not available yet" for every kind outside `CODEX_AGENT_KINDS` (empty until
// Phase 3 ports each agent), and the pre-flight every Run gate and background sweeper asks
// (`review/auth.ts` `detectClaudeAuth`, which feeds `MeResponse.ai` and `ctx.llm.detectAuth`) still
// answers 'none' with that sentence, so no Run button or sweeper offers Codex to a user yet. Nothing
// crashes.
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AiUsageReading } from '@pierre-review/shared';
import type { CodexProgress, TokenUsage } from './codex/events.js';
import { claudeProvider } from './providers/claude.js';
import { codexProvider } from './providers/codex.js';
import { resolveAiCredential, resolveCodexCredential } from './credentials.js';
import { aiProviderSetting, codexRunnable } from './provider-setting.js';

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
  /** Provider-neutral progress (Codex today; Phase 3 moves the runners' status lines onto it). */
  onProgress?(progress: AgentProgress): void;
  /** Who to bill. Given ⇒ a provider that records its own usage (Codex) writes the ledger row. */
  usageRecord?: AgentUsageRecord;
  claude: ClaudeRunOptions;
  /** The Codex-only knobs (Phase 3 sets them per runner). */
  codex?: CodexRunOptions;
}

/** Provider-neutral progress: a status sentence, a tool step, file changes, a message, an error. */
export type AgentProgress = CodexProgress;

/** The ledger row's identity (db/usage.ts `AiUsageRecord`, minus what the provider knows itself). */
export interface AgentUsageRecord {
  accountId: number;
  seam: 'summary' | 'agent';
  feature: string;
  prId?: number | null;
  repoId?: number | null;
}

export interface CodexRunOptions {
  /** The result tool whose answer ENDS the run, when the run has several tools. */
  resultTool?: string;
  /** Wall-clock limit in ms. Absent ⇒ the provider's default. */
  timeoutMs?: number;
  /** Reasoning effort override. Absent ⇒ by role. */
  effort?: string;
}

export interface AgentRunResult {
  /** The run's final result message (Claude's), or null when it ended without one (always, on Codex). */
  result: AgentResultMessage | null;
  /** Which provider ran it. Absent ⇒ Claude (Phase 1 shape). */
  provider?: AgentProviderId;
  /** Codex: the final answer as text (the JSON when the run had a result tool). */
  text?: string;
  /** Codex: the run's tokens, or null when not reported (a cancelled turn). */
  usage?: TokenUsage | null;
  /** Codex: US$ (0 on a ChatGPT login; priced from tokens on an API key). */
  costUsd?: number;
  /** Codex: the files the run changed, read from `git` in its write roots — never from the stream. */
  filesChanged?: string[] | null;
  /** Codex: the thread id (its session lives in Limn's own Codex home). */
  threadId?: string | null;
}

export interface CompleteRequest {
  /** An exact model id (a stored per-account override, say). Absent ⇒ the provider's `fast` model. */
  model?: string;
  role?: ModelRole;
  system?: string;
  prompt: string;
  maxTokens?: number;
  /** A JSON caller's answer schema (strict form). Claude ignores it; Codex passes `--output-schema`. */
  outputSchema?: Record<string, unknown>;
  /** Who to bill. Given ⇒ a provider that records its own usage (Codex) writes the ledger row. */
  usageRecord?: AgentUsageRecord;
}

export interface CompleteResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Which provider answered. Absent ⇒ Claude. A Codex answer's usage is NOT Claude-priced. */
  provider?: AgentProviderId;
  /** The model that answered (Codex reports its own; Claude callers know theirs). */
  model?: string;
  /** Codex: US$ (0 on a ChatGPT login). */
  costUsd?: number;
}

export interface ProviderStatus {
  id: AgentProviderId;
  /** False ⇒ this provider cannot run anything here (not built yet, not installed, no sign-in). */
  available: boolean;
  /** Which credential rung a run would use. */
  route: 'login' | 'api_key' | 'none';
  /** One plain sentence when not available. */
  message: string | null;
  /** Codex only (Phase 2): its program is installed. */
  installed?: boolean;
  /** Codex only: Limn's own Codex home holds a live sign-in (`account/read`). */
  signedIn?: boolean;
  /** Codex only: the ChatGPT plan, when signed in with one. */
  plan?: string | null;
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

export {
  AI_PROVIDER_ENV,
  aiProviderSetting,
  CODEX_AGENT_KINDS,
  CODEX_NOT_AVAILABLE_MESSAGE,
  codexKindNotAvailableMessage,
  codexKindReady,
  codexRunnable,
  ALL_AGENT_KINDS,
  type AiProviderSetting,
} from './provider-setting.js';
export { CODEX_MODEL_FOR_ROLE } from './providers/codex.js';

/** One provider by id. */
export function getProvider(id: AgentProviderId): AgentProvider {
  return id === 'codex' ? codexProvider : claudeProvider;
}

/**
 * Can Codex run agents in this version? Only once EVERY agent kind is in `CODEX_AGENT_KINDS`
 * (provider-setting.ts `codexRunnable`) — FALSE in Phase 2, so `auto` never picks Codex (it would
 * pick a provider bound to refuse), the pre-flight answers "not available", and `/api/me` reports
 * `providers.codex.available: false`. `complete()` runs on Codex regardless (LIMN_AI_PROVIDER=codex).
 */
export const CODEX_RUNNABLE: boolean = codexRunnable();

/**
 * THE `auto` RULE (docs/CODEX-PLAN.md § 6, DECIDED): Claude when both are signed in, Claude when
 * neither is; Codex only when it alone has a credential AND can run. Pure.
 */
export function pickAutoProvider(s: { claudeReady: boolean; codexReady: boolean; codexRunnable: boolean }): AgentProviderId {
  return s.codexRunnable && s.codexReady && !s.claudeReady ? 'codex' : 'claude';
}

/** THE provider every run and completion uses, per `LIMN_AI_PROVIDER` (read at call time). */
export function getActiveProvider(env: NodeJS.ProcessEnv = process.env): AgentProvider {
  const setting = aiProviderSetting(env);
  if (setting === 'codex') return codexProvider;
  if (setting === 'claude' || !CODEX_RUNNABLE) return claudeProvider;
  return getProvider(pickAutoProvider(autoReadiness(env)));
}

/**
 * What the auto rule reads. ⚠ Codex is ready ONLY on a ChatGPT sign-in (`route === 'login'`): the
 * OpenAI API-key route is REFUSED until it can be priced, so a key alone must never make auto pick
 * Codex (where every run would then fail on the refusal).
 */
export function autoReadiness(env: NodeJS.ProcessEnv = process.env): { claudeReady: boolean; codexReady: boolean; codexRunnable: boolean } {
  return {
    claudeReady: resolveAiCredential(env).route !== 'none',
    codexReady: resolveCodexCredential(env).route === 'login',
    codexRunnable: CODEX_RUNNABLE,
  };
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
