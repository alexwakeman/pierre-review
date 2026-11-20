// The Feed's ONE severity scale (packages/shared/src/feed-severity.ts).
import { describe, expect, it } from 'vitest';
import {
  FEED_SEVERITIES,
  FEED_SEVERITY_LABEL,
  feedSeverityOf,
  parseFeedBotRoles,
  parseFeedSeverities,
} from '@pierre-review/shared';

describe('feedSeverityOf', () => {
  it("maps Ensemble's own severities onto the scale", () => {
    expect(feedSeverityOf({ limnSeverity: 'blocker' })).toBe('critical');
    expect(feedSeverityOf({ limnSeverity: 'warning' })).toBe('major');
    expect(feedSeverityOf({ limnSeverity: 'question' })).toBe('minor');
    expect(feedSeverityOf({ limnSeverity: 'nit' })).toBe('nit');
  });

  it("the comment's own severity wins over the ML score", () => {
    expect(feedSeverityOf({ limnSeverity: 'blocker', mlSeverity: 'nit' })).toBe('critical');
  });

  it('falls back to the ML score, then to unscored', () => {
    expect(feedSeverityOf({ mlSeverity: 'major' })).toBe('major');
    expect(feedSeverityOf({ limnSeverity: null, mlSeverity: null })).toBe('unscored');
    expect(feedSeverityOf({})).toBe('unscored');
  });

  it('has one label per bucket, Unscored last', () => {
    expect(FEED_SEVERITIES.map((s) => FEED_SEVERITY_LABEL[s])).toEqual([
      'Critical',
      'Major',
      'Minor',
      'Nit',
      'Unscored',
    ]);
  });
});

describe('the query-param parsers', () => {
  it('absent, empty or unknown means no narrowing', () => {
    expect(parseFeedSeverities(undefined)).toBeNull();
    expect(parseFeedSeverities('')).toBeNull();
    expect(parseFeedSeverities('loud')).toBeNull();
    expect(parseFeedBotRoles(undefined)).toBeNull();
    expect(parseFeedBotRoles('robots')).toBeNull();
  });

  it('keeps known words, drops unknown ones and duplicates', () => {
    expect(parseFeedSeverities('critical, unscored,loud,critical')).toEqual(['critical', 'unscored']);
    expect(parseFeedBotRoles('review,dependency,x')).toEqual(['review', 'dependency']);
  });
});
