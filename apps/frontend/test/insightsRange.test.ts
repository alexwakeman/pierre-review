// The Insights chat range, client side (src/lib/insightsRange.ts).
//
// `defaultInsightsRange` decides which chip the FilterBar highlights when the user has picked
// nothing — and it is a MIRROR of the server's `resolveInsightsRange(row, now, null)` branch in
// packages/pro/src/settings/store.ts. That duplication is deliberate (the client cannot run the
// server's resolver and must render the bar before any answer exists), which makes drift the risk
// worth pinning: if the two disagree, the bar shows one range while the answer covers another, both
// looking equally confident. The sibling test is packages/pro/test/insights-range.test.ts, and the
// four cases below are the same four.
//
// `describeAnswerWindow` returning NULL is the other load-bearing case: history rows written before
// ranges shipped carry no window, and captioning those with today's default would attach a period
// nobody chose to somebody's stored answer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { InsightsAnswerWindow } from '@pierre-review/shared';
import { defaultInsightsRange, describeAnswerWindow } from '../src/lib/insightsRange.js';

describe('defaultInsightsRange', () => {
  it('mirrors the configured mode', () => {
    expect(defaultInsightsRange('rolling_7', false)).toBe('7d');
    expect(defaultInsightsRange('rolling_14', false)).toBe('14d');
    expect(defaultInsightsRange('sprint', true)).toBe('sprint');
  });

  it('mode sprint WITHOUT stored dates falls back to 14d, exactly as the server does', () => {
    expect(defaultInsightsRange('sprint', false)).toBe('14d');
  });

  it('an unread/absent setting is rolling 14 — the documented default', () => {
    expect(defaultInsightsRange(null, false)).toBe('14d');
    // Sprint dates alone don't change the default; the MODE selects it.
    expect(defaultInsightsRange(null, true)).toBe('14d');
  });
});

describe('describeAnswerWindow', () => {
  const win = (over: Partial<InsightsAnswerWindow>): InsightsAnswerWindow => ({
    kind: '14d',
    from: '2026-08-03T00:00:00.000Z',
    to: '2026-08-17T00:00:00.000Z',
    ...over,
  });

  it('renders nothing for a window-less (pre-range) row', () => {
    expect(describeAnswerWindow(null)).toBeNull();
    expect(describeAnswerWindow(undefined)).toBeNull();
  });

  it('names the range and its dates', () => {
    const out = describeAnswerWindow(win({ kind: '90d' }));
    expect(out).toContain('Last 90 days');
    expect(out).toContain('–'); // an en-dashed date range, locale-formatted either side
  });

  it('calls a sprint window a sprint', () => {
    expect(describeAnswerWindow(win({ kind: 'sprint' }))).toContain('Sprint to date');
  });

  it('discloses the fallback rather than relabelling it', () => {
    const out = describeAnswerWindow(win({ kind: '14d', requested: 'sprint' }));
    expect(out).toContain('Last 14 days');
    expect(out).toContain('no sprint cadence configured');
    expect(out).not.toContain('Sprint to date');
  });
});
