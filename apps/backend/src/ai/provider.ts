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
// `spec.claude` — the SDK tool names, the extra PreToolUse hooks, the specialist agents and the raw
// Agent SDK message tap (`spec.claude.onMessage`, the one escape hatch: see its comment).
//
// THE NEUTRAL RUN STREAM (Phase 3 foundation). Every provider reports a run the same way, through
// `spec.onProgress` and the returned `AgentRunResult.outcome`:
//   • `step` — one model step: its activity lines (already worded, per `spec.activity`), its text and
//     the run's LIVE token tally so far (Claude: one per assistant message, derived inside
//     providers/claude.ts exactly as each runner used to; Codex: from ai/codex/events.ts);
//   • `outcome` — how the run ended (subtype, final text on success, US$, turns, whole-run tokens),
//     emitted the moment it is known, so a run that throws AFTER it still reports it;
//   • Codex's finer progress kinds (`status`, `tool`, `file_change`, `message`, `error`) for the
//     status line. A runner reads the facts it needs and never a raw SDK message.
//
// THE CHOICE: `LIMN_AI_PROVIDER` = `claude` | `auto` (default: `auto`, which is Claude — the one the
// rules were tuned on, docs/CODEX-PLAN.md § 6). `codex` is ACCEPTED and, since Phase 2, resolves to
// the real Codex provider (`ai/providers/codex.ts`). Its `runAgent` answers "not available yet" for
// any kind outside `CODEX_AGENT_KINDS` (the union of ai/codex/kinds/*.ts — every kind since Phase 3). The
// pre-flight every Run gate and background sweeper asks (`review/auth.ts` `detectClaudeAuth(kind)`,
// which feeds `MeResponse.ai` + its per-kind `kinds` map and `ctx.llm.detectAuth(kind)`) answers PER
// KIND: a one-shot ('complete') or a ported kind is runnable once Codex is installed and signed in with
// ChatGPT; every other kind answers its own "Codex cannot run … yet" sentence. Nothing crashes.
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AiAgentKind, AiEffort, AiUsageReading } from '@pierre-review/shared';
import type { CodexProgress, TokenUsage } from './codex/events.js';
import type { UsageTokens } from '../review/usage.js';
import { CLAUDE_MODEL_FOR_ROLE, claudeProvider } from './providers/claude.js';
import { CODEX_MODEL_FOR_ROLE as CODEX_MODEL_FOR_ROLE_SRC, codexProvider } from './providers/codex.js';
import { activeProviderId, codexRunnable } from './provider-setting.js';

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

/**
 * Which agent this is — for logs, tests and per-kind provider config (`CODEX_AGENT_KINDS`, the
 * per-kind pre-flight). The ONE list lives in packages/shared (`AiAgentKind`), because `/api/me`
 * answers per kind (`MeResponse.ai.kinds`).
 */
export type AgentKind = AiAgentKind;

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
  /**
   * The run's effort, decided by the caller (the review and AI Fix: ai/effort.ts `agenticRunEffort`).
   * Absent ⇒ `defaultRunEffort` for `spec.effort`'s mode (review/model-options.ts).
   */
  effort?: AiEffort;
  /**
   * ⚠ THE CLAUDE-ONLY ESCAPE HATCH: every raw Agent SDK message, in order, BEFORE the neutral
   * `onProgress` events derived from it. Only for a fact no neutral event carries. A throw here ends
   * the run like a throw in the loop body. Users (keep this list current):
   *   • reference-docs/agent.ts (the docs build) — the PDF page a `Read` reached (`pages`), a Claude
   *     tool's own argument, for the "page N of M" line. Codex reads no PDF pages through its tools.
   */
  onMessage?(message: AgentMessage): void;
}

/** A raw Agent SDK message — `spec.claude.onMessage` only. Runners read the neutral stream instead. */
export type AgentMessage = SDKMessage;
export type AgentResultMessage = SDKResultMessage;

/** The run's tokens, provider-neutral (review/usage.ts's shape: input EXCLUSIVE of the cache buckets). */
export type AgentTokens = UsageTokens;

/**
 * How a run ended — the neutral form of Claude's result message (Codex: built by its provider).
 * `subtype` is 'success' or the reason it stopped (Claude's own words: 'error_max_turns',
 * 'error_max_budget_usd', 'error_during_execution'; Codex: 'error' | 'cancelled').
 */
export interface AgentOutcome {
  subtype: string;
  /** The final text answer — on success only, untrimmed (Claude: the result message's `result`). */
  text: string | null;
  /** The provider's own US$ for the run (Claude: `total_cost_usd`), or null when it gave none. */
  costUsd: number | null;
  /** Model turns (Claude: `num_turns`), or null when the provider does not count them. */
  numTurns: number | null;
  /** The AUTHORITATIVE whole-run tokens (Claude: summed `modelUsage`), or null when not reported. */
  usage: AgentTokens | null;
}

/** One model step (Claude: one assistant message). */
export interface AgentStep {
  kind: 'step';
  /** Human-readable activity lines for this step (tool labels, clipped text), in order. */
  lines: string[];
  /** The step's text, joined and trimmed ('' when it had none). */
  text: string;
  /** The run's LIVE token tally so far (de-duplicated per request), or null when not known yet. */
  usage: AgentTokens | null;
}

export interface AgentRunSpec {
  kind: AgentKind;
  model: ModelChoice;
  /**
   * Effort profile: a diff-only run vs a worktree run. The level itself is `claude.effort` /
   * `codex.effort` when the caller decides it (ai/effort.ts), else each provider's Default.
   */
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
  // `turns` undefined = no turn limit (a worktree review unless REVIEW_MAX_TURNS is set).
  budget: { usd: number | undefined; turns: number | undefined };
  abortController: AbortController;
  /**
   * Which words the activity lines use: 'review' (the read tools, Claude Review's specialists) or
   * 'fix' (the write tools too). Absent ⇒ 'review'.
   */
  activity?: 'review' | 'fix';
  /**
   * The neutral run stream (see the header): steps, the outcome, Codex's status kinds. A throw here
   * ends the run like a throw in the loop body did.
   */
  onProgress?(progress: AgentProgress): void;
  /** Who to bill. Given ⇒ a provider that records its own usage (Codex) writes the ledger row. */
  usageRecord?: AgentUsageRecord;
  claude: ClaudeRunOptions;
  /** The Codex-only knobs (Phase 3 sets them per runner). */
  codex?: CodexRunOptions;
}

/**
 * Provider-neutral progress: a model step and the run's outcome (BOTH providers), plus Codex's finer
 * kinds — a status sentence, a tool call, file changes, a message, an error.
 */
export type AgentProgress = AgentStep | { kind: 'outcome'; outcome: AgentOutcome } | CodexProgress;

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
  /** How the run ended (the same value the `outcome` progress event carried), or null when it never said. */
  outcome: AgentOutcome | null;
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

/**
 * ONE image, described (docs/REFERENCE-DOCS.md § Figures): a tool-less, one-turn completion whose user
 * message carries the image beside the prompt. CLAUDE ONLY — Codex's image input stays locked off
 * (ai/codex/config.ts `LOCKED_SETTINGS`), so its provider has no `describeImage` and a caller keeps the
 * image's name. The image is a stranger's: the caller's system prompt says describe, never obey.
 */
export interface DescribeImageRequest {
  /** An exact model id. Absent ⇒ the provider's `fast` model. */
  model?: string;
  system: string;
  prompt: string;
  image: { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; base64: string };
  maxTokens?: number;
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
  /** Describe one image (vision). Absent ⇒ this provider reads no images (Codex). */
  describeImage?(req: DescribeImageRequest): Promise<CompleteResult>;
  detect(): Promise<ProviderStatus>;
  /** The credential rung, read at call time. Cheap and sync (the budget asks it per request). */
  credentialRoute(): 'login' | 'api_key' | 'none';
  usage: ProviderUsageSource;
}

// ---- the registry -------------------------------------------------------------------------------

export {
  AI_PROVIDER_ENV,
  aiProviderEnvSetting,
  aiProviderSetting,
  aiProviderSettingStatus,
  setStoredAiProviderSetting,
  storedAiProviderSetting,
  CODEX_AGENT_KINDS,
  CODEX_NOT_AVAILABLE_MESSAGE,
  codexKindNotAvailableMessage,
  codexKindReady,
  codexRunnable,
  ALL_AGENT_KINDS,
  ALL_RUN_KINDS,
  activeProviderId,
  autoReadiness,
  codexRunKindReady,
  pickAutoProvider,
  type AiProviderSetting,
} from './provider-setting.js';
export { CODEX_MODEL_FOR_ROLE } from './providers/codex.js';

/** One provider by id. */
export function getProvider(id: AgentProviderId): AgentProvider {
  return id === 'codex' ? codexProvider : claudeProvider;
}

/**
 * Can Codex run agents in this version? Only once EVERY agent kind is in `CODEX_AGENT_KINDS`
 * (provider-setting.ts `codexRunnable`) — TRUE since Phase 3 completed (`plan` was the last kind), so
 * `auto` may pick Codex (only when Claude is not signed in), and `/api/me` reports
 * `providers.codex.available` as the ChatGPT sign-in. `complete()` runs on Codex regardless.
 */
export const CODEX_RUNNABLE: boolean = codexRunnable();

/**
 * THE provider every run and completion uses, per `LIMN_AI_PROVIDER` (read at call time). The choice
 * itself — and the `auto` rule (`pickAutoProvider`, `autoReadiness`) — lives in provider-setting.ts
 * (`activeProviderId`), so the pre-flight asks the SAME question without importing this registry.
 */
export function getActiveProvider(env: NodeJS.ProcessEnv = process.env): AgentProvider {
  return getProvider(activeProviderId(env));
}

/**
 * WHAT A RUN RAN ON — the provider and the model id it resolved for this choice: what every AI run row
 * stores (`provider` + `model`), so a Codex run is labelled "Codex · GPT-6 Astra", never the Claude
 * model it was asked for (docs/CODEX-PLAN.md Phase 4; packages/shared `aiRunLabel`).
 */
export interface AiRanOn {
  provider: AgentProviderId;
  model: string;
  /** The effort the run sent (ai/effort.ts), when the runner stores it (the review, AI Fix). */
  effort?: string;
}

export function ranOn(provider: AgentProvider, choice: ModelChoice): AiRanOn {
  return { provider: provider.id, model: provider.resolveModel(choice) };
}

/**
 * What a run QUEUED now is expected to run on (the active provider, read now). A row written at queue
 * time stores this, so a queued or running run is labelled by its provider from the start; the run
 * then stamps what actually ran (`ranOn`) — the provider may have been switched in between.
 */
export function expectedRanOn(choice: ModelChoice, env: NodeJS.ProcessEnv = process.env): AiRanOn {
  return ranOn(getActiveProvider(env), choice);
}

/**
 * What a run queued now on a NAMED provider will run on — a manual run's per-run choice
 * (ai/run-choice.ts). Absent ⇒ the default provider (`expectedRanOn`).
 */
export function queuedRanOn(choice: ModelChoice, provider?: AgentProviderId | null): AiRanOn {
  return provider ? ranOn(getProvider(provider), choice) : expectedRanOn(choice);
}

/**
 * A stored run's model → the CLAUDE model id to ask for again (the next plan pass, the build after a
 * plan, a chat on a review). A row stores what RAN, so a Codex run holds a Codex id; it maps back by
 * ROLE (gpt-6.1-sol → Opus, gpt-6.1-terra → Sonnet, gpt-6-luna → Haiku; a retired gpt-6-astra → Opus), so either provider then resolves
 * the same depth. A Claude id (or any id Limn does not know) is returned as it is.
 */
// Codex models a stored row may name that the role table no longer uses (2026-10-26: Astra → Sol).
const RETIRED_CODEX_ROLE: Readonly<Record<string, ModelRole>> = { 'gpt-6-astra': 'deep' };

export function requestModelOf(stored: string): string {
  if (stored.startsWith('claude-')) return stored;
  const roles = Object.keys(CODEX_MODEL_FOR_ROLE_SRC) as ModelRole[];
  const role = roles.find((r) => CODEX_MODEL_FOR_ROLE_SRC[r] === stored) ?? RETIRED_CODEX_ROLE[stored];
  return role ? CLAUDE_MODEL_FOR_ROLE[role] : stored;
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
