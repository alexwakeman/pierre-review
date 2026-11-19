// THE FIX START QUEUE (coding/ai-fix/start-queue.ts), pure: the line's order, one entry per PR, Cancel, and
// the pump — five PRs needing a fix at once with three build slots: three start, two wait, and each waiting
// one starts as a slot frees, people's presses first. A start that loses the race goes back to the front.
//
//   pnpm --filter @pierre-review/backend test ai-fix/start-queue
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetStartQueueForTest, bindStartQueue, cancelQueuedStart, enqueueStart, pumpStartQueue, queuedPlaceOf, sameTicketWaiting, startQueuedNow, startQueueLength, startWaitingFor } from './start-queue.js';
import { _resetTicketLineForTest, bindTicketLine, bindTicketLineFix, holdsTicketLine, releaseTicketLine, ticketLineBlocker, tryHoldTicketLine } from './ticket-line.js';

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
  _resetTicketLineForTest();
  bindTicketLine({ onReleased: pumpStartQueue });
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

// ONE TICKET AT A TIME (ticket-line.ts): PRs 60, 61 and 62 share a ticket; 70 is on another one. `reads` = the PRs
// a fix would READ at their head (another repository it loads).
describe('the per-ticket line', () => {
  const T = [60, 61, 62];
  const others = (p: number): number[] => T.filter((x) => x !== p);
  const hold = (prId: number, number: number, reads: number[] = others(prId), o: { skip?: boolean } = {}) => tryHoldTicketLine({ accountId: 1, prId, number, reads }, o);

  it('check and hold in one tick: a start waits only for a running fix of a PR it READS; tokens release only their own hold', () => {
    const a = hold(60, 12);
    expect('token' in a).toBe(true);
    expect(holdsTicketLine(60)).toBe(true);
    // 61 reads 60 ⇒ blocked, nothing held.
    expect(hold(61, 13)).toEqual({ blocked: { prId: 60, number: 12 } });
    expect(holdsTicketLine(61)).toBe(false);
    // ⑤ 62 does NOT read 60 (same repository, or a repository it does not load) ⇒ never blocked by it.
    expect('token' in hold(62, 14, [61])).toBe(true);
    expect(ticketLineBlocker(1, 61, [])).toBeNull();
    // Another account is never blocked.
    expect(ticketLineBlocker(2, 61, [60])).toBeNull();
    // ⑩ a stale token, or an unbound fix id, releases nothing; the hold's own token does.
    releaseTicketLine(60, { token: 999 });
    releaseTicketLine(60, { fixId: 5 });
    expect(holdsTicketLine(60)).toBe(true);
    bindTicketLineFix(60, (a as { token: number }).token, 5);
    releaseTicketLine(60, { fixId: 4 });
    expect(holdsTicketLine(60)).toBe(true);
    releaseTicketLine(60, { fixId: 5 });
    expect(holdsTicketLine(60)).toBe(false);
    // "Start now" holds without the check.
    hold(60, 12);
    expect('token' in hold(61, 13, others(61), { skip: true })).toBe(true);
  });

  it('a ticket-blocked entry is SKIPPED (others behind it start), says whom it waits for, and starts when the holder leaves running', async () => {
    free = 3;
    hold(60, 12);
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: others(61), sameTicket: others(61), run: runner(61) }, 1);
    enqueueStart({ accountId: 1, prId: 70, trigger: 'manual', reads: [], run: runner(70) }, 2);
    await drain();
    expect(ran).toEqual([70]);
    expect(startWaitingFor(1, 61)).toMatchObject({ position: 1, blockedBy: { prNumber: 12 } });
    releaseTicketLine(60);
    await drain();
    expect(ran).toEqual([70, 61]);
    expect(startQueueLength()).toBe(0);
  });

  it('presses first, then auto fixes, oldest first — among ticket-blocked entries too', async () => {
    free = 3;
    hold(60, 12);
    enqueueStart({ accountId: 1, prId: 61, trigger: 'auto', reads: others(61), run: runner(61) }, 1);
    enqueueStart({ accountId: 1, prId: 62, trigger: 'manual', reads: others(62), run: runner(62) }, 2);
    await drain();
    expect(ran).toEqual([]);
    expect(startWaitingFor(1, 62)?.position).toBe(1);
    releaseTicketLine(60);
    await drain();
    expect(ran).toEqual([62, 61]);
  });

  it('a narrow (dependency) entry carries no reads: never ticket-blocked', async () => {
    free = 1;
    hold(60, 12);
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', run: runner(61) });
    await drain();
    expect(ran).toEqual([61]);
  });

  it('⑥ no jumping the line: a direct start sees a same-ticket entry already waiting (either side\'s list); the queue\'s own start does not', async () => {
    free = 0;
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: [], sameTicket: [60, 62], run: runner(61) }, 1);
    expect(sameTicketWaiting(1, 60, [61])).toBe(true);
    expect(sameTicketWaiting(1, 62, [])).toBe(true);
    expect(sameTicketWaiting(1, 70, [71])).toBe(false);
    expect(sameTicketWaiting(2, 60, [61])).toBe(false);
    // While the queue runs 61's start, 61 is a queue start (it keeps its place, and skips the no-jumping rule).
    let seen: number | null = -1;
    free = 1;
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: [], sameTicket: [60, 62], run: async () => ((seen = queuedPlaceOf(1, 61)), (free -= 1), { status: 'queued' }) }, 5);
    await drain();
    expect(seen).toBe(1);
    expect(queuedPlaceOf(1, 61)).toBeNull();
  });

  it('⑦ a start the queue ran that has to wait again KEEPS ITS PLACE (ticket-blocked again, or Start now with no slot)', async () => {
    free = 1;
    // 61 (oldest) is run by the pump but finds itself blocked: it goes back with its OWN queuedAt, ahead of 62.
    hold(60, 12);
    const back = async () => {
      enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: [60], run: runner(61), queuedAt: queuedPlaceOf(1, 61) }, 50);
      return { status: 'waiting' };
    };
    enqueueStart({ accountId: 1, prId: 62, trigger: 'manual', reads: [60], run: runner(62) }, 2);
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: [], run: back }, 1);
    await drain();
    expect(startWaitingFor(1, 61)).toMatchObject({ position: 1, queuedAt: new Date(1).toISOString() });
    // Start now with no slot: back in line, in its old place, waiting for the slot only.
    free = 0;
    hold(62, 14);
    enqueueStart({ accountId: 1, prId: 63, trigger: 'manual', reads: [62], run: runner(63), runNow: async () => {
      enqueueStart({ accountId: 1, prId: 63, trigger: 'manual', reads: [62], skipLine: true, run: runner(63), queuedAt: queuedPlaceOf(1, 63) }, 99);
      return { status: 'waiting' };
    } }, 3);
    expect(await startQueuedNow(1, 63)).toMatchObject({ status: 'waiting' });
    expect(startWaitingFor(1, 63)).toMatchObject({ queuedAt: new Date(3).toISOString(), blockedBy: null });
  });

  it('START NOW starts a waiting press at once past the line; an auto entry is refused with whom it waits for; nothing waiting ⇒ null', async () => {
    free = 3;
    hold(60, 12);
    let nowRan = 0;
    enqueueStart({ accountId: 1, prId: 61, trigger: 'manual', reads: others(61), run: runner(61), runNow: async () => ((nowRan += 1), { status: 'queued' }), meta: { include: true, ciOnly: false } });
    enqueueStart({ accountId: 1, prId: 62, trigger: 'auto', reads: others(62) });
    await drain();
    expect(ran).toEqual([]);
    expect(await startQueuedNow(1, 62)).toEqual({ refused: 'auto', blockedBy: 12 });
    expect(await startQueuedNow(2, 61)).toBeNull();
    expect(await startQueuedNow(1, 61)).toEqual({ status: 'queued', meta: { include: true, ciOnly: false } });
    expect(nowRan).toBe(1);
    expect(startWaitingFor(1, 61)).toBeNull();
    expect(await startQueuedNow(1, 61)).toBeNull();
  });
});
