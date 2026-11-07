// CLAUDE CODE'S stream-json → the ONE agent event (docs/SANDBOX.md § Agent drivers; spike 1). Pure: the
// driver feeds every stdout line here and acts on what comes back.
//
// What the CLI prints (2.1.295, `-p --input-format stream-json --output-format stream-json --verbose
// --include-partial-messages`, recorded in __fixtures__/claude-interactive.out.jsonl):
//   control_response              the answer to OUR control_request (initialize, set_permission_mode, interrupt)
//   system/init                   at the start of EVERY turn; names the CURRENT permissionMode and the session id
//   system/status, thinking_tokens  progress; ignored
//   stream_event                  the Messages API stream: message_start (the message id), content_block_*
//                                 (text_delta → a partial text; thinking/input_json deltas are not shown)
//   assistant                     one whole model message: its text blocks (final text) and tool_use blocks
//   user                          tool_result blocks (the tool's output) — and "[Request interrupted by user]"
//   rate_limit_event              the subscription windows (the spend budget's reading)
//   result                        ONE per turn: its subtype, the final text, and ⚠ the PROCESS's running
//                                 `total_cost_usd` and cumulative `modelUsage` — so THIS turn's usage is
//                                 the DIFFERENCE from the last result (an interrupted turn adds nothing).
import { clipSandboxText, SANDBOX_TOOL_OUTPUT_MAX, type SandboxAgentEvent, type SandboxTurnOutcome, type SandboxTurnUsage } from '@pierre-review/shared';
import { toolSummary } from './common.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** The cumulative tokens a `result` reports (summed over its `modelUsage`). Null when absent. Pure. */
export function cumulativeTokens(result: Record<string, unknown>): Tokens | null {
  const mu = result.modelUsage;
  if (!isObj(mu)) return null;
  const t: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const m of Object.values(mu)) {
    if (!isObj(m)) continue;
    t.input += num(m.inputTokens);
    t.output += num(m.outputTokens);
    t.cacheRead += num(m.cacheReadInputTokens);
    t.cacheCreation += num(m.cacheCreationInputTokens);
  }
  return t;
}

export interface ClaudeTurnResult {
  outcome: SandboxTurnOutcome;
  usage: SandboxTurnUsage | null;
  /** The turn's final text (the result's `result` on success, else the last message's text). */
  text: string;
  /** The error to show, when the turn did not succeed for a reason the reader must know. */
  error: { code: 'usage_limit' | 'auth' | 'turn_failed'; message: string } | null;
}

export interface ClaudeFoldOutput {
  events: SandboxAgentEvent[];
  /** A control_response: its request id, success, and body. */
  control?: { requestId: string; ok: boolean; response: unknown; error: string | null };
  /** A turn ended. */
  turnEnd?: ClaudeTurnResult;
  /** A rate_limit_event, for the spend budget's reading. */
  rateLimit?: Record<string, unknown>;
}

function errorFor(text: string): ClaudeTurnResult['error'] {
  if (/usage limit|rate limit|limit reached|out of (extra )?usage/i.test(text)) return { code: 'usage_limit', message: text };
  if (/\b401\b|authenticat|invalid (x-)?api[ -]key|oauth token|not logged in|please run \/login/i.test(text)) {
    return { code: 'auth', message: text };
  }
  return text ? { code: 'turn_failed', message: text } : null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : isObj(c) && c.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** The fold over one Claude Code process's stream. One instance per process. */
export class ClaudeStreamFold {
  sessionId: string | null = null;
  /** The permission mode the CLI last stated (system/init or a mode-change status). */
  permissionMode: string | null = null;
  private costSoFar = 0;
  private tokensSoFar: Tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  private messageId: string | null = null;
  private lastText = '';
  /** Set by the driver when it sent an interrupt this turn (an aborted turn is "interrupted", not "failed"). */
  interruptRequested = false;

  feed(raw: unknown): ClaudeFoldOutput {
    const out: ClaudeFoldOutput = { events: [] };
    if (!isObj(raw)) return out;
    const sid = typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : null;
    if (sid) this.sessionId = sid;

    switch (raw.type) {
      case 'control_response': {
        const r = isObj(raw.response) ? raw.response : {};
        const requestId = typeof r.request_id === 'string' ? r.request_id : '';
        out.control = {
          requestId,
          ok: r.subtype === 'success',
          response: r.response ?? null,
          error: typeof r.error === 'string' ? r.error : r.subtype === 'success' ? null : 'refused',
        };
        return out;
      }
      case 'system': {
        if (raw.subtype === 'init' || (raw.subtype === 'status' && typeof raw.permissionMode === 'string')) {
          if (typeof raw.permissionMode === 'string') this.permissionMode = raw.permissionMode;
        }
        return out;
      }
      case 'stream_event': {
        const ev = isObj(raw.event) ? raw.event : {};
        if (ev.type === 'message_start' && isObj(ev.message) && typeof ev.message.id === 'string') {
          this.messageId = ev.message.id;
        } else if (ev.type === 'content_block_delta' && isObj(ev.delta) && ev.delta.type === 'text_delta') {
          const text = typeof ev.delta.text === 'string' ? ev.delta.text : '';
          if (text) out.events.push({ type: 'text', messageId: this.blockKey(ev.index), partial: true, text });
        }
        return out;
      }
      case 'assistant': {
        const msg = isObj(raw.message) ? raw.message : {};
        if (typeof msg.id === 'string') this.messageId = msg.id;
        const content = Array.isArray(msg.content) ? msg.content : [];
        content.forEach((block, index) => {
          if (!isObj(block)) return;
          if (block.type === 'text' && typeof block.text === 'string') {
            this.lastText = block.text;
            out.events.push({ type: 'text', messageId: this.blockKey(index), partial: false, text: block.text });
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            const tool = typeof block.name === 'string' ? block.name : 'tool';
            out.events.push({ type: 'tool_call', id: block.id, tool, summary: toolSummary(tool, block.input) });
          }
        });
        return out;
      }
      case 'user': {
        const msg = isObj(raw.message) ? raw.message : {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          out.events.push({
            type: 'tool_result',
            id: block.tool_use_id,
            ok: block.is_error !== true,
            output: clipSandboxText(toolResultText(block.content), SANDBOX_TOOL_OUTPUT_MAX),
          });
        }
        return out;
      }
      case 'rate_limit_event':
        out.rateLimit = raw;
        return out;
      case 'result': {
        out.turnEnd = this.endTurn(raw);
        return out;
      }
      default:
        return out;
    }
  }

  private blockKey(index: unknown): string {
    return `${this.messageId ?? 'msg'}:${typeof index === 'number' ? index : 0}`;
  }

  private endTurn(r: Record<string, unknown>): ClaudeTurnResult {
    const subtype = typeof r.subtype === 'string' ? r.subtype : 'error';
    const aborted = r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools' || this.interruptRequested;
    const outcome: SandboxTurnOutcome =
      subtype === 'success' && r.is_error !== true
        ? 'completed'
        : subtype === 'error_max_turns'
          ? 'max_turns'
          : subtype === 'error_max_budget_usd'
            ? 'budget'
            : aborted
              ? 'interrupted'
              : 'failed';

    // THIS turn's usage: the difference from the process's last running total.
    let usage: SandboxTurnUsage | null = null;
    const total = typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
    const tokens = cumulativeTokens(r);
    if (total != null || tokens) {
      const cost = total != null ? Math.max(0, total - this.costSoFar) : null;
      if (total != null) this.costSoFar = Math.max(this.costSoFar, total);
      const d = tokens
        ? {
            input: Math.max(0, tokens.input - this.tokensSoFar.input),
            output: Math.max(0, tokens.output - this.tokensSoFar.output),
            cacheRead: Math.max(0, tokens.cacheRead - this.tokensSoFar.cacheRead),
            cacheCreation: Math.max(0, tokens.cacheCreation - this.tokensSoFar.cacheCreation),
          }
        : null;
      if (tokens) this.tokensSoFar = tokens;
      usage = {
        inputTokens: d ? d.input : null,
        outputTokens: d ? d.output : null,
        cacheReadTokens: d ? d.cacheRead : null,
        cacheCreationTokens: d ? d.cacheCreation : null,
        costUsd: cost != null ? Math.round(cost * 1e6) / 1e6 : null,
      };
    }

    const resultText = typeof r.result === 'string' ? r.result : '';
    const text = outcome === 'completed' ? resultText || this.lastText : this.lastText;
    let error: ClaudeTurnResult['error'] = null;
    if (outcome === 'failed') {
      const errs = Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === 'string').join(' ') : '';
      error = errorFor(resultText || errs || 'The turn failed.') ?? { code: 'turn_failed', message: 'The turn failed.' };
    }
    this.lastText = '';
    this.interruptRequested = false;
    return { outcome, usage, text, error };
  }
}
