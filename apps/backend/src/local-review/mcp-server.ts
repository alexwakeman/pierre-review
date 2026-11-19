// `ensemble mcp` — ENSEMBLE AS AN MCP SERVER FOR THE READER'S CODING AGENT (docs/CLAUDE-REVIEW.md § Reviewing a
// local branch). Claude Code: `claude mcp add ensemble -- npx ensemble-review mcp`; Codex: an `[mcp_servers.ensemble]`
// entry with `command = "npx"`, `args = ["ensemble-review", "mcp"]`. It is a CLIENT of the running Ensemble
// (client.ts): it packages the branch in the agent's working folder and asks Ensemble to review it.
//
// WHY A HAND-ROLLED JSON-RPC LOOP, NOT `@modelcontextprotocol/sdk` — the reasons of ai/codex/workspace-mcp.ts:
// the SDK is an AI-runtime package only `ai/runtime.ts` may load (the release build greps for any other
// importer), and this process must start fast and work before any AI runtime is installed. The slice an MCP
// client uses is small: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` over
// newline-delimited JSON on stdio. ⚠ STDOUT IS THE PROTOCOL: nothing else may print to it.
//
// The tools return PLAIN JSON (view.ts): a review starts with `review_local_branch` and is read with
// `get_local_review`, which waits up to 50 seconds per call (a review takes minutes; MCP clients time out tool
// calls).
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { AI_EFFORTS, LOCAL_REVIEW_WAIT_MAX_MS, type LocalReviewAnswer } from '@pierre-review/shared';
import { ClientError, LocalReviewClient } from './client.js';
import { reviewView } from './view.js';

const SERVER_INFO = { name: 'ensemble', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const MAX_LINE_CHARS = 1024 * 1024;

const PATH_ARG = { type: 'string', description: 'A folder inside the repository. Default: the folder this server started in.' };
const ANSWERS_ARG = {
  type: 'array',
  description:
    'Answers to the previous review of this branch. ref: "F<id>" for a finding (action fixed, answered or pushed_back), "AC<n>" or "M<n>" for an open criterion (fixed, not_applicable, cannot_meet). reply: what you did, or why (required; a reason for cannot_meet).',
  items: {
    type: 'object',
    properties: {
      ref: { type: 'string' },
      action: { type: 'string', enum: ['fixed', 'answered', 'pushed_back', 'not_applicable', 'cannot_meet'] },
      reply: { type: 'string' },
    },
    required: ['ref', 'action', 'reply'],
  },
};

export const LOCAL_REVIEW_TOOL_DEFS = [
  {
    name: 'review_local_branch',
    description:
      'Ask Ensemble to review the current branch before it is pushed: the commits since the base branch plus uncommitted tracked changes (untracked files are never sent). Returns a review id at once; read the result with get_local_review. When a ticket is found, the review also checks the acceptance criteria.',
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        includeUncommitted: { type: 'boolean', description: 'Include uncommitted changes to tracked files. Default true.' },
        ticket: { type: 'string', description: 'The ticket key (for example PAY-142). Default: found in the branch name or commit subjects.' },
        base: { type: 'string', description: "The ref to compare against. Default: the branch's upstream when stacked, else origin's default branch." },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'One reviewer for this run. Default: Settings → AI → Review (Claude and Codex together when both are on).' },
        effort: { type: 'string', enum: [...AI_EFFORTS], description: 'The effort for this run. Default: Settings → AI → Review.' },
        answers: ANSWERS_ARG,
      },
    },
  },
  {
    name: 'get_local_review',
    description: 'Read a local review: its status, findings (file, line, severity, title, body) and the acceptance criteria. While it runs, waits up to 50 seconds for it to finish.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The review id.' },
        waitSeconds: { type: 'integer', description: 'How long to wait while it runs (0–50). Default 50.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_local_reviews',
    description: 'List the local reviews of the current branch (newest first).',
    inputSchema: { type: 'object', properties: { path: PATH_ARG, branch: { type: 'string', description: 'Another branch of this repository.' } } },
  },
  {
    name: 'cancel_local_review',
    description: 'Stop a running local review.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'check_story',
    description: "Check the current branch against its ticket's acceptance criteria only (no code review). Returns a review id; read it with get_local_review.",
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        ticket: { type: 'string', description: 'The ticket key. Default: found in the branch name or commit subjects.' },
        includeUncommitted: { type: 'boolean', description: 'Include uncommitted changes to tracked files. Default true.' },
        base: { type: 'string' },
        provider: { type: 'string', enum: ['claude', 'codex'] },
        answers: ANSWERS_ARG,
      },
    },
  },
] as const;

/** A tool argument that is wrong: one plain line. */
class ArgError extends Error {}

type Args = Record<string, unknown>;
const optStr = (a: Args, k: string): string | null => {
  const v = a[k];
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new ArgError(`"${k}" must be text.`);
  return v;
};
const optBool = (a: Args, k: string, dflt: boolean): boolean => {
  const v = a[k];
  if (v == null) return dflt;
  if (typeof v !== 'boolean') throw new ArgError(`"${k}" must be true or false.`);
  return v;
};
const idOf = (a: Args): number => {
  const v = typeof a.id === 'string' && /^\d+$/.test(a.id) ? Number(a.id) : a.id;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new ArgError('"id" must be a review id.');
  return v;
};
const providerOf = (a: Args): 'claude' | 'codex' | null => {
  const v = optStr(a, 'provider');
  if (v == null) return null;
  if (v !== 'claude' && v !== 'codex') throw new ArgError('"provider" must be "claude" or "codex".');
  return v;
};
const effortOf = (a: Args): (typeof AI_EFFORTS)[number] | null => {
  const v = optStr(a, 'effort');
  if (v == null) return null;
  if (!(AI_EFFORTS as readonly string[]).includes(v)) throw new ArgError(`"effort" must be one of ${AI_EFFORTS.join(', ')}.`);
  return v as (typeof AI_EFFORTS)[number];
};
const answersOf = (a: Args): LocalReviewAnswer[] => {
  const v = a.answers;
  if (v == null) return [];
  if (!Array.isArray(v)) throw new ArgError('"answers" must be a list.');
  return v as LocalReviewAnswer[];
};

/** Run one tool (the result is the text of its one content item). Throws ClientError / ArgError with a plain line. */
export async function callTool(client: LocalReviewClient, name: string, rawArgs: unknown): Promise<string> {
  const a = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Args;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  switch (name) {
    case 'review_local_branch':
    case 'check_story': {
      const res = await client.start({
        kind: name === 'check_story' ? 'story' : 'review',
        includeUncommitted: optBool(a, 'includeUncommitted', true),
        ticket: optStr(a, 'ticket'),
        base: optStr(a, 'base'),
        path: optStr(a, 'path'),
        provider: providerOf(a),
        effort: name === 'check_story' ? null : effortOf(a),
        answers: answersOf(a),
      });
      return json({
        id: res.id,
        status: res.status,
        repo: res.repo,
        branch: res.branch,
        head: res.headSha.slice(0, 12),
        uncommittedChanges: res.uncommittedChanges,
        ...(res.skippedFiltered.length > 0 ? { leftOutFiltered: res.skippedFiltered, leftOutNote: 'These uncommitted files use a git filter (for example Git LFS), so their committed version was reviewed. Commit them to include them.' } : {}),
        ...(res.alreadyRunning ? { alreadyRunning: true } : {}),
        ...(res.ignoredAnswers.length > 0 ? { ignoredAnswers: res.ignoredAnswers } : {}),
        next: `${res.alreadyRunning ? 'A review of this branch is already running. ' : ''}Call get_local_review with id ${res.id}; it waits up to 50 seconds per call.`,
      });
    }
    case 'get_local_review': {
      const w = a.waitSeconds == null ? LOCAL_REVIEW_WAIT_MAX_MS / 1000 : Number(a.waitSeconds);
      if (!Number.isFinite(w)) throw new ArgError('"waitSeconds" must be a number.');
      return json(reviewView(await client.get(idOf(a), Math.max(0, Math.min(w, 50)) * 1000)));
    }
    case 'list_local_reviews':
      return json(await client.list({ path: optStr(a, 'path'), branch: optStr(a, 'branch') }));
    case 'cancel_local_review': {
      const r = await client.cancel(idOf(a));
      return json({ cancelled: r.cancelled, ...reviewView(r.review) });
    }
    default:
      throw new ArgError(`There is no tool named ${name || '(none)'}.`);
  }
}

type JsonRpcId = string | number | null;
export interface Outgoing {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Answer one JSON-RPC message; null for a notification (no reply). */
export async function handleMessage(client: LocalReviewClient, msg: unknown): Promise<Outgoing | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const m = msg as { id?: JsonRpcId; method?: unknown; params?: unknown };
  const isRequest = m.id !== undefined && m.id !== null;
  if (typeof m.method !== 'string') return isRequest ? { jsonrpc: '2.0', id: m.id!, error: { code: -32600, message: 'Invalid request' } } : null;
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
          instructions:
            'Ensemble reviews the branch you are working on before it is pushed. Call review_local_branch, then get_local_review with the id until the status is no longer "running". Fix what applies, then review again with answers to the earlier findings and criteria.',
        },
      };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: LOCAL_REVIEW_TOOL_DEFS } };
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'resources/templates/list':
      return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      try {
        const text = await callTool(client, name, params.arguments);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
      } catch (e) {
        const text = e instanceof ClientError || e instanceof ArgError ? e.message : `The ${name || 'tool'} call failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } };
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

/** Serve newline-delimited JSON-RPC on `input`/`output` until `input` ends (and every call has answered). */
export function serveLocalReviewMcp(opts: { input: Readable; output: Writable; client?: LocalReviewClient }): Promise<void> {
  const client = opts.client ?? new LocalReviewClient();
  const send = (m: Outgoing) => opts.output.write(`${JSON.stringify(m)}\n`);
  const pending = new Set<Promise<void>>();
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
    const p = handleMessage(client, msg)
      .then((reply) => {
        if (reply) send(reply);
      })
      .catch(() => {})
      .finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => rl.on('close', () => void Promise.all([...pending]).then(() => resolve())));
}
