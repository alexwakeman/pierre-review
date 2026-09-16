// The global loading bar's catch-up sentence. It is copy, so every failure here is silent: the
// card renders, the words are wrong, and nothing throws.
//
// TWO CLAIMS IT MUST NOT MAKE, both of which it did make:
//   - that a QUEUED repo is being caught up. `enqueueSyncForRepo` seeds a waiting row with a real
//     `sinceMs` and `paused: { reason: 'queued' }`, so it arrives in the same `catchups` array as
//     a repo actually being walked — and "Catching up · 3 repos" over a set where nothing is
//     being fetched asserts work that is not happening.
//   - that every repo in the count is as far behind as the span says. The span is a MINIMUM over
//     `sinceMs`, i.e. the OLDEST repo, and printing it beside a bare count reads as a claim about
//     all of them.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { SyncCatchupRepo } from '@pierre-review/shared';
import { catchupLine } from '../src/components/GlobalLoadingBar.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function row(over: Partial<SyncCatchupRepo> & { sinceMs: number }): SyncCatchupRepo {
  return {
    repoId: 1,
    fullName: 'acme/web',
    percent: 0.4,
    prsProcessed: 12,
    ...over,
  };
}

describe('catchupLine', () => {
  it('says nothing when there is no catch-up', () => {
    expect(catchupLine([], NOW)).toBeNull();
  });

  it('drops the count for a single repo — it carries no denominator and the span is exact', () => {
    expect(catchupLine([row({ sinceMs: NOW - 18 * DAY })], NOW)).toBe(
      'Catching up · 18 days behind',
    );
  });

  it('⚠ names the reduction when a count and a maximum appear together', () => {
    const line = catchupLine(
      [
        row({ repoId: 1, sinceMs: NOW - 18 * DAY }),
        row({ repoId: 2, sinceMs: NOW - 26 * HOUR }),
        row({ repoId: 3, sinceMs: NOW - 26 * HOUR }),
      ],
      NOW,
    );
    expect(line).toBe('Catching up · 3 repos · oldest 18 days behind');
  });

  it('⚠ counts only the repos being WALKED, and reports the queued ones as waiting', () => {
    const line = catchupLine(
      [
        row({ repoId: 1, sinceMs: NOW - 2 * DAY }),
        row({ repoId: 2, sinceMs: NOW - 18 * DAY, percent: 0, paused: { reason: 'queued' } }),
        row({ repoId: 3, sinceMs: NOW - 18 * DAY, percent: 0, paused: { reason: 'queued' } }),
      ],
      NOW,
    );
    // The 18-day repos are queued, so they are neither counted nor the source of the span: the
    // sentence would otherwise say "3 repos · 18 days behind" over one repo's worth of work.
    expect(line).toBe('Catching up · 2 days behind · 2 waiting');
  });

  it('⚠ never says "Catching up" when every row is only queued', () => {
    const line = catchupLine(
      [
        row({ repoId: 1, sinceMs: NOW - 18 * DAY, percent: 0, paused: { reason: 'queued' } }),
        row({ repoId: 2, sinceMs: NOW - 18 * DAY, percent: 0, paused: { reason: 'queued' } }),
      ],
      NOW,
    );
    expect(line).toBe('Catch-up queued · 2 waiting');
  });
});
