// AI Fix's one-job-per-PR guard (manager.ts `startFix`): the claim is taken in the SAME tick as
// the `claimed.has` check, before any await — so a manual click and `maybeStartAutoFix` racing
// on one PR cannot both start a paid fix run.
//
//   pnpm --filter @pierre-review/backend test manager-claim
import { describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../../review/agent-context.js';

// The PR lookup is the first await after the guard; holding it open is what exposes the race.
let releasePr: () => void = () => {};
const prGate = new Promise<void>((r) => {
  releasePr = r;
});
const PR = { prId: 7, repoId: 3, owner: 'acme', name: 'app', number: 12 };

vi.mock('./pr-context.js', () => ({
  getFixPrContext: vi.fn(async (_ctx: unknown, _a: number, prId: number) => {
    await prGate;
    return prId === 404 ? null : PR;
  }),
}));

let nextFixId = 1;
vi.mock('./persist.js', () => ({
  insertQueuedFix: vi.fn(async () => nextFixId++),
  markFixCancelled: vi.fn(async () => {}),
  markFixFailed: vi.fn(async () => {}),
  markFixRunning: vi.fn(async () => {}),
  reconcileOrphanedFixes: vi.fn(async () => 0),
  saveFixSuccess: vi.fn(async () => {}),
}));

function fakeCtx(): AgentContext {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  return {
    log: { warn: vi.fn(), info: vi.fn() },
    llm: { detectAuth: () => ({ status: 'ok' }) },
    aiCredits: { check: async () => ({ agentBlocked: false }) },
    github: {
      fetchPrHeadInfo: vi.fn(async () => ({ headSha: 'h1' })),
      fetchPrDiff: vi.fn(async () => ''),
    },
    // Never settles: the first run holds the slot for the whole test.
    coding: { generateFix: vi.fn(() => new Promise(() => {})) },
  } as any as AgentContext;
}

describe('startFix — the per-PR claim', () => {
  it('two concurrent starts on one PR: exactly one queues, the other is already_running', async () => {
    const { startFix, isFixRunning } = await import('./manager.js');
    const ctx = fakeCtx();
    const input = { accountId: 1, prId: 7, model: 'm', seed: 'plain' as const, instruction: 'x' };
    const a = startFix(ctx, input);
    const b = startFix(ctx, { ...input, trigger: 'auto' as const });
    // Let both reach the PR lookup before it answers.
    await new Promise((r) => setTimeout(r, 0));
    releasePr();
    const results = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(results).toEqual(['already_running', 'queued']);
    expect(isFixRunning(7)).toBe(true);
  });

  it('an early return after the claim releases it (PR not found)', async () => {
    const { startFix, isFixRunning } = await import('./manager.js');
    const r = await startFix(fakeCtx(), {
      accountId: 1,
      prId: 404,
      model: 'm',
      seed: 'plain',
      instruction: 'x',
    });
    expect(r.status).toBe('not_found');
    expect(isFixRunning(404)).toBe(false);
  });
});
