// A SESSION'S SHOWN STATE (docs/SANDBOX.md § Sessions): what `story_builds.session_json` holds, the
// conversation fold, and the ONE wire mapper (`toStoryBuildSession`). Pure.
//
// ⚠ Nothing secret is ever in here: no credential, no patch, no seed text. The conversation holds the
//   reader's messages and the agent's FINAL texts (partial deltas are live-only), each tool call as one
//   line with its output clipped, the turn ends with their cost, and notices.
import {
  SANDBOX_CONVERSATION_MAX,
  clipSandboxText,
  type SandboxAgentEvent,
  type SandboxAgentMode,
  type SandboxAgentState,
  type SandboxBootStep,
  type SandboxBootStepKey,
  type SandboxConversationItem,
  type SandboxNetworkEntry,
  type SandboxServicesStatus,
  type SandboxSessionPhase,
  type SandboxSessionRepo,
  type StoryBuildSession,
} from '@pierre-review/shared';

/** A tool's output as STORED (the live frame carries up to SANDBOX_TOOL_OUTPUT_MAX). */
export const STORED_TOOL_OUTPUT_MAX = 600;
export const STORED_NETWORK_MAX = 200;

export interface SessionStateJson {
  version: 1;
  /** Whose session: Implement's story (absent on rows from before AI Fix moved here) or an AI Fix. */
  subject?: 'story' | 'fix';
  /** Story: implement / fill_gaps. Fix: `fix` (started building) or `fix_plan` (Plan first). */
  action: 'implement' | 'fill_gaps' | 'fix' | 'fix_plan';
  runtimeNote: string | null;
  boot: SandboxBootStep[];
  notes: string[];
  conversation: SandboxConversationItem[];
  repos: SandboxSessionRepo[];
  startDir: string | null;
  credentialLine: string | null;
  mode: SandboxAgentMode;
  /** The criteria the session was told about (`AC<n>: text`), to say when they change at Start build. */
  criteria: string[];
  /** The ticket's open points, one line each (the Ticket panel). */
  openPoints: string[];
  services: SandboxServicesStatus | null;
  network: SandboxNetworkEntry[];
  /** The next conversation item id. */
  seq: number;
  /** AI Fix: edits in repositories that are NOT pushed (only the PR's repository is). */
  leftOut?: Array<{ repoId: number; fullName: string; files: string[] }>;
  /** AI Fix: nobody follows up (an auto fix, dependency automation's fix): it closes after its turn. */
  unattended?: boolean;
}

export function emptySessionState(action: SessionStateJson['action']): SessionStateJson {
  return {
    version: 1,
    action,
    runtimeNote: null,
    boot: [],
    notes: [],
    conversation: [],
    repos: [],
    startDir: null,
    credentialLine: null,
    mode: 'chat',
    criteria: [],
    openPoints: [],
    services: null,
    network: [],
    seq: 1,
  };
}

/** A stored value → the state (an unreadable or missing value is a fresh one, never a throw). */
export function readSessionState(raw: unknown, action: SessionStateJson['action'] = 'implement'): SessionStateJson {
  if (raw == null || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) return emptySessionState(action);
  const s = raw as Partial<SessionStateJson>;
  const stored = s.action === 'fill_gaps' || s.action === 'fix' || s.action === 'fix_plan' ? s.action : action;
  const base = emptySessionState(stored);
  return {
    ...base,
    ...s,
    boot: Array.isArray(s.boot) ? s.boot : [],
    notes: Array.isArray(s.notes) ? s.notes : [],
    conversation: Array.isArray(s.conversation) ? s.conversation : [],
    repos: Array.isArray(s.repos) ? s.repos : [],
    criteria: Array.isArray(s.criteria) ? s.criteria : [],
    openPoints: Array.isArray(s.openPoints) ? s.openPoints : [],
    network: Array.isArray(s.network) ? s.network : [],
    ...(s.leftOut !== undefined ? { leftOut: Array.isArray(s.leftOut) ? s.leftOut : [] } : {}),
    seq: typeof s.seq === 'number' && s.seq > 0 ? s.seq : base.seq,
    version: 1,
  };
}

export const BOOT_LABELS: Readonly<Record<SandboxBootStepKey, string>> = {
  runtime: 'Finding the container runtime',
  image: 'Getting the sandbox image',
  network: 'Making the private network',
  proxy: 'Starting the network filter',
  sandbox: 'Starting the sandbox',
  ticket: 'Reading the ticket',
  task: 'Reading the pull request',
  repos: 'Cloning the repositories',
  services: 'Getting the services ready',
  agent: 'Starting the agent',
  patches: 'Putting your earlier changes back',
};

/** Set one boot step (added in order of first use). Returns the step as it now is. */
export function setBootStep(s: SessionStateJson, key: SandboxBootStepKey, state: SandboxBootStep['state'], detail: string | null = null): SandboxBootStep {
  const at = s.boot.findIndex((b) => b.key === key);
  const step: SandboxBootStep = { key, label: BOOT_LABELS[key], state, detail: detail == null ? null : clipSandboxText(detail, 300) };
  if (at >= 0) s.boot[at] = step;
  else s.boot.push(step);
  return step;
}

/** Append (or, by id, replace) one conversation item; the oldest go past SANDBOX_CONVERSATION_MAX. */
export function putItem(s: SessionStateJson, item: SandboxConversationItem): SandboxConversationItem {
  const at = s.conversation.findIndex((c) => c.id === item.id);
  if (at >= 0) s.conversation[at] = item;
  else {
    s.conversation.push(item);
    if (s.conversation.length > SANDBOX_CONVERSATION_MAX) s.conversation.splice(0, s.conversation.length - SANDBOX_CONVERSATION_MAX);
  }
  return item;
}

export function nextId(s: SessionStateJson, prefix: string): string {
  const id = `${prefix}${s.seq}`;
  s.seq += 1;
  return id;
}

/**
 * One agent event → the conversation item it stores (or updates), or null for a live-only event
 * (partial text, status). `toolIds` maps the driver's tool ids to the stored item ids.
 */
export function itemForAgentEvent(
  s: SessionStateJson,
  e: SandboxAgentEvent,
  at: string,
  toolIds: Map<string, string>,
): SandboxConversationItem | null {
  switch (e.type) {
    case 'status':
      return null;
    case 'text':
      if (e.partial || e.text.trim() === '') return null;
      return putItem(s, { kind: 'agent', id: `m-${e.messageId}`, text: e.text, at });
    case 'tool_call': {
      const id = nextId(s, 't');
      toolIds.set(e.id, id);
      return putItem(s, { kind: 'tool', id, tool: e.tool, summary: e.summary, ok: null, output: null, at });
    }
    case 'tool_result': {
      const id = toolIds.get(e.id);
      const prev = id ? s.conversation.find((c) => c.id === id) : undefined;
      if (!id || !prev || prev.kind !== 'tool') return null;
      return putItem(s, { ...prev, ok: e.ok, output: clipSandboxText(e.output, STORED_TOOL_OUTPUT_MAX) });
    }
    case 'turn_end':
      return putItem(s, {
        kind: 'turn',
        id: nextId(s, 'e'),
        turn: e.turn,
        mode: e.mode,
        outcome: e.outcome,
        costUsd: e.usage?.costUsd ?? null,
        at,
      });
    case 'error':
      return putItem(s, { kind: 'error', id: nextId(s, 'x'), code: e.code, text: e.message, at });
  }
}

/** Keep the Network panel's rows (newest activity first, bounded). */
export function putNetworkEntry(s: SessionStateJson, e: SandboxNetworkEntry): void {
  const at = s.network.findIndex((n) => n.key === e.key);
  if (at >= 0) s.network[at] = e;
  else s.network.unshift(e);
  s.network.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  if (s.network.length > STORED_NETWORK_MAX) s.network.length = STORED_NETWORK_MAX;
}

export interface SessionRowFacts {
  sessionPhase: string | null;
  runtime: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  planCostUsd: number | null;
  buildCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}

export interface LiveFacts {
  agentState: SandboxAgentState | null;
  idleCloseAt: string | null;
}

const isPhase = (p: string | null): p is SandboxSessionPhase =>
  p === 'booting' || p === 'ready' || p === 'chatting' || p === 'building' || p === 'built' || p === 'pushed' || p === 'discarded' || p === 'failed';

/**
 * THE wire mapper of a session (`StoryBuild.session`). `live` is the in-memory session when the
 * sandbox runs; `hasPatches` says a closed session can be resumed. null for a row of the old flow.
 */
export function toStoryBuildSession(
  row: SessionRowFacts,
  state: SessionStateJson,
  live: LiveFacts | null,
  hasPatches: boolean,
): StoryBuildSession | null {
  if (!isPhase(row.sessionPhase)) return null;
  const phase = row.sessionPhase;
  const cost = [row.planCostUsd, row.buildCostUsd].filter((x): x is number => typeof x === 'number');
  return {
    phase,
    runtime: row.runtime,
    runtimeNote: state.runtimeNote,
    provider: row.provider === 'codex' ? 'codex' : row.provider === 'claude' ? 'claude' : null,
    model: row.model,
    effort: row.effort,
    agentState: live?.agentState ?? null,
    mode: state.mode,
    live: live != null,
    resumable: live == null && hasPatches && (phase === 'built' || phase === 'pushed'),
    boot: state.boot,
    notes: state.notes,
    conversation: state.conversation,
    repos: state.repos,
    startDir: state.startDir,
    credentialLine: state.credentialLine,
    services: state.services,
    network: state.network,
    spend: {
      costUsd: cost.length === 0 ? null : cost.reduce((a, b) => a + b, 0),
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      turns: row.numTurns ?? 0,
    },
    idleCloseAt: live?.idleCloseAt ?? null,
    ticket: { criteria: state.criteria, openPoints: state.openPoints },
  };
}
