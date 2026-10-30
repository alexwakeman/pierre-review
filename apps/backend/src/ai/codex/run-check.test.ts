// CODEX'S `run_check` (coding/checks/): the workspace MCP server offers it only with a frozen spec,
// runs only frozen names, and the path-guard hook lets it through only on a run that carries checks.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckToolRunner, type CheckSpec } from '../../coding/checks/spec.js';
import { mcpConfig } from './config.js';
import { decideCodexToolCall, decodeGuardRoots, encodeGuardRoots, RUN_CHECK_TOOL_NAME } from './hook-rule.js';
import { createWorkspaceTools } from './workspace-files.js';
import { handleMessage, parseServerArgv, toolDefs, workspaceMcpConfig } from './workspace-mcp.js';

const root = mkdtempSync(join(tmpdir(), 'limn-runcheck-'));
const spec: CheckSpec = {
  version: 1,
  maxCalls: 3,
  log: null,
  checks: [{ name: 'test', kind: 'test', display: 'pnpm run test', command: process.execPath, args: ['-e', 'console.log("all good")'], cwd: root, env: {}, timeoutMs: 20_000, outputCap: 2000 }],
};

describe('the workspace MCP server and run_check', () => {
  it('lists run_check only when the run carries checks, with the names as an enum', () => {
    expect((toolDefs(null) as Array<{ name: string }>).map((t) => t.name)).not.toContain('run_check');
    const defs = toolDefs(new CheckToolRunner(spec)) as Array<{ name: string; inputSchema: { properties: { name: { enum: string[] } } } }>;
    const rc = defs.find((d) => d.name === 'run_check')!;
    expect(rc.inputSchema.properties.name.enum).toEqual(['test']);
  });

  it('answers a run_check call asynchronously with the check’s output; an unknown name is an error', async () => {
    const tools = createWorkspaceTools([root]);
    const runner = new CheckToolRunner(spec);
    const ok = await handleMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_check', arguments: { name: 'test' } } }, () => {}, runner);
    expect(JSON.stringify(ok)).toContain('all good');
    const bad = await handleMessage(tools, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run_check', arguments: { name: 'sh -c id' } } }, () => {}, runner);
    expect(bad?.result).toMatchObject({ isError: true });
  });

  it('without a spec, run_check is just an unknown tool', () => {
    const tools = createWorkspaceTools([root]);
    const r = handleMessage(tools, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_check', arguments: { name: 'test' } } }, () => {});
    expect(r?.result).toMatchObject({ isError: true });
  });

  it('the server is told the spec file by argv, and Codex a longer tool timeout', () => {
    const file = join(root, 'checks.json');
    writeFileSync(file, JSON.stringify(spec));
    const cfg = workspaceMcpConfig({ read: [root], write: [root] }, { checks: { specFile: file, timeoutSec: 600 } });
    expect(parseServerArgv(cfg.args.slice(cfg.args.indexOf('--read'))).checksSpec).toBe(file);
    expect(cfg.tool_timeout_sec).toBe(630);
    expect(mcpConfig(cfg)).toContain('mcp_servers.workspace.tool_timeout_sec=630');
    expect(workspaceMcpConfig({ read: [root], write: [] }).tool_timeout_sec).toBeUndefined();
  });
});

describe('the path-guard hook and run_check', () => {
  const roots = { read: [root], write: [root] };
  it('denies run_check on a run without checks', () => {
    expect(decideCodexToolCall(RUN_CHECK_TOOL_NAME, { name: 'test' }, roots, root).allow).toBe(false);
  });
  it('allows a plain name on a run with checks, and nothing else', () => {
    const withChecks = { ...roots, checks: true };
    expect(decideCodexToolCall(RUN_CHECK_TOOL_NAME, { name: 'test' }, withChecks, root).allow).toBe(true);
    expect(decideCodexToolCall(RUN_CHECK_TOOL_NAME, { name: ['test'] }, withChecks, root).allow).toBe(false);
    expect(decideCodexToolCall(RUN_CHECK_TOOL_NAME, {}, withChecks, root).allow).toBe(false);
    // The flag lets run_check through, never a shell.
    expect(decideCodexToolCall('shell', { command: ['pnpm', 'test'] }, withChecks, root).allow).toBe(false);
  });
  it('the flag survives the trip to the hook process, and only as `true`', () => {
    expect(decodeGuardRoots(encodeGuardRoots({ ...roots, checks: true }))).toEqual({ ...roots, checks: true });
    expect(decodeGuardRoots(encodeGuardRoots(roots))).toEqual(roots);
    expect(decodeGuardRoots(JSON.stringify({ ...roots, checks: 'yes' }))).toEqual(roots);
  });
});
