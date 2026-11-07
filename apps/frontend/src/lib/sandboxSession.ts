// THE BUILD TAB'S SESSION HALF (docs/SANDBOX.md § Sessions; docs/FRONTEND.md § The build tab), pure and
// React-free so test/sandboxSession.test.ts pins it: the stream fold (a `snapshot`, then the changes),
// the live partial text, the merge of the stream with the query's read, the phase words, the step line
// and which buttons a phase offers.
import {
  SANDBOX_CONVERSATION_MAX,
  type SandboxBootStep,
  type SandboxConversationItem,
  type SandboxNetworkEntry,
  type SandboxSessionPhase,
  type SandboxSessionStreamEvent,
  type StoryBuild,
  type StoryBuildSession,
} from '@pierre-review/shared';

// ── the stream fold ─────────────────────────────────────────────────────────────────────────────

/** What the stream has told the tab: the session as it now is, and the agent's words still arriving. */
export interface SessionStreamState {
  session: StoryBuildSession | null;
  /** messageId → the text the deltas built so far (dropped when the whole message arrives as an item). */
  partials: ReadonlyMap<string, string>;
  /** The stream said the sandbox closed. */
  done: boolean;
  /** The latest phase frame's error line (a failed boot, a closed session). */
  error: string | null;
}

export const EMPTY_SESSION_STREAM: SessionStreamState = { session: null, partials: new Map(), done: false, error: null };

function upsertBy<T>(list: readonly T[], item: T, same: (a: T) => boolean): T[] {
  const at = list.findIndex(same);
  if (at < 0) return [...list, item];
  const next = list.slice();
  next[at] = item;
  return next;
}

/** The final text of message `m-<id>` replaces the deltas the tab was showing for `<id>`. */
const partialIdOf = (item: SandboxConversationItem): string | null => (item.kind === 'agent' && item.id.startsWith('m-') ? item.id.slice(2) : null);

/** Fold one frame. Frames before the first snapshot change nothing but the partial text. */
export function applySessionEvent(s: SessionStreamState, e: SandboxSessionStreamEvent): SessionStreamState {
  switch (e.type) {
    case 'snapshot':
      return { session: e.session, partials: new Map(), done: false, error: s.error };
    case 'done':
      return { ...s, done: true, partials: new Map(), session: s.session != null ? { ...s.session, live: false, agentState: null, idleCloseAt: null } : null };
    case 'agent': {
      const ev = e.event;
      if (ev.type === 'text' && ev.partial) {
        const partials = new Map(s.partials);
        partials.set(ev.messageId, (partials.get(ev.messageId) ?? '') + ev.text);
        return { ...s, partials };
      }
      if (ev.type === 'status' && s.session != null) return { ...s, session: { ...s.session, agentState: ev.state, mode: ev.mode } };
      return s;
    }
    default:
      break;
  }
  if (s.session == null) return s;
  const cur = s.session;
  switch (e.type) {
    case 'phase':
      return { ...s, error: e.error, session: { ...cur, phase: e.phase } };
    case 'boot':
      return { ...s, session: { ...cur, boot: upsertBy<SandboxBootStep>(cur.boot, e.step, (b) => b.key === e.step.key) } };
    case 'item': {
      let conversation = upsertBy<SandboxConversationItem>(cur.conversation, e.item, (c) => c.id === e.item.id);
      if (conversation.length > SANDBOX_CONVERSATION_MAX) conversation = conversation.slice(conversation.length - SANDBOX_CONVERSATION_MAX);
      const pid = partialIdOf(e.item);
      let partials = s.partials;
      if (pid != null && partials.has(pid)) {
        const next = new Map(partials);
        next.delete(pid);
        partials = next;
      }
      // A turn's end: the words in flight are over (an interrupted reply never gets its final text).
      if (e.item.kind === 'turn') partials = new Map();
      return { ...s, partials, session: { ...cur, conversation } };
    }
    case 'network':
      return { ...s, session: { ...cur, network: upsertBy<SandboxNetworkEntry>(cur.network, e.entry, (n) => n.key === e.entry.key) } };
    case 'services':
      return { ...s, session: { ...cur, services: e.status } };
  }
}

/** A frame after which the query's read is worth fetching again (spend, repositories, status). */
export function sessionEventNeedsRefetch(e: SandboxSessionStreamEvent): boolean {
  return e.type === 'phase' || e.type === 'done' || (e.type === 'item' && e.item.kind === 'turn');
}

/**
 * The session the tab draws: the STREAM owns what it streams (phase, boot, conversation, network,
 * services, the agent's state) while it is open; the QUERY's read owns the rest (spend, repositories,
 * the ticket, the idle clock, resumable). With no stream, the read alone.
 */
export function mergeSessionViews(read: StoryBuildSession | null | undefined, stream: StoryBuildSession | null): StoryBuildSession | null {
  if (stream == null) return read ?? null;
  if (read == null) return stream;
  // A read that says the sandbox closed is the last word (the stream may not have said `done` yet).
  if (!read.live) return { ...read, conversation: longer(read.conversation, stream.conversation) };
  return {
    ...read,
    phase: stream.phase,
    boot: stream.boot,
    conversation: longer(read.conversation, stream.conversation),
    network: stream.network,
    services: stream.services ?? read.services,
    agentState: stream.agentState,
    mode: stream.mode,
    live: stream.live,
  };
}

const longer = (a: SandboxConversationItem[], b: SandboxConversationItem[]): SandboxConversationItem[] => (b.length >= a.length ? b : a);

// ── what the tab says ───────────────────────────────────────────────────────────────────────────

/** The header's one status sentence. */
export function sessionStatusLine(s: Pick<StoryBuildSession, 'phase' | 'live' | 'resumable'>, error: string | null = null): string {
  switch (s.phase) {
    case 'booting':
      return 'Setting up the sandbox.';
    case 'ready':
      return 'Ready. Talk to the agent, then press Start build.';
    case 'chatting':
      return 'The agent is answering.';
    case 'building':
      return 'The agent is building and testing.';
    case 'built':
      return s.live ? 'Built. Review the changes and push them, or keep talking.' : 'The sandbox is closed. The changes are kept: push them, or resume.';
    case 'pushed':
      return s.live ? 'Pushed. You can keep talking.' : 'Pushed.';
    case 'discarded':
      return 'Discarded.';
    case 'failed':
      return error ?? 'The session failed.';
  }
}

export type SessionStepWord = 'Set up' | 'Talk' | 'Build' | 'Push';
export interface SessionStep {
  word: SessionStepWord;
  state: 'done' | 'current' | 'next';
}

const STEP_OF: Readonly<Record<SandboxSessionPhase, number>> = {
  booting: 0,
  ready: 1,
  chatting: 1,
  building: 2,
  built: 3,
  pushed: 4,
  discarded: -1,
  failed: -1,
};

/** "Set up · Talk · Build · Push", the current one marked. Before a start: every step next. */
export function sessionSteps(s: Pick<StoryBuildSession, 'phase'> | null): SessionStep[] {
  const words: SessionStepWord[] = ['Set up', 'Talk', 'Build', 'Push'];
  // A message after Start build is a build turn (`building`), so the phase alone says the step.
  const cur = s == null ? -1 : STEP_OF[s.phase];
  return words.map((word, i) => ({ word, state: i < cur ? 'done' : i === cur ? 'current' : 'next' }));
}

/** A turn is running (the composer waits; Stop is offered). */
export function sessionTurnRunning(s: Pick<StoryBuildSession, 'phase' | 'live'>): boolean {
  return s.live && (s.phase === 'chatting' || s.phase === 'building');
}

/** The agent takes a message now. */
export function sessionCanSend(s: Pick<StoryBuildSession, 'phase' | 'live' | 'agentState'>): boolean {
  return s.live && (s.phase === 'ready' || s.phase === 'built' || s.phase === 'pushed') && s.agentState !== 'stopped';
}

/** Start build is offered once: in chat mode, while the agent waits. */
export function sessionCanStartBuild(s: Pick<StoryBuildSession, 'phase' | 'live' | 'mode' | 'agentState'>): boolean {
  return s.live && s.phase === 'ready' && s.mode === 'chat' && s.agentState !== 'stopped';
}

/** Discard: anything not already over. */
export function sessionCanDiscard(s: Pick<StoryBuildSession, 'phase'>): boolean {
  return s.phase !== 'discarded' && s.phase !== 'failed';
}

/** The session has finished with this tab: the start state shows (with the last session in one line). */
export function sessionClosedForGood(b: Pick<StoryBuild, 'status'> & { session?: Pick<StoryBuildSession, 'phase'> | null }): boolean {
  if (b.session == null) return b.status === 'failed' || b.status === 'cancelled' || b.status === 'discarded';
  return b.session.phase === 'discarded' || b.session.phase === 'failed';
}

/** The boot's progress, as "3 of 9". Skipped steps count as done. */
export function bootProgress(steps: readonly SandboxBootStep[]): { done: number; total: number; current: SandboxBootStep | null; failed: SandboxBootStep | null } {
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return {
    done,
    total: steps.length,
    current: steps.find((s) => s.state === 'running') ?? null,
    failed: steps.find((s) => s.state === 'failed') ?? null,
  };
}

/** The Network panel: blocked first (they need a decision), then the busiest. */
export function networkRows(entries: readonly SandboxNetworkEntry[]): SandboxNetworkEntry[] {
  return [...entries].sort((a, b) => Number(a.allowed) - Number(b.allowed) || b.count - a.count || a.host.localeCompare(b.host));
}

/** The rule an Allow button sends for a row: the host, with its port when it is not 443 or 80. */
export function networkAllowRule(e: Pick<SandboxNetworkEntry, 'host' | 'port'>): string {
  return e.port === 443 || e.port === 80 ? e.host : `${e.host}:${e.port}`;
}

/** Bytes in a short form: "812 B", "4.1 kB", "12 MB". */
export function shortBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} kB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

/** A turn's end, in words, for the conversation's quiet divider. */
export function turnOutcomeWords(outcome: string): string {
  switch (outcome) {
    case 'completed':
      return 'Done';
    case 'interrupted':
      return 'Stopped';
    case 'max_turns':
      return 'Stopped at its step limit';
    case 'budget':
      return 'Stopped at its budget';
    case 'failed':
      return 'Failed';
    default:
      return outcome;
  }
}

/** A session action's failure in words: the server's sentence (it writes plain ones), else the fallback. */
export function sessionErrorText(err: { message?: string } | null | undefined): string | null {
  if (err == null) return null;
  return err.message != null && err.message !== '' ? err.message : 'Something went wrong.';
}
