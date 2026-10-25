// THE CODEX PROCESS (ai/codex/run.ts), against FAKE `codex` binaries (small node scripts written per
// test) — no real CLI, no network, no quota. What is pinned:
//   • the prompt goes in on stdin and every event reaches onEvent in order, a trailing line too;
//   • an abort sends SIGTERM and reports `cancelled` with NULL usage, even though the CLI exits 0 and
//     even when a turn had already reported (a cancelled run's tokens are unknown);
//   • the timeout does the same as `timedOut`; a child that ignores SIGTERM gets SIGKILL;
//   • a non-zero exit RESOLVES with its stderr (the caller decides), a missing binary REJECTS.
//
//   pnpm --filter @pierre-review/backend test ai/codex/run
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodexEvent } from './events.js';
import { runCodexExec } from './run.js';

const dir = mkdtempSync(join(tmpdir(), 'limn-codex-run-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
/** A fake codex: `body` is the script after the shebang. */
function fake(body: string): string {
  const p = join(dir, `codex-${++n}.mjs`);
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const env = { PATH: process.env.PATH ?? '' };
const line = (o: unknown): string => JSON.stringify(o);

const WAIT_FOREVER = `
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 't-1' });
out({ type: 'turn.started' });
setInterval(() => {}, 1000);
`;

describe('runCodexExec', () => {
  it('writes the prompt to stdin, streams every event in order, and resolves with the answer', async () => {
    const stdinFile = join(dir, 'stdin.txt');
    const argvFile = join(dir, 'argv.json');
    const bin = fake(`
import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(stdinFile)}, readFileSync(0, 'utf8'));
process.stderr.write('Reading prompt from stdin...\\n');
const lines = [
  ${JSON.stringify(line({ type: 'thread.started', thread_id: 'th-9' }))},
  ${JSON.stringify(line({ type: 'turn.started' }))},
  'not json at all',
  ${JSON.stringify(line({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'first' } }))},
  ${JSON.stringify(line({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"ok":true}' } }))},
];
process.stdout.write(lines.join('\\n') + '\\n');
// The last line arrives WITHOUT a newline.
process.stdout.write(${JSON.stringify(line({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1 } }))});
`);
    const seen: CodexEvent[] = [];
    const res = await runCodexExec(['exec', '--json', '-'], { cwd: dir, env, binary: bin, stdin: 'THE PROMPT ✓', onEvent: (e) => seen.push(e) });
    expect(readFileSync(stdinFile, 'utf8')).toBe('THE PROMPT ✓');
    expect(JSON.parse(readFileSync(argvFile, 'utf8'))).toEqual(['exec', '--json', '-']);
    expect(seen.map((e) => e.type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'item.completed', 'turn.completed']);
    expect(res.events).toEqual(seen);
    expect(res).toMatchObject({
      threadId: 'th-9',
      finalResponse: '{"ok":true}',
      usage: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningOutputTokens: 1 },
      exitCode: 0,
      cancelled: false,
      timedOut: false,
    });
    expect(res.stderr).toContain('Reading prompt from stdin');
  });

  it('an abort sends SIGTERM; the CLI exits 0, yet the run is CANCELLED with null usage', async () => {
    const bin = fake(`
process.on('SIGTERM', () => process.exit(0));
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ type: 'thread.started', thread_id: 't-1' });
// A turn that already reported — the run is still cancelled, so its tokens are unknown.
out({ type: 'turn.completed', usage: { input_tokens: 5, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
setInterval(() => {}, 1000);
`);
    const ac = new AbortController();
    const res = await runCodexExec(['exec'], {
      cwd: dir,
      env,
      binary: bin,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'turn.completed') ac.abort();
      },
    });
    expect(res.cancelled).toBe(true);
    expect(res.exitCode).toBe(0);
    expect(res.usage).toBeNull();
  });

  it('an already-aborted signal never starts the child', async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: '/nonexistent/codex', signal: ac.signal });
    expect(res).toMatchObject({ cancelled: true, usage: null, events: [], exitCode: null });
  });

  it('the timeout stops the run and says so', async () => {
    const bin = fake(`process.on('SIGTERM', () => process.exit(0));\n${WAIT_FOREVER}`);
    // Long enough for node to start and print (a SIGTERM before the handler exists kills it outright).
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: bin, timeoutMs: 1500 });
    expect(res.timedOut).toBe(true);
    expect(res.cancelled).toBe(false);
    expect(res.usage).toBeNull();
    // (No assertion on the events: under a loaded machine node may not have printed by the deadline.)
  });

  it('a child that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const bin = fake(`process.on('SIGTERM', () => {});\n${WAIT_FOREVER}`);
    // Abort only once the child has printed, i.e. once its SIGTERM handler is in place.
    const ac = new AbortController();
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: bin, signal: ac.signal, killGraceMs: 200, onEvent: () => ac.abort() });
    expect(res.cancelled).toBe(true);
    expect(res.signal).toBe('SIGKILL');
  });

  // A grandchild (stands in for the MCP server / hook) that IGNORES SIGTERM, writes its pid, and lives.
  const withGrandchild = (pidFile: string, tail: string): string => `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const g = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
${tail}
`;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const gone = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };

  it.skipIf(process.platform === 'win32')('a cancel ends the WHOLE process group, not just the CLI (the MCP server, the hook)', async () => {
    const pidFile = join(dir, 'grandchild-cancel.pid');
    const bin = fake(withGrandchild(pidFile, `process.on('SIGTERM', () => process.exit(0));\n${WAIT_FOREVER}`));
    const ac = new AbortController();
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: bin, signal: ac.signal, killGraceMs: 200, onEvent: () => ac.abort() });
    expect(res.cancelled).toBe(true);
    const gpid = Number(readFileSync(pidFile, 'utf8'));
    expect(await gone(gpid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('a CLI that exits on its own leaves no straggler in its group', async () => {
    const pidFile = join(dir, 'grandchild-exit.pid');
    const bin = fake(withGrandchild(pidFile, `process.stdout.write(${JSON.stringify(line({ type: 'turn.started' }))} + '\\n'); process.exit(0);`));
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: bin, killGraceMs: 200 });
    expect(res.exitCode).toBe(0);
    const gpid = Number(readFileSync(pidFile, 'utf8'));
    expect(await gone(gpid)).toBe(true);
  });

  it('a non-zero exit RESOLVES with its stderr (refusals appear only there)', async () => {
    const bin = fake(`process.stderr.write('Error loading config.toml: unknown configuration field \`x\`\\n'); process.exit(1);`);
    const res = await runCodexExec(['exec'], { cwd: dir, env, binary: bin });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('unknown configuration field');
    expect(res.usage).toBeNull();
  });

  it('a binary that cannot start REJECTS with a plain sentence', async () => {
    await expect(runCodexExec(['exec'], { cwd: dir, env, binary: join(dir, 'missing-codex') })).rejects.toThrow(
      /Could not start Codex \(ENOENT\)/,
    );
  });

  it('a throwing onEvent is logged, never fatal', async () => {
    const bin = fake(`process.stdout.write(${JSON.stringify(line({ type: 'turn.started' }))} + '\\n');`);
    const res = await runCodexExec(['exec'], {
      cwd: dir,
      env,
      binary: bin,
      onEvent: () => {
        throw new Error('boom');
      },
    });
    expect(res.exitCode).toBe(0);
    expect(res.events).toHaveLength(1);
  });
});
