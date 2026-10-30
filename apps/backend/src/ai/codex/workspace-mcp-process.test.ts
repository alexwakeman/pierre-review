// THE WORKSPACE MCP SERVER AS A PROCESS (the dev entry under tsx), over stdio. Split from
// workspace-mcp.test.ts so the in-process cases stay in the `fast` project: starting the server is a
// node + tsx spawn, seconds inside a vitest worker on macOS (vitest.workspace.ts SLOW_TESTS).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceMcpConfig } from './workspace-mcp.js';

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
