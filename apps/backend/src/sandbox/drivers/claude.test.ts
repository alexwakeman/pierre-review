// The Claude driver over the FAKE runtime, replaying the recorded spike-1 stream turn by turn: each
// stdin line the driver writes releases the next recorded segment of stdout.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxAgentEvent } from '@pierre-review/shared';
import { createFakeRuntime, type FakeExecContext } from '../runtime/fake.js';
import { CLAUDE_SANDBOX_DISALLOWED_TOOLS, claudeSandboxArgv, startClaudeDriver } from './claude.js';
import { SandboxAgentBusyError, SandboxAgentExitedError, type SandboxUsageRow } from './types.js';

const OUT = readFileSync(fileURLToPath(new URL('./__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8').split('\n').filter(Boolean);
const IN = readFileSync(fileURLToPath(new URL('./__fixtures__/claude-interactive.in.jsonl', import.meta.url)), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { type: string; request?: { subtype: string } });

/** stdin line kind → the recorded stdout segment it releases (line ranges of the fixture). */
const SCRIPT: Array<{ wait: string; lines: [number, number] }> = [
  { wait: 'initialize', lines: [0, 0] },
  { wait: 'user', lines: [1, 11] },
  { wait: 'user', lines: [12, 45] },
  { wait: 'set_permission_mode', lines: [46, 47] },
  { wait: 'user', lines: [48, 79] },
  { wait: 'user', lines: [80, 84] },
  { wait: 'interrupt', lines: [85, 91] },
  { wait: 'user', lines: [92, 101] },
];

const kindOf = (m: { type: string; request?: { subtype: string } }): string => (m.type === 'control_request' ? m.request!.subtype : m.type);

function replay(sent: unknown[]) {
  return async (ctx: FakeExecContext): Promise<number> => {
    let step = 0;
    for await (const line of ctx.stdin) {
      const msg = JSON.parse(line) as { type: string; request?: { subtype: string } };
      sent.push(msg);
      const s = SCRIPT[step];
      if (!s) continue;
      expect(kindOf(msg)).toBe(s.wait);
      step++;
      for (let i = s.lines[0]; i <= s.lines[1]; i++) ctx.stdout(`${OUT[i]}\n`);
    }
    return 0;
  };
}

function setup() {
  const fake = createFakeRuntime();
  const sent: unknown[] = [];
  fake.onExec((argv) => argv[0] === 'claude', replay(sent));
  const events: SandboxAgentEvent[] = [];
  const rows: SandboxUsageRow[] = [];
  const rateLimits: unknown[] = [];
  let refreshed = 0;
  const opts = {
    runtime: fake,
    container: 'limn-s1-sandbox',
    cwd: '/Users/alex/Projects/home',
    choice: { provider: 'claude' as const, model: 'claude-sonnet-5', effort: 'low' as const },
    env: { ANTHROPIC_BASE_URL: 'http://limn-proxy:8081', CLAUDE_CODE_OAUTH_TOKEN: 'limn-placeholder-x' },
    systemPromptFile: '/home/agent/.limn/seed.md',
    addDirs: ['/Users/alex/Projects/other'],
    usage: { accountId: 1, repoId: 7 },
    usageSink: { record: async (r: SandboxUsageRow) => void rows.push(r), noteClaudeRateLimit: (m: unknown) => void rateLimits.push(m) },
    beforeTurn: async () => void refreshed++,
    onEvent: (e: SandboxAgentEvent) => void events.push(e),
  };
  return { fake, sent, events, rows, rateLimits, opts, refreshed: () => refreshed };
}

describe('the Claude driver', () => {
  it('runs the recorded session: two chat turns, Start build, a build turn, Stop, another turn', async () => {
    const t = setup();
    const d = await startClaudeDriver(t.opts);
    expect(d.mode()).toBe('chat');

    const r1 = await d.send('Reply with the single word: alpha.');
    expect(r1).toMatchObject({ turn: 1, mode: 'chat', outcome: 'completed', text: 'alpha.' });
    const r2 = await d.send('touch it, then the word');
    expect(r2.text).toMatch(/alpha/);
    expect(d.agentRef()).toBe('d0a2cbdd-4919-4138-839b-d590bed54988');

    await d.startBuild();
    expect(d.mode()).toBe('build');
    const r3 = await d.send('echo built > /work/built.txt');
    expect(r3).toMatchObject({ turn: 3, mode: 'build', outcome: 'completed', text: 'done.' });

    // Stop at the first partial text of turn 4.
    const p4 = d.send('count to 300');
    for (let i = 0; i < 50 && !t.events.some((e) => e.type === 'text' && e.partial && e.text.startsWith('1')); i++) await new Promise((r) => setTimeout(r, 5));
    await d.interrupt();
    const r4 = await p4;
    expect(r4).toMatchObject({ turn: 4, outcome: 'interrupted' });
    const r5 = await d.send('still here?');
    expect(r5).toMatchObject({ turn: 5, outcome: 'completed', text: 'still-here.' });

    // What went in is what the spike sent, in order (the driver's request ids match the recording).
    expect(t.sent.map((m) => kindOf(m as never))).toEqual(IN.map(kindOf));
    expect(t.sent.filter((m) => (m as { type: string }).type === 'control_request')).toEqual(IN.filter((m) => m.type === 'control_request'));

    // Usage: one ledger row per turn that cost something, chat → story_plan, build → story_build.
    expect(t.rows.map((r) => [r.feature, r.costUsd])).toEqual([
      ['story_plan', 0.101772],
      ['story_plan', 0.025135],
      ['story_build', 0.012746],
      ['story_build', 0.005491],
    ]);
    expect(t.rows[0]).toMatchObject({ accountId: 1, repoId: 7, provider: 'claude', model: 'claude-sonnet-5', inputTokens: 2, outputTokens: 6 });
    expect(t.rateLimits.length).toBe(1);
    expect(t.refreshed()).toBe(5);

    // The UI's stream: turn_end events carry the provider and the turn's usage; status follows the mode.
    const ends = t.events.filter((e): e is Extract<SandboxAgentEvent, { type: 'turn_end' }> => e.type === 'turn_end');
    expect(ends.map((e) => [e.turn, e.mode, e.outcome, e.provider])).toEqual([
      [1, 'chat', 'completed', 'claude'],
      [2, 'chat', 'completed', 'claude'],
      [3, 'build', 'completed', 'claude'],
      [4, 'build', 'interrupted', 'claude'],
      [5, 'build', 'completed', 'claude'],
    ]);
    expect(t.events[0]).toEqual({ type: 'status', state: 'starting', mode: 'chat', detail: null });
    expect(t.events.some((e) => e.type === 'error')).toBe(false);

    await d.close();
    await d.exited;
    expect(t.events.at(-1)).toEqual({ type: 'status', state: 'stopped', mode: 'build', detail: null });
  });

  it('starts claude with the run choice, plan mode, no MCP, no session files, and the seed file', async () => {
    const t = setup();
    const d = await startClaudeDriver(t.opts);
    const exec = t.fake.calls.find((c) => c.method === 'exec')!;
    const [container, argv, opts] = exec.args as [string, string[], { cwd: string; env: Record<string, string>; interactive: boolean }];
    expect(container).toBe('limn-s1-sandbox');
    expect(opts).toMatchObject({ cwd: '/Users/alex/Projects/home', interactive: true, env: t.opts.env });
    expect(argv).toEqual(claudeSandboxArgv(t.opts));
    const flag = (f: string) => argv[argv.indexOf(f) + 1];
    expect(flag('--permission-mode')).toBe('plan');
    expect(argv).toContain('--allow-dangerously-skip-permissions');
    expect(flag('--model')).toBe('claude-sonnet-5');
    expect(flag('--effort')).toBe('low');
    expect(flag('--setting-sources')).toBe('user,project');
    expect(flag('--append-system-prompt-file')).toBe('/home/agent/.limn/seed.md');
    expect(flag('--add-dir')).toBe('/Users/alex/Projects/other');
    expect(flag('--disallowedTools')!.split(',')).toEqual([...CLAUDE_SANDBOX_DISALLOWED_TOOLS]);
    expect(argv).toEqual(expect.arrayContaining(['--strict-mcp-config', '--no-session-persistence']));
    expect(argv).not.toContain('--mcp-config');
    // No secret in the argv or the env: only the placeholder the egress session made.
    expect(JSON.stringify(exec.args)).not.toMatch(/sk-ant-|oat01/);
    await d.close();
  });

  it('a build session starts in bypassPermissions; text instead of a file uses --append-system-prompt', () => {
    const argv = claudeSandboxArgv({ choice: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, mode: 'build', systemPrompt: 'Seed.' });
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe('Seed.');
    expect(argv).not.toContain('--append-system-prompt-file');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('80');
    expect(argv).not.toContain('--max-budget-usd');
  });

  it('an unattended fix passes the process-wide US$ cap; a zero or missing cap passes none', () => {
    const choice = { provider: 'claude' as const, model: 'claude-sonnet-5', effort: 'medium' as const };
    const argv = claudeSandboxArgv({ choice, mode: 'build', maxTurns: 40, maxBudgetUsd: 5 });
    expect(argv[argv.indexOf('--max-budget-usd') + 1]).toBe('5');
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe('40');
    expect(claudeSandboxArgv({ choice, mode: 'build', maxBudgetUsd: 0 })).not.toContain('--max-budget-usd');
  });

  it('refuses a second message while a turn runs', async () => {
    const t = setup();
    const d = await startClaudeDriver(t.opts);
    const first = d.send('one');
    await expect(d.send('two')).rejects.toBeInstanceOf(SandboxAgentBusyError);
    await first;
    await d.close();
  });

  it('the agent process ending mid-turn fails the turn and says so', async () => {
    const fake = createFakeRuntime();
    fake.onExec((argv) => argv[0] === 'claude', async (ctx) => {
      for await (const line of ctx.stdin) {
        const m = JSON.parse(line) as { type: string };
        if (m.type === 'control_request') ctx.stdout(`${OUT[0]}\n`);
        else {
          ctx.stderr('Error: something broke\n');
          return 1;
        }
      }
      return 0;
    });
    const events: SandboxAgentEvent[] = [];
    const d = await startClaudeDriver({
      runtime: fake,
      container: 'c',
      cwd: '/w',
      choice: { provider: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
      env: {},
      usage: { accountId: 1 },
      usageSink: { record: async () => {} },
      onEvent: (e) => void events.push(e),
    });
    await expect(d.send('hi')).rejects.toBeInstanceOf(SandboxAgentExitedError);
    expect(events).toContainEqual({ type: 'error', code: 'agent_exited', message: 'The agent stopped: Error: something broke' });
    await expect(d.send('again')).rejects.toBeInstanceOf(SandboxAgentExitedError);
  });

  it('refuses a non-Claude choice', async () => {
    const t = setup();
    await expect(startClaudeDriver({ ...t.opts, choice: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } })).rejects.toThrow(/Claude only/);
  });
});
