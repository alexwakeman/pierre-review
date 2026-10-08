// THE REPORTING-WINDOW RULE ON REPORTS: every figure is tied to the workspace's reporting window,
// and the exceptions are LABELLED. These pins cover the labels a reader sees.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { coverageLineFor } from '../src/components/Activity/bottlenecksModel.js';
import { windowDates, windowOrDefault } from '../src/components/Activity/reportingWindowText.js';

const PANEL = readFileSync(
  new URL('../src/components/Activity/WorkspaceMetricsPanel.tsx', import.meta.url),
  'utf8',
);

describe('the flow tiles, by source guard', () => {
  it('sets the two snapshot tiles apart under "Right now"', () => {
    const rightNow = PANEL.indexOf('aria-label="Right now"');
    expect(rightNow).toBeGreaterThan(0);
    // Both snapshot tiles render AFTER the "Right now" group opens…
    expect(PANEL.indexOf('Open pull requests', rightNow)).toBeGreaterThan(rightNow);
    expect(PANEL.indexOf('Red checks now', rightNow)).toBeGreaterThan(rightNow);
    // …and every windowed tile renders BEFORE it, under the window's own heading.
    const windowGroup = PANEL.indexOf('aria-label={windowGroupLabel}');
    expect(windowGroup).toBeGreaterThan(0);
    for (const label of ['label="Merged"', 'label="Time to merge"', 'label="Checks green at merge"']) {
      const at = PANEL.indexOf(label);
      expect(at).toBeGreaterThan(windowGroup);
      expect(at).toBeLessThan(rightNow);
    }
    // Named through the ONE shared spelling, never retyped.
    expect(PANEL).toMatch(/reportingWindowTitle\(\{ mode: cmp, days: metrics\.sprintDays \}\)/);
    expect(PANEL).not.toMatch(/'This sprint so far'/);
  });

  it('labels the 12-week trend band as the other exception', () => {
    expect(PANEL).toMatch(/Last 12 weeks/);
    expect(PANEL).toMatch(/always cover more than one window/);
  });
});

describe('the window in words', () => {
  const sprint = {
    mode: 'sprint' as const,
    from: '2026-10-01T09:00:00.000Z',
    to: '2026-10-04T09:00:00.000Z',
    end: '2026-10-15T09:00:00.000Z',
    days: 14,
    elapsedDays: 3,
  };

  it("Chronology's coverage line names the reporting window like the tiles do", () => {
    const c = {
      reposInWorkspace: 4,
      reposWithData: 3,
      prsScanned: 12,
      truncated: false,
      excludedNoHumanTouch: 0,
      excludedBotAuthored: 0,
    };
    expect(coverageLineFor(c, 3, sprint)).toBe(
      'Measured 3 of 4 repositories · 12 merged pull requests · this sprint so far (day 3 of 14).',
    );
    expect(coverageLineFor(c, 60)).toBe(
      'Measured 3 of 4 repositories · 12 merged pull requests · last 60 days.',
    );
  });

  it('prints the measured dates, last day inclusive', () => {
    expect(windowDates(sprint)).toMatch(/1.*Oct.*4.*Oct|Oct.*1.*Oct.*4/);
  });

  it('reads a response with no window as the trailing fortnight it always was', () => {
    const w = windowOrDefault(undefined, sprint.from, sprint.to);
    expect(w).toMatchObject({ mode: 'rolling_14', days: 14 });
  });
});
