// THE CODEX EVENT STREAM (docs/CODEX-PLAN.md § 3.2; CODEX-SPIKE.md § 2–6, 9). `codex exec --json`
// prints one JSON event per line; this module parses them (the shapes are those of
// `@openai/codex-sdk` 0.164.0 `dist/index.d.ts`, re-declared here — no AI package is imported) and
// folds them into what Limn's runners need, provider-neutral:
//
//   • PROGRESS — one status-line sentence per step (`AiStatusLine`), tool activity, file changes;
//   • THE FINAL ANSWER — the LAST `agent_message` (with `--output-schema`, the JSON answer);
//   • USAGE — `turn.completed.usage`. ⚠ A RESUMED turn reports the THREAD's cumulative total, so the
//     ledger takes `usageDelta(now, before)`; a cancelled turn emits no `turn.completed` at all, so its
//     usage is null ("tokens unknown"), never zero;
//   • ERRORS — `turn.failed`, top-level `error` events (reconnects, auth), and `error` ITEMS.
//     ⚠ The two "`--dangerously-bypass-hook-trust` is enabled" warning items are noise and are
//     filtered (Limn never passes that flag, but a recorded stream may carry them).
//
// ⚠ THE STREAM IS NOT THE TRUTH ABOUT WRITES OR REFUSALS. A refused, hook-denied or failed patch emits
// NO item — it appears only on STDERR (`codex_core::tools::router: error=…`) and in the agent's own
// words (spike § 4). `stderrRefusals` reads them; a run's edits are verified with `git diff`
// (ai/providers/codex.ts), never taken from `file_change` items.

// ---- the event types (@openai/codex-sdk 0.164.0) ------------------------------------------------

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export type CodexItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | { id: string; type: 'command_execution'; command: string; aggregated_output: string; exit_code?: number; status: 'in_progress' | 'completed' | 'failed' }
  | { id: string; type: 'file_change'; changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>; status: 'completed' | 'failed' | 'in_progress' }
  | {
      id: string;
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      arguments: unknown;
      result?: { content: unknown[]; structured_content?: unknown } | null;
      error?: { message: string } | null;
      status: 'in_progress' | 'completed' | 'failed';
    }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items: Array<{ text: string; completed: boolean }> }
  | { id: string; type: 'error'; message: string };

export type CodexEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage: CodexUsage }
  | { type: 'turn.failed'; error: { message: string } }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  | { type: 'error'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

const KNOWN_TYPES = new Set([
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'item.started',
  'item.updated',
  'item.completed',
  'error',
]);

/**
 * One line of the stream → an event, or null for anything that is not one (a blank line, a non-JSON
 * line, an unknown type, a known type missing its fields). Never throws: the stream is a child
 * process's output, not a contract we control.
 */
export function parseEventLine(line: string): CodexEvent | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.type !== 'string' || !KNOWN_TYPES.has(v.type)) return null;
  switch (v.type) {
    case 'thread.started':
      return typeof v.thread_id === 'string' ? { type: 'thread.started', thread_id: v.thread_id } : null;
    case 'turn.completed': {
      const u = isObj(v.usage) ? v.usage : {};
      return {
        type: 'turn.completed',
        usage: {
          input_tokens: num(u.input_tokens),
          cached_input_tokens: num(u.cached_input_tokens),
          cache_write_input_tokens: num(u.cache_write_input_tokens),
          output_tokens: num(u.output_tokens),
          reasoning_output_tokens: num(u.reasoning_output_tokens),
        },
      };
    }
    case 'turn.failed':
      return { type: 'turn.failed', error: { message: isObj(v.error) && typeof v.error.message === 'string' ? v.error.message : 'The Codex turn failed.' } };
    case 'error':
      return { type: 'error', message: typeof v.message === 'string' ? v.message : 'Codex reported an error.' };
    case 'turn.started':
      return { type: 'turn.started' };
    default:
      return isObj(v.item) && typeof v.item.type === 'string'
        ? ({ type: v.type, item: v.item as unknown as CodexItem } as CodexEvent)
        : null;
  }
}

/** The bypass-flag warning items (`--dangerously-bypass-hook-trust` is enabled…). Noise. */
export function isBypassWarning(e: CodexEvent): boolean {
  return (
    (e.type === 'item.completed' || e.type === 'item.started') &&
    e.item.type === 'error' &&
    typeof e.item.message === 'string' &&
    e.item.message.includes('--dangerously-bypass-hook-trust')
  );
}

const TRANSIENT = /^(?:Reconnecting\.\.\.|Falling back from WebSockets)/;

/** Codex's error text without the transport tail (`, url: …`, `cf-ray`, request id). */
export function cleanCodexError(message: string): string {
  const cut = message.search(/, (?:url|cf-ray|request id): /);
  return (cut >= 0 ? message.slice(0, cut) : message).trim();
}

// ---- progress ----------------------------------------------------------------------------------

/** What a runner shows while a run works — provider-neutral. */
export type CodexProgress =
  | { kind: 'status'; text: string }
  | { kind: 'tool'; tool: string; status: 'started' | 'completed' | 'failed'; text: string; detail: string | null }
  | { kind: 'file_change'; paths: string[]; status: 'completed' | 'failed' | 'in_progress' }
  | { kind: 'message'; text: string }
  | { kind: 'error'; message: string };

const clip = (s: string, n = 120): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function argString(args: unknown, key: string): string | null {
  return isObj(args) && typeof args[key] === 'string' && args[key] !== '' ? (args[key] as string) : null;
}

/** The status-line sentence for one workspace tool call. */
export function toolStatusText(tool: string, args: unknown): string {
  const path = argString(args, 'path');
  switch (tool) {
    case 'read_file':
      return path ? `Reading ${clip(path, 80)}` : 'Reading a file';
    case 'list_files': {
      const glob = argString(args, 'glob') ?? argString(args, 'pattern');
      return glob ? `Listing ${clip(glob, 80)}` : 'Listing files';
    }
    case 'search': {
      const q = argString(args, 'query') ?? argString(args, 'pattern');
      return q ? `Searching for ${clip(q, 80)}` : 'Searching the code';
    }
    default:
      return `Using ${tool}`;
  }
}

/** One event → the progress it shows, or null (thread/turn bookkeeping, usage, filtered noise). */
export function progressFromEvent(e: CodexEvent): CodexProgress | null {
  if (isBypassWarning(e)) return null;
  switch (e.type) {
    case 'turn.started':
      return { kind: 'status', text: 'Working' };
    case 'turn.failed':
      return { kind: 'error', message: cleanCodexError(e.error.message) };
    case 'error':
      // Transport retries are transient: a status, not an error (the turn fails on its own if they run out).
      return TRANSIENT.test(e.message) ? { kind: 'status', text: 'Reconnecting' } : { kind: 'error', message: cleanCodexError(e.message) };
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const it = e.item;
      const done = e.type === 'item.completed';
      switch (it.type) {
        case 'mcp_tool_call': {
          const status = it.status === 'failed' ? 'failed' : done || it.status === 'completed' ? 'completed' : 'started';
          return {
            kind: 'tool',
            tool: it.tool,
            status,
            text: toolStatusText(it.tool, it.arguments),
            detail: status === 'failed' ? (it.error?.message ?? firstText(it.result?.content) ?? null) : null,
          };
        }
        case 'file_change':
          return { kind: 'file_change', paths: (it.changes ?? []).map((c) => c.path), status: it.status };
        case 'agent_message':
          return done ? { kind: 'message', text: it.text } : null;
        case 'reasoning':
          return { kind: 'status', text: 'Thinking' };
        case 'error':
          return TRANSIENT.test(it.message) ? { kind: 'status', text: 'Reconnecting' } : { kind: 'error', message: cleanCodexError(it.message) };
        case 'command_execution':
          // The shell is OFF (features.shell_tool=false); one showing up is reported, never hidden.
          return { kind: 'tool', tool: 'shell', status: it.status === 'failed' ? 'failed' : done ? 'completed' : 'started', text: 'Running a command', detail: clip(it.command ?? '', 200) };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function firstText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const c of content) if (isObj(c) && c.type === 'text' && typeof c.text === 'string') return c.text;
  return null;
}

// ---- usage --------------------------------------------------------------------------------------

/** Tokens, provider-neutral. */
export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export const toTokenUsage = (u: CodexUsage): TokenUsage => ({
  inputTokens: u.input_tokens,
  cachedInputTokens: u.cached_input_tokens,
  outputTokens: u.output_tokens,
  reasoningOutputTokens: u.reasoning_output_tokens,
});

/**
 * The tokens ONE turn spent, from the thread's cumulative figure now and before it. A first turn has
 * no `before`. A figure that went DOWN (never seen; a different thread) is not subtracted from — the
 * turn's own figure is kept rather than inventing a negative.
 */
export function usageDelta(now: TokenUsage, before: TokenUsage | null): TokenUsage {
  if (!before) return now;
  const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens'] as const;
  if (keys.some((k) => now[k] < before[k])) return now;
  return {
    inputTokens: now.inputTokens - before.inputTokens,
    cachedInputTokens: now.cachedInputTokens - before.cachedInputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    reasoningOutputTokens: now.reasoningOutputTokens - before.reasoningOutputTokens,
  };
}

/** Two turns' usage, added (the first run plus its retry's delta). */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a || !b) return null; // one turn's tokens unknown ⇒ the run's are unknown
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

// ---- the whole stream ---------------------------------------------------------------------------

export interface CodexStreamSummary {
  threadId: string | null;
  /** The last agent message's text ('' when there was none). */
  finalResponse: string;
  /** The last `turn.completed` usage (cumulative for a resumed thread), or null when none came. */
  usage: TokenUsage | null;
  /** `turn.failed` messages, in order. */
  turnFailures: string[];
  /** Top-level `error` events and `error` items (bypass warnings filtered), in order. */
  errors: string[];
  /** Paths the stream CLAIMS changed — informational only (verify with `git diff`). */
  claimedChanges: string[];
}

export function summarizeEvents(events: readonly CodexEvent[]): CodexStreamSummary {
  let threadId: string | null = null;
  let finalResponse = '';
  let usage: TokenUsage | null = null;
  const turnFailures: string[] = [];
  const errors: string[] = [];
  const claimed = new Set<string>();
  for (const e of events) {
    if (isBypassWarning(e)) continue;
    if (e.type === 'thread.started') threadId = e.thread_id;
    else if (e.type === 'turn.completed') usage = toTokenUsage(e.usage);
    else if (e.type === 'turn.failed') turnFailures.push(e.error.message);
    else if (e.type === 'error') errors.push(e.message);
    else if (e.type === 'item.completed') {
      if (e.item.type === 'agent_message') finalResponse = e.item.text;
      else if (e.item.type === 'error') errors.push(e.item.message);
      else if (e.item.type === 'file_change' && e.item.status === 'completed') {
        for (const c of e.item.changes ?? []) claimed.add(c.path);
      }
    }
  }
  return { threadId, finalResponse, usage, turnFailures, errors, claimedChanges: [...claimed] };
}

// ---- stderr ------------------------------------------------------------------------------------

const ROUTER_ERROR = /codex_core::tools::router: error=(.*)$/;

/**
 * The refusals Codex reports ONLY on stderr: a patch outside the project, a hook denial, a failed
 * patch. One entry per refusal (its first line). The timestamp/level prefix is dropped.
 */
export function stderrRefusals(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split('\n')) {
    const m = ROUTER_ERROR.exec(line);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out;
}

/** The stderr's last meaningful line (for an error message), without the stdin notice. */
export function stderrTail(stderr: string, max = 400): string {
  const lines = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && l !== 'Reading additional input from stdin...' && l !== 'Reading prompt from stdin...');
  const last = lines[lines.length - 1] ?? '';
  return clip(last, max);
}
