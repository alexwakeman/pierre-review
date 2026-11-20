import { describe, expect, it } from 'vitest';
import type { BotResponsiveness } from '@pierre-review/shared';
import { formatHours, formatResponsivenessTiles } from '../src/lib/botResponsiveness.js';

const base: BotResponsiveness = {
  prs: 42,
  ttfrMedianHours: 0.75,
  ttfrP90Hours: 9.2,
  ttfrBaseline: 'ready',
  followupRatePct: 61.4,
  avgFollowups: 1.43,
  trend: [],
};

describe('formatHours', () => {
  it('never prints 0h for a fast bot', () => {
    expect(formatHours(0)).toBe('<1m');
    expect(formatHours(0.005)).toBe('<1m');
  });
  it('steps minutes → hours → days', () => {
    expect(formatHours(0.75)).toBe('45m');
    expect(formatHours(3.46)).toBe('3.5h');
    expect(formatHours(20.4)).toBe('20h');
    expect(formatHours(50)).toBe('2.1d');
    expect(formatHours(24 * 12)).toBe('12d');
  });
});

describe('formatResponsivenessTiles', () => {
  it('shows median, p90 and the PR count as the denominator', () => {
    const t = formatResponsivenessTiles(base);
    expect(t.ttfr).toEqual({ value: '45m', sub: 'p90 9.2h · 42 PRs' });
    expect(t.followups).toEqual({ value: '61%', sub: 'avg 1.4 more per PR · 42 PRs' });
  });

  it('reads unknown as a dash, never 0, when no PR was reviewed', () => {
    const empty: BotResponsiveness = {
      ...base,
      prs: 0,
      ttfrMedianHours: null,
      ttfrP90Hours: null,
      ttfrBaseline: null,
      followupRatePct: null,
      avgFollowups: null,
    };
    for (const t of [formatResponsivenessTiles(empty), formatResponsivenessTiles(undefined)]) {
      expect(t.ttfr.value).toBe('—');
      expect(t.followups.value).toBe('—');
      expect(t.ttfr.sub).toBe('No PR reviewed by a bot in this window');
    }
  });

  it('says "1 PR", not "1 PRs"', () => {
    expect(formatResponsivenessTiles({ ...base, prs: 1 }).ttfr.sub).toBe('p90 9.2h · 1 PR');
  });

  it('drops a missing p90 / average rather than printing a dash in the sub-line', () => {
    const t = formatResponsivenessTiles({ ...base, ttfrP90Hours: null, avgFollowups: null });
    expect(t.ttfr.sub).toBe('42 PRs');
    expect(t.followups.sub).toBe('42 PRs');
  });
});
