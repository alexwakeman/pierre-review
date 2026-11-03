// The manual review split button (lib/reviewPostMode.ts): the remembered choice, the button's words,
// the "Review and post" lines and the "Review only" summary pre-fill that never clobbers typed text.
import { describe, expect, it } from 'vitest';
import {
  nextSummaryPrefill,
  pressedPostLine,
  readReviewPostMode,
  REVIEW_POST_MODE_KEY,
  reviewRunButtonLabel,
  summaryPrefillOf,
  writeReviewPostMode,
} from '../src/lib/reviewPostMode.js';

const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
};
const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('the remembered choice', () => {
  it('defaults to Review only, remembers Review and post, and survives blocked storage', () => {
    const s = memory();
    expect(readReviewPostMode(s)).toBe('review_only');
    writeReviewPostMode('post', s);
    expect(s.map.get(REVIEW_POST_MODE_KEY)).toBe('post');
    expect(readReviewPostMode(s)).toBe('post');
    s.map.set(REVIEW_POST_MODE_KEY, 'garbage');
    expect(readReviewPostMode(s)).toBe('review_only');
    expect(readReviewPostMode(throwing)).toBe('review_only');
    expect(() => writeReviewPostMode('post', throwing)).not.toThrow();
    expect(readReviewPostMode(null)).toBe('review_only');
  });

  it('labels the main button by the choice', () => {
    expect(reviewRunButtonLabel('review_only', false)).toBe('Review only');
    expect(reviewRunButtonLabel('post', false)).toBe('Review and post');
    expect(reviewRunButtonLabel('review_only', true)).toBe('Re-review only');
    expect(reviewRunButtonLabel('post', true)).toBe('Re-review and post');
  });
});

describe('Review and post lines', () => {
  it('says it posts when done while running, and why nothing was posted after', () => {
    expect(pressedPostLine({ postOnFinish: true, status: 'running', autoPost: null })).toBe('Posts to GitHub when done.');
    const skipped = (reason: 'nothing_new' | 'draft' | 'already_posted') => ({
      postOnFinish: true,
      status: 'succeeded' as const,
      autoPost: { status: 'skipped' as const, at: '', reason, error: null, postedCount: 0 },
    });
    expect(pressedPostLine(skipped('nothing_new'))).toBe('Nothing new to post.');
    expect(pressedPostLine(skipped('draft'))).toBe('Not posted: the PR is a draft.');
    // Its own line already (autoPostSkipLine).
    expect(pressedPostLine(skipped('already_posted'))).toBeNull();
    expect(pressedPostLine({ status: 'running', autoPost: null })).toBeNull();
  });
});

describe('the Review only pre-fill', () => {
  const run = {
    trigger: 'manual' as const,
    status: 'succeeded' as const,
    summary: '  Two blockers in the parser.  ',
    userBody: null,
  };

  it('pre-fills only a finished Review only run with no saved text', () => {
    expect(summaryPrefillOf(run)).toBe('Two blockers in the parser.');
    expect(summaryPrefillOf({ ...run, postOnFinish: true })).toBeNull();
    expect(summaryPrefillOf({ ...run, trigger: 'auto' })).toBeNull();
    expect(summaryPrefillOf({ ...run, status: 'running' })).toBeNull();
    expect(summaryPrefillOf({ ...run, userBody: 'my words' })).toBeNull();
    expect(summaryPrefillOf({ ...run, kind: 'replies' })).toBeNull();
    expect(summaryPrefillOf({ ...run, summary: '   ' })).toBeNull();
  });

  it('never refills a summary the reader cleared and saved, or a posted review', () => {
    // The reader emptied the box and it saved '' on blur: a reload must not put the summary back
    // (a Post would then send the text they removed).
    expect(summaryPrefillOf({ ...run, userBody: '' })).toBeNull();
    expect(summaryPrefillOf({ ...run, userBody: '   ' })).toBeNull();
    expect(summaryPrefillOf({ ...run, postedAt: '2026-11-03T10:00:00Z' })).toBeNull();
  });

  it('fills an empty box, replaces an untouched earlier pre-fill, and never clobbers typed text', () => {
    expect(nextSummaryPrefill({ box: '', lastPrefill: null, prefill: 'New.' })).toBe('New.');
    expect(nextSummaryPrefill({ box: '  \n', lastPrefill: null, prefill: 'New.' })).toBe('New.');
    expect(nextSummaryPrefill({ box: 'Old.', lastPrefill: 'Old.', prefill: 'New.' })).toBe('New.');
    // The reader typed (or edited the earlier pre-fill): left alone.
    expect(nextSummaryPrefill({ box: 'My own words', lastPrefill: null, prefill: 'New.' })).toBeNull();
    expect(nextSummaryPrefill({ box: 'Old. Plus mine', lastPrefill: 'Old.', prefill: 'New.' })).toBeNull();
    // Already there, or nothing to fill.
    expect(nextSummaryPrefill({ box: 'New.', lastPrefill: 'New.', prefill: 'New.' })).toBeNull();
    expect(nextSummaryPrefill({ box: '', lastPrefill: null, prefill: null })).toBeNull();
  });
});
