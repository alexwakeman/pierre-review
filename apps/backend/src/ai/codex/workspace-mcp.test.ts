import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkspaceTools } from './workspace-files.js';
import { handleMessage, parseServerArgv, workspaceMcpConfig } from './workspace-mcp.js';

let dir: string;
let root: string;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'limn-wsmcp-')));
  root = join(dir, 'root');
  mkdirSync(root);
  mkdirSync(join(dir, 'outside'));
  writeFileSync(join(root, 'a.txt'), 'alpha\n');
  writeFileSync(join(dir, 'outside', 'secret.env'), 'S=1\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('workspaceMcpConfig', () => {
  it('is the mcp_servers.workspace entry Codex needs', () => {
    const cfg = workspaceMcpConfig({ read: [root, '/lib'], write: [root] });
    expect(cfg.id).toBe('workspace');
    expect(cfg.default_tools_approval_mode).toBe('approve');
    expect(cfg.command).toBe(process.execPath);
    // dev (this test runs the .ts): tsx's loader by absolute URL, then the .ts entry.
    expect(cfg.args[0]).toBe('--import');
    expect(cfg.args[1]).toMatch(/^file:\/\/.*tsx/);
    expect(cfg.args[2]).toMatch(/ai\/codex\/workspace-mcp-main\.ts$/);
    expect(cfg.args.slice(3)).toEqual(['--read', root, '--read', '/lib']);
    expect(workspaceMcpConfig({ read: [root], write: [] }, { logFile: '/tmp/x.log' }).args.slice(-2)).toEqual(['--log', '/tmp/x.log']);
    expect(() => workspaceMcpConfig({ read: [], write: [] })).toThrow(/read root/);
  });

  it('round-trips through the entry argv parser', () => {
    expect(parseServerArgv(['--read', '/a', '--read', '/b', '--log', '/l'])).toEqual({ read: ['/a', '/b'], logFile: '/l' });
    expect(() => parseServerArgv(['--write', '/a'])).toThrow(/unexpected argument/);
  });
});

describe('handleMessage', () => {
  const tools = () => createWorkspaceTools([root]);
  const log: object[] = [];
  it('speaks the MCP slice Codex uses', () => {
    const t = tools();
    const init = handleMessage(t, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, () => {});
    expect(init?.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'limn-workspace' } });
    expect(handleMessage(t, { jsonrpc: '2.0', method: 'notifications/initialized' }, () => {})).toBeNull();
    const list = handleMessage(t, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, () => {});
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((x) => x.name)).toEqual(['read_file', 'list_files', 'search']);
    expect(handleMessage(t, { jsonrpc: '2.0', id: 3, method: 'ping' }, () => {})?.result).toEqual({});
    expect(handleMessage(t, { jsonrpc: '2.0', id: 4, method: 'nope' }, () => {})?.error?.code).toBe(-32601);
    expect(handleMessage(t, 'x', () => {})?.error?.code).toBe(-32600);
  });

  it('answers a refusal as an isError result the agent reads, and logs it', () => {
    const r = handleMessage(
      tools(),
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../outside/secret.env' } } },
      (e) => log.push(e),
    );
    expect(r?.result).toEqual({ isError: true, content: [{ type: 'text', text: 'Refused: ../outside/secret.env is outside the workspace. Only files under the workspace can be read.' }] });
    expect(log.at(-1)).toMatchObject({ tool: 'read_file', ok: false });
  });
});

describe('the server process (dev entry under tsx)', () => {
  it('serves read_file and refuses an outside read over stdio', async () => {
    const logFile = join(dir, 'calls.log');
    const cfg = workspaceMcpConfig({ read: [root], write: [] }, { logFile });
    const child = spawn(cfg.command, cfg.args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map<number, { result?: unknown; error?: unknown }>();
    let buf = '';
    const waiters = new Map<number, () => void>();
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        replies.set(m.id, m);
        waiters.get(m.id)?.();
      }
    });
    const call = (id: number, method: string, params?: object) =>
      new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
        waiters.set(id, () => resolve(replies.get(id)!));
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      await call(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 't', version: '0' } });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const ok = await call(2, 'tools/call', { name: 'read_file', arguments: { path: 'a.txt' } });
      expect(ok.result).toEqual({ content: [{ type: 'text', text: '1\talpha' }] });
      const no = await call(3, 'tools/call', { name: 'read_file', arguments: { path: join(dir, 'outside', 'secret.env') } });
      expect(no.result).toMatchObject({ isError: true });
      const logged = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(logged.map((l) => [l.tool, l.ok])).toEqual([
        ['read_file', true],
        ['read_file', false],
      ]);
    } finally {
      child.kill('SIGTERM');
    }
  }, 30_000);
});
