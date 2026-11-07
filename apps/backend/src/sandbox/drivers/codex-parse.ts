// CODEX'S app-server notifications → the ONE agent event (docs/SANDBOX.md § Agent drivers; spike 2). Pure:
// the driver hands every server notification here (JSON-RPC 2.0 over stdio, @openai/codex 0.164 protocol
// v2, `codex app-server generate-json-schema`) and acts on what comes back.
//
//   turn/started                        the turn's id (what `turn/interrupt` names)
//   item/agentMessage/delta             a partial text (`itemId` is the message)
//   item/started                        commandExecution | fileChange | mcpToolCall → a tool call
//   item/completed                      agentMessage → the final text; a tool → its result
//   thread/tokenUsage/updated           `total` is the THREAD's running total and `last` the latest
//                                       request's: THIS turn = last total − (first total − first last),
//                                       which holds after a `thread/resume` too (the total then
//                                       includes the old turns)
//   error {willRetry:false}             usageLimitExceeded → usage_limit, unauthorized → auth, …
//   turn/completed                      completed | interrupted | failed → the turn's end
// Everything else (reasoning, rate limits, MCP start-up, config warnings) is not shown.
import { clipSandboxText, SANDBOX_TOOL_OUTPUT_MAX, type SandboxAgentErrorCode, type SandboxAgentEvent, type SandboxTurnOutcome, type SandboxTurnUsage } from '@pierre-review/shared';
import { toolSummary } from './common.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

interface Breakdown {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function breakdown(v: unknown): Breakdown | null {
  if (!isObj(v)) return null;
  return { input: num(v.inputTokens), cached: num(v.cachedInputTokens), cacheWrite: num(v.cacheWriteInputTokens), output: num(v.outputTokens) };
}

const minus = (a: Breakdown, b: Breakdown): Breakdown => ({
  input: Math.max(0, a.input - b.input),
  cached: Math.max(0, a.cached - b.cached),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
  output: Math.max(0, a.output - b.output),
});

export interface CodexTurnResult {
  turnId: string;
  outcome: SandboxTurnOutcome;
  usage: SandboxTurnUsage | null;
  /** Raw input tokens (cached included), as the ledger stores a Codex row (ai/providers/codex.ts). */
  ledgerInputTokens: number | null;
  text: string;
  error: { code: SandboxAgentErrorCode; message: string } | null;
}

export interface CodexFoldOutput {
  events: SandboxAgentEvent[];
  turnStarted?: string;
  turnEnd?: CodexTurnResult;
}

/** The error code of a Codex `TurnError.codexErrorInfo`. Pure. */
export function codexErrorCode(info: unknown): SandboxAgentErrorCode {
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded') return 'usage_limit';
  if (info === 'unauthorized') return 'auth';
  return 'turn_failed';
}

function fileChangeSummary(changes: unknown): string {
  if (!Array.isArray(changes)) return 'files';
  const paths = changes.map((c) => (isObj(c) && typeof c.path === 'string' ? c.path : null)).filter((p): p is string => !!p);
  return paths.length ? paths.join(', ') : 'files';
}

/** The fold over one app-server's notifications, for one thread. */
export class CodexStreamFold {
  turnId: string | null = null;
  private firstBase: Breakdown | null = null;
  private lastTotal: Breakdown | null = null;
  private lastText = '';
  private error: CodexTurnResult['error'] = null;

  feed(method: string, params: unknown): CodexFoldOutput {
    const out: CodexFoldOutput = { events: [] };
    const p = isObj(params) ? params : {};
    switch (method) {
      case 'turn/started': {
        const t = isObj(p.turn) ? p.turn : {};
        if (typeof t.id === 'string') {
          this.turnId = t.id;
          out.turnStarted = t.id;
        }
        return out;
      }
      case 'item/agentMessage/delta': {
        if (typeof p.delta === 'string' && p.delta && typeof p.itemId === 'string') {
          out.events.push({ type: 'text', messageId: p.itemId, partial: true, text: p.delta });
        }
        return out;
      }
      case 'item/started':
      case 'item/completed': {
        const item = isObj(p.item) ? p.item : null;
        if (!item || typeof item.id !== 'string') return out;
        const started = method === 'item/started';
        if (item.type === 'agentMessage' && !started && typeof item.text === 'string') {
          this.lastText = item.text;
          out.events.push({ type: 'text', messageId: item.id, partial: false, text: item.text });
        } else if (item.type === 'commandExecution') {
          if (started) out.events.push({ type: 'tool_call', id: item.id, tool: 'shell', summary: toolSummary('shell', { command: item.command }) });
          else {
            out.events.push({
              type: 'tool_result',
              id: item.id,
              ok: item.status === 'completed' && (item.exitCode == null || item.exitCode === 0),
              output: clipSandboxText(typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : '', SANDBOX_TOOL_OUTPUT_MAX),
            });
          }
        } else if (item.type === 'fileChange') {
          if (started) out.events.push({ type: 'tool_call', id: item.id, tool: 'edit', summary: toolSummary('edit', { path: fileChangeSummary(item.changes) }) });
          else out.events.push({ type: 'tool_result', id: item.id, ok: item.status === 'completed', output: fileChangeSummary(item.changes) });
        } else if (item.type === 'mcpToolCall') {
          const tool = `${typeof item.server === 'string' ? item.server : 'mcp'}.${typeof item.tool === 'string' ? item.tool : 'tool'}`;
          if (started) out.events.push({ type: 'tool_call', id: item.id, tool, summary: toolSummary(tool, item.arguments) });
          else {
            const err = isObj(item.error) && typeof item.error.message === 'string' ? item.error.message : '';
            out.events.push({ type: 'tool_result', id: item.id, ok: item.status === 'completed' && !err, output: clipSandboxText(err, SANDBOX_TOOL_OUTPUT_MAX) });
          }
        }
        return out;
      }
      case 'thread/tokenUsage/updated': {
        const u = isObj(p.tokenUsage) ? p.tokenUsage : {};
        const total = breakdown(u.total);
        const last = breakdown(u.last);
        if (!total) return out;
        if (!this.firstBase) this.firstBase = last ? minus(total, last) : total;
        this.lastTotal = total;
        return out;
      }
      case 'error': {
        if (p.willRetry === true) return out;
        const e = isObj(p.error) ? p.error : {};
        const message = typeof e.message === 'string' ? e.message : 'The turn failed.';
        this.error = { code: codexErrorCode(e.codexErrorInfo), message };
        return out;
      }
      case 'turn/completed': {
        const t = isObj(p.turn) ? p.turn : {};
        const status = t.status;
        const outcome: SandboxTurnOutcome = status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
        let error = this.error;
        if (outcome === 'failed' && !error) {
          const te = isObj(t.error) ? t.error : {};
          error = { code: codexErrorCode(te.codexErrorInfo), message: typeof te.message === 'string' ? te.message : 'The turn failed.' };
        }
        let usage: SandboxTurnUsage | null = null;
        let ledgerInputTokens: number | null = null;
        if (this.firstBase && this.lastTotal) {
          const d = minus(this.lastTotal, this.firstBase);
          usage = {
            inputTokens: Math.max(0, d.input - d.cached),
            outputTokens: d.output,
            cacheReadTokens: d.cached,
            cacheCreationTokens: d.cacheWrite,
            costUsd: null,
          };
          ledgerInputTokens = d.input;
        }
        out.turnEnd = {
          turnId: typeof t.id === 'string' ? t.id : (this.turnId ?? ''),
          outcome,
          usage,
          ledgerInputTokens,
          text: this.lastText,
          error: outcome === 'completed' ? null : outcome === 'interrupted' ? null : error,
        };
        this.turnId = null;
        this.firstBase = null;
        this.lastTotal = null;
        this.lastText = '';
        this.error = null;
        return out;
      }
      default:
        return out;
    }
  }
}
