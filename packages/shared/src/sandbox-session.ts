// A WORKSPACE SESSION ON THE WIRE (docs/SANDBOX.md § Sessions). The new Implement: one disposable
// sandbox per story_builds row, holding every workspace repository, the ticket and the reader's notes;
// the reader talks to the agent, presses Start build, reviews the diffs and pushes (the EXISTING push
// routes, `STORY_BUILD_API.repoPush` / `pushAll`).
//
//   POST /api/story-builds                      start (boot the sandbox)         → StoryBuildStartResponse
//   GET  /api/story-builds/:id                  StoryBuild, with `session`
//   GET  /api/story-builds/:id/stream           SSE: SandboxSessionStreamEvent frames
//   POST /api/story-builds/:id/messages         one chat turn                     → SandboxSessionActionResponse
//   POST /api/story-builds/:id/interrupt        Stop the running turn             → SandboxSessionActionResponse
//   POST /api/story-builds/:id/build            Start build (the ticket is read again first)
//   POST /api/story-builds/:id/network/allow    an Allow click                    → SandboxNetworkAllowResponse
//   GET  /api/story-builds/:id/diff             every repository's stored patch   → SandboxSessionDiffResponse
//   POST /api/story-builds/:id/resume           re-boot a closed session from its stored patches
//   POST /api/story-builds/:id/discard          tear everything down              → StoryBuildDiscardResponse
//
// THE STATUS stays the old StoryBuildStatus (the one-open-session-per-ticket index, the sprint mark and
// the push code read it); the SESSION PHASE is the finer word (`story_builds.session_phase`), and the
// status is DERIVED from it by `sandboxSessionStatus` — never written apart.
import type { SandboxAgentErrorCode, SandboxAgentEvent, SandboxAgentMode, SandboxAgentState } from './sandbox-agent.js';
import type { SandboxServicesStatus } from './sandbox-services.js';
import type { StoryBuildStatus } from './story-build.js';
import type { AiProviderId } from './types.js';

export type SandboxSessionPhase =
  /** The runtime, the proxy, the repositories, the reader's notes and the agent are being set up. */
  | 'booting'
  /** The agent is waiting for the reader (chat mode). */
  | 'ready'
  /** A chat turn is running. */
  | 'chatting'
  /** Start build was pressed: a build-mode turn is running. */
  | 'building'
  /** A build turn ended and its patches are stored: Push, or keep talking. */
  | 'built'
  /** Every repository with changes is pushed. */
  | 'pushed'
  | 'discarded'
  | 'failed';

export const SANDBOX_SESSION_PHASES: readonly SandboxSessionPhase[] = ['booting', 'ready', 'chatting', 'building', 'built', 'pushed', 'discarded', 'failed'];

const STATUS_OF: Readonly<Record<SandboxSessionPhase, StoryBuildStatus>> = {
  booting: 'assessing',
  ready: 'plan_ready',
  chatting: 'planning',
  building: 'building',
  built: 'ready',
  pushed: 'ready',
  discarded: 'discarded',
  failed: 'failed',
};

/** The StoryBuildStatus a phase is stored as (open/running exactly as the old flow's words). */
export function sandboxSessionStatus(phase: SandboxSessionPhase): StoryBuildStatus {
  return STATUS_OF[phase];
}

/** The sandbox is (or should be) running: the phases a restart or an idle teardown cuts off. */
export const SANDBOX_SESSION_LIVE_PHASES: readonly SandboxSessionPhase[] = ['booting', 'ready', 'chatting', 'building', 'built'];

/** Open sessions (a running sandbox) per machine (LIMN_SANDBOX_MAX_SESSIONS). */
export const SANDBOX_MAX_OPEN_SESSIONS_DEFAULT = 2;
/** A session with no turn and no reader action for this long is closed (LIMN_SANDBOX_IDLE_MINUTES). */
export const SANDBOX_IDLE_MINUTES_DEFAULT = 60;
/** A reader's message, in characters. */
export const SANDBOX_MESSAGE_MAX = 8_000;
/** Conversation items kept on the row (the oldest go first). */
export const SANDBOX_CONVERSATION_MAX = 400;

// ---- what the session shows --------------------------------------------------------------------------

export type SandboxBootStepKey = 'runtime' | 'image' | 'network' | 'proxy' | 'sandbox' | 'ticket' | 'repos' | 'services' | 'agent' | 'patches';
export type SandboxBootStepState = 'running' | 'done' | 'failed' | 'skipped';

export interface SandboxBootStep {
  key: SandboxBootStepKey;
  /** Plain words: "Starting the sandbox". */
  label: string;
  state: SandboxBootStepState;
  /** The latest line of progress, or why it failed. */
  detail: string | null;
}

/** One row of the conversation, as stored and as streamed. The agent's partial deltas are NOT stored. */
export type SandboxConversationItem =
  | { kind: 'reader'; id: string; text: string; at: string; build: boolean }
  | { kind: 'agent'; id: string; text: string; at: string }
  | { kind: 'tool'; id: string; tool: string; summary: string; ok: boolean | null; output: string | null; at: string }
  | { kind: 'turn'; id: string; turn: number; mode: SandboxAgentMode; outcome: string; costUsd: number | null; at: string }
  | { kind: 'notice'; id: string; text: string; at: string }
  | { kind: 'error'; id: string; code: SandboxAgentErrorCode | 'session'; text: string; at: string };

/** One Network panel row (one per source, host, port and verdict; `count` climbs). */
export interface SandboxNetworkEntry {
  key: string;
  source: string | null;
  host: string;
  port: number;
  allowed: boolean;
  reason: string | null;
  via: 'forward' | 'anthropic' | 'chatgpt';
  count: number;
  up: number;
  down: number;
  lastStatus: number | null;
  firstAt: string;
  lastAt: string;
}

/** Where one repository is inside the sandbox. */
export interface SandboxSessionRepo {
  repoId: number;
  fullName: string;
  /** Absolute path inside the sandbox (the reader's own path when the folder matched). */
  path: string;
  branch: string;
  baseSha: string;
}

/** The Ticket panel: what TICKET.md holds now (read at the start and again at Start build). */
export interface SandboxSessionTicket {
  /** `AC1: text`, in the story view's order. */
  criteria: string[];
  /** The open points, one plain line each. */
  openPoints: string[];
}

export interface SandboxSessionSpend {
  /** US$ the provider reported (null when it reports none: Codex on ChatGPT). */
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  turns: number;
}

/** `StoryBuild.session` — set on every session row; null on a row of the old plan/build flow. */
export interface StoryBuildSession {
  phase: SandboxSessionPhase;
  /** The runtime that ran it ('docker' today), null before detection. */
  runtime: string | null;
  /** One line about the runtime's licence (Docker Desktop), or null. */
  runtimeNote: string | null;
  provider: AiProviderId | null;
  model: string | null;
  effort: string | null;
  agentState: SandboxAgentState | null;
  mode: SandboxAgentMode;
  /** The sandbox is running now (false after an idle teardown, a restart, a failure, a discard). */
  live: boolean;
  /** A closed session with stored patches can be booted again from them. */
  resumable: boolean;
  boot: SandboxBootStep[];
  /** Plain lines from the boot: what was left out, what could not be cloned. */
  notes: string[];
  conversation: SandboxConversationItem[];
  repos: SandboxSessionRepo[];
  startDir: string | null;
  /** "The model's sign-in stays on your computer." — the credentials mode, in one line. */
  credentialLine: string | null;
  services: SandboxServicesStatus | null;
  network: SandboxNetworkEntry[];
  spend: SandboxSessionSpend;
  /** The ticket as the agent was last told it (TICKET.md): `AC<n>: text` lines and the open points. */
  ticket: SandboxSessionTicket;
  /** ISO: when an idle session will be closed; null while a turn runs or when closed. */
  idleCloseAt: string | null;
}

// ---- the stream ----------------------------------------------------------------------------------------

/**
 * One SSE frame of `GET /api/story-builds/:id/stream` for a session (`data: <JSON>`). The stream stays
 * open while the sandbox runs; it starts with ONE `snapshot` (the whole `StoryBuildSession`), then the
 * changes. `done` ends it (the sandbox closed); the client then re-reads the session.
 */
export type SandboxSessionStreamEvent =
  | { type: 'snapshot'; session: StoryBuildSession }
  | { type: 'phase'; phase: SandboxSessionPhase; error: string | null }
  | { type: 'boot'; step: SandboxBootStep }
  | { type: 'agent'; event: SandboxAgentEvent }
  | { type: 'item'; item: SandboxConversationItem }
  | { type: 'network'; entry: SandboxNetworkEntry }
  | { type: 'services'; status: SandboxServicesStatus }
  | { type: 'done' };

// ---- bodies --------------------------------------------------------------------------------------------

/** `POST /api/story-builds` for a session. `provider`/`model`: the reader's pick (absent ⇒ the default). */
export interface SandboxSessionStartBody {
  workspaceId: number;
  ident: string;
  /** Fill gaps adds the story check's verdicts to the ticket. Default 'implement'. */
  action?: 'implement' | 'fill_gaps';
  provider?: AiProviderId;
  model?: string;
}

/** `POST …/messages`. 1..SANDBOX_MESSAGE_MAX characters. */
export interface SandboxSessionMessageBody {
  text: string;
}

/** `POST …/build`. `text`: optional words added to the build instruction. */
export interface SandboxSessionBuildBody {
  text?: string;
}

/** 202 — the turn (or the boot) started; follow the stream. */
export interface SandboxSessionActionResponse {
  buildId: number;
}

/** `POST …/network/allow`. `rule`: a host, `*.suffix` or `host:port`. */
export interface SandboxNetworkAllowBody {
  rule: string;
  scope: 'session' | 'workspace';
}

export interface SandboxNetworkAllowResponse {
  rule: string;
  scope: 'session' | 'workspace';
}

/** `GET …/diff`: every repository's stored patch (the per-repository `…/repos/:repoId/diff` stays). */
export interface SandboxSessionDiffResponse {
  repos: Array<{ repoId: number; fullName: string; baseSha: string; patch: string | null; filesChanged: string[]; insertions: number | null; deletions: number | null }>;
}

/** `story_build_repos.stat_json`. */
export interface SandboxRepoStat {
  files: number;
  insertions: number;
  deletions: number;
  commits: number;
}

export type SandboxSessionErrorCode = 'NoRuntime' | 'TooManySessions' | 'BuildBusy' | 'AgentBusy' | 'NotLive' | 'NotResumable' | 'NetworkRule';

/** Every session path (the backend's registration, the client and the rate-limit tiers). */
export const SANDBOX_SESSION_API = {
  messages: '/api/story-builds/:id/messages',
  interrupt: '/api/story-builds/:id/interrupt',
  build: '/api/story-builds/:id/build',
  networkAllow: '/api/story-builds/:id/network/allow',
  diff: '/api/story-builds/:id/diff',
  resume: '/api/story-builds/:id/resume',
} as const;

export type SandboxSessionApiRoute = keyof typeof SANDBOX_SESSION_API;

export function sandboxSessionPath(route: SandboxSessionApiRoute, id: number): string {
  return SANDBOX_SESSION_API[route].replace(':id', String(id));
}
