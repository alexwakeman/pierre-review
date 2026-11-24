// Spike ACP client, raw JSON-RPC over ndjson stdio. Drives `opencode acp`, logs every message,
// answers permission requests from ONE rule.
// Usage: node acp-client.mjs <cwd> <promptFile|-> [policy]
//   policy: "ensemble" (allow only the workspace MCP tools; deny everything else) | "deny-all" | "allow-all"
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const [cwd, promptArg, policy = 'ensemble'] = process.argv.slice(2);
const LOG = process.env.SPIKE_LOG;
const t0 = Date.now();
const log = (kind, data) => fs.appendFileSync(LOG, JSON.stringify({ ms: Date.now() - t0, kind, data }) + '\n');

const childEnv = JSON.parse(process.env.SPIKE_CHILD_ENV);
const child = spawn(process.env.SPIKE_OPENCODE, ['acp', '--cwd', cwd], { env: childEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
child.stderr.on('data', (d) => log('stderr', d.toString()));
child.on('exit', (code, sig) => log('exit', { code, sig }));

let nextId = 1;
const pending = new Map();
const send = (msg) => { log('send', msg); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); };
const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ id, method, params }); });

function decide(params) {
  const raw = JSON.stringify(params.toolCall ?? {});
  const isOurs = /workspace_(read_file|list_files|submit_review)/.test(raw);
  const allow = policy === 'allow-all' || (policy === 'ensemble' && isOurs);
  const opt = params.options.find((o) => o.kind === (allow ? 'allow_once' : 'reject_once')) ?? params.options.find((o) => o.kind.startsWith(allow ? 'allow' : 'reject'));
  log('permission_decision', { allow, chosen: opt?.optionId });
  return opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } };
}

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { log('stdout_text', line); return; }
  log('recv', msg);
  if (msg.id !== undefined && msg.method === undefined) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p?.reject(msg.error) : p?.resolve(msg.result);
  } else if (msg.id !== undefined && msg.method) {
    // a request FROM the agent
    if (msg.method === 'session/request_permission') send({ id: msg.id, result: decide(msg.params) });
    else send({ id: msg.id, error: { code: -32601, message: `refused: ${msg.method}` } });
  }
});

const stopAll = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
process.on('exit', stopAll);
const timer = setTimeout(() => { log('timeout', {}); stopAll(); process.exit(3); }, Number(process.env.SPIKE_TIMEOUT_MS ?? 180000));

try {
  const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const env = Object.entries({ SPIKE_ROOT: cwd, SPIKE_RESULT_FILE: process.env.SPIKE_RESULT_FILE, SPIKE_MCP_LOG: process.env.SPIKE_MCP_LOG }).map(([name, value]) => ({ name, value }));
  const sess = await request('session/new', { cwd, mcpServers: [{ name: 'workspace', command: process.execPath, args: [path.join(import.meta.dirname, 'mcp-server.mjs')], env }] });
  if (promptArg && promptArg !== '-') {
    const text = fs.readFileSync(promptArg, 'utf8');
    const res = await request('session/prompt', { sessionId: sess.sessionId, prompt: [{ type: 'text', text }] });
    log('prompt_done', res);
  }
  if (process.env.SPIKE_IDLE_MS) await new Promise((r) => setTimeout(r, Number(process.env.SPIKE_IDLE_MS)));
} catch (e) {
  log('error', e);
}
clearTimeout(timer);
stopAll();
setTimeout(() => process.exit(0), 300);
