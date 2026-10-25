// SPECIALISTS ON CODEX (ai/codex/specialists.ts; docs/CODEX-PLAN.md § 3.5), with the run door faked.
// What this pins:
//   1. THE CAP and the catalogue: at most `cap` run, a name outside `offered` or a repeat is refused,
//      each with a sentence (the cap's is the dispatch guard's own);
//   2. every run is READ-ONLY (no write root), names its one result tool, carries the instructions as
//      its system prompt, and gets an even share of the US$ budget;
//   3. they run IN PARALLEL, and their answers come back in the order given — the checked answer, or
//      why there is none (a failure does not stop the others; a cancel is reported as one);
//   4. THE BUDGET: `allowStart` is asked before each start, and once the finished runs' US$ reach
//      the batch's budget no further specialist starts.
//
//   pnpm --filter @pierre-review/backend test ai/codex/specialists
import { describe, expect, it } from 'vitest';
import type { AgentRunResult, AgentRunSpec } from '../provider.js';
import { capRefusal, planSpecialists, runCodexSpecialists, SPECIALIST_RESULT_TOOL, type CodexSpecialistSpec } from './specialists.js';

const spec = (name: string, over: Partial<CodexSpecialistSpec> = {}): CodexSpecialistSpec => ({
  name,
  instructions: `You are the ${name} specialist.`,
  prompt: `Check ${name}.`,
  shape: { items: {} },
  ...over,
});

const outcome = (costUsd: number) => ({ subtype: 'success', text: '{}', costUsd, numTurns: null, usage: null });

/** A fake door: answers through the spec's own result tool, after `delayMs`. */
function fakeDoor(opts: { delayMs?: number; costUsd?: number; fail?: string[]; answer?: (name: string) => unknown } = {}) {
  const calls: AgentRunSpec[] = [];
  let live = 0;
  let maxLive = 0;
  const run = async (s: AgentRunSpec): Promise<AgentRunResult> => {
    calls.push(s);
    live += 1;
    maxLive = Math.max(maxLive, live);
    await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
    live -= 1;
    const name = String(s.system).replace(/^You are the (.*) specialist\.$/, '$1');
    if (opts.fail?.includes(name)) throw new Error(`${name} broke`);
    const tool = s.tools!.tools[0]!;
    const reply = await tool.handle(opts.answer ? opts.answer(name) : { items: [name] });
    if (reply.isError) throw new Error(`answer refused: ${reply.text}`);
    const o = outcome(opts.costUsd ?? 0);
    s.onProgress?.({ kind: 'outcome', outcome: o });
    return { outcome: o, provider: 'codex' };
  };
  return { run, calls, maxLive: () => maxLive };
}

const base = { model: { role: 'deep' as const }, cwd: '/w', budget: { usd: 3, turns: 12 } };

describe('planSpecialists', () => {
  it('runs at most the cap, catalogue names only, each once', () => {
    const p = planSpecialists([spec('security'), spec('bogus'), spec('security'), spec('tests'), spec('design')], ['security', 'tests', 'design'], 2);
    expect(p.run.map((s) => s.name)).toEqual(['security', 'tests']);
    expect(p.refused).toEqual([
      { name: 'bogus', reason: 'Only these specialists can be consulted: security, tests, design.' },
      { name: 'security', reason: 'This specialist was already consulted for this review.' },
      { name: 'design', reason: capRefusal(2) },
    ]);
  });
});

describe('runCodexSpecialists', () => {
  it('runs them read-only, in parallel, and returns the answers in order', async () => {
    const door = fakeDoor({ delayMs: 20 });
    const res = await runCodexSpecialists({
      ...base,
      specialists: [spec('security'), spec('tests'), spec('perf'), spec('design')],
      cap: 3,
      abortController: new AbortController(),
      usageRecord: { accountId: 1, seam: 'agent', feature: 'claude_review', prId: 9 },
      run: door.run,
    });
    expect(res.answers.map((a) => [a.name, a.status, a.answer])).toEqual([
      ['security', 'answered', { items: ['security'] }],
      ['tests', 'answered', { items: ['tests'] }],
      ['perf', 'answered', { items: ['perf'] }],
    ]);
    expect(res.refused).toEqual([{ name: 'design', reason: capRefusal(3) }]);
    expect(door.maxLive()).toBe(3);
    for (const c of door.calls) {
      expect(c.writeRoots).toEqual([]);
      expect(c.kind).toBe('review');
      expect(c.codex?.resultTool).toBe(SPECIALIST_RESULT_TOOL);
      expect(c.tools?.tools.map((t) => t.name)).toEqual([SPECIALIST_RESULT_TOOL]);
      expect(c.budget).toEqual({ usd: 1, turns: 12 });
      expect(c.usageRecord?.feature).toMatch(/^claude_review:(security|tests|perf)$/);
    }
    expect(door.calls[0]!.system).toBe('You are the security specialist.');
    expect(door.calls[0]!.prompt).toBe('Check security.');
  });

  it('a failure does not stop the others; a validation refusal is the run’s to retry', async () => {
    const door = fakeDoor({ fail: ['tests'], answer: (n) => ({ items: n === 'perf' ? 'bad' : [n] }) });
    const res = await runCodexSpecialists({
      ...base,
      specialists: [
        spec('security'),
        spec('tests'),
        spec('perf', { validate: (a) => (Array.isArray((a as { items: unknown }).items) ? null : 'items must be a list') }),
      ],
      abortController: new AbortController(),
      run: door.run,
    });
    expect(res.answers.map((a) => [a.name, a.status, a.error])).toEqual([
      ['security', 'answered', null],
      ['tests', 'failed', 'tests broke'],
      ['perf', 'failed', 'answer refused: items must be a list'],
    ]);
  });

  it('asks the budget gate before each start, and stops starting once the US$ budget is spent', async () => {
    const asked: string[] = [];
    const door = fakeDoor({ costUsd: 2 });
    const res = await runCodexSpecialists({
      ...base,
      specialists: [spec('security'), spec('tests'), spec('perf')],
      concurrency: 1,
      abortController: new AbortController(),
      allowStart: (n) => {
        asked.push(n);
        return n !== 'tests';
      },
      run: door.run,
    });
    expect(res.answers.map((a) => [a.name, a.status])).toEqual([
      ['security', 'answered'],
      ['tests', 'skipped'],
      // security spent 2 of 3: perf still starts; it spends 2 more.
      ['perf', 'answered'],
    ]);
    expect(asked).toEqual(['security', 'tests', 'perf']);
    expect(res.costUsd).toBe(4);

    const door2 = fakeDoor({ costUsd: 3 });
    const res2 = await runCodexSpecialists({
      ...base,
      specialists: [spec('security'), spec('tests')],
      concurrency: 1,
      abortController: new AbortController(),
      run: door2.run,
    });
    expect(res2.answers.map((a) => [a.name, a.status, a.error])).toEqual([
      ['security', 'answered', null],
      ['tests', 'skipped', 'The review’s budget is spent.'],
    ]);
    expect(door2.calls).toHaveLength(1);
  });

  it('a cancelled review starts nothing more and says so', async () => {
    const ac = new AbortController();
    ac.abort();
    const door = fakeDoor();
    const res = await runCodexSpecialists({ ...base, specialists: [spec('security')], abortController: ac, run: door.run });
    expect(res.answers).toEqual([
      { name: 'security', status: 'cancelled', answer: null, error: 'The review was cancelled.', outcome: null },
    ]);
    expect(door.calls).toHaveLength(0);
  });

  it('nothing to run is an empty answer, never a hang', async () => {
    const res = await runCodexSpecialists({ ...base, specialists: [], abortController: new AbortController(), run: fakeDoor().run });
    expect(res).toEqual({ answers: [], refused: [], costUsd: 0 });
  });
});
