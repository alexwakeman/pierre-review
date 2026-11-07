// THE AGENT DRIVER CONTRACT (docs/SANDBOX.md § Agent drivers). One long-lived agent process per session,
// inside the sandbox, reached only through the runtime's `exec` (never a host process). Both drivers
// speak the ONE normalised event (packages/shared `SandboxAgentEvent`).
//
// Who decides what:
//   • the PROVIDER, the MODEL and the EFFORT come from the run choice (drivers/index.ts
//     `resolveSandboxAgentChoice`, over ai/run-choice.ts + ai/effort.ts) — a driver never picks one;
//   • the SEED (the system prompt file, the extra directories) is written by the workspace step (WP4)
//     before the driver starts; the driver only names it;
//   • the network and the credential placeholders are the egress session's (`EgressSession.sandboxEnv`).
//
// The ONE budget gate (review/budget-gate.ts) applies to an AUTOMATIC continuation, which the session
// manager decides; a driver takes every turn it is given (a reader's click is never refused).
import type { AiEffort, AiProviderId, SandboxAgentEvent, SandboxAgentMode, SandboxTurnOutcome, SandboxTurnUsage } from '@pierre-review/shared';
import type { SandboxRuntime } from '../runtime/types.js';

/** What a session runs on: resolved ONCE at session start (drivers/index.ts). */
export interface SandboxAgentChoice {
  provider: AiProviderId;
  /** The provider's OWN model id (`claude-sonnet-5`, `gpt-6.1-sol`). */
  model: string;
  effort: AiEffort;
}

/** One row of the spend ledger per turn (db/usage.ts `AiUsageRecord`). */
export interface SandboxUsageRow {
  accountId: number;
  feature: string;
  model: string;
  provider: AiProviderId;
  costUsd: number;
  inputTokens: number | null;
  outputTokens: number | null;
  repoId: number | null;
}

/** Where usage goes. The default (drivers/usage.ts) is the ledger + the budget's Claude reading. */
export interface SandboxUsageSink {
  record(row: SandboxUsageRow): Promise<void>;
  /** A Claude `rate_limit_event` (the subscription windows) for the spend budget's reading. */
  noteClaudeRateLimit?(message: unknown): void;
}

/** Who to bill, and under which ledger feature per mode. */
export interface SandboxUsageAccount {
  accountId: number;
  repoId?: number | null;
  /** Ledger feature per mode. Default: chat `story_plan`, build `story_build`. */
  features?: Partial<Record<SandboxAgentMode, string>>;
}

export interface SandboxAgentStartOptions {
  runtime: SandboxRuntime;
  /** The sandbox container (`runtime.startSandbox`). */
  container: string;
  /** The starting directory (the home project, at its mirrored absolute path). */
  cwd: string;
  choice: SandboxAgentChoice;
  /** The network + placeholder environment (`EgressSession.sandboxEnv`). */
  env: Record<string, string>;
  /** The seeded system prompt, as a file INSIDE the sandbox (preferred: no argv limit). */
  systemPromptFile?: string;
  /** …or as text, when there is no file. */
  systemPrompt?: string;
  /** More directories the agent may use (the other workspace repositories). */
  addDirs?: string[];
  /** The repositories whose `git status` is checked after a Codex chat turn. Default: none. */
  repoDirs?: string[];
  /** Start in this mode. Default `chat`. */
  mode?: SandboxAgentMode;
  /** Claude: model turns per user message. Default STORY_BUILD_MAX_TURNS_DEFAULT. */
  maxTurns?: number;
  usage: SandboxUsageAccount;
  usageSink?: SandboxUsageSink;
  /** Called before each turn (the egress session's `refreshCredentials`: the host refreshes, never the sandbox). */
  beforeTurn?: () => Promise<unknown>;
  onEvent(event: SandboxAgentEvent): void;
  /** Codex: the sandbox's auth.json (fake secrets; `EgressSession.codexAuthJson`). Required for Codex. */
  codexAuthJson?: string | null;
  /** Codex: resume this stored thread instead of starting one (a re-booted session). */
  resumeRef?: string | null;
  /** How long the handshake may take. Default 90 s (a cold CLI start inside a container). */
  startTimeoutMs?: number;
}

export interface SandboxTurnEnd {
  turn: number;
  mode: SandboxAgentMode;
  outcome: SandboxTurnOutcome;
  usage: SandboxTurnUsage | null;
  /** The agent's last message of the turn ('' when it said nothing). */
  text: string;
  changedInChat: string[];
}

export interface SandboxAgentDriver {
  readonly provider: AiProviderId;
  readonly choice: SandboxAgentChoice;
  mode(): SandboxAgentMode;
  /** The agent's own conversation id (Claude session id, Codex thread id) once known. Sandbox-internal. */
  agentRef(): string | null;
  /** A turn is running. */
  busy(): boolean;
  /** Send the reader's message: starts a turn; resolves at its end. Refused while a turn runs. */
  send(text: string): Promise<SandboxTurnEnd>;
  /** Start build: the mode switches to `build` (Claude: bypassPermissions; Codex: full access per turn). */
  startBuild(): Promise<void>;
  /** Stop the current turn. The process stays; the next `send` works. No-op when idle. */
  interrupt(): Promise<void>;
  /** End the process (stdin closed, then killed). */
  close(): Promise<void>;
  /** Resolves when the agent process has ended. */
  readonly exited: Promise<void>;
}

/** A turn refused because another runs (the route answers 409). */
export class SandboxAgentBusyError extends Error {
  constructor() {
    super('The agent is still working on the last message.');
    this.name = 'SandboxAgentBusyError';
  }
}

/** The agent process has ended; the session cannot take another turn. */
export class SandboxAgentExitedError extends Error {
  constructor(message = 'The agent stopped.') {
    super(message);
    this.name = 'SandboxAgentExitedError';
  }
}
