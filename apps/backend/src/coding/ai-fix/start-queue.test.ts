// THE FIX START QUEUE (coding/ai-fix/start-queue.ts), pure: the line's order, one entry per PR, Cancel, and
// the pump — five PRs needing a fix at once with three build slots: three start, two wait, and each waiting
// one starts as a slot frees, people's presses first. A start that loses the race goes back to the front.
//
//   pnpm --filter @pierre-review/backend test ai-fix/start-queue
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetStartQueueForTest, bindStartQueue, cancelQueuedStart, enqueueStart, pumpStartQueue, startQueueLength, startWaitingFor } from './start-queue.js';

// An auto entry is decided again at its turn by THE AUTO FIX QUEUE (re-validated at the PR's current head).
const evaluated: number[] = [];
vi.mock('./auto-fix-queue.js', () => ({
  evaluateAutoFix: async (_c: unknown, a: { prId: number }) => {
    evaluated.push(a.prId);
    free -= 1;
    return { status: 'started' };
  },
}));

const settle = () => new Promise((r) => setTimeout(r, 0));
const drain = async () => {
  for (let i = 0; i < 20; i += 1) await settle();
};

let free = 0;
let ran: number[] = [];
const runner = (prId: number, answer: () => string = () => 'queued') => async () => {
  ran.push(prId);
  const status = answer();
  if (status === 'queued') free -= 1;
  return { status };
};

beforeEach(() => {
  _resetStartQueueForTest();
  free = 0;
  ran = [];
  bindStartQueue({ slotFree: () => free > 0 });
});

describe('the line', () => {
  it('people’s presses come first, each oldest first; one entry per PR', () => {
    enqueueStart({ accountId: 1, prId: 10, trigger: 'auto' }, 1);
    enqueueStart({ accountId: 1, prId: 11, trigger: 'manual', run: runner(11) }, 2);
    enqueueStart({ accountId: 1, prId: 12, trigger: 'auto' }, 3);
    enqueueStart({ accountId: 1, prId: 13, trigger: 'manual', run: runner(13) }, 4);
    expect([10, 11, 12, 13].map((p) => startWaitingFor(1, p)?.position)).toEqual([3, 1, 4, 2]);
    // A press replaces the PR's waiting auto fix and keeps its age; an auto fix never replaces a press.
    enqueueStart({ accountId: 1, prId: 10, trigger: 'manual', run: runner(10) }, 9);
    expect(startWaitingFor(1, 10)).toMatchObject({ position: 1, trigger: 'manual' });
    enqueueStart({ accountId: 1, prId: 11, trigger: 'auto' }, 10);
    expect(startWaitingFor(1, 11)?.trigger).toBe('manual');
    expect(startQueueLength()).toBe(4);
    // Another account never sees it.
    expect(startWaitingFor(2, 10)).toBeNull();
  });

  it('Cancel drops a waiting start; nothing else', () => {
    enqueueStart({ accountId: 1, prId: 20, trigger: 'manual', run: runner(20) });
    expect(cancelQueuedStart(2, 20)).toBe(false);
    expect(cancelQueuedStart(1, 20)).toBe(true);
    expect(cancelQueuedStart(1, 20)).toBe(false);
    expect(startQueueLength()).toBe(0);
  });
});

describe('the pump', () => {
  it('five PRs at once, three slots: three start, two wait, and each starts as a slot frees', async () => {
    free = 3;
    // The first three find a slot (their own start, outside the line); the rest wait.
    for (const p of [1, 2, 3]) await runner(p)();
    for (const p of [4, 5]) enqueueStart({ accountId: 1, prId: p, trigger: p === 5 ? 'manual' : 'auto', run: runner(p) });
    await drain();
    expect(ran).toEqual([1, 2, 3]);
    expect(startWaitingFor(1, 5)?.position).toBe(1);
    // A fix ends: the press (5) goes before the auto fix (4).
    free += 1;
    pumpStartQueue();
    await drain();
    expect(ran).toEqual([1, 2, 3, 5]);
    free += 1;
    pumpStartQueue();
    await drain();
    expect(ran).toEqual([1, 2, 3, 5, 4]);
    expect(startQueueLength()).toBe(0);
  });

  it('a start that loses the race for the slot goes back to the FRONT and waits for the next free slot', async () => {
    let lose = true;
    enqueueStart({ accountId: 1, prId: 30, trigger: 'manual', run: runner(30, () => (lose ? 'build_busy' : 'queued')) });
    enqueueStart({ accountId: 1, prId: 31, trigger: 'manual', run: runner(31) });
    free = 1;
    pumpStartQueue();
    await drain();
    expect(ran).toEqual([30]);
    expect(startWaitingFor(1, 30)?.position).toBe(1);
    lose = false;
    pumpStartQueue();
    await drain();
    expect(ran).toEqual([30, 30]);
    expect(startWaitingFor(1, 31)?.position).toBe(1);
  });

  it('a start that ends with nothing to do leaves the line and the next one goes', async () => {
    enqueueStart({ accountId: 1, prId: 40, trigger: 'manual', run: runner(40, () => 'nothing_to_fix') });
    enqueueStart({ accountId: 1, prId: 41, trigger: 'manual', run: runner(41) });
    free = 1;
    pumpStartQueue();
    await drain();
    expect(ran).toEqual([40, 41]);
    expect(startQueueLength()).toBe(0);
  });

  it('an AUTO entry is decided again by the auto fix queue at its turn (never a stale start)', async () => {
    bindStartQueue({ ctx: {} as never });
    enqueueStart({ accountId: 1, prId: 50, trigger: 'auto' });
    free = 1;
    pumpStartQueue();
    await drain();
    expect(evaluated).toEqual([50]);
    expect(startQueueLength()).toBe(0);
  });
});
