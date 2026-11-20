// Bot comment VOLUME: the renderings that are wrong in a way that type-checks.
//
// Every assertion here pins a distinction where the obvious implementation compiles, ships, and is
// only visible as a number that lies:
//   • a tiny mean   — `toFixed(1)` turns 0.04 into "0.0", which reads as silence
//   • a missing bot — absent from the volume response means "said nothing", not "zero"
//
// Run from the workspace that HAS vitest (see prRef.test.ts for why this file lives outside src/):
//   ./apps/backend/node_modules/.bin/vitest run --root apps/frontend
import { describe, expect, it } from 'vitest';
import type { BotVolumeBot } from '@pierre-review/shared';
import { formatAvg, volumeByKey } from '../src/lib/botVolume.js';

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
