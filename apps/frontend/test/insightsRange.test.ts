// The Insights chat range, client side (src/lib/insightsRange.ts).
//
// (`defaultInsightsRange` and its tests were DELETED with the FilterBar "Range" chips — the chat's
// window precedence made those chips unreachable, so the client mirror had nothing left to mirror
// for. The server's `resolveInsightsRange` is now knowingly pinned on one side only; see the note
// in packages/pro/test/insights-range.test.ts.)
// This file now covers `describeAnswerWindow` alone.
//
// `describeAnswerWindow` returning NULL is the load-bearing case: history rows written before
// ranges shipped carry no window, and captioning those with today's default would attach a period
// nobody chose to somebody's stored answer.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { InsightsAnswerWindow } from '@pierre-review/shared';
import { describeAnswerWindow } from '../src/lib/insightsRange.js';

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
