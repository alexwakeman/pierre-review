// THE ONE AGENT EVENT of a workspace session (docs/SANDBOX.md § Agent drivers). Both drivers — Claude
// Code's stream-json (apps/backend/src/sandbox/drivers/claude.ts) and Codex's app-server
// (…/drivers/codex.ts) — turn their own wire into THIS shape, and the build tab renders only this, so
// both providers look the same. Nothing provider-specific crosses the wire.
//
//   status     the agent's state (starting → ready ⇄ working → stopped) and its MODE (chat | build).
//   text       the agent's words. `partial: true` is a DELTA to append to `messageId`; `partial: false`
//              is that message's whole text (it replaces what the deltas built).
//   tool_call  one tool the agent started (a shell command, a file edit, …), as one plain line.
//   tool_result  that tool's end: ok or not, and its output CLIPPED to SANDBOX_TOOL_OUTPUT_MAX.
//   turn_end   one turn's end: how it ended and THIS turn's usage (never the process's running total).
//              US$ is the provider's own figure; a Codex turn on a ChatGPT sign-in has none (null).
//   error      something the reader must see (usage limit, sign-in, the agent process ended).
import type { AiProviderId } from './types.js';

/** Chat (the agent reads and answers; no writes) or build (the agent changes files and runs tests). */
export type SandboxAgentMode = 'chat' | 'build';

export type SandboxAgentState = 'starting' | 'ready' | 'working' | 'stopped';

/** How a turn ended. */
export type SandboxTurnOutcome = 'completed' | 'interrupted' | 'failed' | 'max_turns' | 'budget';

export type SandboxAgentErrorCode =
  /** The provider's usage limit (a subscription window, a ChatGPT plan). */
  | 'usage_limit'
  /** The sign-in was refused. */
  | 'auth'
  /** The agent process ended. The session cannot take another turn. */
  | 'agent_exited'
  /** The agent sent something the driver could not read, or did not answer in time. */
  | 'protocol'
  /** The turn failed for another reason (the message says which). */
  | 'turn_failed';

/** One turn's usage. Null fields are NOT REPORTED, never zero. */
export interface SandboxTurnUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** The provider's US$ for this turn (Claude). Null when the provider gives none (Codex on ChatGPT). */
  costUsd: number | null;
}

export type SandboxAgentEvent =
  | { type: 'status'; state: SandboxAgentState; mode: SandboxAgentMode; detail: string | null }
  | { type: 'text'; messageId: string; partial: boolean; text: string }
  | { type: 'tool_call'; id: string; tool: string; summary: string }
  | { type: 'tool_result'; id: string; ok: boolean; output: string }
  | {
      type: 'turn_end';
      /** 1-based, per session. */
      turn: number;
      mode: SandboxAgentMode;
      outcome: SandboxTurnOutcome;
      /** Who RAN the turn and on what model (the run label, `aiRunLabel`; the cost text, `runCostText`). */
      provider: AiProviderId;
      model: string;
      usage: SandboxTurnUsage | null;
      /**
       * Files that changed during a CHAT turn (Codex only: its own read-only sandbox cannot run inside
       * ours, so Limn checks `git status` after every chat turn). [] when none; always [] for Claude.
       */
      changedInChat: string[];
    }
  | { type: 'error'; code: SandboxAgentErrorCode; message: string };

/** A tool's output is clipped to this many characters on the wire (the whole log stays in the sandbox). */
export const SANDBOX_TOOL_OUTPUT_MAX = 2000;
/** A tool call's one-line summary is clipped to this many characters. */
export const SANDBOX_TOOL_SUMMARY_MAX = 240;

/** Clip a string to `max` characters, marking the cut. Pure. */
export function clipSandboxText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
