import { describe, expect, it } from 'vitest';
import { weeklyAnomalies, detectSilentRuns } from './queries.js';

// The deterministic anomaly-detection helpers behind the Bots "Behaviour" tab. Each bot is
// judged against its OWN robust baseline (median + MAD), so these lock the two subtle rules the
// adversarial review flagged: the "building baseline" guard (needs ≥4 real data points) and the
// silence-run detection (regular bots only, leading run ignored, trailing run kept).

describe('weeklyAnomalies (robust median+MAD self-baseline)', () => {
  it('suppresses anomalies until there are ≥4 real (non-null) data points', () => {
    // A 2-week-old bot: 10 nulls (no data) + two real weeks. Even a big jump between the two real
    // weeks must NOT flag — "typical" isn't meaningful yet (building baseline).
    const series = [...Array(10).fill(null), 5, 40];
    const out = weeklyAnomalies(series, { direction: 'both', minScale: 2 });
    expect(out.every((a) => a == null)).toBe(true);
  });

  it('does NOT flag a new / bursty bot whose zero weeks are nulled (the volume-guard fix)', () => {
    // getBotBehaviourAnalytics nulls ALL zero weeks of the volume series (baseline = active weeks
    // only), so the structural 0s can't defeat the ≥4-points guard. A 2-week-old bot at ~10/week,
    // or a bursty bot with a single active week (89), both read as "building baseline" → no anomaly.
    const newBot = [...Array(10).fill(null), 10, 10]; // 2 active weeks
    const burstyBot = [...Array(11).fill(null), 89]; // 1 active week
    expect(weeklyAnomalies(newBot, { direction: 'both', minScale: 2 }).every((a) => a == null)).toBe(true);
    expect(weeklyAnomalies(burstyBot, { direction: 'both', minScale: 2 }).every((a) => a == null)).toBe(true);
  });

  it('flags a clear outlier against a stable baseline', () => {
    // 11 weeks around ~12, one week at 300. MAD is small → the spike is a high anomaly.
    const series = [12, 11, 13, 12, 14, 12, 11, 13, 12, 300, 12, 13];
    const out = weeklyAnomalies(series, { direction: 'both', minScale: 2 });
    expect(out[9]).not.toBeNull();
    expect(out[9]!.direction).toBe('high');
    // The other weeks stay clean.
    expect(out.filter((a) => a != null)).toHaveLength(1);
  });

  it("direction 'high' ignores faster-than-typical (a drop is not a TTFR problem)", () => {
    const series = [10, 10, 11, 10, 9, 10, 10, 11, 10, 0.1, 10, 10]; // one very-fast week
    const both = weeklyAnomalies(series, { direction: 'both', minScale: 0.5 });
    const highOnly = weeklyAnomalies(series, { direction: 'high', minScale: 0.5 });
    expect(both[9]).not.toBeNull(); // 'both' catches the low outlier
    expect(highOnly[9]).toBeNull(); // 'high' does not
  });

  it('a near-constant series does not flag trivial wobble (minScale floor)', () => {
    const series = [8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 9]; // MAD=0, but minScale floors sigma
    const out = weeklyAnomalies(series, { direction: 'both', minScale: 2 });
    expect(out.every((a) => a == null)).toBe(true);
  });
});

describe('detectSilentRuns (coverage gaps for a regular bot)', () => {
  const DAILY_BOT = (): number[] => Array.from({ length: 84 }, () => 2); // active every day

  it('returns no runs for a sparse bot (< 4 active days)', () => {
    const daily = new Array<number>(84).fill(0);
    daily[0] = 1;
    daily[40] = 1;
    daily[80] = 1;
    expect(detectSilentRuns(daily)).toEqual([]);
  });

  it('flags a 3+ day internal gap for a daily bot', () => {
    const daily = DAILY_BOT();
    daily[40] = 0;
    daily[41] = 0;
    daily[42] = 0; // a 3-day silence
    const runs = detectSilentRuns(daily);
    expect(runs).toContainEqual({ startDay: 40, days: 3 });
  });

  it('ignores the LEADING run (before first activity) but keeps the TRAILING (ongoing) run', () => {
    const daily = new Array<number>(84).fill(0);
    // Active days 10..49 (a regular stretch), then silent to the end (trailing run 50..83).
    for (let i = 10; i < 50; i++) daily[i] = 2;
    const runs = detectSilentRuns(daily);
    // No run should start before the first active day (10).
    expect(runs.every((r) => r.startDay >= 10)).toBe(true);
    // The trailing "went dark" run is present and reaches the end.
    const trailing = runs.find((r) => r.startDay + r.days >= 84);
    expect(trailing).toBeDefined();
    expect(trailing!.startDay).toBe(50);
  });

  it('does not flag a short 2-day gap for a daily bot (below the max(3, …) floor)', () => {
    const daily = DAILY_BOT();
    daily[40] = 0;
    daily[41] = 0; // only 2 days
    const runs = detectSilentRuns(daily);
    expect(runs.find((r) => r.startDay === 40)).toBeUndefined();
  });
});
