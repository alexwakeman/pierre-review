// LIMN'S WORKSPACE MCP SERVER — how a Codex agent reads code with its shell OFF (docs/CODEX-PLAN.md
// § 3.3, CODEX-SPIKE.md § 2). Codex starts it per run as a stdio child process (`mcp_servers.
// workspace`), with the run's read roots on its command line; its three tools (`workspace-files.ts`)
// refuse every path outside them, so it IS the read half of the path guard. The PreToolUse hook
// (`hook.ts`) repeats the check before each call reaches it, and denies every other MCP server.
//
// WHY A HAND-ROLLED JSON-RPC LOOP, NOT `@modelcontextprotocol/sdk`. The server is its OWN process,
// started by Codex, not by Limn: it cannot be handed the SDK `ai/runtime.ts` loaded, and loading it
// again there would (a) make a Codex-only install also download the MCP SDK + zod into the AI
// runtime, (b) put a second value-importer of an AI package next to `ai/runtime.ts` (CLAUDE.md
// forbids it; the release build greps for it), and (c) add the SDK's start-up to EVERY run. The
// protocol slice Codex uses is five methods over newline-delimited JSON (`initialize`,
// `notifications/initialized`, `tools/list`, `tools/call`, `ping`) — the spike's server spoke
// exactly this to Codex 0.164. So the entry imports nothing but `node:` built-ins and relative
// files, which scripts/build-release.mjs asserts.
//
// ⚠ Codex needs `default_tools_approval_mode="approve"` on this server under
// `approval_policy="never"`, or every call fails "requires approval" — `workspaceMcpConfig` sets it.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { helperCommand } from './entry.js';
import type { CodexMcpConfig } from './types.js';
import { createWorkspaceTools, ToolRefusal, WORKSPACE_TOOL_DEFS, type WorkspaceTools } from './workspace-files.js';
import { CheckToolRunner, loadCheckSpec, runCheckDescription, runCheckInputSchema } from '../../coding/checks/spec.js';

export const WORKSPACE_MCP_ID = 'workspace' as const;
const SERVER_INFO = { name: 'limn-workspace', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_LINE_CHARS = 1024 * 1024;

/**
 * The `mcp_servers.workspace` entry for one run: Node + the entry script + `--read <root>` per read
 * root. `opts.logFile` makes the server append one JSON line per tool call (tests, the live check).
 * `opts.checks` adds the project's own checks (`run_check`, coding/checks/spec.ts): the server reads
 * that frozen list ONCE at start-up, and Codex is told a call may take up to `timeoutSec`.
 */
export function workspaceMcpConfig(
  roots: { read: string[]; write: string[] },
  opts: { logFile?: string; checks?: { specFile: string; timeoutSec: number } } = {},
): CodexMcpConfig {
  if (roots.read.length === 0) throw new Error('workspaceMcpConfig: a run needs at least one read root');
  const { command, args } = helperCommand('workspace-mcp-main');
  const argv = [...args];
  for (const r of roots.read) argv.push('--read', r);
  if (opts.logFile) argv.push('--log', opts.logFile);
  if (opts.checks) argv.push('--checks', opts.checks.specFile);
  return {
    id: WORKSPACE_MCP_ID,
    command,
    args: argv,
    env: {},
    default_tools_approval_mode: 'approve',
    ...(opts.checks ? { tool_timeout_sec: Math.ceil(opts.checks.timeoutSec + 30) } : {}),
  };
}

/** Parse the entry's argv (`--read <root>`…, `--log <file>`, `--checks <spec file>`). */
export function parseServerArgv(argv: readonly string[]): { read: string[]; logFile: string | null; checksSpec: string | null } {
  const read: string[] = [];
  let logFile: string | null = null;
  let checksSpec: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === '--read' || flag === '--log' || flag === '--checks') && value !== undefined) {
      if (flag === '--read') read.push(value);
      else if (flag === '--log') logFile = value;
      else checksSpec = value;
      i++;
    } else throw new Error(`workspace MCP server: unexpected argument ${JSON.stringify(flag)}`);
  }
  return { read, logFile, checksSpec };
}

/** The tool definitions: the three file tools, plus `run_check` when the run carries checks. */
export function toolDefs(checks: CheckToolRunner | null): unknown[] {
  if (!checks || checks.names.length === 0) return WORKSPACE_TOOL_DEFS as unknown as unknown[];
  return [
    ...(WORKSPACE_TOOL_DEFS as unknown as unknown[]),
    { name: 'run_check', description: runCheckDescription(checks.names), inputSchema: runCheckInputSchema(checks.names) },
  ];
}

type JsonRpcId = string | number | null;
interface Outgoing {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Answer one JSON-RPC message; null for a notification (no reply). A `run_check` call answers later. */
export function handleMessage(tools: WorkspaceTools, msg: unknown, log: (entry: object) => void): Outgoing | null;
export function handleMessage(
  tools: WorkspaceTools,
  msg: unknown,
  log: (entry: object) => void,
  checks: CheckToolRunner | null,
): Outgoing | null | Promise<Outgoing>;
export function handleMessage(
  tools: WorkspaceTools,
  msg: unknown,
  log: (entry: object) => void,
  checks: CheckToolRunner | null = null,
): Outgoing | null | Promise<Outgoing> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  }
  const m = msg as { id?: JsonRpcId; method?: unknown; params?: unknown };
  const isRequest = m.id !== undefined && m.id !== null;
  if (typeof m.method !== 'string') {
    return isRequest ? { jsonrpc: '2.0', id: m.id!, error: { code: -32600, message: 'Invalid request' } } : null;
  }
  if (!isRequest) return null; // notifications/initialized, notifications/cancelled, …
  const id = m.id!;
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
  switch (m.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: `Read-only access to the workspace. Relative paths start at ${tools.roots[0]}.${tools.roots.length > 1 ? ` Other readable folders: ${tools.roots.slice(1).join(', ')}.` : ''}`,
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: toolDefs(checks) } };
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      if (name === 'run_check' && checks) {
        return checks.call(params.arguments).then(
          (reply) => {
            log({ tool: name, args: params.arguments, ok: !reply.isError });
            return { jsonrpc: '2.0' as const, id, result: { ...(reply.isError ? { isError: true } : {}), content: [{ type: 'text', text: reply.text }] } };
          },
          () => ({ jsonrpc: '2.0' as const, id, result: { isError: true, content: [{ type: 'text', text: 'The check could not run.' }] } }),
        );
      }
      try {
        const text = tools.call(name, params.arguments);
        log({ tool: name, args: params.arguments, ok: true });
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (e) {
        const text = e instanceof ToolRefusal ? e.message : `The ${name || 'tool'} call failed.`;
        log({ tool: name, args: params.arguments, ok: false, error: text });
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } };
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

/** Serve newline-delimited JSON-RPC on `input`/`output` until `input` ends. */
export function serveWorkspaceMcp(opts: {
  read: string[];
  logFile: string | null;
  /** The frozen check list (coding/checks/spec.ts), read HERE, once, before any call is served. */
  checksSpec?: string | null;
  input: Readable;
  output: Writable;
}): Promise<void> {
  const tools = createWorkspaceTools(opts.read);
  const checks = opts.checksSpec ? new CheckToolRunner(loadCheckSpec(opts.checksSpec)) : null;
  const log = (entry: object) => {
    if (!opts.logFile) return;
    try {
      appendFileSync(opts.logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
    } catch {
      /* logging never breaks a call */
    }
  };
  const send = (m: Outgoing) => opts.output.write(`${JSON.stringify(m)}\n`);
  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim() === '') return;
    if (line.length > MAX_LINE_CHARS) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request too large' } });
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const reply = handleMessage(tools, msg, log, checks);
    if (reply instanceof Promise) void reply.then(send);
    else if (reply) send(reply);
  });
  return new Promise((resolve) => rl.on('close', () => resolve()));
}
