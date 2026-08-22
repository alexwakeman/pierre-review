// Bot comment VOLUME: the renderings that are wrong in a way that type-checks.
//
// Every assertion here pins a distinction where the obvious implementation compiles, ships, and is
// only visible as a number that lies:
//   • null ratio    — "no baseline" rendered as "1.0×" claims the PR is exactly average
//   • null LOC      — "size never observed" rendered as "0" puts the PR in the smallest bucket
//   • a tiny mean   — `toFixed(1)` turns 0.04 into "0.0", which reads as silence
//   • a missing bot — absent from the volume response means "said nothing", not "zero"
//   • `'repo'`      — the fallback baseline is NOT size-conditioned and must not be captioned so
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVolumeBot, BotVolumePrRow } from '@pierre-review/shared';
import {
  VOLUME_SORTS,
  baselineCaption,
  formatAvg,
  formatLoc,
  formatRatio,
  ratioDetail,
  ratioTone,
  volumeByKey,
} from '../src/lib/botVolume.js';

function bot(p: Partial<BotVolumeBot> & { key: string }): BotVolumeBot {
  return {
    authorUserId: 1,
    label: 'CodeRabbit',
    login: 'coderabbitai',
    kind: 'coderabbit',
    role: 'review',
    comments: 0,
    prsCommentedOn: 0,
    avgCommentsPerCommentedPr: null,
    avgCommentsPerScopePr: null,
    maxCommentsOnOnePr: 0,
    ...p,
  };
}

function row(p: Partial<BotVolumePrRow> = {}): BotVolumePrRow {
  return {
    prId: 1,
    prNumber: 7802,
    prTitle: 'fix: tighten the guard',
    prUrl: 'https://github.com/erxes/erxes/pull/7802',
    repoId: 3,
    repoFullName: 'erxes/erxes',
    createdAt: '2026-08-01T00:00:00.000Z',
    mergedAt: '2026-08-02T00:00:00.000Z',
    additions: 12,
    deletions: 5,
    loc: 17,
    changedFiles: 1,
    botComments: 25,
    byBot: [],
    sizeBucket: 'xs',
    expected: 6.8,
    ratio: 3.68,
    baseline: 'bucket',
    baselinePrs: 167,
    commentsPer100Loc: 147.06,
    ...p,
  };
}

describe('formatAvg — a small average must not read as silence', () => {
  it('prints one decimal', () => {
    // The wire carries 2dp; the column shows 1. 16.89 is the measured erxes/erxes figure.
    expect(formatAvg(16.89)).toBe('16.9');
    expect(formatAvg(4.91)).toBe('4.9');
  });

  it('a value under 0.05 is "<0.1", NOT "0.0"', () => {
    // ⚠ THE LOAD-BEARING CASE. `toFixed(1)` would render 0.04 as "0.0", which a reader cannot tell
    // apart from a bot that said nothing — and this is exactly where the per-scope-PR denominator
    // lands on a quiet repo (656 of three.js's 796 merged PRs drew no bot comment at all).
    expect(formatAvg(0.04)).toBe('<0.1');
    expect(formatAvg(0.001)).toBe('<0.1');
  });

  it('an exact zero is a flat "0", not a blank', () => {
    expect(formatAvg(0)).toBe('0');
  });

  it('null — no denominator — is a dash, never a zero', () => {
    expect(formatAvg(null)).toBe('—');
  });
});

describe('formatRatio / formatLoc — the two nulls that must not become numbers', () => {
  it('a null ratio reads as words, never "1.0×" and never "0×"', () => {
    // "No baseline" and "exactly average" are different claims. Rendering the first as the second
    // manufactures a finding out of an absence of evidence.
    expect(formatRatio(null)).toBe('no baseline');
    expect(formatRatio(null)).not.toContain('1.0');
    expect(formatRatio(null)).not.toContain('0');
  });

  it('a real ratio prints with its multiplier sign', () => {
    expect(formatRatio(3.68)).toBe('3.7×');
    expect(formatRatio(42.86)).toBe('42.9×');
  });

  it('a null LOC is a dash — a fabricated 0 would land the PR in the smallest size bucket', () => {
    expect(formatLoc(null)).toBe('—');
    expect(formatLoc(0)).toBe('0'); // a REAL zero (rename-only) still prints
    expect(formatLoc(2400)).toBe('2,400');
  });
});

describe('baselineCaption — "repo" is not size-conditioned and must not claim to be', () => {
  it('the bucket baseline names the size comparison', () => {
    expect(baselineCaption('bucket', 167)).toContain('PRs this size');
  });

  it('the repo fallback does NOT say "this size"', () => {
    // ⚠ It is the repo's whole merged population standing in because the size bucket was under the
    // small-sample floor. Captioning it as a size comparison turns a fallback into a false claim.
    const c = baselineCaption('repo', 61);
    expect(c).not.toContain('PRs this size');
    expect(c).toContain('NOT matched on size');
    expect(c).toContain('repo');
    expect(c).toContain('61');
  });

  it('"none" explains the absence rather than implying a value', () => {
    const c = baselineCaption('none', 0);
    expect(c).toContain('No baseline');
    expect(c).not.toContain('0×');
  });
});

describe('ratioDetail — the expectation rides BESIDE the multiplier', () => {
  it('quotes both the expected mean and how many PRs it came from', () => {
    // ⚠ Why both: bevy #24971 reads 42.9× off 3 comments against an expectation of 0.07 over 61
    // PRs, while erxes #7802's 3.7× is 25 comments against 6.80. Same arithmetic, very different
    // findings — only the surrounding numbers separate them.
    expect(ratioDetail(row())).toBe('expected 6.8 over 167 PRs');
    expect(ratioDetail(row({ botComments: 3, expected: 0.07, ratio: 42.86, baselinePrs: 61 }))).toBe(
      'expected 0.1 over 61 PRs',
    );
  });

  it('is null when there is no baseline, so nothing is printed beside "no baseline"', () => {
    expect(ratioDetail(row({ ratio: null, expected: null, baseline: 'none', baselinePrs: 0 }))).toBe(
      null,
    );
  });
});

describe('ratioTone — an absent comparison is muted, not scored low', () => {
  it('null is grey, not the "well under expectation" colour', () => {
    expect(ratioTone(null)).toBe('text-gray-400');
  });

  it('bands escalate', () => {
    expect(ratioTone(0.4)).toContain('gray');
    expect(ratioTone(2)).toContain('amber');
    expect(ratioTone(3.68)).toContain('red');
  });
});

describe('volumeByKey — a missing bot means "said nothing", not zero', () => {
  it('indexes on the `u<userId>` key the ROI table already renders', () => {
    const idx = volumeByKey([
      bot({ key: 'u12', authorUserId: 12, comments: 400, prsCommentedOn: 40, avgCommentsPerCommentedPr: 10 }),
    ]);
    expect(idx.get('u12')?.comments).toBe(400);
  });

  it('a bot absent from the response is a MISS — the caller dashes it', () => {
    // ⚠ The volume response OMITS a bot with no window comments (it has no trend to keep such a
    // row meaningful, unlike the ROI table's dormant rows). A `?? 0` at the call site would print
    // a confident zero for a bot that may simply not have been measured yet.
    const idx = volumeByKey([bot({ key: 'u12', authorUserId: 12 })]);
    expect(idx.get('u99')).toBeUndefined();
  });

  it('tolerates an absent response (the query has not settled)', () => {
    expect(volumeByKey(undefined).size).toBe(0);
  });
});

describe('VOLUME_SORTS — the second order has to explain itself', () => {
  it('offers exactly the two wire sorts, comments first', () => {
    expect(VOLUME_SORTS.map((s) => s.key)).toEqual(['comments', 'ratio']);
  });

  it('the raw-count option ADMITS it ranks by size', () => {
    // ⚠ The whole reason `ratio` exists. Measured: a 17-LOC, 1-file PR with 25 bot comments (3.68×
    // its bucket) ranks 123rd of 686 under "most comments" and 8th under "most vs expected". A
    // screen that offers only the default, with nothing saying why, has shipped a size ranking.
    expect(VOLUME_SORTS[0]?.help.toLowerCase()).toContain('size');
    expect(VOLUME_SORTS[1]?.help.toLowerCase()).toContain('this size');
  });
});
