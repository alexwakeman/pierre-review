import { describe, expect, it } from 'vitest';
import { nextTicketSnapshot, paintedPrs, ticketGate, ticketWaitKey } from '../src/lib/openPrsTicketGate.js';

const base = {
  trackerKnown: true,
  ticketsOn: true,
  prCount: 5,
  ticketsAnswered: false,
  ticketsFailed: false,
  timedOut: false,
};

describe('ticketGate — the Open PRs first paint waits for tickets', () => {
  it('waits while the tracker settings are unknown', () => {
    expect(ticketGate({ ...base, trackerKnown: false })).toBe('wait');
  });
  it('falls back when the tracker settings never answer', () => {
    expect(ticketGate({ ...base, trackerKnown: false, timedOut: true })).toBe('fallback');
  });
  it('paints at once with no tracker', () => {
    expect(ticketGate({ ...base, ticketsOn: false })).toBe('ready');
  });
  it('waits for the ticket answer where the tracker runs', () => {
    expect(ticketGate(base)).toBe('wait');
  });
  it('paints once the ticket answer is in', () => {
    expect(ticketGate({ ...base, ticketsAnswered: true })).toBe('ready');
  });
  it('falls back on a failed ticket request', () => {
    expect(ticketGate({ ...base, ticketsFailed: true })).toBe('fallback');
  });
  it('falls back on a slow ticket request', () => {
    expect(ticketGate({ ...base, timedOut: true })).toBe('fallback');
  });
  it('an answer that lands after the timeout still paints grouped data', () => {
    expect(ticketGate({ ...base, timedOut: true, ticketsAnswered: true })).toBe('ready');
  });
  it('no PRs means nothing to wait for (no ticket request is made)', () => {
    expect(ticketGate({ ...base, prCount: 0, trackerKnown: false })).toBe('ready');
  });
});

describe('the latch — what stays painted across refetches', () => {
  const pr = (id: number) => ({ id });
  const T = { prs: [] as number[] };
  const first = nextTicketSnapshot(null, { ws: 1, answered: true, gate: 'ready', livePrs: [pr(1), pr(2)], ticketsOn: true, ticketData: T })!;

  it('a query that has not answered yet never paints an empty list', () => {
    expect(nextTicketSnapshot(null, { ws: 1, answered: false, gate: 'ready', livePrs: [], ticketsOn: true, ticketData: undefined })).toBeNull();
  });

  it('⚠ an ANSWERED empty list after the first paint replaces the old cards', () => {
    const next = nextTicketSnapshot(first, { ws: 1, answered: true, gate: 'ready', livePrs: [], ticketsOn: true, ticketData: undefined });
    expect(next?.prs).toEqual([]);
    expect(paintedPrs(next, [], true)).toEqual([]);
  });

  it('a refetch waiting on tickets keeps the snapshot, less any PR that has gone', () => {
    const held = nextTicketSnapshot(first, { ws: 1, answered: true, gate: 'wait', livePrs: [pr(1), pr(3)], ticketsOn: true, ticketData: undefined });
    expect(held).toBe(first);
    expect(paintedPrs(held, [pr(1), pr(3)], true)).toEqual([pr(1)]);
  });

  it('⚠ a refetch that times out paints the live PRs with the tickets already on screen, never a held list', () => {
    const next = nextTicketSnapshot(first, { ws: 1, answered: true, gate: 'fallback', livePrs: [pr(1), pr(3)], ticketsOn: true, ticketData: undefined });
    expect(next).toMatchObject({ prs: [pr(1), pr(3)], ticketData: T, fellBack: false });
  });

  it('a first paint that falls back holds the list', () => {
    expect(nextTicketSnapshot(null, { ws: 1, answered: true, gate: 'fallback', livePrs: [pr(1)], ticketsOn: true, ticketData: undefined })?.fellBack).toBe(true);
  });

  it('the wait key moves with the PR set, not its order', () => {
    expect(ticketWaitKey(1, [2, 1])).toBe(ticketWaitKey(1, [1, 2]));
    expect(ticketWaitKey(1, [1, 2])).not.toBe(ticketWaitKey(1, [1, 3]));
  });
});
