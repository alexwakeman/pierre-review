// The ONE large-PR comparison every surface makes (Feed cards, the Pending board's PrMetaRow,
// the PR-detail header, and the vis-timeline tooltip). What it gets right is the THREE DATA
// TRAPS — all three of which end in "render nothing", which is why the function returns null
// rather than a verdict object carrying a `false`.
//
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import { LARGE_PR_CODE_LOC_DEFAULT } from '@pierre-review/shared';
import {
  currentLargePrThreshold,
  largePrFlag,
  noteLargePrThreshold,
} from '../src/lib/ui.js';

describe('largePrFlag — TRAP 1: codeLoc == null is UNKNOWN, never "not large"', () => {
  it('renders nothing for an explicit null (no stored file breakdown / never-observed size)', () => {
    expect(largePrFlag({ codeLoc: null }, 1500)).toBeNull();
  });

  it('renders nothing for an ABSENT field — a payload cached before the feature shipped', () => {
    expect(largePrFlag({}, 1500)).toBeNull();
  });

  it('an unknown PR is indistinguishable from a small one, and that is deliberate', () => {
    // Both answers are the same object shape (null), so no caller can accidentally build
    // "unknown" chrome that a small PR would not also get.
    expect(largePrFlag({ codeLoc: null }, 1500)).toBe(largePrFlag({ codeLoc: 12 }, 1500));
  });

  it('a null with a lower-bound marker is still nothing — the marker is not a measurement', () => {
    expect(largePrFlag({ codeLoc: null, codeLocIsLowerBound: true }, 1500)).toBeNull();
  });
});

describe('largePrFlag — TRAP 2: a lower bound reads ASYMMETRICALLY', () => {
  it('asserts the flag when a TRUNCATED count is already over the threshold', () => {
    // A missing file can only ADD lines, so over-threshold survives truncation.
    const flag = largePrFlag({ codeLoc: 2340, codeLocIsLowerBound: true }, 1500);
    expect(flag).not.toBeNull();
    expect(flag?.isLowerBound).toBe(true);
    expect(flag?.label).toContain('At least 2,340');
    expect(flag?.short).toBe('2,340+ code lines');
  });

  it('makes NO claim when a truncated count is under the threshold', () => {
    // files(first:100) truncates exactly the biggest PRs, so 900-of-unknown proves nothing.
    expect(largePrFlag({ codeLoc: 900, codeLocIsLowerBound: true }, 1500)).toBeNull();
  });

  it('states the number exactly when the file list was complete', () => {
    const flag = largePrFlag({ codeLoc: 2340, codeLocIsLowerBound: false }, 1500);
    expect(flag?.isLowerBound).toBe(false);
    expect(flag?.label).not.toContain('At least');
    expect(flag?.short).toBe('2,340 code lines');
  });
});

describe('largePrFlag — TRAP 3: under the threshold, silence', () => {
  it('flags AT the threshold (the backend defines it as "at or above")', () => {
    expect(largePrFlag({ codeLoc: 1500 }, 1500)).not.toBeNull();
    expect(largePrFlag({ codeLoc: 1499 }, 1500)).toBeNull();
  });

  it('never returns a "small PR" verdict for any input', () => {
    for (const codeLoc of [0, 1, 42, 1499]) {
      expect(largePrFlag({ codeLoc }, 1500)).toBeNull();
    }
  });

  it('zero is a real measurement (a docs-only PR) and is still silence, not a flag', () => {
    expect(largePrFlag({ codeLoc: 0 }, 1500)).toBeNull();
  });
});

describe('largePrFlag — the copy carries the magnitude', () => {
  it('names both the count and the threshold, so "large" is reviewable information', () => {
    const flag = largePrFlag({ codeLoc: 12345 }, 800);
    expect(flag?.label).toBe('12,345 code lines changed — above your 800 threshold.');
  });

  it('tracks a changed threshold with no cache invalidation — the wire carries a NUMBER', () => {
    expect(largePrFlag({ codeLoc: 1200 }, 1500)).toBeNull();
    expect(largePrFlag({ codeLoc: 1200 }, 1000)).not.toBeNull();
  });
});

describe('the threshold cell the vis-timeline tooltip reads', () => {
  it('defaults to the product default before /api/me lands', () => {
    expect(currentLargePrThreshold()).toBe(LARGE_PR_CODE_LOC_DEFAULT);
  });

  it('takes a stored account value', () => {
    noteLargePrThreshold(400);
    expect(currentLargePrThreshold()).toBe(400);
  });

  it('falls back to the default for anything not a positive integer', () => {
    for (const bad of [undefined, 0, -1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      noteLargePrThreshold(bad as number | undefined);
      expect(currentLargePrThreshold()).toBe(LARGE_PR_CODE_LOC_DEFAULT);
    }
  });
});
