// THE AUTOMATIC STORY CHECK'S ONE RULE (auto-plan.ts) — pure. What this pins:
//   1. The grace window: 2 quiet minutes after the newest change, restarted by a push to ANY member,
//      a PR joining or the ticket changing — a FIRST check too.
//   2. The 20-minute ceiling from the burst's first change (changes after the latest run only).
//   3. What holds it is said before a time that would not be kept; the cap spares the reader's PRs.
import { describe, expect, it } from 'vitest';
import { TICKET_AUTO_GRACE_MS, TICKET_AUTO_MAX_WAIT_MS } from '@pierre-review/shared';
import {
  latestAllMet,
  nextUtcMidnightMs,
  ticketAutoCheckPlan,
  ticketAutoDueAt,
  toWireAutoCheck,
  type TicketAutoChange,
  type TicketAutoPlanInputs,
} from './auto-plan.js';

const MIN = 60_000;
const T = Date.UTC(2026, 10, 9, 15, 0, 0);
const at = (m: number): number => T + m * MIN;
const push = (m: number, prId = 615): TicketAutoChange => ({ atMs: at(m), prId, kind: 'pushed' });

const base = (over: Partial<TicketAutoPlanInputs> = {}): TicketAutoPlanInputs => ({
  running: false,
  needsRun: true,
  autoOn: true,
  tooManyPrs: false,
  alreadyTried: false,
  first: false,
  allMet: false,
  floorOk: true,
  aiReady: true,
  overBudget: false,
  changes: [push(0)],
  lastRunAtMs: at(-60),
  cap: { used: 0, limit: 60, exempt: false },
  laneRoom: 4,
  ...over,
});

describe('ticketAutoDueAt', () => {
  it('⚠ an unseen comment is the change waited on, never a push the latest run already checked', () => {
    const comment: TicketAutoChange = { atMs: at(-5), prId: null, kind: 'commented' };
    // Run at 0 saw the push at -1; the comment from -5 is unseen. The wait names the comment.
    const r = ticketAutoDueAt([comment, push(-1)], at(0), at(0.5));
    expect(r.last).toEqual(comment);
    expect(r.dueAtMs).toBe(at(-3));
  });
  it('is 2 minutes after the newest change; a push to another member restarts it', () => {
    expect(TICKET_AUTO_GRACE_MS).toBe(2 * MIN);
    expect(ticketAutoDueAt([push(0)], null, at(1)).dueAtMs).toBe(at(2));
    const r = ticketAutoDueAt([push(0, 615), push(1.5, 474)], null, at(2));
    expect(r.dueAtMs).toBe(at(3.5));
    expect(r.last).toEqual(push(1.5, 474));
  });

  it('a PR joining and a ticket change restart it too', () => {
    const joined: TicketAutoChange = { atMs: at(3), prId: 222, kind: 'joined' };
    const edited: TicketAutoChange = { atMs: at(4), prId: null, kind: 'ticket_changed' };
    expect(ticketAutoDueAt([push(0), joined], null, at(4)).dueAtMs).toBe(at(5));
    expect(ticketAutoDueAt([push(0), joined, edited], null, at(4)).dueAtMs).toBe(at(6));
  });

  it('⚠ the ceiling: pushes every minute are still checked 20 minutes after the first', () => {
    expect(TICKET_AUTO_MAX_WAIT_MS).toBe(20 * MIN);
    const burst = Array.from({ length: 30 }, (_, i) => push(i));
    expect(ticketAutoDueAt(burst.slice(0, 19), at(-10), at(18.5)).dueAtMs).toBe(at(20));
    expect(ticketAutoDueAt(burst, at(-10), at(29.5)).dueAtMs).toBe(at(20));
  });

  it('⚠ one PR pushed every minute reaches the ceiling through its stored burst start', () => {
    // Only the newest push is stored per PR (`head_seen_at`); `head_burst_at` keeps where the run began.
    const one: TicketAutoChange = { atMs: at(25), sinceMs: at(0), prId: 615, kind: 'pushed' };
    expect(ticketAutoDueAt([one], at(-10), at(25.5)).dueAtMs).toBe(at(20));
    // A burst that began before the latest run counts from the run.
    expect(ticketAutoDueAt([one], at(10), at(25.5)).dueAtMs).toBe(at(27));
    expect(ticketAutoDueAt([{ ...one, atMs: at(15) }], at(10), at(15.5)).dueAtMs).toBe(at(17));
  });

  it('a quiet gap or the latest run starts a new burst', () => {
    // 0, 1, then 5 minutes quiet, then 6..9: the burst starts at 6.
    const changes = [push(0), push(1), push(6), push(7), push(8), push(9)];
    expect(ticketAutoDueAt(changes, null, at(9.5)).dueAtMs).toBe(at(11));
    const steady = Array.from({ length: 25 }, (_, i) => push(i));
    // A run queued at minute 10 saw everything before it: the ceiling counts from minute 11.
    expect(ticketAutoDueAt(steady, at(10), at(24.5)).dueAtMs).toBe(at(26));
    expect(ticketAutoDueAt(steady.slice(0, 22), at(10), at(21.5)).dueAtMs).toBe(at(23));
    expect(ticketAutoDueAt(Array.from({ length: 40 }, (_, i) => push(i)), at(10), at(39.5)).dueAtMs).toBe(at(31));
  });

  it('no change to wait for (or only future ones) is due at once', () => {
    expect(ticketAutoDueAt([], null, at(0)).dueAtMs).toBeNull();
    expect(ticketAutoDueAt([push(5)], null, at(0)).dueAtMs).toBeNull();
  });
});

describe('ticketAutoCheckPlan', () => {
  it('waits 2 quiet minutes, then is due', () => {
    const waiting = ticketAutoCheckPlan(base(), at(1));
    expect(waiting).toMatchObject({ status: 'waiting', reason: 'settling', startsAtMs: at(2), due: false });
    expect(ticketAutoCheckPlan(base(), at(2))).toMatchObject({ status: 'due', due: true });
  });

  it('⚠ a FIRST check waits too', () => {
    expect(ticketAutoCheckPlan(base({ first: true, lastRunAtMs: null }), at(1)).reason).toBe('settling');
  });

  it('⚠ all met: a ticket whose latest check found every criterion done is never re-checked by itself', () => {
    // Even past the window, with room and budget: off, never due.
    expect(ticketAutoCheckPlan(base({ allMet: true }), at(30)).due).toBe(false);
    // Running / up to date still read first.
    expect(ticketAutoCheckPlan(base({ allMet: true, running: true }), at(5)).status).toBe('running');
    expect(ticketAutoCheckPlan(base({ allMet: true, needsRun: false }), at(5)).status).toBe('up_to_date');
  });

  it('latestAllMet: every criterion done (met or met outside code); no criteria is not "all met"', () => {
    expect(latestAllMet({ criteria: [{ status: 'met' }, { status: 'met_outside_code' }] })).toBe(true);
    expect(latestAllMet({ criteria: [{ status: 'met' }, { status: 'partly_met' }] })).toBe(false);
    expect(latestAllMet({ criteria: [{ status: 'met' }, { status: 'unclear' }] })).toBe(false);
    expect(latestAllMet({ criteria: [] })).toBe(false);
    expect(latestAllMet(null)).toBe(false);
  });

  it('running and up to date come first', () => {
    expect(ticketAutoCheckPlan(base({ running: true }), at(5)).status).toBe('running');
    expect(ticketAutoCheckPlan(base({ needsRun: false }), at(5)).status).toBe('up_to_date');
  });

  it('says why it will never run by itself', () => {
    expect(ticketAutoCheckPlan(base({ autoOn: false }), at(5))).toMatchObject({ status: 'off', reason: 'auto_off' });
    expect(ticketAutoCheckPlan(base({ tooManyPrs: true }), at(5)).reason).toBe('too_many_prs');
    expect(ticketAutoCheckPlan(base({ alreadyTried: true }), at(5)).reason).toBe('already_tried');
    expect(ticketAutoCheckPlan(base({ allMet: true }), at(5))).toMatchObject({ status: 'off', reason: 'all_met', due: false });
    expect(ticketAutoCheckPlan(base({ first: true, floorOk: false }), at(5)).reason).toBe('no_floor');
    // The floor is a first check's rule only.
    expect(ticketAutoCheckPlan(base({ first: false, floorOk: false }), at(5)).status).toBe('due');
  });

  it('⚠ a hold is said before a time it would not keep', () => {
    expect(ticketAutoCheckPlan(base({ overBudget: true }), at(1))).toMatchObject({ status: 'held', reason: 'over_budget' });
    expect(ticketAutoCheckPlan(base({ aiReady: false }), at(1)).reason).toBe('ai_not_ready');
    const capped = ticketAutoCheckPlan(base({ cap: { used: 60, limit: 60, exempt: false } }), at(1));
    expect(capped).toMatchObject({ status: 'held', reason: 'daily_limit', startsAtMs: nextUtcMidnightMs(at(1)) });
    expect(new Date(capped.startsAtMs!).toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('⚠ a ticket with a PR the reader owns is never held by the cap', () => {
    const mine = ticketAutoCheckPlan(base({ cap: { used: 99, limit: 60, exempt: true } }), at(3));
    expect(mine.status).toBe('due');
  });

  it('a full lane waits without a time', () => {
    expect(ticketAutoCheckPlan(base({ laneRoom: 0 }), at(3))).toMatchObject({ status: 'waiting', reason: 'lane_full', startsAtMs: null });
    expect(ticketAutoCheckPlan(base({ laneRoom: null }), at(3)).status).toBe('due');
  });

  it('the wire carries ISO times and the last change', () => {
    expect(toWireAutoCheck(ticketAutoCheckPlan(base(), at(1)))).toEqual({
      status: 'waiting',
      reason: 'settling',
      startsAt: new Date(at(2)).toISOString(),
      lastChange: { prId: 615, kind: 'pushed', at: new Date(at(0)).toISOString() },
    });
  });
});
