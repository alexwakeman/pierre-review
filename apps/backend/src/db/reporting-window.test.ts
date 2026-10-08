// db/reporting-window.ts — the one window every Reports figure is tied to. Pure: no database.
import { afterEach, describe, expect, it } from 'vitest';
import {
  reportingWindowCaption,
  reportingWindowPhrase,
  reportingWindowTitle,
} from '@pierre-review/shared';
import {
  getReportingWindow,
  measuredTo,
  registerReportingWindowResolver,
  reportingWindowInfo,
} from './reporting-window.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 8, 12); // 2026-10-08T12:00:00Z

afterEach(() => registerReportingWindowResolver(null));

describe('getReportingWindow', () => {
  it('is the trailing 14 days when no plugin registered a resolver (OSS mode)', async () => {
    const w = await getReportingWindow(1, 7, NOW);
    expect(w).toEqual({ fromMs: NOW - 14 * DAY, toMs: NOW, mode: 'rolling_14' });
  });

  it("asks the registered resolver, passing the WORKSPACE so the cadence is that team's", async () => {
    const seen: unknown[] = [];
    registerReportingWindowResolver(async (args) => {
      seen.push(args);
      return { fromMs: NOW - 3 * DAY, toMs: NOW + 11 * DAY, mode: 'sprint' };
    });
    const w = await getReportingWindow(1, 7, NOW);
    expect(seen).toEqual([{ accountId: 1, workspaceId: 7, nowMs: NOW }]);
    expect(w).toEqual({ fromMs: NOW - 3 * DAY, toMs: NOW + 11 * DAY, mode: 'sprint' });
  });

  it('degrades to the default, and SAYS rolling_14, when the resolver throws or answers nonsense', async () => {
    registerReportingWindowResolver(async () => {
      throw new Error('settings read failed');
    });
    expect((await getReportingWindow(1, 7, NOW)).mode).toBe('rolling_14');
    // A window that has not started yet measures nothing.
    registerReportingWindowResolver(async () => ({
      fromMs: NOW + DAY,
      toMs: NOW + 15 * DAY,
      mode: 'sprint',
    }));
    expect(await getReportingWindow(1, 7, NOW)).toEqual({
      fromMs: NOW - 14 * DAY,
      toMs: NOW,
      mode: 'rolling_14',
    });
  });
});

describe('reportingWindowInfo', () => {
  it('measures a running sprint up to now, never into the future', () => {
    const sprint = { fromMs: NOW - 3.5 * DAY, toMs: NOW + 10.5 * DAY, mode: 'sprint' as const };
    expect(measuredTo(sprint, NOW)).toBe(NOW);
    const info = reportingWindowInfo(sprint, NOW);
    expect(info).toEqual({
      mode: 'sprint',
      from: new Date(NOW - 3.5 * DAY).toISOString(),
      to: new Date(NOW).toISOString(),
      end: new Date(NOW + 10.5 * DAY).toISOString(),
      days: 14,
      elapsedDays: 3.5,
    });
    expect(reportingWindowTitle(info)).toBe('This sprint so far');
    expect(reportingWindowCaption(info)).toBe('This sprint so far (day 4 of 14)');
    expect(reportingWindowPhrase(info)).toBe('so far this sprint');
  });

  it('names a rolling window by its days', () => {
    const info = reportingWindowInfo({ fromMs: NOW - 7 * DAY, toMs: NOW, mode: 'rolling_7' }, NOW);
    expect(reportingWindowTitle(info)).toBe('Last 7 days');
    expect(reportingWindowCaption(info)).toBe('Last 7 days');
    expect(reportingWindowPhrase(info)).toBe('in the last 7 days');
  });
});
