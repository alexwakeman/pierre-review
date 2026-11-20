// The pooled review-bot responsiveness fold behind the Bots Monitoring headline tiles.
import { describe, expect, it } from 'vitest';
import { emptyBotResponsiveness, foldBotResponsiveness } from './bot-responsiveness.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 0, 1); // trend start
const weekStarts = Array.from({ length: 12 }, (_, i) => new Date(T0 + i * 7 * DAY).toISOString());
const weekIndexOf = (ms: number): number =>
  Math.min(11, Math.max(0, Math.floor((ms - T0) / (7 * DAY))));
const fromMs = T0 + 70 * DAY; // window = the last two weeks (weeks 10–11)

type Touches = Map<number, Map<number, { ms: number }[]>>;
function touches(rows: Array<[userId: number, prId: number, ms: number]>): Touches {
  const m: Touches = new Map();
  for (const [u, p, ms] of rows) {
    const byPr = m.get(u) ?? new Map<number, { ms: number }[]>();
    const arr = byPr.get(p) ?? [];
    arr.push({ ms });
    byPr.set(p, arr);
    m.set(u, byPr);
  }
  return m;
}
const fold = (t: Touches, opened: Record<number, number>, ready: Record<number, number> = {}) =>
  foldBotResponsiveness({
    touchesByUserPr: t,
    openedMsByPr: new Map(Object.entries(opened).map(([k, v]) => [Number(k), v])),
    readyMsByPr: new Map(Object.entries(ready).map(([k, v]) => [Number(k), v])),
    fromMs,
    weekStarts,
    weekIndexOf,
  });

describe('foldBotResponsiveness', () => {
  it('no bots → null figures, zero PRs, a 12-week trend of nulls (unknown is not zero)', () => {
    const r = fold(new Map(), {});
    expect(r).toEqual(emptyBotResponsiveness(weekStarts));
    expect(r.prs).toBe(0);
    expect(r.ttfrMedianHours).toBeNull();
    expect(r.ttfrP90Hours).toBeNull();
    expect(r.followupRatePct).toBeNull();
    expect(r.avgFollowups).toBeNull();
    expect(r.trend).toHaveLength(12);
    expect(r.trend.every((w) => w.prs === 0 && w.ttfrMedianHours === null)).toBe(true);
  });

  it('one bot: TTFR from opened, one touch → no follow-up', () => {
    const opened = T0 + 75 * DAY;
    const r = fold(touches([[1, 10, opened + 2 * HOUR]]), { 10: opened });
    expect(r.prs).toBe(1);
    expect(r.ttfrMedianHours).toBe(2);
    expect(r.ttfrP90Hours).toBe(2);
    expect(r.ttfrBaseline).toBe('opened');
    expect(r.followupRatePct).toBe(0);
    expect(r.avgFollowups).toBe(0);
    expect(r.trend[10]).toMatchObject({ prs: 1, ttfrMedianHours: 2, followupRatePct: 0, avgFollowups: 0 });
  });

  it('two bots where the second is faster: the FIRST touch by any bot sets TTFR', () => {
    const opened = T0 + 75 * DAY;
    const r = fold(
      touches([
        [1, 10, opened + 5 * HOUR], // slow bot
        [2, 10, opened + 1 * HOUR], // fast bot
      ]),
      { 10: opened },
    );
    expect(r.prs).toBe(1);
    expect(r.ttfrMedianHours).toBe(1);
    // The slow bot's later pass is a follow-up after the first review.
    expect(r.followupRatePct).toBe(100);
    expect(r.avgFollowups).toBe(1);
  });

  it('a follow-up by a different bot counts; ready-for-review is the clock when seen first', () => {
    const opened = T0 + 72 * DAY;
    const ready = opened + 10 * HOUR;
    const r = fold(
      touches([
        [1, 10, ready + 3 * HOUR],
        [2, 10, ready + 30 * HOUR],
        [2, 10, ready + 31 * HOUR],
        [1, 11, opened + 4 * HOUR], // PR 11: one pass, no follow-up
      ]),
      { 10: opened, 11: opened },
      { 10: ready },
    );
    expect(r.prs).toBe(2);
    expect(r.ttfrBaseline).toBe('mixed');
    expect(r.ttfrMedianHours).toBe(3.5); // median of 3h and 4h
    expect(r.ttfrP90Hours).toBe(4);
    expect(r.followupRatePct).toBe(50);
    expect(r.avgFollowups).toBe(1); // (2 + 0) / 2
  });

  it('is window-pure: a PR first touched before the window is only in the trend', () => {
    const opened = T0 + 20 * DAY;
    const r = fold(touches([[1, 10, opened + HOUR], [1, 10, T0 + 75 * DAY]]), { 10: opened });
    expect(r.prs).toBe(0);
    expect(r.ttfrMedianHours).toBeNull();
    expect(r.followupRatePct).toBeNull();
    expect(r.trend[2]).toMatchObject({ prs: 1, ttfrMedianHours: 1, followupRatePct: 100, avgFollowups: 1 });
    expect(r.trend[10]!.prs).toBe(0);
  });

  it('skips a PR with no known open time', () => {
    const r = fold(touches([[1, 99, T0 + 75 * DAY]]), {});
    expect(r.prs).toBe(0);
  });
});
