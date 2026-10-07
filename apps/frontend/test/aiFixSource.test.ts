// AI Fix builds from the newest SUCCEEDED Claude review: a failed latest run never hides an older
// finished one, and "run a Claude Review first" shows only when no run on the PR succeeded.
import { describe, expect, it } from 'vitest';
import { fixSourceReviewId, olderSourceNote } from '../src/lib/aiFixSource.js';

const run = (id: number, status: 'succeeded' | 'failed' | 'running' | 'queued') => ({ id, status });

describe('fixSourceReviewId', () => {
  it('uses the latest run when it succeeded', () => {
    expect(fixSourceReviewId(null, run(3, 'succeeded'), [run(3, 'succeeded'), run(2, 'succeeded')])).toBe(3);
  });
  it('falls back to the newest succeeded run when the latest failed', () => {
    expect(fixSourceReviewId(null, run(5, 'failed'), [run(5, 'failed'), run(4, 'failed'), run(2, 'succeeded'), run(1, 'succeeded')])).toBe(2);
  });
  it('is null only when nothing succeeded', () => {
    expect(fixSourceReviewId(null, run(5, 'failed'), [run(5, 'failed'), run(4, 'running')])).toBeNull();
    expect(fixSourceReviewId(null, null, [])).toBeNull();
  });
  it('the hand-over from the Claude Review tab wins', () => {
    expect(fixSourceReviewId(1, run(5, 'succeeded'), [run(5, 'succeeded'), run(1, 'succeeded')])).toBe(1);
  });
});

describe('olderSourceNote', () => {
  it('says nothing when the fix uses the latest run', () => {
    expect(olderSourceNote(null, 3, run(3, 'succeeded'))).toBeNull();
    expect(olderSourceNote(null, null, run(3, 'failed'))).toBeNull();
  });
  it('names why an older run is used', () => {
    expect(olderSourceNote(null, 2, run(5, 'failed'))).toBe('Uses the last review that finished. The latest one failed.');
    expect(olderSourceNote(null, 2, run(5, 'running'))).toBe('Uses the last review that finished. A newer one is running.');
    expect(olderSourceNote(1, 1, run(5, 'succeeded'))).toBe('Uses the review you picked, not the latest.');
  });
});
