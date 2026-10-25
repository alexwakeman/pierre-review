// Bots → ROI "Turning it off would save" line (lib/botSavings.ts).
// Run: ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import {
  RARELY_USED_MAX_PCT,
  RARELY_USED_MIN_THREADS,
  savingsUsd,
  stopPayingLine,
} from '../src/lib/botSavings.js';

const row = {
  label: 'Cursor Bugbot',
  threads: 40,
  actedOnPct: 12,
  costMonthlyUsd: 40,
  dormant: false,
  verdict: 'noisy' as const,
};

describe('stopPayingLine', () => {
  it('templates the sentence with the window and monthly × 12', () => {
    expect(stopPayingLine(row, 'rolling_14', true)).toBe(
      'Cursor Bugbot costs $40 a month and your team used 12% of its threads in the last 14 days. Turning it off would save $480 a year.',
    );
  });
  it('says nothing on a repo-narrowed mount (money is Workspace-grained)', () => {
    expect(stopPayingLine(row, 'rolling_14', false)).toBeNull();
  });
  it('says nothing without a positive price', () => {
    expect(stopPayingLine({ ...row, costMonthlyUsd: null }, 'rolling_14', true)).toBeNull();
    expect(stopPayingLine({ ...row, costMonthlyUsd: 0 }, 'rolling_14', true)).toBeNull();
  });
  it('says nothing at or above the threshold, below the volume floor, or for a dormant bot', () => {
    expect(stopPayingLine({ ...row, actedOnPct: RARELY_USED_MAX_PCT }, 'rolling_14', true)).toBeNull();
    expect(stopPayingLine({ ...row, actedOnPct: null }, 'rolling_14', true)).toBeNull();
    expect(stopPayingLine({ ...row, threads: RARELY_USED_MIN_THREADS - 1 }, 'rolling_14', true)).toBeNull();
    expect(stopPayingLine({ ...row, dormant: true }, 'rolling_14', true)).toBeNull();
  });
  it('says nothing unless the chip beside it reads Rarely used', () => {
    expect(stopPayingLine({ ...row, verdict: 'tune' }, 'rolling_14', true)).toBeNull();
  });
  it('still speaks when nothing was used', () => {
    expect(stopPayingLine({ ...row, actedOnPct: 0 }, 'sprint', true)).toContain('used 0% of its threads this sprint');
  });
});

describe('savingsUsd', () => {
  it('whole dollars when whole, cents otherwise, thousands separated', () => {
    expect(savingsUsd(360)).toBe('$360');
    expect(savingsUsd(1200)).toBe('$1,200');
    expect(savingsUsd(29.5)).toBe('$29.50');
  });
});
