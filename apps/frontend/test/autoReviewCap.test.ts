import { describe, expect, it } from 'vitest';
import {
  autoReviewCapCopy,
  autoReviewCapDismissKey,
  autoReviewCapState,
  capResumeText,
  pruneCapDismissals,
  utcDayOf,
} from '../src/lib/autoReviewCap.js';

const RESETS = '2026-11-04T00:00:00.000Z';
const u = (used: number, cap: number) => ({ used, cap, resetsAt: RESETS });

describe('autoReviewCapState', () => {
  it('says nothing without usage (auto review off) or below 80%', () => {
    expect(autoReviewCapState(null)).toBeNull();
    expect(autoReviewCapState(undefined)).toBeNull();
    expect(autoReviewCapState(u(0, 20))).toBeNull();
    expect(autoReviewCapState(u(15, 20))).toBeNull();
  });

  it('is near from 80% of the cap, with at least 2 used', () => {
    expect(autoReviewCapState(u(16, 20))?.state).toBe('near');
    expect(autoReviewCapState(u(19, 20))?.state).toBe('near');
    // 1 of a cap of 1 is reached, never near; 1 of 1.25 is under the 2-run floor.
    expect(autoReviewCapState(u(4, 5))?.state).toBe('near');
    expect(autoReviewCapState(u(1, 1))?.state).toBe('reached');
    expect(autoReviewCapState(u(2, 3))).toBeNull();
  });

  it('is reached at the cap, and past it (a cap lowered mid-day)', () => {
    expect(autoReviewCapState(u(20, 20))).toEqual({ state: 'reached', used: 20, cap: 20, resetsAt: RESETS });
    expect(autoReviewCapState(u(25, 10))?.state).toBe('reached');
  });

  it('ignores a nonsense cap', () => {
    expect(autoReviewCapState(u(3, 0))).toBeNull();
  });
});

describe('the dismissal key', () => {
  it('is one workspace, one UTC day, one state', () => {
    const near = autoReviewCapState(u(16, 20))!;
    const reached = autoReviewCapState(u(20, 20))!;
    expect(utcDayOf(RESETS)).toBe('2026-11-03');
    expect(autoReviewCapDismissKey(7, near)).toBe('7:2026-11-03:near');
    // A dismissed "near" does not hide "reached".
    expect(autoReviewCapDismissKey(7, reached)).not.toBe(autoReviewCapDismissKey(7, near));
    // Another workspace and another day are other keys.
    expect(autoReviewCapDismissKey(8, near)).not.toBe(autoReviewCapDismissKey(7, near));
    const tomorrow = autoReviewCapState({ used: 16, cap: 20, resetsAt: '2026-11-05T00:00:00.000Z' })!;
    expect(autoReviewCapDismissKey(7, tomorrow)).toBe('7:2026-11-04:near');
  });

  it('prunes keys from other days only', () => {
    const near = autoReviewCapState(u(16, 20))!;
    expect(pruneCapDismissals(['7:2026-11-02:near', '7:2026-11-03:near', '9:2026-11-03:reached'], near)).toEqual([
      '7:2026-11-03:near',
      '9:2026-11-03:reached',
    ]);
  });
});

describe('the copy', () => {
  it('near names the count', () => {
    expect(autoReviewCapCopy(autoReviewCapState(u(16, 20))!, Date.parse('2026-11-03T12:00:00Z'))).toEqual({
      label: 'Auto reviews',
      summary: '16 of 20 used today.',
    });
  });

  it('reached names the limit and the local restart time', () => {
    const now = Date.parse('2026-11-03T12:00:00Z');
    const { label, summary } = autoReviewCapCopy(autoReviewCapState(u(20, 20))!, now, 'en-GB');
    expect(label).toBe('Auto reviews stopped for today');
    expect(summary).toMatch(/^The daily limit of 20 is used\. They start again at .+\.$/);
    expect(summary).toContain(capResumeText(RESETS, now, 'en-GB'));
  });

  it('says "tomorrow" only when the reset is on the next local day', () => {
    const reset = new Date(RESETS);
    // A minute before the reset, local time: the same local day unless the reset is local midnight.
    const justBefore = Date.parse(RESETS) - 60_000;
    const sameDay = new Date(justBefore).getDate() === reset.getDate();
    expect(capResumeText(RESETS, justBefore).endsWith('tomorrow')).toBe(!sameDay);
    // The local midnight that starts the reset's own day: always the same local day.
    const localMidnight = new Date(reset.getFullYear(), reset.getMonth(), reset.getDate()).getTime();
    expect(capResumeText(RESETS, localMidnight).endsWith('tomorrow')).toBe(false);
    // The local day before the reset's: tomorrow.
    expect(capResumeText(RESETS, localMidnight - 3_600_000)).toMatch(/tomorrow$/);
    expect(capResumeText('not a date', justBefore)).toBe('midnight UTC');
  });
});
