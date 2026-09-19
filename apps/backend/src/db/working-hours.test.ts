// The working-hours clock. Every figure Chronology now leads with is counted by it, so a wrong
// hour here is a wrong verdict against a budget on screen.
import { describe, expect, it } from 'vitest';
import { buildWorkingCalendar, zonedToUtc } from './working-hours.js';

const t = (iso: string): number => Date.parse(iso);
const LONDON = { timeZone: 'Europe/London', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 };
const cal = buildWorkingCalendar(LONDON, t('2026-01-01T00:00:00Z'), t('2026-12-31T00:00:00Z'));

describe('a weekend is not waiting time', () => {
  it('charges Friday 16:00 to Monday 10:00 three working hours, not 66', () => {
    // Winter: London is on UTC.
    expect(cal.between(t('2026-01-09T16:00:00Z'), t('2026-01-12T10:00:00Z'))).toBe(3);
  });

  it('does the same in summer, when London is an hour ahead of UTC', () => {
    // 16:00 BST Friday = 15:00Z; 10:00 BST Monday = 09:00Z.
    expect(cal.between(t('2026-07-10T15:00:00Z'), t('2026-07-13T09:00:00Z'))).toBe(3);
  });

  it('counts nothing for an interval that lies wholly outside working hours', () => {
    expect(cal.between(t('2026-01-10T09:00:00Z'), t('2026-01-11T17:00:00Z'))).toBe(0);
    expect(cal.between(t('2026-01-12T19:00:00Z'), t('2026-01-13T08:00:00Z'))).toBe(0);
  });

  it('is zero, never negative, when the end is not after the start', () => {
    expect(cal.between(t('2026-01-12T12:00:00Z'), t('2026-01-12T12:00:00Z'))).toBe(0);
    expect(cal.between(t('2026-01-12T12:00:00Z'), t('2026-01-12T10:00:00Z'))).toBe(0);
  });

  it('is additive, so a PR split into court spells sums to its whole life', () => {
    const a = t('2026-02-02T08:13:00Z');
    const b = t('2026-02-04T12:47:00Z');
    const c = t('2026-02-09T17:05:00Z');
    expect(cal.between(a, b) + cal.between(b, c)).toBeCloseTo(cal.between(a, c), 10);
  });
});

describe('the clock change', () => {
  it('spans the spring-forward weekend without gaining or losing an hour of work', () => {
    // Clocks went forward on Sunday 29 March 2026. Friday 17:00 GMT → Monday 10:00 BST.
    expect(cal.between(t('2026-03-27T17:00:00Z'), t('2026-03-30T09:00:00Z'))).toBe(2);
  });

  it('keeps the working day at nine hours either side of the autumn change', () => {
    // Friday 23 October (BST) and Monday 26 October (GMT) are both 09:00–18:00 local.
    expect(cal.between(t('2026-10-23T08:00:00Z'), t('2026-10-23T17:00:00Z'))).toBe(9);
    expect(cal.between(t('2026-10-26T09:00:00Z'), t('2026-10-26T18:00:00Z'))).toBe(9);
  });

  it('converts local wall-clock time through the zone, not a fixed offset', () => {
    expect(new Date(zonedToUtc(2026, 1, 12, 540, 'Europe/London')).toISOString()).toBe(
      '2026-01-12T09:00:00.000Z',
    );
    expect(new Date(zonedToUtc(2026, 7, 13, 540, 'Europe/London')).toISOString()).toBe(
      '2026-07-13T08:00:00.000Z',
    );
  });
});

describe('the workspace decides the calendar', () => {
  it('counts New York hours in New York', () => {
    const ny = buildWorkingCalendar(
      { timeZone: 'America/New_York', days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1020 },
      t('2026-01-01T00:00:00Z'),
      t('2026-03-01T00:00:00Z'),
    );
    // Wednesday 08:00–18:00 local (13:00Z–23:00Z) holds the whole 09:00–17:00 day.
    expect(ny.between(t('2026-01-07T13:00:00Z'), t('2026-01-07T23:00:00Z'))).toBe(8);
    expect(ny.dayHours).toBe(8);
  });

  it('honours a Sunday-to-Thursday week', () => {
    const sunThu = buildWorkingCalendar(
      { timeZone: 'Asia/Dubai', days: [7, 1, 2, 3, 4], startMinute: 540, endMinute: 1020 },
      t('2026-01-01T00:00:00Z'),
      t('2026-03-01T00:00:00Z'),
    );
    // Friday 9 Jan 2026 is not a working day there; Sunday 11 Jan is (09:00 GST = 05:00Z).
    expect(sunThu.between(t('2026-01-09T05:00:00Z'), t('2026-01-09T13:00:00Z'))).toBe(0);
    expect(sunThu.between(t('2026-01-11T05:00:00Z'), t('2026-01-11T13:00:00Z'))).toBe(8);
  });

  it('equals the clock when every hour of every day is a working hour', () => {
    const always = buildWorkingCalendar(
      { timeZone: 'UTC', days: [1, 2, 3, 4, 5, 6, 7], startMinute: 0, endMinute: 1440 },
      t('2026-01-01T00:00:00Z'),
      t('2026-03-01T00:00:00Z'),
    );
    const a = t('2026-01-05T03:17:00Z');
    const b = t('2026-02-11T19:42:00Z');
    expect(always.between(a, b)).toBeCloseTo((b - a) / 3_600_000, 9);
  });

  it('reads the weekday in the zone, not in UTC', () => {
    // 23:30Z on Friday 18 September 2026 is 00:30 on Saturday in London.
    expect(cal.weekday(t('2026-09-18T23:30:00Z'))).toBe(6);
    expect(cal.weekday(t('2026-09-18T22:30:00Z'))).toBe(5);
  });
});
