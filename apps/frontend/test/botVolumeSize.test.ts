// PR size vs bot comment volume: the bucket-series selection whose wrong version type-checks.
//
// Every assertion pins a distinction the obvious implementation gets wrong silently, because both
// halves render as blank space in a bar chart:
//   • `prs: 0`          — no PR of that size merged → a band that must LEAVE the axis and be named
//   • `avgComments: 0`  — PRs merged and the bots said nothing → a band that must STAY on the axis
//   • a null mean        — a contract violation must draw a GAP, never a fabricated zero
//   • bucket ORDER       — taken from the wire's own `minLoc`, never a hardcoded xs→xl list
//   • the unsized note   — PRs with no recorded size are in NEITHER points nor buckets
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVolumeSizeBucketStat } from '@pierre-review/shared';
import {
  bucketPrCount,
  formatBucketAvg,
  formatBucketDensity,
  sizeBucketSeries,
  unsizedNote,
} from '../src/lib/botVolumeSize.js';

function bucket(p: Partial<BotVolumeSizeBucketStat> & { bucket: BotVolumeSizeBucketStat['bucket'] }): BotVolumeSizeBucketStat {
  return {
    label: '<50',
    minLoc: 0,
    maxLoc: 50,
    prs: 0,
    comments: 0,
    avgComments: null,
    commentsPer100Loc: null,
    ...p,
  };
}

/** erxes/erxes over 90d, as the live route returned it — the shape the card was designed against:
 *  the mean RISES 6.64 → 35.5 while the density FALLS 30.56 → 0.27. */
const ERXES_90D: BotVolumeSizeBucketStat[] = [
  { bucket: 'xs', label: '<50', minLoc: 0, maxLoc: 50, prs: 116, comments: 770, avgComments: 6.64, commentsPer100Loc: 30.56 },
  { bucket: 's', label: '50–200', minLoc: 50, maxLoc: 200, prs: 102, comments: 946, avgComments: 9.27, commentsPer100Loc: 8.03 },
  { bucket: 'm', label: '200–600', minLoc: 200, maxLoc: 600, prs: 98, comments: 1547, avgComments: 15.79, commentsPer100Loc: 4.22 },
  { bucket: 'l', label: '600–2k', minLoc: 600, maxLoc: 2000, prs: 93, comments: 2265, avgComments: 24.35, commentsPer100Loc: 2.12 },
  { bucket: 'xl', label: '2k+', minLoc: 2000, maxLoc: null, prs: 82, comments: 2911, avgComments: 35.5, commentsPer100Loc: 0.27 },
];

describe('sizeBucketSeries', () => {
  it('keeps every populated bucket, ascending by size, with the wire’s own labels', () => {
    const m = sizeBucketSeries(ERXES_90D);
    expect(m.rows.map((r) => r.label)).toEqual(['<50', '50–200', '200–600', '600–2k', '2k+']);
    expect(m.rows.map((r) => r.avg)).toEqual([6.64, 9.27, 15.79, 24.35, 35.5]);
    expect(m.rows.map((r) => r.density)).toEqual([30.56, 8.03, 4.22, 2.12, 0.27]);
    expect(m.emptyLabels).toEqual([]);
    expect(m.hasComments).toBe(true);
  });

  it('orders on the wire’s minLoc, not on the order the array happened to arrive in', () => {
    // A hardcoded ['xs','s','m','l','xl'] table would also pass a same-order fixture — this one
    // arrives shuffled, so only an edge-driven sort reproduces the size order.
    const shuffled = [ERXES_90D[3]!, ERXES_90D[0]!, ERXES_90D[4]!, ERXES_90D[2]!, ERXES_90D[1]!];
    expect(sizeBucketSeries(shuffled).rows.map((r) => r.label)).toEqual([
      '<50',
      '50–200',
      '200–600',
      '600–2k',
      '2k+',
    ]);
  });

  it('does not mutate the array it was handed', () => {
    const input = [ERXES_90D[4]!, ERXES_90D[0]!];
    sizeBucketSeries(input);
    expect(input.map((b) => b.bucket)).toEqual(['xl', 'xs']);
  });

  // ── The distinction the whole file exists for ────────────────────────────────────────────────
  it('separates "no PR of this size" from "PRs of this size drew nothing"', () => {
    // Workspace 7 on this dev corpus, 30d — it has BOTH at once, which is why it is the fixture.
    const ws7: BotVolumeSizeBucketStat[] = [
      bucket({ bucket: 'xs', label: '<50', prs: 268, comments: 445, avgComments: 1.66, commentsPer100Loc: 23.37 }),
      bucket({ bucket: 's', label: '50–200', minLoc: 50, maxLoc: 200, prs: 12, comments: 6, avgComments: 0.5, commentsPer100Loc: 0.48 }),
      // Three PRs merged at this size and the bots said NOTHING. A real measurement.
      bucket({ bucket: 'm', label: '200–600', minLoc: 200, maxLoc: 600, prs: 3, comments: 0, avgComments: 0, commentsPer100Loc: 0 }),
      // Nothing this big merged at all. Not a measurement.
      bucket({ bucket: 'l', label: '600–2k', minLoc: 600, maxLoc: 2000 }),
      bucket({ bucket: 'xl', label: '2k+', minLoc: 2000, maxLoc: null }),
    ];
    const m = sizeBucketSeries(ws7);
    // The zero-comment bucket STAYS on the axis — its band is the finding.
    expect(m.rows.map((r) => r.label)).toEqual(['<50', '50–200', '200–600']);
    expect(m.rows[2]).toMatchObject({ prs: 3, avg: 0, density: 0 });
    // The two empty ones leave the axis but are NAMED, in size order.
    expect(m.emptyLabels).toEqual(['600–2k', '2k+']);
  });

  it('reports hasComments false when every populated bucket is silent — an empty state, not five flat bands', () => {
    const silent = [
      bucket({ bucket: 'xs', label: '<50', prs: 27, comments: 0, avgComments: 0, commentsPer100Loc: 0 }),
      bucket({ bucket: 's', label: '50–200', minLoc: 50, maxLoc: 200, prs: 6, comments: 0, avgComments: 0, commentsPer100Loc: 0 }),
    ];
    const m = sizeBucketSeries(silent);
    expect(m.rows).toHaveLength(2); // the bands are still real
    expect(m.hasComments).toBe(false);
  });

  it('carries a null mean through as a gap rather than fabricating a zero', () => {
    // The wire says a populated bucket always has a mean. If that is ever violated, the band must
    // render as absent data — a 0 would claim the bots ignore PRs this size.
    const broken = [bucket({ bucket: 'xs', label: '<50', prs: 5, comments: 12, avgComments: null, commentsPer100Loc: null })];
    const m = sizeBucketSeries(broken);
    expect(m.rows[0]?.avg).toBeNull();
    expect(m.rows[0]?.density).toBeNull();
    expect(m.rows[0]?.avg).not.toBe(0);
    // Comments were observed, so the card is not empty — only that one band is unreadable.
    expect(m.hasComments).toBe(true);
  });

  it('returns nothing drawable when no merged PR in scope had an observed size', () => {
    const m = sizeBucketSeries([
      bucket({ bucket: 'xs', label: '<50' }),
      bucket({ bucket: 'xl', label: '2k+', minLoc: 2000, maxLoc: null }),
    ]);
    expect(m.rows).toEqual([]);
    expect(m.emptyLabels).toEqual(['<50', '2k+']);
    expect(m.hasComments).toBe(false);
  });

  it('handles an empty response without inventing bands', () => {
    expect(sizeBucketSeries([])).toEqual({ rows: [], emptyLabels: [], hasComments: false });
  });
});

describe('formatBucketAvg', () => {
  it('prints an exact zero as a real measurement, not as a dash', () => {
    // "3 PRs this size merged and drew nothing" — the band's own finding.
    expect(formatBucketAvg(0)).toBe('0');
  });

  it('never rounds a tiny mean down into that zero', () => {
    expect(formatBucketAvg(0.04)).toBe('<0.1');
    expect(formatBucketAvg(0.04)).not.toBe('0.0');
  });

  it('dashes an absent mean', () => {
    expect(formatBucketAvg(null)).toBe('—');
  });

  it('prints ordinary means at one decimal', () => {
    expect(formatBucketAvg(6.64)).toBe('6.6');
    expect(formatBucketAvg(35.5)).toBe('35.5');
  });
});

describe('formatBucketDensity', () => {
  it('keeps two decimals where the series bottoms out, so the fall is still legible', () => {
    // erxes's largest bucket is 0.27/100 lines against 30.56 in the smallest — at a flat 1dp the
    // bottom of that range collapses and the sublinearity stops being readable.
    expect(formatBucketDensity(0.27)).toBe('0.27');
    expect(formatBucketDensity(0.24)).toBe('0.24');
  });

  it('sheds precision as the magnitude grows', () => {
    expect(formatBucketDensity(8.03)).toBe('8.0');
    expect(formatBucketDensity(30.56)).toBe('31');
  });

  it('distinguishes a true zero from a value that merely rounds to one', () => {
    expect(formatBucketDensity(0)).toBe('0');
    expect(formatBucketDensity(0.004)).toBe('<0.01');
    expect(formatBucketDensity(null)).toBe('—');
  });
});

describe('bucketPrCount', () => {
  it('singularises', () => {
    expect(bucketPrCount(1)).toBe('1 PR');
    expect(bucketPrCount(3)).toBe('3 PRs');
  });

  it('groups thousands so a 268-PR band is not mistaken for a 268-comment one', () => {
    expect(bucketPrCount(1268)).toBe('1,268 PRs');
  });
});

describe('unsizedNote', () => {
  it('says nothing when every merged PR had a recorded size', () => {
    expect(unsizedNote(491, 0)).toBeNull();
  });

  it('states the excluded count against the FULL merged population, not the sized one', () => {
    // three.js, measured: 135 of 796 merged PRs never had their size observed.
    const note = unsizedNote(661, 135);
    expect(note).toContain('135 of 796');
    expect(note).toContain('excluded');
  });
});
