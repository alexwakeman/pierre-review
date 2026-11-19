// THE CLIENTS OF A LOCAL BRANCH REVIEW: `ensemble mcp` (mcp-server.ts, newline JSON-RPC on stdio) and `ensemble
// review` (cli-review.ts), over client.ts. Pinned here:
//   • the MCP slice: initialize, tools/list (the five tools), each tool's call and result (plain JSON: file, line,
//     severity, title, body; the criteria), argument errors, an unknown method / tool, parse errors;
//   • NOT RUNNING (no lock, a refused connection) and AI OFF (the routes are not registered) are ONE plain line each;
//   • the client talks to 127.0.0.1 with a loopback Host and no Origin;
//   • the CLI's arguments, its text and --json output, its exit status, and Ctrl-C cancelling the run.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalReview } from '@pierre-review/shared';
import { registerErrorHandler } from '../api/plugins/error-handler.js';
import { AI_OFF, LocalReviewClient, NOT_RUNNING, type ClientDeps } from './client.js';
import { callTool, handleMessage, LOCAL_REVIEW_TOOL_DEFS, serveLocalReviewMcp } from './mcp-server.js';
import { parseReviewArgs, runReviewCli } from './cli-review.js';
import type { BranchSnapshot } from './snapshot.js';

const REVIEW: LocalReview = {
  id: 7,
  kind: 'review',
  status: 'succeeded',
  repo: 'acme/api',
  branch: 'feature/refunds',
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
  includeUncommitted: true,
  uncommittedChanges: true,
  createdAt: '2026-11-19T10:00:00.000Z',
  completedAt: '2026-11-19T10:03:00.000Z',
  failureReason: null,
  review: {
    reviewers: [{ provider: 'claude', model: 'claude-opus-5-5', effort: 'medium', status: 'succeeded', failureReason: null }],
    summary: 'One real bug.',
    verdict: 'REQUEST_CHANGES',
    findings: [{ id: 11, file: 'src/refund.ts', line: 12, severity: 'warning', title: 'Refund can go negative', body: 'Check the amount.', suggestion: null, raisedBy: ['claude', 'codex'], earlierFindingId: null }],
    followUp: [],
  },
  ticket: { key: 'PAY-142', title: 'Refunds', url: null },
  ticketNote: null,
  storyCheck: {
    status: 'succeeded',
    failureReason: null,
    summary: 'Partly.',
    open: 1,
    criteria: [
      { ref: 'AC1', text: 'Refund a payment', status: 'met', explanation: 'Done.', open: false, cannotMeet: null, notApplicable: false },
      { ref: 'AC2', text: 'Email the customer', status: 'not_met', explanation: 'No email.', open: true, cannotMeet: 'Needs the mail service.', notApplicable: false },
    ],
  },
  answers: [],
};

const SNAP: BranchSnapshot = {
  root: '/r',
  owner: 'acme',
  name: 'api',
  branch: 'feature/refunds',
  baseRef: 'origin/main',
  baseSha: 'b'.repeat(40),
  headSha: 'c'.repeat(40),
  commitSha: 'a'.repeat(40),
  includeUncommitted: true,
  uncommittedChanges: true,
  skippedFiltered: [],
  subjects: ['PAY-142 refunds'],
  bundle: Buffer.from('bundle'),
};

let server: Server | null = null;
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: any }> = [];

/** A stand-in backend on a loopback port. */
async function backend(handler: (method: string, url: string, body: any) => { status: number; body: unknown }): Promise<number> {
  seen.length = 0;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const out = handler(req.method!, req.url!, body);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  return (server!.address() as AddressInfo).port;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = null;
});

const deps = (port: number | null, snapshot: ClientDeps['snapshot'] = async () => SNAP): ClientDeps => ({ port: () => port, cwd: () => '/r', snapshot });

function happy(method: string, url: string): { status: number; body: unknown } {
  if (method === 'POST' && url === '/api/local-reviews') return { status: 200, body: { id: 7, status: 'running', alreadyRunning: false, ignoredAnswers: [] } };
  if (method === 'GET' && url.startsWith('/api/local-reviews/7')) return { status: 200, body: REVIEW };
  if (method === 'POST' && url === '/api/local-reviews/7/cancel') return { status: 200, body: { cancelled: true, review: { ...REVIEW, status: 'cancelled' } } };
  if (method === 'GET' && url.startsWith('/api/local-reviews?')) return { status: 200, body: { repo: 'acme/api', branch: 'feature/refunds', reviews: [] } };
  return { status: 404, body: { message: 'nope' } };
}

describe('the MCP server', () => {
  it('initializes, lists its five tools and answers ping; notifications get no reply', async () => {
    const c = new LocalReviewClient(deps(null));
    const init = await handleMessage(c, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(init).toMatchObject({ id: 1, result: { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ensemble' } } });
    const list = await handleMessage(c, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list!.result as any).tools.map((t: any) => t.name)).toEqual(['review_local_branch', 'get_local_review', 'list_local_reviews', 'cancel_local_review', 'check_story']);
    expect(LOCAL_REVIEW_TOOL_DEFS.every((t) => t.inputSchema.type === 'object')).toBe(true);
    expect(await handleMessage(c, { jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(await handleMessage(c, { jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await handleMessage(c, { jsonrpc: '2.0', id: 4, method: 'sampling/x' })).toMatchObject({ error: { code: -32601 } });
    expect(await handleMessage(c, [])).toMatchObject({ error: { code: -32600 } });
  });

  it('NOT RUNNING and AI OFF are one plain line, as a tool error', async () => {
    const off = await handleMessage(new LocalReviewClient(deps(null)), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_local_branch', arguments: {} } });
    expect(off!.result).toEqual({ isError: true, content: [{ type: 'text', text: NOT_RUNNING }] });
    expect(NOT_RUNNING).toBe('Ensemble is not running. Start it with: npx ensemble-review');
    // A lock naming a port nobody listens on (a crash): the refused connection reads the same.
    const dead = await backend(() => ({ status: 200, body: {} }));
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    const refused = await handleMessage(new LocalReviewClient(deps(dead)), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_local_review', arguments: { id: 1, waitSeconds: 0 } } });
    expect((refused!.result as any).content[0].text).toBe(NOT_RUNNING);
    const port = await backend((m, u) => ({ status: 404, body: { message: `Route ${m}:${u.split('?')[0]} not found`, error: 'Not Found', statusCode: 404 } }));
    const ai = await handleMessage(new LocalReviewClient(deps(port)), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'review_local_branch', arguments: {} } });
    expect((ai!.result as any).content[0].text).toBe(AI_OFF);
  });

  it("AI OFF is read from the APP's own not-found handler (a space, not Fastify's colon)", async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app, { serveSpa: false, publicDir: '/nonexistent' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const c = new LocalReviewClient(deps(port));
      const start = await handleMessage(c, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'review_local_branch', arguments: {} } });
      expect((start!.result as any).content[0].text).toBe(AI_OFF);
      const get = await handleMessage(c, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_local_review', arguments: { id: 3, waitSeconds: 0 } } });
      expect((get!.result as any).content[0].text).toBe(AI_OFF);
    } finally {
      await app.close();
    }
  });

  it('review_local_branch sends the bundle and the branch facts to 127.0.0.1 (loopback Host, no Origin), never a path', async () => {
    const port = await backend(happy);
    const asked: any[] = [];
    const c = new LocalReviewClient(deps(port, async (o) => (asked.push(o), SNAP)));
    const text = await callTool(c, 'review_local_branch', { includeUncommitted: false, ticket: 'PAY-142', provider: 'codex', effort: 'high', answers: [{ ref: 'F1', action: 'fixed', reply: 'done' }], path: '/r/src' });
    expect(JSON.parse(text)).toMatchObject({ id: 7, status: 'running', repo: 'acme/api', branch: 'feature/refunds', uncommittedChanges: true });
    expect(asked[0]).toEqual({ cwd: '/r/src', includeUncommitted: false, base: null });
    const req = seen[0]!;
    expect(req.headers.host).toBe(`127.0.0.1:${port}`);
    expect(req.headers.origin).toBeUndefined();
    expect(req.body).toMatchObject({ owner: 'acme', name: 'api', branch: 'feature/refunds', baseSha: SNAP.baseSha, headSha: SNAP.headSha, kind: 'review', ticket: 'PAY-142', provider: 'codex', effort: 'high', answers: [{ ref: 'F1', action: 'fixed', reply: 'done' }] });
    expect(Buffer.from(req.body.bundle, 'base64').toString()).toBe('bundle');
    expect(Object.keys(req.body)).not.toContain('path');
    expect(Object.keys(req.body)).not.toContain('root');
  });

  it('get_local_review long-polls and returns plain JSON; check_story, list and cancel', async () => {
    const port = await backend(happy);
    const c = new LocalReviewClient(deps(port));
    const got = JSON.parse(await callTool(c, 'get_local_review', { id: 7 }));
    expect(seen[0]!.url).toBe('/api/local-reviews/7?waitMs=50000');
    expect(got.findings).toEqual([{ id: 11, file: 'src/refund.ts', line: 12, severity: 'warning', title: 'Refund can go negative', body: 'Check the amount.', raisedBy: ['claude', 'codex'] }]);
    expect(got.storyCheck.criteria[1]).toEqual({ ref: 'AC2', status: 'not_met', open: true, text: 'Email the customer', explanation: 'No email.', cannotMeet: 'Needs the mail service.' });
    expect(got.verdict).toBe('request changes');
    expect(got.next).toMatch(/^Fix what applies/);
    await callTool(c, 'check_story', { ticket: 'PAY-142' });
    expect(seen.at(-1)!.body).toMatchObject({ kind: 'story', ticket: 'PAY-142', effort: null, includeUncommitted: true });
    const cancelled = JSON.parse(await callTool(c, 'cancel_local_review', { id: '7' }));
    expect(cancelled).toMatchObject({ cancelled: true, status: 'cancelled' });
  });

  it('refuses bad arguments with one line', async () => {
    const c = new LocalReviewClient(deps(1));
    await expect(callTool(c, 'get_local_review', {})).rejects.toThrow('"id" must be a review id.');
    await expect(callTool(c, 'review_local_branch', { provider: 'gpt' })).rejects.toThrow('"provider" must be "claude" or "codex".');
    await expect(callTool(c, 'review_local_branch', { effort: 'ultra' })).rejects.toThrow(/^"effort" must be one of/);
    await expect(callTool(c, 'nope', {})).rejects.toThrow('There is no tool named nope.');
    const r = await handleMessage(c, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'get_local_review', arguments: { id: -1 } } });
    expect(r!.result).toEqual({ isError: true, content: [{ type: 'text', text: '"id" must be a review id.' }] });
  });

  it('serves newline-delimited JSON-RPC on a stream (parse errors answered, stdout only the protocol)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: any[] = [];
    output.on('data', (c: Buffer) => lines.push(...c.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))));
    const done = serveLocalReviewMcp({ input, output, client: new LocalReviewClient(deps(null)) });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n{not json\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_local_reviews', arguments: {} } })}\n`);
    input.end();
    await done;
    expect(lines.find((l) => l.id === 1).result.serverInfo.name).toBe('ensemble');
    expect(lines.find((l) => l.error?.code === -32700)).toBeTruthy();
    expect(lines.find((l) => l.id === 2).result.content[0].text).toBe(NOT_RUNNING);
  });
});

describe('ensemble review', () => {
  it('parses its arguments', () => {
    expect(parseReviewArgs([])).toMatchObject({ json: false, includeUncommitted: true, ticket: null, story: false });
    expect(parseReviewArgs(['--json', '--no-uncommitted', '--ticket', 'PAY-1', '--provider', 'codex', '--effort', 'low', '--base', 'origin/dev', '--story'])).toMatchObject({
      json: true,
      includeUncommitted: false,
      ticket: 'PAY-1',
      provider: 'codex',
      effort: 'low',
      base: 'origin/dev',
      story: true,
    });
    expect(parseReviewArgs(['--ticket'])).toBe('--ticket needs a key, for example --ticket PAY-142');
    expect(parseReviewArgs(['--provider', 'x'])).toBe('--provider must be claude or codex');
    expect(parseReviewArgs(['--bogus'])).toBe('Unknown argument: --bogus. Run `ensemble review --help` for usage.');
  });

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    let interrupt: (() => void) | null = null;
    return { out, err, fire: () => interrupt?.(), io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t), onInterrupt: (h: () => void) => ((interrupt = h), () => (interrupt = null)) } };
  };

  it('prints the review as text, or the MCP projection with --json; exit 0 on success', async () => {
    const port = await backend(happy);
    const a = io();
    expect(await runReviewCli([], new LocalReviewClient(deps(port)), a.io)).toBe(0);
    expect(a.err[0]).toMatch(/^Reviewing acme\/api feature\/refunds at cccccccccccc \(with uncommitted changes\) — review 7/);
    expect(a.out[0]).toContain('F11 [warning] src/refund.ts:12 — Refund can go negative');
    expect(a.out[0]).toContain('OPEN AC2 not met — Email the customer');
    expect(a.out[0]).toContain('Cannot meet: Needs the mail service.');
    const b = io();
    expect(await runReviewCli(['--json'], new LocalReviewClient(deps(port)), b.io)).toBe(0);
    expect(JSON.parse(b.out[0]!)).toMatchObject({ id: 7, findings: [{ id: 11, file: 'src/refund.ts' }] });
    expect(b.err).toEqual([]);
  });

  it('a refusal is one line on stderr and exit 1; Ctrl-C cancels the run', async () => {
    const a = io();
    expect(await runReviewCli([], new LocalReviewClient(deps(null)), a.io)).toBe(1);
    expect(a.err).toEqual([NOT_RUNNING]);
    let polls = 0;
    const b = io();
    const port = await backend((m, u, body) => {
      if (m === 'GET' && u.startsWith('/api/local-reviews/7')) {
        polls += 1;
        if (polls === 1) setTimeout(() => b.fire(), 0);
        // Cancelled only once the cancel has arrived (never by the poll count: that races the Ctrl-C).
        const cancelled = seen.some((x) => x.method === 'POST' && x.url === '/api/local-reviews/7/cancel');
        return { status: 200, body: { ...REVIEW, status: cancelled ? 'cancelled' : 'running' } };
      }
      return happy(m, u);
    });
    expect(await runReviewCli([], new LocalReviewClient(deps(port)), b.io)).toBe(1);
    expect(seen.some((s) => s.method === 'POST' && s.url === '/api/local-reviews/7/cancel')).toBe(true);
    expect(b.out[0]).toMatch(/: cancelled/);
  });
});
