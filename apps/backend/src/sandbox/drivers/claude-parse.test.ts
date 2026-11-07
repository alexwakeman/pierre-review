// The Claude stream fold over the RECORDED spike-1 stream (__fixtures__/claude-interactive.out.jsonl:
// 5 turns — two chat turns in plan mode, the switch to bypassPermissions, a build turn that ran Bash, an
// interrupted turn, and one after it).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SandboxAgentEvent } from '@pierre-review/shared';
import { ClaudeStreamFold, cumulativeTokens, type ClaudeFoldOutput } from './claude-parse.js';

const lines = readFileSync(fileURLToPath(new URL('./__fixtures__/claude-interactive.out.jsonl', import.meta.url)), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as unknown);

function foldAll(): { fold: ClaudeStreamFold; outs: ClaudeFoldOutput[]; events: SandboxAgentEvent[] } {
  const fold = new ClaudeStreamFold();
  const outs = lines.map((l) => fold.feed(l));
  return { fold, outs, events: outs.flatMap((o) => o.events) };
}

describe('ClaudeStreamFold over the recorded stream', () => {
  it('ends five turns with the right outcomes', () => {
    const ends = foldAll().outs.flatMap((o) => (o.turnEnd ? [o.turnEnd] : []));
    expect(ends.map((e) => e.outcome)).toEqual(['completed', 'completed', 'completed', 'interrupted', 'completed']);
    expect(ends.map((e) => e.text)).toEqual([
      'alpha.',
      expect.stringContaining('The word I replied with was: alpha.'),
      'done.',
      '1\n2\n3\n4',
      'still-here.',
    ]);
    expect(ends.every((e) => e.error === null)).toBe(true);
  });

  it("records THIS turn's cost: the difference of the process's running total", () => {
    const ends = foldAll().outs.flatMap((o) => (o.turnEnd ? [o.turnEnd] : []));
    expect(ends.map((e) => e.usage?.costUsd)).toEqual([0.101772, 0.025135, 0.012746, 0, 0.005491]);
    // The interrupted turn added nothing; tokens are differences too.
    expect(ends[3]!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    expect(ends[0]!.usage).toEqual({ inputTokens: 2, outputTokens: 6, cacheReadTokens: 0, cacheCreationTokens: 25427, costUsd: 0.101772 });
    expect(ends[4]!.usage).toMatchObject({ inputTokens: 2, outputTokens: 6, cacheReadTokens: 25954, cacheCreationTokens: 59 });
  });

  it('tracks the session id and the permission mode the CLI states', () => {
    const fold = new ClaudeStreamFold();
    const modes: (string | null)[] = [];
    for (const l of lines) {
      const o = fold.feed(l);
      if (o.turnEnd) modes.push(fold.permissionMode);
    }
    expect(fold.sessionId).toBe('d0a2cbdd-4919-4138-839b-d590bed54988');
    expect(modes).toEqual(['plan', 'plan', 'bypassPermissions', 'bypassPermissions', 'bypassPermissions']);
  });

  it('streams partial text, then the whole message under the same id', () => {
    const { events } = foldAll();
    const texts = events.filter((e): e is Extract<SandboxAgentEvent, { type: 'text' }> => e.type === 'text');
    const finalAlpha = texts.find((t) => !t.partial && t.text === 'alpha.')!;
    const partials = texts.filter((t) => t.partial && t.messageId === finalAlpha.messageId);
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.map((p) => p.text).join('')).toBe('alpha.');
  });

  it('turns the Bash call and its output into a tool call and a result', () => {
    const { events } = foldAll();
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 'toolu_01TK5A4Sb8Bkvr7TKWHSSv7b', tool: 'Bash', summary: 'echo built > /work/built.txt' },
    ]);
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'toolu_01TK5A4Sb8Bkvr7TKWHSSv7b', ok: true, output: '(Bash completed with no output)' },
    ]);
  });

  it('hands over the control responses and the rate-limit event', () => {
    const { outs } = foldAll();
    expect(outs.flatMap((o) => (o.control ? [[o.control.requestId, o.control.ok]] : []))).toEqual([
      ['limn_1', true],
      ['limn_2', true],
      ['limn_3', true],
    ]);
    expect(outs.filter((o) => o.rateLimit).length).toBe(1);
  });

  it('a failed turn names the usage limit or the sign-in', () => {
    const fold = new ClaudeStreamFold();
    const limit = fold.feed({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit · resets 9pm", total_cost_usd: 0 }).turnEnd!;
    expect(limit).toMatchObject({ outcome: 'failed', error: { code: 'usage_limit' } });
    const auth = fold.feed({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login' }).turnEnd!;
    expect(auth).toMatchObject({ outcome: 'failed', error: { code: 'auth' } });
    expect(fold.feed({ type: 'result', subtype: 'error_max_turns', is_error: true }).turnEnd!.outcome).toBe('max_turns');
    expect(fold.feed({ type: 'result', subtype: 'error_max_budget_usd', is_error: true }).turnEnd!.outcome).toBe('budget');
  });

  it('an interrupt the driver sent makes an aborted turn "interrupted" whatever its reason', () => {
    const fold = new ClaudeStreamFold();
    fold.interruptRequested = true;
    expect(fold.feed({ type: 'result', subtype: 'error_during_execution', is_error: true }).turnEnd).toMatchObject({ outcome: 'interrupted', error: null });
    // …and only that turn.
    expect(fold.feed({ type: 'result', subtype: 'error_during_execution', is_error: true }).turnEnd!.outcome).toBe('failed');
  });

  it('cumulativeTokens sums every model', () => {
    expect(cumulativeTokens({ modelUsage: { a: { inputTokens: 1, outputTokens: 2 }, b: { inputTokens: 3, cacheReadInputTokens: 4 } } })).toEqual({
      input: 4,
      output: 2,
      cacheRead: 4,
      cacheCreation: 0,
    });
    expect(cumulativeTokens({})).toBeNull();
  });
});
